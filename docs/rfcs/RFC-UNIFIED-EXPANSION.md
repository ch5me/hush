# RFC: Unified Variable Expansion with Pull-Based Subdirectory Configuration

**Status**: Draft  
**Author**: Sisyphus (synthesized from beta client RFC + owner feedback)  
**Date**: 2026-01-17  
**For**: Hush Developer

---

## Executive Summary

This RFC proposes a **pull-based architecture** where subdirectories can define their own `.env` template files that reference root secrets via `${VAR}` syntax. This solves the prefix problem (EXPO_PUBLIC_*, NEXT_PUBLIC_*) while giving each subdirectory full control over how it consumes and transforms root secrets.

**Key insight**: Subdirectory `.env` files contain **no actual secrets**—only variable references like `${SUPABASE_URL}`. They're safe to commit to git and serve as explicit declarations of what each app needs.

---

## Problem Statement

### The Current "Push" Model

Today, Hush uses a centralized push model:

```yaml
# hush.yaml (root)
targets:
  - name: web
    path: ./apps/web
    include: [NEXT_PUBLIC_*]
  - name: mobile
    path: ./apps/mobile
    include: [EXPO_PUBLIC_*]
```

**Problems with push:**

1. **Root must know everything**: The root config must anticipate every subdirectory's needs
2. **Prefix duplication**: To serve both `api` (needs `SUPABASE_URL`) and `mobile` (needs `EXPO_PUBLIC_SUPABASE_URL`), you must store the same secret twice with different names
3. **No local transformation**: Subdirectories can't compose or derive variables—they just receive what's pushed
4. **Tight coupling**: Adding a new app means editing the root config

### The Prefix Duplication Problem (from original RFC)

```bash
# Current: Same value stored twice
SUPABASE_URL=https://xyz.supabase.co
EXPO_PUBLIC_SUPABASE_URL=https://xyz.supabase.co  # Duplicate!
```

**Consequences:**
- Update one, forget the other → drift
- Double storage in encrypted files
- Confusion about source of truth

---

## Proposed Solution: Pull-Based with Local Expansion

### Core Concept

1. **Root owns the secrets** (encrypted, source of truth)
2. **Subdirectories own their configuration** (unencrypted `.env` templates)
3. **Templates reference root secrets** via `${VAR}` syntax
4. **`hush run` resolves everything** at runtime

### Directory Structure

```
monorepo/
├── hush.yaml                    # Root config
├── .sops.yaml                   # Encryption config
├── .env.encrypted               # Root secrets (encrypted)
├── .env.development.encrypted   # Dev overrides (encrypted)
│
├── apps/
│   ├── web/                     # Next.js app
│   │   └── .env                 # Template: NEXT_PUBLIC_API_URL=${API_URL}
│   │
│   ├── mobile/                  # Expo app
│   │   └── .env                 # Template: EXPO_PUBLIC_API_URL=${API_URL}
│   │
│   ├── landing-us/              # Wrangler landing page (US)
│   │   └── .env                 # Template: REGION=us, API_URL=${API_URL}/us
│   │
│   └── landing-eu/              # Wrangler landing page (EU)
│       └── .env                 # Template: REGION=eu, API_URL=${API_URL}/eu
│
└── packages/
    └── api/                     # Cloudflare Worker
        └── .env                 # Template: DATABASE_URL=${DATABASE_URL}
```

### Example: Two Landing Pages, Different Configurations

**Root secrets** (`.env.encrypted`):
```bash
API_URL=https://api.example.com
SUPABASE_URL=https://xyz.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**apps/landing-us/.env** (template, NOT encrypted, safe to commit):
```bash
# Pull from root and customize for US region
REGION=us
PUBLIC_API_URL=${API_URL}/v1/us
PUBLIC_SUPABASE_URL=${SUPABASE_URL}
PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
```

**apps/landing-eu/.env** (template, NOT encrypted, safe to commit):
```bash
# Pull from root and customize for EU region
REGION=eu
PUBLIC_API_URL=${API_URL}/v1/eu
PUBLIC_SUPABASE_URL=${SUPABASE_URL}
PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
```

**Result when running `hush run` from each directory:**

```bash
# From apps/landing-us/
$ hush run -- printenv PUBLIC_API_URL
https://api.example.com/v1/us

# From apps/landing-eu/
$ hush run -- printenv PUBLIC_API_URL
https://api.example.com/v1/eu
```

Same root secret, different local transformations. **No duplication.**

---

## How It Works

### Resolution Algorithm

When `hush run -e <environment> -- <command>` is executed:

```
1. FIND PROJECT ROOT
   - Walk up from current directory until hush.yaml is found
   - This is the "Project Root"

