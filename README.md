# Pi Extensions

Extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Install the complete setup

Install this extension package and the Catppuccin theme package over SSH:

```bash
pi install git:git@github.com:gotenksIN/pi-extensions.git
pi install git:git@github.com:otahontas/pi-coding-agent-catppuccin.git
```

Pi runs `npm install` for Git packages containing `package.json`. The
standalone Pi binary does not include a JavaScript package manager. If `node`
and `npm` are unavailable, temporarily install the smaller Bun runtime without
requiring Node.js:

```bash
(
  set -e

  work="$HOME/sandbox/bun-install"
  rm -rf "$work"
  mkdir -p "$work" "$HOME/.local/bin"
  cd "$work"

  gh release download \
    --repo oven-sh/bun \
    --pattern 'bun-linux-x64.zip' \
    --pattern 'SHASUMS256.txt'

  sha256sum --check --ignore-missing SHASUMS256.txt
  7z x bun-linux-x64.zip

  # Use the absolute path because some Zsh setups alias `install` to Nala.
  /usr/bin/install -Dm755 \
    "$work/bun-linux-x64/bun" \
    "$HOME/.local/bin/bun"

  "$HOME/.local/bin/bun" --version
  rm -rf "$work"
)
```

If installing `pi-subagents` failed before Bun was available, install its
production dependencies directly, then remove Bun because Pi's standalone
runtime can load the installed modules without keeping the package manager:

```bash
cd ~/.pi/agent/git/github.com/tintinweb/pi-subagents
~/.local/bin/bun install --production --ignore-scripts --no-save
rm -f ~/.local/bin/bun
```

If a package has no dependencies, such as the Catppuccin theme, it can instead
be cloned directly into Pi's package directory:

```bash
mkdir -p ~/.pi/agent/git/github.com/otahontas
git clone git@github.com:otahontas/pi-coding-agent-catppuccin.git \
  ~/.pi/agent/git/github.com/otahontas/pi-coding-agent-catppuccin
```

Copy the tracked [`settings.json`](settings.json) into Pi's agent directory to
reproduce this setup exactly:

```bash
cp settings.json ~/.pi/agent/settings.json
```

This replaces the destination settings and intentionally configures only the
shared packages and theme. The theme pair uses Catppuccin Latte for light
terminal backgrounds and Frappé for dark terminal backgrounds. Pi follows
terminal color-scheme changes automatically.

Restart Pi or run:

```text
/reload
```

Update both packages later with:

```bash
pi update --extensions
```

Pi packages execute code with your user permissions. Review third-party package
sources before installing them.

## bwrap-sandbox

A Linux `bubblewrap` sandbox extension for Pi bash and file tools.

### Features

- Runs bash commands under `bwrap`.
- Uses a structured filesystem policy:
  - `"none"`
  - `"read"`
  - `"write"`
- Keeps a sparse host-read model instead of binding the full host filesystem.
- Keeps project `.git` metadata writable for normal Git operations while protecting `.git/config` and hiding `.git/hooks`.
- Mounts other protected project paths read-only by default, including `.pi`, `.agents`, `.codex`, and `.env`.
- Makes user-installed executables under `~/.local/bin` available read-only.
- Makes Pi installation under `~/.local/lib/pi` available read-only.
- Supports nested `pi`/subagent dispatch with an ephemeral writable agent directory while keeping the canonical `~/.pi` read-only.
- Keeps common tool config under `~/.config` read-only by default.
- Keeps Git user config under `~/.gitconfig` read-only by default.
- Supports SSH/Git pushes via a mounted SSH agent socket without mounting private keys.
- Mounts Git worktree/common-dir metadata read-only when it lives outside the project.
- Keeps Pi config under `~/.pi` read-only by default.
- Makes host `/tmp` readable and writable by default so temporary files (such as pasted TUI clipboard screenshots) are auto-approved.
- Automatically blocks bash commands attempting output suppression using `/dev/null`.
- Supports memory-only session grants for one-off file/bash access.
- Makes explicit user-approved write grants override default read-only rules; `none` remains a hard denial.
- Detects mutating Git commands (including `git -C …` and `cd … && git …`) and requests write access to the target repository.
- Network access is normal by default.
- Optional paranoid network isolation via `isolateNetwork: true`.
- Uses PID/user namespace isolation, a fresh `/proc`, and drops capabilities inside bwrap.

