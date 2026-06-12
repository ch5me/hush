# HUSH_V3_SPEC

## Status

Planning document. Canonical source of truth for the future Hush v3 architecture and product shape described in this planning set.

## Canonical Source of Truth

This file is the canonical architecture and specification document for the Hush v3 planning effort.

Use this file to define the intended future architecture, system boundaries, terminology, invariants, and section ownership for follow-on writing tasks.

Do not treat existing shipped docs under `docs/src/content/docs/**` as the source of truth for this future architecture. Those files remain product documentation for shipped behavior and historical releases.

## Versioning Note

This repository already includes shipped version history that uses the label `v3`, including the docs-site page `docs/src/content/docs/migrations/v2-to-v3.mdx`.

In this planning set, `HUSH_V3` means the future architecture revision defined by these root-level planning documents under `docs/`. Until this work is implemented and shipped, the root-level planning docs are authoritative for intent, and the docs-site content remains authoritative only for already shipped product behavior.

## Planning Doc Topology

The root-level planning set is intentionally split into two canonical documents:

| File | Role | Owns | Does not own |
| --- | --- | --- | --- |
| `docs/HUSH_V3_SPEC.md` | Canonical architecture/spec | Product shape, architecture, terminology, invariants, command-level intent, open design sections, section ownership | Rollout sequencing, migration execution plan, release choreography |
| `docs/HUSH_V3_MIGRATION_STRATEGY.md` | Canonical migration plan | Adoption path, compatibility plan, migration phases, risk handling, docs handoff into shipped pages | Core architecture decisions unless explicitly delegated back to this spec |

Existing shipped docs under `docs/src/content/docs/**` stay in their current role as product docs. They may later be updated to reflect shipped outcomes, but they do not replace either root-level planning document during the planning phase.

## Section Ownership

This file owns the following sections for the planning set:

1. Vision and scope of the future Hush v3 architecture
2. Definitions and terminology used across the planning set
3. Architectural constraints and non-goals
4. Configuration model and source-of-truth boundaries
5. Command behavior intent and cross-cutting invariants
6. Data flow, runtime flow, and system boundaries
7. Outstanding architecture questions that later tasks may fill in

The migration strategy document owns rollout, compatibility, user migration, release sequencing, and conversion of planning decisions into shipped docs-site content.

## Decision-to-Section Coverage Matrix

Use this matrix to keep every locked decision assigned to an explicit section before prose is written.

| Locked decision | Destination section | Notes for later writing |
| --- | --- | --- |
| Unified encrypted config | `## Unified Encrypted Configuration Model` | Define the single source-of-truth config shape and boundary rules. |
| `sensitive` | `### Sensitive Values and Exposure Boundaries` | Define semantics and invariants, not rollout behavior. |
| File-scoped ACLs | `## Access Model`, `### File-Scoped ACLs` | Specify authorization unit and policy boundary. |
| Logical paths vs physical files | `## Configuration Topology and Addressing`, `### Logical Paths vs Physical Files` | Preserve topology framing and naming separation. |
| Roles | `## Access Model`, `### Roles` | Define role vocabulary and responsibilities. |
| Readers semantics | `## Access Model`, `### Readers Semantics` | Clarify what reader access means and does not mean. |
| Explicit active identity pointer | `## Identity and Execution Context`, `### Explicit Active Identity Pointer` | Define how active identity is selected and observed. |
| Bundle semantics | `## Bundle Model`, `### Bundle Semantics` | Define bundle composition and invariants. |
| Imports | `## Bundle Model`, `### Imports` | Define composition/import behavior inside the config model. |
| Signal-safe materialization | `## Runtime Materialization and Execution Safety`, `### Signal-Safe Materialization` | Keep focused on runtime behavior and cleanup guarantees. |
| Audit log | `## Auditability`, `### Audit Log` | Define what events and boundaries the log covers. |
| Preserved non-goals | `## Non-Goals` | Keep as a dedicated section, not scattered mentions. |
| Big-bang migration | `docs/HUSH_V3_MIGRATION_STRATEGY.md -> ## Migration Strategy`, `### Big-Bang Migration` | Migration-owned, referenced here only for boundary clarity. |
| Required workflow commands | `docs/HUSH_V3_MIGRATION_STRATEGY.md -> ## Operator Workflow and Required Commands` | Migration/adoption-owned command workflow. |