2. DECRYPT ROOT SECRETS (environment-aware)
   - Load and merge: .env → .env.{environment} → .env.local
   - All from encrypted files at project root
   - Result: RootSecrets map (in memory only)

3. FIND LOCAL TEMPLATES (new behavior)
   - Look for .env files in the current working directory
   - If none found: fall back to existing behavior (inject all/filtered root secrets)

4. IF LOCAL TEMPLATES EXIST:
   a. Load and merge local templates: .env → .env.{environment} → .env.local
   b. For each variable in merged result:
      - ${VAR} syntax: resolve VAR from RootSecrets
      - ${env:VAR} syntax: resolve VAR from process.env
      - Literal value: use as-is
   c. Inject ONLY the resolved local variables into subprocess
   
5. EXECUTE COMMAND
   - spawn with { env: { ...process.env, ...resolvedVars } }
```

**Key insight**: The `-e` flag affects BOTH root and subdirectory resolution. This means production secrets at root combine with production templates in subdirectories.

### Resolution Order (Precedence)

When a variable is defined in multiple places:

```
1. Local .env literal value     (highest priority)
2. Local .env expanded value    
3. Root secrets                 (lowest priority)
```

**Example:**
```bash
# Root: API_URL=https://prod.api.com
# Local: API_URL=http://localhost:3000

# Result: http://localhost:3000 (local wins)
```

This allows local development overrides.

### What Gets Injected

**With local `.env` template**: Only variables defined in the local template are injected (explicit allowlist).

**Without local `.env` template**: Falls back to current behavior (all secrets or filtered by `-t` target).

This is a security improvement—**Least Privilege by default**.

---

## Configuration Changes

### hush.yaml Updates

The root `hush.yaml` becomes simpler. Targets are still useful for `hush push` (deployment) but less critical for `hush run`:

```yaml
# hush.yaml
sources:
  shared: .env
  development: .env.development
  production: .env.production

# Targets are now optional for hush run
# They're still used for hush push (Cloudflare deployment)
targets:
  - name: api
    path: ./packages/api
    format: wrangler
```

### No Subdirectory Config Files

**Decision**: Subdirectories use `.env` files only. No `hush.local.yaml` or similar.

**Rationale**: 
- `.env` is the universal standard
- Adding config files increases cognitive load
- If complex logic is needed, that's a code smell

---

## New Commands

### `hush template` (or `hush vars`)

Show what variables a subdirectory's template will resolve to:

```bash
$ cd apps/mobile
$ hush template

Template: apps/mobile/.env
Resolves against: /monorepo (hush.yaml)

Variables:
  EXPO_PUBLIC_API_URL        = ${API_URL}           → https://api.example.com
  EXPO_PUBLIC_SUPABASE_URL   = ${SUPABASE_URL}      → https://xyz.supabase.co
  EXPO_PUBLIC_SUPABASE_ANON_KEY = ${SUPABASE_ANON_KEY} → eyJh****... (masked)
  DEBUG                      = true                 → true (literal)

Total: 4 variables (3 from root, 1 local)
```

### `hush expansions` (from original RFC)

Show the dependency graph across all templates:

```bash
$ hush expansions

Expansion Graph (from /monorepo):

apps/web/.env:
  NEXT_PUBLIC_API_URL        ← ${API_URL}
  NEXT_PUBLIC_SUPABASE_URL   ← ${SUPABASE_URL}

apps/mobile/.env:
  EXPO_PUBLIC_API_URL        ← ${API_URL}
  EXPO_PUBLIC_SUPABASE_URL   ← ${SUPABASE_URL}

apps/landing-us/.env:
  PUBLIC_API_URL             ← ${API_URL}/v1/us
  REGION                     = us (literal)

apps/landing-eu/.env:
  PUBLIC_API_URL             ← ${API_URL}/v1/eu
  REGION                     = eu (literal)
```

### Enhanced `hush check`

Add validation for template files:

```bash
$ hush check

Checking secrets...
✓ All .env files encrypted
✓ No circular expansion references

