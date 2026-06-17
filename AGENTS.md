# Hush

AI-native secrets manager. This file is the repo-local operating contract, not a full handbook.

## Mission

- Hush is the encrypted secrets manager for AI-first workflows.
- Code, docs, and release behavior must stay aligned.

## Structure

- `hush-cli/` — CLI implementation
- `docs/` — Starlight documentation site
- `.forgejo/workflows/` — CI / release automation

## Non-Negotiables

1. No interactive-only scripts.
2. No secrets in commits.
3. No `as any`, `@ts-ignore`, or `@ts-expect-error`.
4. Tests must pass before commits.
5. Build must succeed before releases.
6. CLI behavior, AI skill docs, and user docs must stay in sync.

## CLI Change Contract

When changing a CLI command, update all three in the same change:

- implementation in `hush-cli/src/commands/`
- AI skill docs generated from `hush-cli/src/commands/skill.ts`
- user docs in `docs/src/content/docs/reference/commands.mdx`

## Architecture Rules

- Commands take `ctx: HushContext` and should use DI rather than global mocks.
- Prefer `mockContext` over global fs/process mocking in tests.

## Release / Git Rules

- Default flow is branch + PR unless explicitly told to land directly on `main`.
- If pushing to `main`, always pull/rebase first because release automation can advance remote history.
- Use conventional commits.
- Major behavior changes need migration docs in `docs/src/content/docs/migrations/`.

## Keys / Secrets

- Hush uses per-project local age keys. It must not invoke 1Password or the `op` CLI.
- Local key path pattern: `~/.config/sops/age/keys/{project}.txt`.
- CI uses `SOPS_AGE_KEY` as the private key secret.
- Load `hush-secrets` for procedure-heavy key and secret operations.

## Docs / Wiki

- Read `.llm/wiki/CONTEXT.md` before touching code.
- Update the wiki when architecture, commands, or sharp edges change.
- Keep AGENTS concise; long command/reference/tutorial content belongs in docs or skills.

## Keep Out Of This File

- No giant commit/reference handbooks.
- No long key-management tutorials.
- No full release workflow prose that belongs in docs/CI docs.
- No duplicated quick-reference tables already covered by README/docs.
