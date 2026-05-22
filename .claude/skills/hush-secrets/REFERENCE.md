# Hush Command Reference

Complete reference for all Hush CLI commands with flags, options, and examples.

## Global Options

These options work with most commands:

| Option | Description |
|--------|-------------|
| `-e, --env <env>` | Environment: `development` (or `dev`) / `production` (or `prod`). Default: `development` |
| `-r, --root <dir>` | Root directory containing `hush.yaml`. Default: current directory |
| `-h, --help` | Show help message |
| `-v, --version` | Show version number |

## Commands

### hush init

Initialize Hush with auto-detected configuration and key generation.

```bash
hush init
```

**What it does:**
1. Scans for `package.json` and `wrangler.toml` to auto-detect targets
1. Generates an age encryption key
1. Creates `hush.yaml` and `.sops.yaml`

---

### hush run (RECOMMENDED)

Run a command with secrets injected as environment variables. Secrets are decrypted to memory only - never written to disk.

```bash
hush run -- npm start               # Development (default)
hush run -e production -- npm build # Production
hush run -t api -- wrangler dev     # Filter for specific target
```

**Options:**

| Option | Description |
|--------|-------------|
| `-e, --env <env>` | Environment: `development` or `production` |
| `-t, --target <name>` | Only include variables for this target |

---

### hush keys

Manage age encryption keys for the project.

```bash
hush keys setup      # Verify local key exists
hush keys generate  # Generate a new key
hush keys list      # List all local keys
```

**Options:**

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing key (generate only) |

---

### hush encrypt

Encrypt source `.env` files to `.env.encrypted` files.

```bash
hush encrypt
```

**What gets encrypted** (based on `hush.yaml` sources):
- `.env` → `.env.encrypted`
- `.env.development` → `.env.development.encrypted`
- `.env.production` → `.env.production.encrypted`

---

### hush decrypt

Decrypt and distribute secrets to all configured targets.

```bash
hush decrypt                    # Development (default)
hush decrypt -e production      # Production
hush decrypt -e prod            # Short form
```

**Process:**
1. Decrypts encrypted source files
2. Merges: shared → environment → local overrides
3. Interpolates variable references (`${VAR}`)
4. Filters per target using `include`/`exclude` patterns
5. Writes to each target in configured format

---

### hush set

Set a single secret interactively.

```bash
hush set API_KEY                # Prompt in terminal
hush set API_KEY --gui          # macOS dialog (for AI agents)
hush set API_KEY -e production  # Set in production env
hush set API_KEY --local        # Set in local overrides
```

**Options:**

| Option | Description |
|--------|-------------|
| `--gui` | Open macOS dialog instead of TTY prompt (perfect for AI agents) |
| `-e, --env <env>` | Target environment file |
| `--local` | Set in `.env.local.encrypted` (personal overrides) |

### hush edit

Edit all secrets in your `$EDITOR`.

```bash
hush edit                       # Edit shared secrets
hush edit development           # Edit development secrets
hush edit production            # Edit production secrets
```

Opens a temporary decrypted file, re-encrypts on save.

**Tip:** Set your editor with `export EDITOR=vim` or use `code --wait` for VS Code.

---

### hush list

List all variables with their **actual values**.

```bash
hush list                       # Development
hush list -e production         # Production
```

**WARNING:** This shows real secret values. Use `hush inspect` for AI-safe output.

---

### hush inspect (AI-Safe)

List all variables with **masked values**. Safe for AI agents.

```bash
hush inspect                    # Development
hush inspect -e production      # Production
```

**Output format:**
```
Secrets for development:

  DATABASE_URL      = post****************... (45 chars)
  STRIPE_SECRET_KEY = sk_t****************... (32 chars)
  API_KEY           = (not set)

Total: 3 variables

Target distribution:

  root (.) - 3 vars
  app (./app/) - 1 vars
    include: EXPO_PUBLIC_*
  api (./api/) - 2 vars
    exclude: EXPO_PUBLIC_*
```

