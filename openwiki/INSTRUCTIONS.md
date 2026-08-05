Document this repository for an agent that has never seen it.

Prioritize:

- what the repository is for, and the boundary between it and its neighbours
- the entry points a reader actually runs: CLIs, services, scripts, tasks
- build, test, lint, and release workflows, with the exact commands
- configuration, secrets topology, and required runtime state
- sharp edges and non-obvious invariants an agent must know before editing
- concise Mermaid diagrams for module relationships and key workflows

Use `AGENTS.md`, `README.md`, and `.llm/wiki/` as existing context, but write an
independent, linked wiki that points readers to the canonical source files and
commands. Prefer operational facts over aspirational plans. Keep generated
artifacts, dependency directories, vendored code, screenshots, fixtures, and
transient handoffs out of the main concept set unless they explain a current
boundary. Do not document secrets, token values, private credentials, or
personal data.