## Relationship to Shipped Docs

Shipped docs continue to serve users of the current released product.

This planning file exists so future architecture work can be developed without repurposing current docs-site pages as draft RFC material. If a planning decision later becomes shipped behavior, that decision should be translated into `docs/src/content/docs/**` as a separate documentation step.

## File Map for Later Tasks

Later doc-authoring tasks should use this map without rethinking topology:

- Put future architecture and spec decisions in `docs/HUSH_V3_SPEC.md`
- Put migration sequencing and compatibility planning in `docs/HUSH_V3_MIGRATION_STRATEGY.md`
- Leave `docs/src/content/docs/**` as shipped product docs until implementation and release work calls for user-facing updates

## Goals

Hush v3 is an encrypted-at-rest hierarchical config system with file-scoped ACLs. The primary product goal is one unified encrypted config that can hold secret and non-secret application configuration together without introducing any plaintext config tier.

That model gives Hush one control plane for structure, access, runtime materialization, and auditability. Files are the security boundary. Paths are the addressing layer inside those files. Targets consume resolved configuration, but targets are not the ACL boundary. Bundles organize and package config for runtime use, but bundles are not cryptographic containers.

This spec is meant to lock product shape and invariants. It is not a rollout guide, and it does not replace `docs/HUSH_V3_MIGRATION_STRATEGY.md` for migration sequencing.

## Future Architecture Scope

Hush v3 replaces the split between plaintext project config and encrypted secret payloads with a single encrypted document model. That model covers shared config, secret values, access control metadata, runtime packaging, import relationships, and operator context.

The future architecture covers:

1. Unified encrypted config as the source of truth
2. Explicit identities, roles, and readers for access decisions
3. File or document ACL boundary, not path-glob ACLs
4. Runtime materialization into artifacts and bundles
5. Local auditability for reads, writes, and materialization events
6. Command behavior that keeps encrypted config authoritative at rest

The future architecture does not define migration steps here. It defines the end state that migration work must land on.

## Core Concepts and Six Primitives

Hush v3 uses six primitives. They are the canonical vocabulary for the rest of this spec.

### Identity

An **Identity** is a named actor that Hush can execute as or attribute work to. An identity may represent a human, CI, or a local automation context. Identities are explicit records in config, not inferred from path patterns.

### File

A **File** is an encrypted configuration document. A file is the smallest authorization unit. ACLs attach to files. A file may contain many logical paths. A file may be imported into a bundle. A file is the security boundary.

### Path

A **Path** is a logical address inside the unified encrypted config tree, such as `env/apps/web/env/NEXT_PUBLIC_API_URL`. Paths organize values and metadata. Paths do not carry their own ACL rules. Path selection is for lookup, resolution, interpolation, inspection, export shaping, and target mapping.

### Artifact

An **Artifact** is a first-class encrypted file or binary secret plus runtime materialization subject derived from the unified encrypted config, such as a certificate file, `.env`-style file, JSON config file, shell export script, or other secret-bearing materialized payload. Artifacts are what Hush materializes for runtime consumption or export. They are not ACL boundaries, but they are more specific than a generic runtime output bucket because they represent concrete file-type secrets and materialized files.

### Bundle

A **Bundle** is an organizational and runtime grouping of files and path selections that resolves into one or more artifacts. A bundle is not a cryptographic boundary. A bundle is not an ACL boundary. Its job is packaging, reuse, and repeatable runtime composition.

### Target

A **Target** is a named consumer surface for resolved configuration, such as a process, service, app, deploy step, or export format. Targets describe where config goes and how artifacts should be shaped. Targets are not the security boundary.

