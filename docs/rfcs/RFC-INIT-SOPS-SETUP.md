# RFC: Fix `hush init` to Always Create `.sops.yaml`

**Status:** Proposed  
**Date:** 2026-03-03  
**Author:** Field observation (automation workspace)  
**Severity:** High — blocks first-time use on every project without a `project` identifier

---

## Problem

Every time hush is initialized in a new project, there is a ~50% chance `hush encrypt` immediately fails with:

```
SOPS encryption failed: config file not found, or has no creation rules, and no keys provided
```

This happens because **`init` only creates `.sops.yaml` when `project` is non-null**. The `setupKey()` call is gated behind a project identifier check:

```ts
// init.ts line 222-226
const keyResult = await setupKey(ctx, root, project);  // project is null here!

if (keyResult) {
  createSopsConfig(ctx, root, keyResult.publicKey);    // Never reached
}
```

`setupKey()` returns `null` immediately when `project` is null (line 79-83 of init.ts):
```ts
async function setupKey(..., project: string | null): Promise<KeySetupResult | null> {
  if (!project) {
    ctx.logger.log(pc.yellow('No project identifier found. Skipping key setup.'));
    return null;   // <-- bails out, no .sops.yaml created
  }
  ...
}
```

The result: `hush.yaml` is written, `.sops.yaml` is **not written**, and the user is stuck.

---

## Affected Scenarios

1. **New project without `repository` in `package.json`** — most common for personal/throwaway projects
2. **`hush.yaml` without `project:` field** — happens with manual editing or `hush init` in non-git repos
3. **Any time `hush init` runs before the user adds `project:` to `hush.yaml`**

---

## Existing Key Is Already Present (But Ignored)

The machine-level SOPS default key at `~/.config/sops/age/key.txt` exists and is valid. The `sops.ts` fallback logic (`getAgeKeyFile()`) already knows about it:

```ts
// sops.ts line 43-46
const defaultPath = join(homedir(), '.config', 'sops', 'age', 'key.txt');
if (fs.existsSync(defaultPath)) {
  return defaultPath;  // sops can USE this key for encrypt/decrypt
}
```

But `init.ts` never reads it to populate `.sops.yaml`. The key exists, SOPS would use it, but `.sops.yaml` has no `creation_rules` so SOPS doesn't know what key to encrypt to.

---

## Proposed Fix

### Option A (Minimal — Recommended): Fall back to `~/.config/sops/age/key.txt`

In `setupKey()` or `initCommand()`, after the `project` check fails, look for the default SOPS age key and use it:

```ts
// init.ts — new fallback in setupKey()
async function setupKey(ctx, root, project): Promise<KeySetupResult | null> {
  if (!project) {
    ctx.logger.log(pc.yellow('No project identifier found. Skipping named key setup.'));
    ctx.logger.log(pc.dim('Add "project: my-org/my-repo" to hush.yaml for per-project key management.\n'));

    // NEW: fall back to the default SOPS age key if it exists
    const defaultKeyPath = join(homedir(), '.config', 'sops', 'age', 'key.txt');
    if (ctx.fs.existsSync(defaultKeyPath)) {
      const content = ctx.fs.readFileSync(defaultKeyPath, 'utf-8') as string;
      const pub = content.match(/# public key: (age1[a-z0-9]+)/)?.[1];
      if (pub) {
        ctx.logger.log(pc.green(`Using default age key from ~/.config/sops/age/key.txt`));
        return { publicKey: pub, source: 'existing' };
      }
    }

    ctx.logger.log(pc.yellow('No age key found. Run "hush keys generate" after adding project to hush.yaml.'));
    return null;
  }
  // ... rest unchanged
}
```

This means: even without a project, if the user has any age key at all (which they do after any prior hush setup), `.sops.yaml` gets written and `hush encrypt` works immediately.

### Option B (Better UX): `init` always creates `.sops.yaml`, prompt for key

Separate `.sops.yaml` creation from the project/key-naming system entirely. `.sops.yaml` only needs a public key — we should get one however we can.

```ts
// In initCommand(), replace the current gated block:
const keyResult = await setupKey(ctx, root, project)
  ?? await tryDefaultAgeKey(ctx)      // check ~/.config/sops/age/key.txt
  ?? await promptUserForPublicKey(ctx); // last resort: ask for it

if (keyResult) {
  createSopsConfig(ctx, root, keyResult.publicKey);
} else {
  ctx.logger.log(pc.yellow('\n⚠️  .sops.yaml not created. Run "hush keys generate" then "hush init" again.'));
  ctx.logger.log(pc.dim('   Or manually create .sops.yaml with your age public key.'));
}
```

### Option C (Most Robust): `hush init` always exits with `.sops.yaml` or a clear error

Make it impossible to complete `init` without `.sops.yaml`. If no key can be found:
1. Auto-generate one (like `keys generate` does)
2. Save it to `~/.config/sops/age/key.txt` (the universal default)
3. Create `.sops.yaml` pointing to it
4. Print the public key and instructions for backing it up

This is the most "it just works" experience.

---

## Recommended Fix: Option A + improve the "skipping key setup" message

Option A is the smallest code change, fixes the immediate failure, and is backwards compatible. The message improvement ensures users who see the "skipping" notice understand what to do.

**Estimated effort:** ~10 lines of code in `init.ts`.

---

## Also: `hush init` Second-Run Behavior

There's a related issue: when `hush.yaml` exists but `.sops.yaml` doesn't (exactly this scenario), `init` has a partial recovery path (lines 173-190):

```ts
if (existingConfig) {
  const sopsPath = ctx.path.join(root, '.sops.yaml');
  if (ctx.fs.existsSync(sopsPath)) {
    ctx.logger.error('Config already exists...');
    process.exit(1);   // <-- blocks if .sops.yaml exists
  }
  // Only reaches here if .sops.yaml is MISSING — good!
  // But still gated on project identifier — bad!
  const keyResult = await setupKey(ctx, root, project ?? null);
  if (keyResult) {
    createSopsConfig(ctx, root, keyResult.publicKey);
  }
  // If project is null, keyResult is null, and we silently exit with no .sops.yaml
}
```

Same fix applies here.

---

## Workaround (Until Fixed)

For any project without a `project:` field, after `hush init`:

```bash
# Get your public key
grep "public key" ~/.config/sops/age/key.txt

# Create .sops.yaml manually
cat > .sops.yaml << 'EOF'
creation_rules:
  - path_regex: \.hush$
    age: <YOUR_PUBLIC_KEY>
  - path_regex: \.hush\..*
    age: <YOUR_PUBLIC_KEY>
EOF

hush encrypt
```

Or more simply, add `project:` to `hush.yaml` before running `hush init`:
```yaml
# hush.yaml
version: 2
project: my-project-name   # add this line
...
```
Then re-run `hush init` — it will detect the existing `hush.yaml` and run `setupKey()` with the project identifier, which will find the key and create `.sops.yaml`.

---

## Impact

- **Every** new project initialized on a machine without `repository` in `package.json` hits this
- The error message from SOPS (`config file not found`) gives no indication the fix is to re-run `hush init` or create `.sops.yaml` manually
- This has caused repeated confusion across multiple projects

---

## Files to Change

- `hush-cli/src/commands/init.ts` — `setupKey()` function, fallback to default age key
- `hush-cli/src/commands/init.ts` — `initCommand()` second-run path, same fix
- `hush-cli/README.md` — document that `project:` is required for named key management, not for basic usage
