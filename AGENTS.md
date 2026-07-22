# Global Rules

## Working Style

- Keep responses concise, direct, and technical.
- Prefer small, focused changes over broad refactors unless the user asks otherwise.
- Verify important changes before concluding when a practical check exists.

## Tooling Preferences

- For Python projects, always use `uv` for running tools, managing dependencies, and virtual environments unless the repository explicitly requires a different workflow.
- For GitHub repositories, issues, pull requests, releases, and file browsing, prefer `gh` CLI over `webfetch`. Use `webfetch` for non-GitHub pages or when `gh` cannot access the target.
- Prefer `rg` over `grep` or `find` for shell-based searches. Prefer native file-search and content-search tools when they are available.
- Never use `/tmp` for temporary work. Use `~/sandbox` instead for work outside the current workspace.
- Do not use `/dev/null`, including for suppressing command output or errors.

## Git Workflow

- Never create commits unless the user explicitly asks for them.
- When the user requests per-task commits, commit each discrete task before starting the next one.
- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only files that belong to the current task.
- Use concise, technical commit messages that explain why the change was made.
- Keep commit subject lines at or under 72 characters.
- Wrap commit body text at 72 characters per line.
- Do not amend commits, push, or rewrite history unless the user explicitly asks.