## Definitions and Terminology

The following terms are normative in this planning set.

| Term | Meaning |
| --- | --- |
| unified encrypted config | The single encrypted source of truth for config structure, values, ACL metadata, identities, bundles, and targets |
| file or document ACL boundary | Access control attaches to encrypted files, not to glob patterns over logical paths |
| readers | The set of roles and explicit identities that may read a file |
| active identity | The identity Hush is currently executing as for access checks, audit attribution, and runtime resolution |
| explicit active identity pointer | The stored selector that identifies which identity is active in the current operator context |
| import | A pull-only relationship where one bundle references files or bundles and pulls them into its own resolved view |
| materialization | The act of resolving config into concrete encrypted file or binary secret artifacts for runtime use |
| sensitive | Metadata that controls redaction and inspection behavior only |

## Unified Encrypted Configuration Model

Hush v3 has one unified encrypted config model. There is no plaintext config tier. There is no separate unencrypted path for non-secret values. If a value belongs to the Hush config graph, it lives in encrypted config at rest.

The unified encrypted config stores:

1. Identities and active identity metadata
2. Encrypted files and their readers metadata
3. Logical config paths and values
4. `sensitive: true|false` metadata on values or subtrees
5. Bundles and imports
6. Targets and artifact materialization metadata

This model keeps structure and values together so that inspection, diffing, access checks, export, and runtime materialization all refer to the same authoritative graph.

### Sensitive Values and Exposure Boundaries

`sensitive: true|false` is required metadata in the v3 schema.

- `sensitive: true` means the value should be redacted in inspection, example export, diff output, and other human-readable views unless the command is explicitly designed to expose materialized runtime output.
- `sensitive: false` means the value may appear in inspection and example-oriented output.
- `sensitive` never changes encryption behavior.
- `sensitive` never changes ACL behavior.
- `sensitive` never creates a new security boundary.

All values remain encrypted at rest, whether `sensitive` is `true` or `false`.

## Configuration Topology and Addressing

The unified encrypted config is hierarchical. Operators and commands reason about it through logical paths, but access and ownership still attach to files.

This gives Hush two separate but connected layers:

1. Physical storage, encrypted files with ACL metadata
2. Logical addressing, paths inside the resolved config tree

### Reserved Top-Level Namespaces

The logical config tree reserves these top-level namespaces:

- `env/`
- `artifacts/`
- `bundles/`
- `user/`
- `imports/`

These names are part of the locked topology. Later prose and examples should use them directly rather than inventing alternative root sections.

- `env/` holds scalar configuration values and config subtrees
- `artifacts/` holds file-oriented or binary materialization subjects
- `bundles/` holds bundle definitions and composition metadata
- `user/` holds explicit operator or identity-local config state that belongs in the unified encrypted model
- `imports/` holds explicit cross-project import declarations used for pull-only composition

### Logical Paths vs Physical Files

Logical paths are stable addresses for config lookup, interpolation, export selection, and target mapping. Physical files are encrypted documents that group those paths for ownership and access.

One file may contain many logical paths. A logical path never implies a dedicated file. Moving a path between files is a security and ownership change because it changes the file or document ACL boundary.

Logical paths address config. Files are the physical encrypted ACL units that store and protect that config.

For scalar config, a logical path resolves to a key inside a file. For example, a path under `env/` resolves to a scalar value or subtree stored inside some encrypted file entry.

For file materialization, an artifact path resolves to a file artifact, not to an inline scalar leaf. A path under `artifacts/` therefore addresses an artifact-shaped payload such as a certificate, JSON file, dotenv file, or `type: binary` payload that is stored as encrypted config and materialized as a file artifact at runtime.

Hush v3 does not use `paths:` as an ACL mechanism. It does not use path-glob ACLs. Paths may be queried, selected, or exported, but authorization is still decided at the file level.

## Access Model

The access model is intentionally small. It combines roles with explicit identities and keeps enforcement at the file boundary.

### Roles

