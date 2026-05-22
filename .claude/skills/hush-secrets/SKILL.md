---
name: hush-secrets
description: Manage secrets safely using Hush CLI. Use when working with .env files, environment variables, secrets, API keys, database URLs, credentials, or configuration. NEVER read .env files directly - always use hush commands instead to prevent exposing secrets to the LLM.
allowed-tools: Bash(hush:*), Bash(npx hush:*), Bash(brew:*), Bash(npm:*), Bash(pnpm:*), Bash(age-keygen:*), Read, Grep, Glob, Write
---

# Hush - AI-Native Secrets Management

Hush encrypts secrets so they can be committed to git, and provides AI-safe commands that let you work with secrets without exposing values to LLMs.

## CRITICAL RULES

### NEVER do these things:
- Read `.env`, `.env.*`, `.env.local`, or `.dev.vars` files directly
- Use `cat`, `grep`, `head`, `tail`, `less`, `more` on env files
- Echo or print environment variable values like `echo $SECRET`
- Include actual secret values in your responses
- Write secrets directly to `.env` files

### ALWAYS use Hush commands instead:
- `npx hush inspect` to see what variables exist (values are masked)
- `npx hush has <KEY>` to check if a specific variable is set
- `npx hush set` to add or modify secrets (opens secure editor)
- `npx hush status` to view configuration

## Quick Check: Is Hush Set Up?

Run this first to check if Hush is configured:

```bash
npx hush status
```

**If this fails or shows errors**, see [SETUP.md](SETUP.md) for first-time setup instructions.

---

## Daily Usage (AI-Safe Commands)

### Run programs with secrets (PREFERRED)

```bash
npx hush run -- npm start           # Development
npx hush run -e prod -- npm build   # Production
npx hush run -t api -- wrangler dev # Filter for specific target
```

Secrets are decrypted to memory only - never written to disk.

### See what variables exist

```bash
npx hush inspect                    # Development
npx hush inspect -e production      # Production
```

Output shows **masked values** - safe for AI to read:

```
Secrets for development:

  DATABASE_URL      = post****************... (45 chars)
  STRIPE_SECRET_KEY = sk_t****************... (32 chars)
  API_KEY           = (not set)

Total: 3 variables
```

### Check if a specific variable exists

```bash
npx hush has DATABASE_URL           # Verbose output
npx hush has API_KEY -q             # Quiet: exit code only (0=set, 1=missing)
```

### View configuration

```bash
npx hush status
```

### Set a secret (AI-agent friendly)

```bash
npx hush set API_KEY --gui          # Opens macOS dialog for input
npx hush set DATABASE_URL --gui     # User enters value in popup
```

The `--gui` flag opens a native macOS dialog - perfect for AI agents that can't interact with TTY prompts.

### Edit all secrets in editor

```bash
npx hush edit                       # Opens $EDITOR
```

---

## Common Workflows

### "What secrets are configured?"
```bash
npx hush inspect
```

### "Is DATABASE_URL set?"
```bash
npx hush has DATABASE_URL
```

### "Add a new secret" (as AI agent)
```bash
npx hush set NEW_SECRET_KEY --gui   # Opens dialog for user to enter value
npx hush inspect                    # Verify it was set
```

### "Run the app with secrets"
```bash
npx hush run -- npm start           # Secrets injected to memory only
```

### "Check all required secrets"
```bash
npx hush has DATABASE_URL -q && npx hush has API_KEY -q && echo "All configured" || echo "Some missing"
```

### "Set up keys for a new developer"
```bash
npx hush keys setup                 # Verifies local key or pulls from team storage
```

---

## Files You Must NOT Read

These contain plaintext secrets - NEVER read them:
- `.env`, `.env.local`, `.env.development`, `.env.production`
- `.dev.vars`
- Any `*/.env` or `*/.env.*` files

## Files That Are Safe to Read

- `hush.yaml` - Configuration (no secrets)
- `.sops.yaml` - SOPS config (public key only)
- `.env.encrypted`, `.env.*.encrypted` - Encrypted files

---

## Additional Resources

- **First-time setup**: [SETUP.md](SETUP.md)
- **Command reference**: [REFERENCE.md](REFERENCE.md)
- **Workflow examples**: [examples/workflows.md](examples/workflows.md)
