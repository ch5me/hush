# Feature: Git Hook Integration (`hush check`)

## Overview

Add a `hush check` command that detects drift between plaintext `.env*` source files and their encrypted counterparts. This enables pre-commit hooks to warn/block commits when secrets haven't been re-encrypted after local changes.

## User Story

1. Developer adds `NEW_API_KEY=secret123` to `.env.development`
2. Developer runs `git commit`
3. Pre-commit hook runs `hush check`
4. Hush detects `.env.development` has keys not in `.env.development.encrypted`
5. Hook blocks commit with: "Drift detected. Run `hush encrypt` first."

## Command: `hush check`

### Usage

```
hush check [options]

Options:
  --warn              Warn but exit 0 (don't block commit)
  --json              Output machine-readable JSON
  --quiet, -q         No output, just exit code
  --only-changed      Only check files modified according to git
  --require-source    Fail if plaintext source file is missing
  -r, --root <dir>    Root directory (default: cwd)
  -h, --help          Show help
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All sources in sync with encrypted files |
| `1` | Drift detected (added/removed/changed keys) |
| `2` | Usage or config error (bad flags, missing hush.yaml) |
| `3` | Runtime error (sops not installed, decrypt failed, parse error) |

### Output Format (default)

```
Checking secrets...

.env.development → .env.development.encrypted
  Added keys:   NEW_API_KEY, ANOTHER_SECRET
  Removed keys: OLD_DEPRECATED_KEY
  Changed keys: STRIPE_SECRET_KEY

.env.production → .env.production.encrypted
  ✓ In sync

✗ Drift detected in 1 file(s)
Run: hush encrypt
```

### Output Format (--json)

```json
{
  "status": "drift",
  "files": [
    {
      "source": ".env.development",
      "encrypted": ".env.development.encrypted",
      "inSync": false,
      "added": ["NEW_API_KEY", "ANOTHER_SECRET"],
      "removed": ["OLD_DEPRECATED_KEY"],
      "changed": ["STRIPE_SECRET_KEY"]
    },
    {
      "source": ".env.production",
      "encrypted": ".env.production.encrypted",
      "inSync": true,
      "added": [],
      "removed": [],
      "changed": []
    }
  ]
}
```

## Implementation

### Algorithm

```typescript
async function check(opts: CheckOptions): Promise<CheckResult[]> {
  const config = loadConfig(opts.root)
  const pairs = getSourceEncryptedPairs(config)
  // pairs = [
  //   { source: ".env", encrypted: ".env.encrypted" },
  //   { source: ".env.development", encrypted: ".env.development.encrypted" },
  //   { source: ".env.production", encrypted: ".env.production.encrypted" },
  // ]

  const results: CheckResult[] = []

  for (const { source, encrypted } of pairs) {
    // Skip if source doesn't exist (common in CI)
    if (!fileExists(source)) {
      if (opts.requireSource) {
        results.push({ source, encrypted, error: "SOURCE_MISSING" })
      }
      continue
    }

    // Encrypted file missing = definitely drift
    if (!fileExists(encrypted)) {
      results.push({
        source,
        encrypted,
        error: "ENCRYPTED_MISSING",
        added: getAllKeys(source),
        removed: [],
        changed: [],
      })
      continue
    }

    // Decrypt to memory (NEVER write to disk)
    const decryptedContent = await sopsDecrypt(encrypted) // sops --decrypt → stdout
    
    // Parse both to key-value maps
    const sourceVars = parseEnvContent(readFile(source))
    const encryptedVars = parseEnvContent(decryptedContent)

    // Compute diff (keys only, NEVER compare/log values in output)
    const sourceKeys = new Set(Object.keys(sourceVars))
    const encryptedKeys = new Set(Object.keys(encryptedVars))

    const added = [...sourceKeys].filter(k => !encryptedKeys.has(k))
    const removed = [...encryptedKeys].filter(k => !sourceKeys.has(k))
    const changed = [...sourceKeys]
      .filter(k => encryptedKeys.has(k))
      .filter(k => sourceVars[k] !== encryptedVars[k])

    results.push({
      source,
      encrypted,
      inSync: added.length === 0 && removed.length === 0 && changed.length === 0,
      added,
      removed,
      changed,
    })
  }

  return results
}
```

### File Structure

Add these files to `hush-cli/`:

```
hush-cli/
├── src/
│   ├── commands/
│   │   ├── check.ts      # NEW: check command implementation
│   │   └── ...
│   ├── lib/
│   │   ├── diff.ts       # NEW: diff utilities (compare key sets)
│   │   └── ...
│   └── cli.ts            # Add 'check' to command router
└── tests/
    └── check.test.ts     # NEW: tests for check command
