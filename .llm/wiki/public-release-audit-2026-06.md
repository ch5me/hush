# Public-Release Readiness Audit — June 2026

> Pre-publication adversarial audit of Hush, anticipating public (HN-grade) scrutiny.
> Method: 52-agent swarm across 9 dimensions (crypto/security, secret-leak channels, CLI UX,
> docs drift, public hygiene, git history, agent ergonomics, tests/CI, red-team positioning),
> every high/critical finding adversarially re-verified against source, then the top findings
> independently re-confirmed by hand. 38 high/critical findings survived verification, 4 were
> refuted, ~67 medium/low collected, plus 6 gaps from a completeness pass.

**Verdict: do not promote yet.** The core thesis holds — the agent loop
(`bootstrap → set → has → run`) was live-verified end-to-end, never exposes plaintext,
delegates all crypto to sops/age, and is genuinely better than competitors' agent stories.
But there is a small set of trust-destroying bugs and claims that a security-literate
audience will find within hours. All are cheap to fix relative to the reputational cost.

---

## P0 — Trust-destroying. Fix before any announcement.

### 1. `hush list` prints plaintext secrets, unmasked, with no guard
`hush-cli/src/commands/list.ts:16-18` prints every resolved value (`KEY=value`, truncated
at 50 chars). Meanwhile `core/mask.ts` exists, is exported, and is wired into **nothing**.
Worse: the shipped AI skill frontmatter (`skill.ts:10`) allowlists `Bash(hush:*)`, which
grants the agent `hush list` — so the headline claim "AI can help without seeing values"
is defeated by a command the skill itself permission-grants.
**Fix:** mask by default in `list` (use the existing `maskValue`), add `--reveal` for
explicit plaintext; narrow the skill allowlist to safe subcommands (`hush inspect`,
`hush has`, `hush set`, `hush run`, `hush config show`…).

### 2. `hush run -e production` is a silent no-op
`run.ts:20` destructures `{ store, cwd, target, command }` — `env` exists in `RunOptions`
but is never read. Live-proved: `hush run -e production -- …` injects the **default**
target's secrets while looking like a production run. A secrets tool silently ignoring an
environment selector is the single worst bug class for launch day.
**Fix:** hard-error (`-e is not supported; use --target`) or wire it. Same release should
fix the general cause: the hand-rolled parser **silently swallows all unknown flags**
(`cli.ts`), so documented flags like `--format shell-export`, `--compact-json`, `--only`,
`--show-length` are dead — SKILL.md and commands.mdx teach flags the binary ignores.
Reject unknown flags loudly; wire or delete the documented ones.

### 3. Docs tell users to run `npx hush` — which executes someone else's package
README has 16 `npx hush` usages; docs ~60 more. The package is scoped
(`@chriscode/hush`). Verified live: registry `hush` is an unrelated 2014 package
(`hush@0.2.3`, "Redacts text…") that **also ships a `hush` bin**. A fresh user
copy-pasting the quick start npx-executes a stranger's code — fatal optics for a
secrets manager.
**Fix:** replace every `npx hush` with `npx @chriscode/hush` (or instruct install-first +
bare `hush`); add a CI grep lint for `npx hush[^-@]`.

### 4. Shell-injection family: secrets and repo-controlled paths interpolated into shell strings
All confirmed in source; one refactor fixes the class:
- `core/sops.ts:272-279` — `execSync(\`sops … --decrypt "${filePath}"\`)`. execSync always
  spawns a shell; `"${...}"` does not neutralize `$()`, backticks, or embedded `"`.
  Paths come from manifest/file-index discovery (`normalizeHushPath` imposes no charset
  allowlist), so a **hostile cloned repo** can achieve command execution on first
  `hush run`/`list`/`resolve`.
- `core/sops.ts:426-433` (`setKey`) — same, plus the shell redirect `> "${filePath}"`
  **truncates the encrypted file before sops runs**: any failure destroys the target file.
- `lib/age.ts:39` — `execSync(\`echo "${privateKey}" | age-keygen -y\`)`: the **age private
  key** lands in the process table (`/proc/<pid>/cmdline` is world-readable) and is
  injectable.
- `commands/set.ts:71,140,147` — key name interpolated into osascript/zenity/kdialog
  shell strings.
- `v3-command-helpers.ts:437` (`openEditor`) — `$EDITOR` + path through `/bin/bash`.
- `core/sops.ts:378-386` (`edit`) — args array but `shell:true`, re-tokenized by sh.
**Fix:** spawnSync with arg arrays everywhere, `shell:false`; pipe the private key via
stdin; capture stdout and write files from Node instead of shell redirects; optionally
tighten `normalizeHushPath` to `[A-Za-z0-9._/-]`.

### 5. `delete-key` is documented everywhere but not registered
`commands/delete-key.ts` is complete, tested, audit-logged — and never imported in
`cli.ts`. README and commands.mdx document it; running it prints `Unknown command`.
**Fix:** register the case in the dispatch (one-line class of fix), or pull it from docs.