Roles are stable labels for common access intent. The locked model in this planning set is:

- `owner`, may manage file metadata, readers, values, and topology within the file
- `member`, may read files and participate in normal local runtime and operator workflows
- `ci`, may read files for automation and non-interactive execution workflows

This spec does not introduce custom roles, policy DSLs, or dynamic policy engines.

### Readers Semantics

Readers are expressed as roles plus explicit identities.

- A file may list allowed roles in `readers.roles`
- A file may list allowed explicit identities in `readers.identities`
- A read is allowed when the active identity matches an allowed role or an allowed explicit identity
- File read access means the identity may read the whole file
- File read access does not mean the identity may only read selected paths within the file

The readers model is file-scoped and explicit. It is not based on path prefixes, glob matching, or inferred app ownership.

### File-Scoped ACLs

Each encrypted file carries its own readers metadata. This is the only ACL boundary in Hush v3.

Consequences of file-scoped ACLs:

1. Secrets with different audiences belong in different files
2. A bundle may combine files with different readers, but bundle composition does not weaken file ACLs
3. Export or materialization of a target must fail if the active identity cannot read every required file
4. Moving values between files is an access-control change that should be visible to diff and audit tools

Hush v3 must not reintroduce `paths:` glob-reader ACLs.

## Identity and Execution Context

Hush v3 makes identity selection explicit because access checks, audit attribution, and runtime resolution depend on it.

### Explicit Active Identity Pointer

The operator context stores an explicit active identity pointer. Hush does not rely on ambient shell state alone to decide identity.

The active identity pointer must support these behaviors:

1. Inspect the currently active identity
2. Switch the active identity intentionally
3. Attribute audit events to the chosen identity
4. Apply file reader checks against the chosen identity

An explicit active identity pointer keeps access decisions reproducible across local runs, CI, automation, and future tooling.

## Bundle Model

Bundles are packaging and reuse tools. They help define repeatable runtime views over the unified encrypted config.

### Bundle Semantics

A bundle may reference files, path selections, or other bundles and resolve them into artifacts for one or more targets.

Bundle rules:

1. A bundle is organizational and runtime only
2. A bundle is not cryptographic
3. A bundle is not the ACL boundary
4. A bundle may fail to resolve if the active identity cannot read one of its files
5. A bundle should be reusable across multiple targets

### Imports

Imports are explicit and pull-only.

- A bundle may import files or other bundles
- Cross-project composition is also explicit and pull-only through declared project imports under `imports/`
- Importing pulls data into the importing bundle's resolved view
- Imported content does not push itself into other bundles automatically
- Imports must be explicit in config
- Import resolution must preserve file provenance for diff, inspect, and audit output

Cross-project composition is not ambient inheritance. A project must declare which external project roots or exported bundle surfaces it imports, then pull specific files, bundles, or artifact paths into its own resolved view.

Hush v3 does not define hidden inheritance or automatic ambient imports.

## Target Model

Targets define how resolved config is consumed.

A target may specify:

1. Which bundle or path selection it resolves from
2. What artifact shape or file type it needs
3. Whether output is meant for process injection, file export, or example generation

Targets are important because they connect config to real runtime surfaces. They are not the security boundary, and they do not replace file ACLs.

## Artifact Model

Artifacts are first-class encrypted file or binary secret materialization subjects produced from bundles, files, and path selections after access checks pass.

Examples include:

- a `.env`-style file produced for a tool that needs file-based config
- a certificate, key, or other secret-bearing file materialized for local runtime use
- a JSON or YAML config file generated for an integration boundary
- a redacted example file emitted for documentation or bootstrap flows

An artifact may be ephemeral or persisted, depending on the command. An artifact may also be projected into a process environment, but the first-class concept is the concrete encrypted file, binary secret payload, or materialized file itself. The artifact is always derived from the unified encrypted config, never the other way around.

## Threat Model

Hush v3 keeps the same basic product promise, config stays encrypted at rest and is revealed only to authorized identities during controlled runtime operations.

