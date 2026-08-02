# Hush — Design

## Identity
Hush is the AI-native secrets manager: an encrypted-at-rest secrets CLI (SOPS/age)
built so an AI coding agent can run, inspect, and set configuration without ever
seeing plaintext values. The name is literal and the shipped hero art already says
it: a key (the age/SOPS encryption key, the thing that grants access) next to a
hand making the "finger to lips" hush gesture (the thing that withholds it). The
feeling its visuals carry is calm, exact, and quietly confident — a locksmith's
tool, not a startup dashboard. Dark, precise, a little bit secretive; never loud,
never playful, never soft-SaaS.

## Icon
The mark is a single key — the object Hush's own encryption model revolves
around (age keys, SOPS keys, per-project local key files). A key reads instantly
at any size, ties directly to what the tool does, and needs no wordmark. It must
never become: a padlock (generic security-vendor cliché), a shield (generic
security-vendor cliché), an eye (surveillance connotation, wrong message for a
tool whose whole point is that nothing is watched), or a literal human hand/finger
(reads as clipart at icon size, only works in the wide hero composition).

## Palette
- Primary `#7C3AED` (deep violet) — the neon-violet glow of the key in the
  shipped hero art; already the project's visual signature, reads as precise and
  a little mysterious rather than corporate.
- Accent `#06B6D4` (cyan) — the second glow color in the hero (the hush-hand /
  waveform), used for a single rim-light or highlight, never as a fill on its own.
- Neutral `#0F172A` (near-black ink) — the hero's background; secrets living in
  the dark is the whole point, so the mark sits on near-black, not white.

## Anti-goals
- Not the generic purple-AI-SaaS gradient blob look, and not `#A855F7` as a
  reflexive default accent — the violet here comes from the shipped hero art,
  not a template.
- Not a padlock or shield icon — those are undifferentiated security-vendor
  clipart and say nothing about the key-based architecture.
- Not a literal human hand or eye — creepy/surveillance-adjacent, and it is the
  opposite of what "nothing is watched" is supposed to communicate.
- Not bright/cheerful/pastel — Hush is a quiet, exact, terminal-native tool, not
  a consumer app.
- No onscreen text, letters, or logotype baked into the icon or cover art.

## Source of truth
- Status: Active
- Last refreshed: 2026-07-09
- Primary product surfaces: Hush CLI, shell completion, generated AI skill, command reference, CI/release automation
- Evidence reviewed: `AGENTS.md`, `.llm/wiki/CONTEXT.md`, `hush-cli/src/cli.ts`, `hush-cli/src/commands/`, `docs/src/content/docs/reference/commands.mdx`, and `docs/rfcs/RFC-TARGET-AWARE-SET.md`

## Brand
- Personality: calm, exact, security-conscious, and automation-native
- Trust signals: explicit requested and resolved scope, deterministic output, no secret values in diagnostics, fail-closed mutations
- Avoid: silent fallback, ambiguous success, decorative prose in machine output, undocumented option behavior

## Product goals
- Goals: make every operation discoverable, scriptable, safely retryable, and easy for an agent to diagnose
- Non-goals: guessing secret values, guessing mutation destinations, or preserving unsafe legacy ambiguity
- Success signals: every command has accurate help; automation can request JSON; errors identify the rejected input and safe next action; docs, completion, skill guidance, and runtime agree

## Personas and jobs
- Primary personas: developers, CI jobs, deployment automation, and coding agents
- User jobs: inspect, resolve, validate, set, edit, copy, move, delete, import, materialize, push, migrate, and diagnose encrypted configuration
- Key contexts of use: non-interactive shells, JSON-consuming agents, local terminals, and CI with partial authority

## Information architecture
- Primary navigation: `hush --help`, `hush <command> --help`, and command groups with explicit subcommands
- Core routes/screens: command help, human result output, JSON result output, and JSON error output
- Content hierarchy: outcome first, resolved scope second, warnings/remediation third, optional detail last

## Design principles
- One command contract: parsing, help, completion, generated skill, tests, and docs derive from or validate against the same option authority.
- Stdout is data; stderr is diagnostics. JSON mode emits one valid JSON document and no ANSI decoration.
- Mutations expose requested and resolved scope and fail before reading secret input when scope or authority is invalid.
- Safe correction is limited to unambiguous spelling suggestions and aliases; Hush never autocorrects a destination, identity, target, file, or destructive operation.
- Human output is concise and line-oriented; JSON output uses stable named fields rather than formatted prose.
- Tradeoff: compatibility may be broken when required to replace silently ignored authority with explicit failure.

## Visual language
- Color: ANSI only in interactive human output; never in JSON or redirected output
- Typography: shell-native monospace; no layout dependent on terminal width for machine-significant data
- Spacing/layout rhythm: one outcome per line, blank lines only between semantic sections
- Shape/radius/elevation: not applicable
- Motion: not applicable
- Imagery/iconography: no emoji or symbols required for parsing

## Components
- Existing components to reuse: command option authority, `HushContext`, audit events, JSON serializers, completion generators
- New/changed components: shared result/error envelope, command-specific help renderer, suggestion helper, mutation scope record
- Variants and states: human/JSON; success/warning/error; dry-run/applied; interactive/non-interactive
- Token/component ownership: CLI runtime owns schemas; docs/completion/skill tests enforce parity

## Accessibility
- Target standard: usable without color and without an interactive TTY
- Keyboard/focus behavior: prompts support cancellation and restore terminal state
- Contrast/readability: color supplements text; it never carries meaning alone
- Screen-reader semantics: line-oriented text with outcome-first wording
- Reduced motion and sensory considerations: no animation or terminal spinners in deterministic output

## Responsive behavior
- Supported breakpoints/devices: narrow terminals through CI logs
- Layout adaptations: avoid fixed-width tables in default output; JSON is width-independent
- Touch/hover differences: not applicable

## Interaction states
- Loading: quiet by default; verbose progress goes to stderr
- Empty: success with an explicit empty collection in JSON and a clear human message
- Error: stable code, message, command, rejected input when applicable, and actionable suggestions
- Success: command, action, requested scope, resolved scope, changed state, and warnings where applicable
- Disabled: rejected as unsupported with the closest safe alternative
- Offline/slow network: distinguish local validation from unavailable provider checks

## Content voice
- Tone: direct, factual, and non-judgmental
- Terminology: use `target`, `bundle`, `file`, `identity`, `repository`, and `scope` consistently
- Microcopy rules: name the command and bad input; state whether anything changed; show one copy-pastable next command when safe

## Implementation constraints
- Framework/styling system: TypeScript CLI running under Node/Bun
- Design-token constraints: no new runtime dependencies for formatting or suggestions
- Performance constraints: option/help validation must not decrypt repositories or contact providers
- Compatibility constraints: Node 24; JSON output must remain valid when stdout is piped
- Test/screenshot expectations: parser/help/completion/docs parity tests, JSON parse tests, no-mutation failure tests, stdout/stderr separation tests

## Machine-output contract
- JSON output uses envelope version `1`: success is `{ version, ok: true, command, data }`; failure is `{ version, ok: false, command, error }`.
- Successful JSON is the only document written to stdout. Structured failures are the only document written to stderr.
- Error objects contain a stable `code` and `message`, with optional `rejectedInput`, `suggestion`, and `details` fields.
- `hush run --json` is intentionally unsupported while child processes inherit stdout. Use `hush materialize --json` when a single machine-readable document is required.

## Open questions
- [ ] Version the JSON envelope before the next public release if external consumers already depend on undocumented shapes.
- [ ] Decide whether JSON Lines is needed for future streaming provider operations; default output remains one JSON document.
