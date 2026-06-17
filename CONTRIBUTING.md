# Contributing to Hush

This guide covers how to build, test, and contribute to Hush.

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
- [Bun](https://bun.sh) (used for all scripts and package management)
- For docs deployment: Cloudflare account with Wrangler CLI

## Development Setup

```bash
# Clone the repository
git clone https://git.ch5.me/ch5/hush.git
cd hush

# Install dependencies
bun install

# Build everything
bun run build

# Run tests
bun run test
```

## Commands

### Root (Monorepo)

| Command | Description |
|---------|-------------|
| `bun run build` | Build all packages |
| `bun run test` | Run all tests |
| `bun run dev` | Start dev mode (all packages) |
| `bun run type-check` | TypeScript type checking |

### CLI (`hush-cli/`)

| Command | Description |
|---------|-------------|
| `bun run cli:build` | Build CLI only |
| `bun run cli:test` | Test CLI only |
| `bun run --filter @chriscode/hush build` | Alternative build |
| `bun run --filter @chriscode/hush test` | Alternative test |

### Docs (`docs/`)

| Command | Description |
|---------|-------------|
| `bun run docs:dev` | Start docs dev server |
| `bun run docs:build` | Build docs for production |
| `bun run docs:preview` | Preview built docs locally |
| `bun run docs:deploy` | Build and deploy to Cloudflare Pages |

## Building

### CLI

```bash
bun run cli:build
```

This compiles TypeScript to `dist/`.

### Docs

```bash
cd docs && bun x astro build
```

This generates a static site in `docs/dist/`.

## Testing

```bash
# Run all tests
bun run test

# Run CLI tests only
bun run cli:test

# Run tests in watch mode
cd hush-cli && bun x vitest
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
bun run docs:deploy
```

## Publishing to npm

Releases are automated by CI on push to `main`. When a conventional commit lands on `main`, CI:

1. Determines the version bump (patch/minor/major) from commit messages
2. Updates `hush-cli/package.json` and creates a git tag
3. Publishes `@chriscode/hush` to npm with provenance
4. Creates a Forgejo Release with changelog notes

**Contributors just write conventional commits.** You do not need to bump versions or publish manually.

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
- Conventional commit messages

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and add tests
4. Run `bun run build && bun run test`
5. Commit with a conventional message (e.g. `feat: add new option`)
6. Push and create a PR

## Release Checklist

- [ ] All tests pass (`bun run test`)
- [ ] Build succeeds (`bun run build`)
- [ ] CHANGELOG updated if applicable
- [ ] Docs updated for new features
- [ ] Committed and pushed with conventional commit message