Checking templates...
✓ apps/web/.env - all references resolve
✓ apps/mobile/.env - all references resolve
⚠ apps/landing-us/.env - TYPO_VAR is undefined (line 5)
⚠ apps/api/.env - contains high-entropy string on line 3 (possible secret?)
```

---

## Security Considerations

### 1. Template Files Contain No Secrets

By design, template `.env` files contain only:
- Variable references: `EXPO_PUBLIC_FOO=${FOO}`
- Literal non-secret values: `DEBUG=true`, `REGION=us`

**Validation**: `hush check` should warn if a template contains high-entropy strings that look like secrets.

### 2. Least Privilege by Default

When a local template exists, **only** the variables defined in that template are injected. This prevents accidentally leaking root secrets to subprocesses that don't need them.

### 3. No External References

The `${VAR}` syntax only resolves against:
- Root Hush secrets (encrypted)
- Other variables in the same template file

It does **not** resolve against:
- System `process.env` (by default—see Open Questions)
- External sources

### 4. Circular Reference Detection

The existing interpolation logic (up to 10 iterations) already handles this. Add explicit cycle detection with clear error messages.

---

## Migration Path

### Backward Compatibility

- **No breaking changes**: Existing setups without local templates work exactly as before
- **Gradual adoption**: Add templates to subdirectories one at a time
- **Targets still work**: `-t target` flag continues to function for filtering

### Migration Example

**Before** (push model with duplication):
```yaml
# hush.yaml
targets:
  - name: mobile
    path: ./apps/mobile
    include: [EXPO_PUBLIC_*]
```
```bash
# Root .env
API_URL=https://api.example.com
EXPO_PUBLIC_API_URL=https://api.example.com  # Duplicate!
```

**After** (pull model with template):
```yaml
# hush.yaml (simpler, no include patterns needed)
targets:
  - name: mobile
    path: ./apps/mobile
```
```bash
# Root .env (no duplication)
API_URL=https://api.example.com
```
```bash
# apps/mobile/.env (template)
EXPO_PUBLIC_API_URL=${API_URL}
```

---

## Implementation Plan

### Phase 1: Core Pull-Based Resolution (P0)

1. **Update config loader**: Walk up directory tree to find `hush.yaml`
2. **Update `hush run`**:
   - Detect local `.env` templates in current directory
   - Load environment-specific variants (`.env` → `.env.{env}` → `.env.local`)
   - If found: parse, expand against root secrets, inject only template vars
   - If not found: existing behavior (all root secrets or filtered by `-t`)
3. **Update interpolator**: 
   - `${VAR}` resolves against root secrets
   - `${env:VAR}` resolves against `process.env`
   - Handle missing values gracefully (warning + empty string)

**Effort**: 1-2 days

### Phase 2: Visibility Commands (P1)

1. **`hush template`**: Show resolved template for current directory
   - Display which variables come from root vs local
   - Show expansion chain for each variable
2. **`hush expansions`**: Show dependency graph across all templates in monorepo
3. **Enhanced `hush check`**: Validate templates, warn on possible secrets

**Effort**: 1 day

### Phase 3: Polish (P2)

1. Default value syntax: `${VAR:-default}`
2. Warning when template references undefined root var
3. Documentation updates
4. Update AI skill to explain pull-based model

**Effort**: 0.5 days

---

## Design Decisions

### 1. Templates resolve against `process.env` with explicit opt-in

**Decision**: Not by default, but available via explicit syntax.

```bash
# Reference root secret (default)
DATABASE_URL=${DATABASE_URL}

# Reference system environment variable (explicit opt-in)
HOME_DIR=${env:HOME}
PATH_VAR=${env:PATH}
```

The `${env:VAR}` syntax makes it explicit when you're pulling from system environment vs root secrets. This maintains security by default while allowing flexibility when needed.

### 2. Environment flag (`-e`) selects variants at BOTH root and subdirectory

**Decision**: When you specify an environment, it applies to the entire hierarchy.

```bash
# hush run -e production -- npm start
```

This resolves:
1. **Root**: `.env.encrypted` → `.env.production.encrypted` (merged)
2. **Subdirectory**: `.env` → `.env.production` (merged, if exists)

**Example:**
```
monorepo/
├── .env.encrypted              # BASE_URL=https://api.example.com
├── .env.production.encrypted   # BASE_URL=https://prod.api.example.com
│
└── apps/web/
    ├── .env                    # NEXT_PUBLIC_API_URL=${BASE_URL}
    └── .env.production         # NEXT_PUBLIC_ANALYTICS=true
```

Running `hush run -e production` from `apps/web/`:
- Root resolves: `BASE_URL=https://prod.api.example.com` (production override)
- Subdirectory merges: `.env` + `.env.production`
- Final result: `NEXT_PUBLIC_API_URL=https://prod.api.example.com`, `NEXT_PUBLIC_ANALYTICS=true`

