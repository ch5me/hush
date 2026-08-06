---
type: application-architecture
title: Documentation Site
description: "docs/ is a private Astro 7 and Starlight workspace that builds the Hush user site at https://hush.ch5.me and deploys dist to Cloudflare Pages. Its content is separate from the CLI runtime but must stay synchronized with command behavior."
tags: [docs, astro, starlight, cloudflare-pages]
---

# Documentation Site

`docs/astro.config.mjs` is the composition root. It sets the site URL, Starlight title/description, custom CSS (`src/styles/theme.css` and `src/styles/terminal.css`), and sidebar navigation for getting started, guides, and reference. `docs/src/content.config.ts` registers the Starlight `docs` collection with `docsLoader()` and `docsSchema()`.

Run `bun run docs:dev`, `bun run docs:build`, `bun run docs:preview`, or `bun run docs:deploy` from the repository root. The workspace scripts are `astro dev`, `bun astro build`, `astro preview`, and `wrangler pages deploy ./dist`. `docs/wrangler.toml` names the Pages project `hush-docs`, sets compatibility date `2025-01-14`, and uses `./dist` as the build output.

## Content ownership

- `src/content/docs/getting-started.mdx` and `index.mdx`: onboarding and product entrypoints.
- `src/content/docs/guides/`: configuration, monorepos, AI-native use, agent automation, threat model, and related workflows.
- `src/content/docs/reference/`: commands, files, formats, and vendor catalog; command behavior must track `hush-cli/src/commands/`.
- `src/content/docs/migrations/`: user-facing migration procedures; distinguish supported bridges from future specs.
- `docs/rfcs/` and `docs/bugs/`: engineering proposals and issue records, useful for context but not automatically shipped behavior.
- Root planning/specification documents such as `docs/HUSH_V3_SPEC.md` are not equivalent to the runtime source of truth.
- `src/assets/` and `src/styles/`: visual assets and site styling; generated `dist/` is build output and not a concept source.

## Sync boundary

When a CLI command changes, update its implementation, skill packaging, and `docs/src/content/docs/reference/commands.mdx` in the same change per `AGENTS.md`. CI's `docs-lint` rejects bare `npx hush`; always use the scoped `npx @chriscode/hush`. A docs build proves Astro content/config validity but does not prove CLI behavior; pair it with the narrow CLI test.