**What's visible:**
- Variable names
- First 4 characters (helps identify type: `sk_` = Stripe, `ghp_` = GitHub)
- Value length
- Which targets receive which variables

---

### hush has (AI-Safe)

Check if a specific secret exists.

```bash
hush has <KEY>                  # Verbose output
hush has <KEY> -q               # Quiet mode (exit code only)
hush has <KEY> --quiet          # Same as -q
```

**Exit codes:**
- `0` - Variable is set
- `1` - Variable not found

**Examples:**
```bash
# Check with output
hush has DATABASE_URL
# Output: DATABASE_URL is set (45 chars)

# Check missing variable
hush has MISSING_KEY
# Output: MISSING_KEY not found
# Exit code: 1

# Use in scripts
hush has DATABASE_URL -q && echo "DB ready"

# Check multiple
hush has DB_URL -q && hush has API_KEY -q && echo "All set"
```

---

### hush push

Push production secrets to Cloudflare Workers.

```bash
hush push                       # Push secrets
hush push --dry-run             # Preview without pushing
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview what would be pushed, don't actually push |

**Requirements:**
- Target must have `format: wrangler`
- `wrangler.toml` must exist in target path
- `wrangler` CLI must be installed and authenticated

---

### hush status

Show configuration and file status.

```bash
hush status
```

**Output includes:**
- Configuration file location
- Source files and their encryption status
- Target configuration (paths, formats, filters)
- Whether files are in sync

---

### hush check

Verify secrets are encrypted (useful for pre-commit hooks).

```bash
hush check                      # Basic check
hush check --warn               # Warn but don't fail
hush check --json               # JSON output for CI
hush check --only-changed       # Only check git-modified files
hush check --require-source     # Fail if source file missing
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

Bypass with: `HUSH_SKIP_CHECK=1 git commit -m "message"`

## Configuration File (hush.yaml)

```yaml
sources:
  shared: .env
  development: .env.development
  production: .env.production

targets:
  - name: root
    path: .
    format: dotenv

  - name: app
    path: ./packages/app
    format: dotenv
    include:
      - EXPO_PUBLIC_*
      - NEXT_PUBLIC_*

  - name: api
    path: ./packages/api
    format: wrangler
    exclude:
      - EXPO_PUBLIC_*
```

### Target Options

| Option | Description |
|--------|-------------|
| `name` | Identifier for the target |
| `path` | Directory to write output file |
| `format` | Output format: `dotenv`, `wrangler`, `json`, `shell`, `yaml` |
| `include` | Glob patterns to include (e.g., `NEXT_PUBLIC_*`) |
| `exclude` | Glob patterns to exclude |

### Output Formats

| Format | Output File | Use Case |
|--------|-------------|----------|
| `dotenv` | `.env.development` / `.env.production` | Next.js, Vite, Expo, Remix, Node.js |
| `wrangler` | `.dev.vars` | Cloudflare Workers & Pages |
| `json` | `.env.development.json` | AWS Lambda, serverless, JSON configs |
| `shell` | `.env.development.sh` | CI/CD pipelines, Docker builds |
| `yaml` | `.env.development.yaml` | Kubernetes ConfigMaps, Docker Compose |

### Framework Client Prefixes

| Framework | Client Prefix | Example |
|-----------|--------------|---------|
| Next.js | `NEXT_PUBLIC_*` | `include: [NEXT_PUBLIC_*]` |
| Vite | `VITE_*` | `include: [VITE_*]` |
| Create React App | `REACT_APP_*` | `include: [REACT_APP_*]` |
| Vue CLI | `VUE_APP_*` | `include: [VUE_APP_*]` |
| Nuxt | `NUXT_PUBLIC_*` | `include: [NUXT_PUBLIC_*]` |
| Astro | `PUBLIC_*` | `include: [PUBLIC_*]` |
| SvelteKit | `PUBLIC_*` | `include: [PUBLIC_*]` |
| Expo | `EXPO_PUBLIC_*` | `include: [EXPO_PUBLIC_*]` |
| Gatsby | `GATSBY_*` | `include: [GATSBY_*]` |
