# Contributing to Hush

This guide covers how to build, test, deploy, and publish Hush.

## Project Structure

```
hush/
├── hush-cli/              # CLI package (@chriscode/hush)
│   ├── src/               # TypeScript source
│   ├── bin/               # CLI entry point
│   ├── tests/             # Vitest tests
│   └── dist/              # Compiled output
├── docs/                  # Documentation site (Astro Starlight)
│   ├── src/content/docs/  # Markdown/MDX content
│   └── dist/              # Built static site
├── .claude/skills/        # Claude Code skill
└── package.json           # Monorepo root
```

## Prerequisites

- Node.js >= 18
- pnpm 9.x (`npm install -g pnpm`)
- For docs deployment: Cloudflare account with Wrangler CLI

## Development Setup

```bash
# Clone the repository
git clone https://github.com/hassoncs/hush.git
cd hush

# Install dependencies
pnpm install

# Build everything
pnpm build

# Run tests
pnpm test
```

## Commands

### Root (Monorepo)

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm dev` | Start dev mode (all packages) |
| `pnpm type-check` | TypeScript type checking |

### CLI (`hush-cli/`)

| Command | Description |
|---------|-------------|
| `pnpm cli:build` | Build CLI only |
| `pnpm cli:test` | Test CLI only |
| `pnpm --filter @chriscode/hush build` | Alternative build |
| `pnpm --filter @chriscode/hush test` | Alternative test |

### Docs (`docs/`)

| Command | Description |
|---------|-------------|
| `pnpm docs:dev` | Start docs dev server |
| `pnpm docs:build` | Build docs for production |
| `pnpm docs:preview` | Preview built docs locally |
| `pnpm deploy` | Build and deploy to Cloudflare Pages |

## Building

### CLI

```bash
cd hush-cli
pnpm build
```

This compiles TypeScript to `dist/` and runs tests.

### Docs

```bash
cd docs
pnpm build
```

This generates a static site in `docs/dist/`.

## Testing

```bash
# Run all tests
pnpm test

# Run CLI tests only
pnpm cli:test

# Run tests in watch mode
cd hush-cli && pnpm test:watch
```

Current test coverage: 95+ tests covering:
- Environment parsing and interpolation
- Variable filtering (include/exclude patterns)
- Output formats (dotenv, wrangler, json, shell, yaml)
- Configuration loading
- Drift detection (hush check)

## Deploying Docs

Docs are hosted on Cloudflare Pages.

```bash
# Build and deploy
pnpm deploy
```

This runs:
1. `pnpm --filter docs build` - Builds Astro site
2. `pnpm --filter docs deploy` - Deploys via `wrangler pages deploy`

### First-time setup

1. Install Wrangler: `npm install -g wrangler`
2. Login: `wrangler login`
3. Create a Pages project in Cloudflare dashboard (or it will be created on first deploy)

## Publishing to npm

The CLI is published to npm as `@chriscode/hush`.

```bash
# Build and verify the shipped package entrypoint first
bun run cli:build
bun run --filter @chriscode/hush verify:pack-install

# Then publish from hush-cli/
cd hush-cli
npm publish --access public
```

This flow verifies three things before publish:
1. `bin/hush.js` still marks the CLI as an entrypoint
2. `npm pack` contains the expected `bin/hush.js`
3. A fresh install prints output for `hush --version` and `hush --help`

**Note:** Publishing requires npm authentication with 2FA.

### Version bumping

Edit `hush-cli/package.json`:
```json
{
  "version": "2.3.0"  // Bump this
}
```

Then commit and publish:
```bash
git add hush-cli/package.json
git commit -m "chore: bump version to 2.3.0"
bun run cli:build
bun run --filter @chriscode/hush verify:pack-install
cd hush-cli
npm publish --access public
```

## Claude Code Skill

The skill at `.claude/skills/hush-secrets/` is self-contained and can be:

1. **Copied to projects** - Users copy the folder to their `.claude/skills/`
2. **Installed personally** - Copy to `~/.claude/skills/` for all projects
3. **Distributed via plugin** - Can be packaged as a Claude Code plugin

### Skill files

| File | Purpose |
|------|---------|
| `SKILL.md` | Core instructions (always loaded) |
| `SETUP.md` | First-time setup (progressive disclosure) |
| `REFERENCE.md` | Command reference |
| `examples/workflows.md` | Workflow examples |

## Code Style

- TypeScript with strict mode
- No `as any` or `@ts-ignore`
- Tests for all new features
- Descriptive commit messages

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and add tests
4. Run `pnpm build && pnpm test`
5. Commit with a descriptive message
6. Push and create a PR

## Release Checklist

- [ ] All tests pass (`pnpm test`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Version bumped in `hush-cli/package.json`
- [ ] CHANGELOG updated (if applicable)
- [ ] Docs updated for new features
- [ ] Committed and pushed
- [ ] Docs deployed (`pnpm deploy`)
- [ ] Published to npm (`pnpm release`)