```

### Key Implementation Details

1. **Use existing `sopsDecrypt()` function** - should already exist for the decrypt command
2. **Use existing `parseEnvContent()` function** - should already exist for parsing
3. **NEVER print secret values** - only print key names in diffs
4. **Semantic comparison** - ignore key ordering, whitespace differences
5. **Handle SOPS errors gracefully** - wrong age key, missing sops binary, etc.

### Helper: Get Source-Encrypted Pairs

```typescript
function getSourceEncryptedPairs(config: HushConfig): Array<{source: string, encrypted: string}> {
  const pairs = []
  
  if (config.sources.shared) {
    pairs.push({
      source: config.sources.shared,           // ".env"
      encrypted: config.sources.shared + ".encrypted"  // ".env.encrypted"
    })
  }
  if (config.sources.development) {
    pairs.push({
      source: config.sources.development,      // ".env.development"
      encrypted: config.sources.development + ".encrypted"
    })
  }
  if (config.sources.production) {
    pairs.push({
      source: config.sources.production,       // ".env.production"
      encrypted: config.sources.production + ".encrypted"
    })
  }
  
  return pairs
}
```

## Hook Integration

### Husky Setup (document in README)

```bash
# .husky/pre-commit
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Allow bypass with HUSH_SKIP_CHECK=1 git commit ...
[ -n "$HUSH_SKIP_CHECK" ] && exit 0

npx hush check || exit 1
```

### Standalone Git Hook (alternative)

```bash
# .git/hooks/pre-commit
#!/bin/sh

# Allow bypass
[ -n "$HUSH_SKIP_CHECK" ] && exit 0

# Run hush check if available
if command -v hush >/dev/null 2>&1 || [ -x ./node_modules/.bin/hush ]; then
  npx --no-install hush check || exit 1
fi
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Plaintext source missing | Skip (unless `--require-source`) |
| Encrypted file missing | Report as drift, show all keys as "added" |
| sops not installed | Exit 3 with helpful error message |
| Decrypt fails (wrong key) | Exit 3 with "check your age key" message |
| Empty source file | Treat as 0 keys (removed = all encrypted keys) |
| Reordered keys only | No drift (semantic comparison) |
| Whitespace differences in values | Counts as changed (exact string match) |
| `.env.local` exists | Ignore (not a configured source) |

## Error Messages

```
# sops not installed
Error: SOPS is not installed
Run: brew install sops

# Decrypt failed
Error: Failed to decrypt .env.development.encrypted
This usually means your age key doesn't match.
Check: ~/.config/sops/age/key.txt

# Config missing
Error: No hush.yaml found
Run: hush init

# Encrypted file missing
Warning: .env.development.encrypted not found
All keys in .env.development will need to be encrypted.
Run: hush encrypt
```

## Tests

```typescript
describe("hush check", () => {
  it("returns 0 when all files in sync", async () => {
    // Setup: source and encrypted have same keys/values
    const result = await runCheck()
    expect(result.exitCode).toBe(0)
  })

  it("returns 1 when keys added to source", async () => {
    // Setup: source has NEW_KEY not in encrypted
    const result = await runCheck()
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Added keys:")
    expect(result.output).toContain("NEW_KEY")
  })

  it("returns 1 when keys removed from source", async () => {
    // Setup: encrypted has OLD_KEY not in source
    const result = await runCheck()
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Removed keys:")
  })

  it("returns 1 when values changed", async () => {
    // Setup: same keys, different values
    const result = await runCheck()
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Changed keys:")
  })

  it("never prints secret values", async () => {
    // Setup: source has SECRET_KEY=actual_secret_value
    const result = await runCheck()
    expect(result.output).not.toContain("actual_secret_value")
    expect(result.output).toContain("SECRET_KEY") // key name OK
  })

  it("skips missing source files by default", async () => {
    // Setup: .env.production doesn't exist
    const result = await runCheck()
    expect(result.exitCode).toBe(0) // not an error
  })

  it("fails on missing source with --require-source", async () => {
    const result = await runCheck(["--require-source"])
    expect(result.exitCode).toBe(2)
  })

  it("returns 0 with --warn even when drift detected", async () => {
    // Setup: drift exists
    const result = await runCheck(["--warn"])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Drift detected") // still warns
  })

  it("outputs valid JSON with --json", async () => {
    const result = await runCheck(["--json"])
    const parsed = JSON.parse(result.output)
    expect(parsed).toHaveProperty("status")
    expect(parsed).toHaveProperty("files")
  })

  it("returns 3 when sops not installed", async () => {
    // Mock: sops command fails
    const result = await runCheck()
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain("SOPS is not installed")
  })
})
```

## README Addition

Add to the Commands section in README.md:

```markdown
### `hush check` - Verify secrets are encrypted

Check that all plaintext `.env*` files are in sync with their encrypted versions.
Useful as a pre-commit hook to prevent committing unencrypted secret changes.

```bash
# Basic check
hush check

# Warn but don't fail
hush check --warn

# JSON output for CI
hush check --json

# Only check git-modified files
hush check --only-changed
```

**Exit codes:**
- `0` - All in sync
- `1` - Drift detected (run `hush encrypt`)
- `2` - Config error
- `3` - Runtime error (sops missing, decrypt failed)

**Pre-commit hook (Husky):**
```bash
# .husky/pre-commit
npx hush check || exit 1
```

Bypass with: `HUSH_SKIP_CHECK=1 git commit -m "emergency fix"`
```

## Summary Checklist

- [ ] Add `src/commands/check.ts` with check implementation
- [ ] Add `src/lib/diff.ts` with key comparison utilities  
- [ ] Register `check` command in `cli.ts`
- [ ] Add tests in `tests/check.test.ts`
- [ ] Update README with check command docs
- [ ] Update `--help` output in cli.ts
