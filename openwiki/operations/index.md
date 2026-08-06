# Files

- [Build, Test, Lint, and Release](build-test-release.md) - This page is the exact command map for local validation and Forgejo CI. It covers Bun workspace scripts, CLI packaging, docs deployment, service control, release gates, npm publication, Forgejo releases, and standalone binary fanout.
- [Detached Local Installation](local-install.md) - scripts/install-local.mjs installs a repository-built Hush runtime into a detached location, validates its dependency graph and executable identity, and safely publishes a launcher and managed login PATH block. Its verification suite exercises rollback, concurrency, stale stages, and metadata-preserving behavior.
