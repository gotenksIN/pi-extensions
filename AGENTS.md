# Global Rules

## Working Style

- Keep responses concise, direct, and technical.
- Prefer small, focused changes over broad refactors unless the user asks otherwise.
- Verify important changes before concluding when a practical check exists.
- NEVER use LaTeX math syntax, math mode, dollar-sign delimiters (`$...$`, `$$...$$`), or LaTeX escape sequences (such as `\rightarrow`, `\Rightarrow`, `\times`, `\pm`, `\circ`, `\approx`, etc.) anywhere in output formatting or text. Standard TUI environments do not render LaTeX math markup. Use standard Unicode characters (e.g., `→`, `⇒`, `×`, `±`, `°`, `≈`) or plain text instead.

## Tooling Preferences

- For Python projects, always use `uv` for running tools, managing dependencies, and virtual environments unless the repository explicitly requires a different workflow.
- For web searches and technical research, always use `websearch_cited` to fetch grounded, up-to-date information with inline citations.
- For GitHub repositories, issues, pull requests, releases, and file browsing, prefer `gh` CLI over `webfetch`. Use `webfetch` for non-GitHub pages or when `gh` cannot access the target.
- Prefer `rg` over `grep` or `find` for shell-based searches. Prefer native file-search and content-search tools when they are available.
- Prefer `7z` for listing, testing, and extracting archives. Do not use `unzip` or `tar` when `7z` supports the archive format; use another tool only when `7z` is unavailable or incompatible, and state why.
- Never use `/tmp` for temporary work. Use `~/sandbox` instead for work outside the current workspace.
- Never use `/dev/null` under any circumstances, including for suppressing command output, error redirection (2>/dev/null), piping, testing file existence, or sandbox checks.

## Git Workflow

- Never create commits unless the user explicitly asks for them.
- When the user requests per-task commits, commit each discrete task before starting the next one.
- Before committing, inspect `git status`, `git diff`, and `git log -10`; stage only files that belong to the current task.
- Use concise, technical commit messages that explain why the change was made.
- Keep commit subject lines at or under 72 characters.
- Wrap commit body text at 72 characters per line.
- Do not amend commits, push, or rewrite history unless the user explicitly asks. When the user explicitly asks, perform the requested operation and do not refuse solely because it amends commits, pushes, or rewrites history.