### Requirements

Install `bubblewrap` and ensure `bwrap` is on `PATH`:

```bash
# Debian / Ubuntu / other apt-based systems
sudo apt update
sudo apt install bubblewrap

# Fedora / RHEL / other dnf-based systems
sudo dnf install bubblewrap

# Arch / Manjaro / other pacman-based systems
sudo pacman -S bubblewrap
```

### Install

Copy the extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/bwrap-sandbox
cp extensions/bwrap-sandbox/index.ts ~/.pi/agent/extensions/bwrap-sandbox/index.ts
```

Then restart Pi or run:

```text
/reload
```

### Configuration

Global config path:

```text
~/.pi/agent/extensions/sandbox.json
```

Project config path:

```text
.pi/sandbox.json
```

Example:

```json
{
  "isolateNetwork": false,
  "filesystem": {
    ":project": "write",
    ":project/.git": "write",
    ":project/.git/config": "read",
    ":project/.git/hooks": "none",
    ":project/.agents": "read",
    ":project/.codex": "read",
    ":project/.pi": "read",
    ":project/.env": "read",
    "~/sandbox": "write",
    "~/.local/bin": "read",
    "~/.local/lib/pi": "read",
    "~/.config": "read",
    "~/.gitconfig": "read",
    "~/.ssh": "none",
    "~/.ssh/config": "read",
    "~/.ssh/known_hosts": "read",
    "~/.ssh/known_hosts2": "read",
    "~/.ssh/id_ed25519.pub": "read",
    "~/.ssh/id_ecdsa.pub": "read",
    "~/.ssh/id_ecdsa_sk.pub": "read",
    "~/.ssh/id_rsa.pub": "read",
    "~/.ssh/id_dsa.pub": "read",
    "~/.ssh/id_ed25519": "none",
    "~/.ssh/id_ecdsa": "none",
    "~/.ssh/id_ecdsa_sk": "none",
    "~/.ssh/id_rsa": "none",
    "~/.ssh/id_dsa": "none",
    "~/.pi": "read",
    "/tmp": "write"
  }
}
```

Legacy compatibility:

```json
{
  "allowNetwork": false
}
```

is interpreted as:

```json
{
  "isolateNetwork": true
}
```


### Git and SSH

The sandbox keeps Git metadata conservative by default:

- `.git` is writable so normal operations such as commits can update repository metadata.
- `.git/config` remains explicitly read-only.
- `.git/hooks` is hidden with a `none` policy entry.
- Git worktree `git-dir` / `git-common-dir` paths outside the project are
  mounted read-only so commands like `git status`, `git log`, and SSH-based
  `git push` can inspect metadata without making hooks/config writable.

The sandbox intentionally does **not** mount private SSH keys. Instead, when
`sshAgent` is enabled, it mounts a live `SSH_AUTH_SOCK` socket read/write and
sets `GIT_SSH_COMMAND` to use the agent plus `~/.ssh/config`. This lets
`git push` authenticate through your host SSH agent/keychain without exposing private
key files to sandboxed bash or file tools.

### Nested Pi and subagents

The canonical `~/.pi` remains read-only because it contains credentials,
settings, executable extensions, prompts, and session history. When a sandboxed
bash command invokes `pi`, the extension creates an ephemeral writable agent
directory under an approved writable root and sets `PI_CODING_AGENT_DIR` for
that command. It copies JSON configuration, links read-only user resources, and
removes package/extension discovery from the copied settings. The child remains
inside the outer bubblewrap sandbox, and the ephemeral directory is deleted when
the command exits.

Default:

```json
{
  "sshAgent": true
}
```

For keychain-managed agents, the extension also checks:

```text
~/.keychain/<hostname>-sh
```

### Commands

Inside Pi:

```text
/sandbox
/sandbox-test
```

## websearch

A provider-native grounded web search extension that registers the real Pi tool
`websearch_cited`.

### Features

- Registers `websearch_cited` as a first-class Pi toolcall.
- Uses provider-native web search/grounding where available:
  - Google Gemini `googleSearch`
  - OpenAI Responses API `web_search`
- Returns inline numeric citations like `[1]` plus a final `Sources:` list.
- Supports ordered model fallback. By default:
  1. `google/gemini-3.6-flash`
  2. `openai/gpt-5.5`
- Allows per-call preferred backend via optional `provider` and `model` tool
  parameters; configured fallbacks are tried after the requested backend.
- Inherits auth, headers, and base URLs from Pi's model registry:
  - `ctx.modelRegistry.find(provider, model)`
  - `ctx.modelRegistry.getApiKeyAndHeaders(model)`
  - `model.baseUrl`
  - `auth.headers`
  - `auth.env`
- Does not duplicate API-key, OAuth, or base-URL configuration.

### Install

Copy the extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/websearch
cp extensions/websearch/index.ts ~/.pi/agent/extensions/websearch/index.ts
```