The threat model assumes:

1. The repository may be readable by humans, CI, and AI tooling
2. Plaintext config on disk is a major leak path and must not be a normal tier in the design
3. Operators need redacted inspection and diff workflows that do not reveal protected values
4. Access control mistakes are most manageable when the boundary is coarse, explicit, and visible in files
5. Local machines and CI may be interrupted, so materialization must clean up safely

This spec does not attempt to solve remote secret serving, live lease revocation, enterprise policy orchestration, or server-mediated secret brokering.

## Runtime Materialization and Execution Safety

Runtime materialization resolves encrypted config into artifacts for commands, exports, and execution.

Materialization rules:

1. Access checks happen before artifact creation
2. Materialization should preserve file provenance internally
3. Commands should prefer in-memory artifacts when possible
4. Persisted artifacts must be explicit command behavior, not implicit background behavior

### Materialization Lifecycle

The materialization lifecycle is:

1. Resolve active identity
2. Resolve requested bundle, file set, path set, or target
3. Check file readers for every required file
4. Decrypt required files in memory
5. Build the logical config graph
6. Apply interpolation
7. Shape concrete artifacts for the requested command or target
8. Emit audit events
9. Clean up temporary state

### Signal-Safe Materialization

Signal-safe materialization is a locked requirement.

If Hush creates temporary files, pipes, or process-local helpers during materialization, it must clean them up on normal completion and on common interruption signals. Signal-safe materialization matters for local shells, CI cancellation, and editor or watcher restarts.

The design target is clear, interruption must not leave behind durable plaintext config unless a command explicitly asked to persist an artifact.

## Auditability

Hush v3 includes a local activity log.

### Audit Log

The audit log records local events relevant to security, traceability, and operator understanding. It is a local activity log (best-effort; not tamper-evident) that appends on the local machine.

Minimum event classes:

1. Active identity changes
2. File reads and decryption attempts
3. File writes and metadata changes
4. Bundle resolution and import resolution events
5. Artifact materialization and export events
6. Access denials

The audit log should record enough provenance to answer who acted, which identity was active, which files were touched, which command initiated the action, and whether the operation succeeded.

## Interpolation

Interpolation remains part of the unified config graph. Values may reference other logical paths or resolved values using a deterministic interpolation model.

Interpolation rules in v3:

1. Interpolation happens after required files are decrypted and loaded into the graph
2. Interpolation must not bypass file ACLs, if a required source file is unreadable, resolution fails
3. Interpolation must keep provenance so inspect, diff, and audit tooling can explain where a value came from
4. Circular interpolation should fail with a clear error

## Schema Reference

The following schema sketch is normative for planning intent. Field names may still tighten during implementation, but the model and boundaries are locked.

```yaml
version: 3

activeIdentity: developer-local

identities:
  developer-local:
    roles: [owner]
  teammate-local:
    roles: [member]
  ci:
    roles: [ci]

imports:
  shared-platform:
    project: github.com/example/platform-secrets
    pull:
      bundles: [bundles/platform/runtime]
      files: [env/platform/shared]

files:
  - path: env/app/shared
    readers:
      roles: [owner, member, ci]
      identities: [developer-local, teammate-local, ci]
    sensitive: false
    entries:
      env/apps/web/env/NEXT_PUBLIC_API_URL:
        value: https://api.example.com
        sensitive: false
      env/shared/database/url:
        value: postgres://db.example.internal/app
        sensitive: true

  - path: env/app/secrets
    readers:
      roles: [owner]
      identities: [developer-local]
    sensitive: true
    entries:
      env/apps/api/env/DATABASE_URL:
        value: ${env/shared/database/url}
        sensitive: true

  - path: artifacts/api/runtime
    readers:
      roles: [owner, ci]
      identities: [developer-local, ci]
    sensitive: true
    entries:
      artifacts/api/tls/client-cert:
        type: binary
        format: pkcs12
        sensitive: true
      artifacts/api/runtime/env-file:
        type: file
        format: dotenv
        sensitive: true

bundles:
  web-runtime:
    files:
      - path: env/app/shared

  api-runtime:
    files:
      - path: env/app/shared
      - path: env/app/secrets
      - path: artifacts/api/runtime
    imports:
      - bundle: web-runtime
      - project: shared-platform
        bundle: bundles/platform/runtime

targets:
  web-dev:
    bundle: web-runtime
    format: dotenv

  api-run:
    bundle: api-runtime
    format: env
```

