---
type: operational-workflow
title: Detached Local Installation
description: "scripts/install-local.mjs installs a repository-built Hush runtime into a detached location, validates its dependency graph and executable identity, and safely publishes a launcher and managed login PATH block. Its verification suite exercises rollback, concurrency, stale stages, and metadata-preserving behavior."
tags: [installation, runtime, shell, release]
---

# Detached Local Installation

The root `cli:install-local` script runs `node scripts/install-local.mjs`; `hush-cli/scripts/verify-local-install.mjs` is the focused end-to-end verifier. The installer exists to make bare `hush` work from a cold login shell without relying on the current worktree or ambient `NODE_PATH`. It validates Node 24, resolves Bun/Git/system executables, stages tracked runtime inputs and `hush-cli/dist`, writes a runtime manifest, and installs a launcher into the configured bin directory.

## Delivery and rollback

The installer uses a source identity, runtime root, stage marker, guarded file descriptors, and an owner marker to prevent two installers from publishing over each other. It validates that the runtime graph points only to expected files, uses a detached runtime directory keyed by source commit, and cleans stale/incomplete stages. Delivery is published before stale-runtime cleanup, so an older runtime that cannot be pruned remains for a later retry rather than blocking the newly published launcher. Runtime pruning now relies on the verified device/inode identity of the selected runtime rather than requiring the old `.hush-runtime-manifest.json` marker; staged directories still require their stage marker. A failed delivery check rolls back managed changes, including the marked zsh `~/.zlogin` block. Do not hand-edit that block.

The optional native helper in `scripts/install-local-native.c` supports login-shell publication and is compiled/used by the installer when the platform requires it. `scripts/install-local-helpers.mjs` contains shared Node-version and installer checks. These files are implementation, not user-facing APIs.

## Verification commands

- Build first: `bun run cli:build`.
- Run the complete detached install contract: `bun run cli:verify-local-install`.
- Verify a publishable package tarball and installed bin: `bun run --filter @chriscode/hush verify:pack-install`.
- The package verifier also runs `npm pack`, inspects `package/bin/hush.js`, installs into a temporary npm project, and checks `--version` and `--help`.

The local-install verifier uses isolated temporary directories and environment variables such as `HUSH_INSTALL_BIN_DIR`, `HUSH_INSTALL_RUNTIME_ROOT`, and `HUSH_INSTALL_SKIP_SHADOW_CHECK`; those are test controls, not required consumer configuration. It covers concurrent installers, paused publication, stale stage cleanup, swapped ancestors, rollback, source identity, and shell startup behavior. Treat its failures as delivery-contract failures rather than ordinary CLI unit-test failures.