### 3. Local templates support full environment-specific variants

**Decision**: Yes, subdirectories follow standard dotenv conventions.

```
apps/web/
├── .env                 # Base template (always loaded)
├── .env.development     # Dev-specific (loaded with -e development)
├── .env.production      # Prod-specific (loaded with -e production)
└── .env.local           # Personal overrides (gitignored, always loaded last)
```

**Merge order** (later wins):
1. `.env` (base)
2. `.env.{environment}` (environment-specific)
3. `.env.local` (personal overrides)

### 4. No nested subdirectory resolution

**Decision**: Flatten it. Only Project Root + Current Directory.

Do **not** try to merge `root/.env` + `apps/.env` + `apps/web/.env`. This creates debugging nightmares ("where did this value come from?").

If `apps/web` needs variables, it defines them in `apps/web/.env`. Period.

**Rationale**: 
- Predictable behavior over clever behavior
- Easy to debug with `hush template`
- Matches developer expectations from other tools

---

## Summary

| Feature | Model | Benefit |
|---------|-------|---------|
| **Current** | Push (root → subdirs) | Simple for small projects |
| **Proposed** | Pull (subdirs ← root) | Scalable, no duplication, local control |

| Capability | Current | Proposed |
|------------|---------|----------|
| Prefix aliasing | Manual duplication | `${VAR}` expansion |
| String composition | Not possible | `${API_URL}/v1` |
| Per-subdir customization | Via root config | Via local template |
| Least Privilege | Manual exclusion | Automatic (template = allowlist) |
| Audit trail | Check root config | `hush expansions` shows all |

**Bottom line**: This proposal transforms Hush from a "secrets broadcaster" into a "secrets API" that subdirectories can query and transform as needed.

---

## Appendix: Real-World Use Cases

### Use Case 1: Monorepo with Multiple Frontends

```
monorepo/
├── .env.encrypted          # API_URL, SUPABASE_URL, etc.
├── apps/
│   ├── web/.env            # NEXT_PUBLIC_API_URL=${API_URL}
│   ├── mobile/.env         # EXPO_PUBLIC_API_URL=${API_URL}
│   └── storybook/.env      # STORYBOOK_API_URL=${API_URL}
```

One root secret, three different prefixes. Zero duplication.

### Use Case 2: Multi-Region Deployment

```
monorepo/
├── .env.encrypted          # BASE_API_URL=https://api.example.com
├── deploy/
│   ├── us-east/.env        # API_URL=${BASE_API_URL}/us-east
│   ├── eu-west/.env        # API_URL=${BASE_API_URL}/eu-west
│   └── ap-south/.env       # API_URL=${BASE_API_URL}/ap-south
```

Same base URL, region-specific endpoints.

### Use Case 3: Environment-Specific Templates (Full Example)

This example shows how `-e production` affects both root and subdirectory:

```
monorepo/
├── .env.encrypted              # API_URL=https://dev.api.example.com
├── .env.production.encrypted   # API_URL=https://prod.api.example.com
│
└── apps/web/
    ├── .env                    # NEXT_PUBLIC_API_URL=${API_URL}
    │                           # NEXT_PUBLIC_DEBUG=true
    └── .env.production         # NEXT_PUBLIC_DEBUG=false
                                # NEXT_PUBLIC_ANALYTICS_ID=UA-PROD-123
```

**Running `hush run -- npm start`** (development):
```bash
NEXT_PUBLIC_API_URL=https://dev.api.example.com  # from root .env
NEXT_PUBLIC_DEBUG=true                            # from local .env
```

**Running `hush run -e production -- npm start`**:
```bash
NEXT_PUBLIC_API_URL=https://prod.api.example.com  # from root .env.production
NEXT_PUBLIC_DEBUG=false                           # overridden by local .env.production
NEXT_PUBLIC_ANALYTICS_ID=UA-PROD-123              # added by local .env.production
```

### Use Case 4: Accessing System Environment Variables

```bash
# apps/ci-runner/.env
NODE_ENV=${env:NODE_ENV}          # Pull from system env
CI=${env:CI}                      # Pull from system env  
DATABASE_URL=${DATABASE_URL}      # Pull from root secrets
BUILD_NUMBER=${env:BUILD_NUMBER}  # Pull from CI system
```

The `${env:VAR}` syntax explicitly opts into system environment resolution.