### Schema Notes

- `imports:` is the explicit cross-project pull surface, not an ambient inheritance mechanism
- `files:` is the container for encrypted documents and their readers metadata
- Each `files:` entry must show `path`, `readers`, and `sensitive` semantics explicitly because the file is the ACL unit
- `files.*.path` names the file slot for one physical encrypted ACL unit. It is the handle bundles, imports, and topology metadata use to refer to that encrypted file, while `files.*.entries` maps the logical config paths stored inside it
- `files.*.readers` is the ACL model
- `files.*.sensitive` documents the default exposure posture for the file entry without creating a new ACL boundary
- `files.*.entries` maps logical paths to stored values or artifact descriptors inside the file
- `sensitive` is required for exposure semantics and is never an ACL or encryption control
- Scalar paths under `env/` resolve into keys inside files
- Artifact paths under `artifacts/` resolve into file artifacts
- `bundles.*.files` is explicit composition and should show `path:` entries, not implicit nested freeform trees
- `imports` is explicit and pull-only, including cross-project project imports
- `artifacts` are first-class encrypted file or binary secret materialization subjects derived from resolved config
- `targets` reference bundles or resolved views, but do not define security boundaries

## CLI Reference

The CLI in v3 should speak in terms of unified encrypted config, file-scoped ACLs, identities, bundles, and targets.

### `hush diff`

Shows changes between two config states with file provenance and redaction rules applied. Sensitive values stay redacted unless the command is explicitly asked for raw materialized output.

### `hush bootstrap`

Creates or updates the initial unified encrypted config structure for a repo or workspace, including identities, files, bundle shells, and target shells.

### `hush config`

Inspects or edits structural config concepts such as active identity, files, readers, bundles, imports, and targets without treating plaintext YAML as the authoritative tier.

### `hush export-example`

Generates a redacted or non-sensitive example artifact suitable for docs, onboarding, or scaffolding. This command must respect `sensitive: true|false` semantics.

### Command Invariants

All v3 commands should preserve these invariants:

1. The unified encrypted config is authoritative at rest
2. No plaintext config tier is implied by command design
3. File reader checks happen before artifact creation
4. Diff, inspect, and example-oriented commands respect `sensitive`
5. Targets shape runtime output but do not define authorization boundaries

## Non-Goals

The following remain out of scope for Hush v3:

1. Any plaintext config tier for non-secret values
2. Path-glob ACLs or `paths:` reader policies
3. Custom role authoring beyond the locked role model in this planning set
4. Policy DSLs
5. Dynamic secret engines
6. Servers, hosted control planes, or enterprise Vault-like features
7. Making bundles into cryptographic containers
8. Making targets into the security boundary
9. Moving migration execution details out of `docs/HUSH_V3_MIGRATION_STRATEGY.md`

## Open Architecture Questions

The following questions remain open without changing the locked architecture described above:

1. How much of the active identity pointer should be repo-local versus machine-local state?
2. What is the exact on-disk encoding for the local append-only audit log?
3. Which artifact formats are first-class in the initial v3 implementation versus follow-on releases?
4. How should provenance be surfaced in `hush diff` output when one value arrives through multiple imports?
5. What is the exact UX for switching active identities in local development and CI?

## Opening Guidance for Follow-on Authors

When extending this spec, preserve these rules:

1. Keep this file as the canonical architecture source of truth
2. Add design detail here only when it changes or clarifies future product intent
3. Push rollout and adoption details into the migration strategy document
4. Do not move draft architecture ownership into docs-site pages