Then restart Pi or run:

```text
/reload
```

### Configuration

Global config path:

```text
~/.pi/agent/extensions/websearch.json
```

Project config path:

```text
.pi/websearch.json
```

Example fallback config:

```json
{
  "models": [
    { "provider": "google", "model": "gemini-3.6-flash" },
    { "provider": "openai", "model": "gpt-5.5" }
  ]
}
```

Compact string form is also supported:

```json
{
  "models": [
    "google/gemini-3.6-flash",
    "openai/gpt-5.5"
  ]
}
```

### Tool parameters

```json
{
  "query": "current search query",
  "provider": "google",
  "model": "gemini-3.6-flash"
}
```

Only `query` is required. `provider` and `model` are optional and are tried
first when supplied.

## delete-session

A small session-management extension that registers `/delete`.

### Features

- Deletes the current session file after an explicit confirmation prompt.
- Waits for Pi to become idle before deleting.
- Starts a fresh session after deleting the old session file.
- Safely no-ops for ephemeral sessions with no backing session file.

### Install

Copy the extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/delete-session
cp extensions/delete-session/index.ts ~/.pi/agent/extensions/delete-session/index.ts
```

Then restart Pi or run:

```text
/reload
```

### Command

Inside Pi:

```text
/delete
```

The command prompts before deletion:

```text
No - keep it
Yes - delete and start new
```

## keybinding-shortcuts

An editor shortcut extension that adds OpenCode-style command-menu and word
deletion keybindings.

### Features

- Makes `ctrl+p` insert `/` in the chat editor.
- Reuses Pi's built-in slash-command autocomplete/menu instead of replacing it.
- Maps `ctrl+backspace` to backward word deletion.
- Maps `ctrl+delete` to forward word deletion.

### Install

Copy the extension into Pi's global extension directory:

```bash
cp extensions/keybinding-shortcuts/index.ts ~/.pi/agent/extensions/keybinding-shortcuts.ts
```

Then unbind Pi's default `ctrl+p` built-in actions in
`~/.pi/agent/keybindings.json` so they do not compete with the extension or
emit shortcut-conflict warnings:

```json
{
  "app.model.cycleForward": [],
  "app.session.togglePath": [],
  "app.models.toggleProvider": []
}
```

These are the complete exact `ctrl+p` default bindings Pi currently documents:

- `app.model.cycleForward` - main app model cycling
- `app.session.togglePath` - session picker path display toggle
- `app.models.toggleProvider` - `/scoped-models` provider toggle

`app.model.cycleBackward` uses `shift+ctrl+p`, not exact `ctrl+p`, so it does
not conflict with this extension.

If you already have a keybindings file, merge those entries with your existing
settings.

Then restart Pi or run:

```text
/reload
```

### Shortcut

Inside Pi's chat editor:

```text
ctrl+p
```