### 6. Materialize writes plaintext into the repo with no gitignore protection
`hush bootstrap` never touches `.gitignore` (migrate does — bootstrap doesn't).
`hush materialize` then writes plaintext to `.hush-materialized/` — and the TOCTOU in
`v3/temp.ts:77-84` creates the file umask-default (0644) **before** chmodding to 0600.
`hush check` doesn't detect materialized artifacts either. Following SKILL.md's own
materialize example leaves a world-readable plaintext env file in an un-ignored repo dir.
**Fix:** bootstrap writes `.hush-materialized/` into `.gitignore`; pass `{mode: 0o600}` to
`writeFileSync` (drop post-write chmod); teach `check` to flag the directory; prefer the
ephemeral `run --` form in SKILL.md examples.

### 7. Undisclosed daily phone-home with no opt-out, child inherits the private key env
`cli.ts:701` triggers `checkForUpdate` on almost every command; `version-check.ts:79-83`
spawns a detached `node -e` child that HTTPS-GETs the npm registry daily. No
`HUSH_NO_UPDATE_CHECK`, no `CI` respect, documented nowhere — and the child inherits
`{...process.env}` including `SOPS_AGE_KEY` if set. "Secrets manager makes silent network
calls from hidden background processes" is a guaranteed top comment.
**Fix:** strip the env to `{PATH, HOME}`, respect `HUSH_NO_UPDATE_CHECK=1` / `CI` /
`NO_UPDATE_NOTIFIER`, and document the check under a Privacy heading.

### 8. No SECURITY.md, no honest threat model, and the headline claim overpromises
- No SECURITY.md / disclosure path anywhere — first question for any security tool.
- The only threat model (`docs/HUSH_V3_SPEC.md:327-345`) treats AI as a benign reader.
  It never models the actual novel risk: a prompt-injected agent that holds the CLI.
  And the claim "AI helps without ever seeing values" is trivially falsified by
  `hush run -- env` — the agent controls `<command>`.
**Fix:** SECURITY.md (contact, scope, supported versions, "unaudited single-maintainer,
crypto delegated to audited sops/age" honesty). Add a threat-model docs page that states
plainly: Hush removes *standing plaintext* and gives a *narrower, auditable* surface; a
runtime that executes arbitrary commands can always exfiltrate — that limitation stated
up front converts the harshest critique into credibility. Consider a least-privilege
agent mode (e.g. `HUSH_AGENT=1` denying `list --reveal`/`decrypt --force`/`edit`).

---

## P1 — Fix before launch week.

**Security/robustness**
- `hush set KEY VALUE` puts the secret in the process table and shell history with no
  warning (`cli.ts:509-517`). Warn, and steer to prompt/stdin/`--gui`.
- `--gui` on Linux/Windows echoes the typed secret on screen: `zenity --entry` (not
  `--password`), `kdialog --inputbox`, WinForms TextBox without `UseSystemPasswordChar`
  (`set.ts:103-147`). macOS is correct. Cheap fix, core to the thesis.
- CI supply chain: Forgejo Actions pinned to floating tags not SHAs, in a workflow holding
  `id-token: write` npm publish rights; sops/age binaries curl'd with no checksum
  verification in all three jobs (`release.yml`). Pin SHAs + `sha256sum -c`.
- Tests: encrypt test never asserts plaintext is **absent** from ciphertext
  (`tests/core/sops.test.ts:83`); `lib/age.ts` has zero real-binary tests (all mocked);
  16/322 tests currently fail in `tests/migrate.test.ts` — fix before release; one
  topology test hangs 5s on missing `--format` validation (validate args before I/O).

**Credibility/identity**
- Split repo identity: `hush-cli/package.json` → `github.com/ch5me/hush`; root
  package.json + astro config + docs hero → `github.com/hassoncs/hush`. Pick one;
  for a security tool this reads as typosquatting. Align package.json (repository,
  homepage, bugs), README badges, astro `social.github`.
- npm description is the v2-era tagline ("SOPS-based secrets management for monorepos"),
  contradicting the AI-native pitch. Update description + add ai/agents/llm keywords.
- README has no "Why not just sops / dotenvx / direnv+age / Doppler?" section — and
  getting-started lists sops, age, **and direnv** as prerequisites, inviting "so it's a
  Node wrapper over the stack I'd use anyway." Lead with the genuinely differentiated
  parts: per-file reader ACLs, identity/bundle/target resolver, provenance/trace,
  `--gui` value isolation, AI skill packaging. Honest comparison table.
- CONTRIBUTING.md: documents pnpm (everything is bun) and a manual `npm publish` flow
  that CI already automates with provenance. Rewrite both sections.
- `docs/migration/` — 30+ internal working notes with `/Users/hassoncs/...` paths,
  internal project names (firefly, fitbot, ghost-browser, bottown), age public keys.
  Not in the published site build, but visible to anyone who clones. Remove from the
  public tree (decide separately whether history scrub via git-filter-repo is worth it;
  commit `c105f99` "firefly-cloud" and `hush/CH5COMPAC4C-*` branches are the other
  history leaks — delete stale remote branches at minimum).
- Missing-binary errors are macOS/Windows-only ("brew install sops … scoop …"), and the
  missing-`age` error has no guidance at all (`sops.ts:268,305`, `bootstrap.ts:44`).
  HN is disproportionately Linux. One `binaryMissingError(name)` helper, per-OS lines,
  point at `hush doctor`.

---

## P2 — Polish (post-launch acceptable, pre-launch nice).

- "v3" jargon leaks into 13+ user-facing strings ("Checking v3 repository integrity…",
  "Repository: v3"). Internal format version ≠ user vocabulary.
- Bootstrap "Next steps" sends new users to identity management instead of
  `set your first secret → run your app → inspect`.
- `inspect` docs say "masked values"; reality is `[redacted]`-or-full-plaintext gated on a
  `sensitive` flag docs never mention; `core/mask.ts` is dead code (see P0-1 — wiring it
  into `list` resolves both). When wired, drop prefix+exact-length disclosure (current
  `maskValue` reveals first 1-4 chars + length; gate behind `--show-length`).
- `--json` missing from exactly the commands agents reach for first: `has`, `inspect`,
  `status`, `doctor`. Exit codes are already good — document them in SKILL.md.
- No shell completions for a 32-command CLI (sops/doppler/op all ship them).
- Fresh-clone story (workflow "what secrets are required but missing?") has no answer
  when the key is absent — everything including key *names* is encrypted. Add a
  committable redacted requirements artifact (`hush export-example --write` → checked-in
  `.env.example`-equivalent).
- Root clutter: move `RFC-INIT-SOPS-SETUP.md` (describes a real unfixed init bug — fix or
  track it), `RFC-UNIFIED-EXPANSION.md`, `FEATURE_GIT_HOOKS.md` out of root; delete stale
  `package-lock.json` (a leftover test install of v5.0.5) and gitignore it.
- Version fragmentation: docs recommend sops 3.8.1/age 1.1.1, CI pins 3.9.4/1.2.0, local
  brew is 3.11. One authoritative triplet in `.tool-versions`/`mise.toml`, referenced by
  both CI and docs.
- Windows: documented (scoop tab, win32 key path) but zero Windows CI. Add a runner or
  mark unsupported.
- "Append-only audit log" is a plain local file append — no hash chain, no tamper
  evidence. Downgrade wording to "local activity log" or add chaining.
- Docs site: default `hush-docs.pages.dev` subdomain; homepage `<title>` renders
  "Hush | Hush"; deploy job requires the maintainer's age key + Hush itself (fork-hostile,
  bootstrap-paradox — split docs deploy to a plain `CLOUDFLARE_API_TOKEN` workflow with PR
  previews; keep the dogfood path as optional).
- `vendor-catalog.mdx:369` uses internal `ch5.me.fitbot` example — genericize.
- Distribution expectations: npm + Node + three brew binaries vs the single static binary
  a security audience expects. Mitigation now: lead with "crypto is delegated to audited
  sops/age" as the trust point; later: bundled single-file build (bun compile).
- Coverage thresholds absent (`@vitest/coverage-v8` installed, unused). Add thresholds
  and a CI coverage step.
- `--from`/`--to` flags have four meanings across commands and duplicate help rows —
  per-command flag parsing eventually.
- CHANGELOG is two released versions behind.

---

## Refuted during verification (don't "fix" these)

- ~~CLAUDE.md/AGENTS.md duplicated~~ — CLAUDE.md is a symlink. Fine.
- ~~`hush skill` hangs in non-TTY~~ — exits 0 cleanly on EOF. Fine.
- ~~50 tests fail due to sops 3.11 temp-file rejection~~ — root cause claim wrong
  (16 real failures exist in migrate.test.ts; see P1).
- ~~Version story v2/v3/v4/v5 incoherent~~ — migration docs carry explicit
  "historical shipped migration note" disclaimers. (Still worth keeping "v3" out of CLI
  output — see P2.)

## What already holds up (lead with these when announcing)

- Crypto fully delegated to sops/age; no home-rolled primitives.
- Live-verified agent loop: `bootstrap --yes` non-interactive + self-verifying;
  `set` echoes name + length only; `has` exits 0/1/2; `run` injects via env (not argv)
  with nothing on stdout; `resolve/trace/verify-target --json` carry provenance only.
- Age keys written 0600; plaintext temp staging is 0700-dir/0600-file with cleanup.
- Persisted-plaintext `decrypt` gated behind `--force` + TTY confirmation.
- Release pipeline uses OIDC/provenance publish and verifies the packed CLI.

## Suggested execution order

1. **One PR per P0 item** (1, 2, 4 are pure code; 3 is docs-wide sed + CI lint; 5 is a
   one-liner; 6, 7 small; 8 is writing). All eight are achievable in a few focused days.
2. P1 security + identity items next; fix the 16 failing migrate tests before any release.
3. Write the threat-model page and "Why Hush" comparison — these convert criticism into
   credibility and should exist before the announcement post.
4. P2 opportunistically; none block launch.

Full machine-readable findings (all 111) from the audit run: `/tmp/hush-audit-findings.json`
(ephemeral; regenerate by re-running the audit workflow if needed).
