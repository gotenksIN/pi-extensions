# Pi Extensions

Extensions for the [Pi coding agent](https://github.com/earendil-works/pi).
This repository contains the extensions used in the author's Pi setup.

## Install the complete setup

The tracked [`settings.json`](settings.json) contains the extension package, the Catppuccin theme package, and the `pi-subagents` package.
Copy it to the Pi agent directory to install and configure the complete setup:

```bash
cp settings.json ~/.pi/agent/settings.json
```

This replaces the destination settings file.
Back up your current file first if it contains settings that you need to keep.

Link this repository's agent rules into Pi's global agent configuration:

```bash
ln -sfn "$PWD/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
```

Run this command from the repository root.
It replaces the existing global `AGENTS.md` link or file.
Keep the link in place so Pi and its agents use the repository rules.

Pi may need a JavaScript package manager when it installs a Git package.
The standalone Pi binary does not include Node.js or npm.
Install Bun temporarily when required:

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

  /usr/bin/install -Dm755 \
    "$work/bun-linux-x64/bun" \
    "$HOME/.local/bin/bun"

  "$HOME/.local/bin/bun" --version
  rm -rf "$work"
)
```

If `pi-subagents` failed to install before Bun was available, install its production dependencies directly:

```bash
cd ~/.pi/agent/git/github.com/tintinweb/pi-subagents
~/.local/bin/bun install --production --ignore-scripts --no-save
```

Remove Bun after the installation if you do not need it for other work:

```bash
rm -f ~/.local/bin/bun
```

Restart Pi or reload its extensions:

```text
/reload
```

Update installed extension packages later with:

```bash
pi update --extensions
```

Pi packages run with your user permissions.
Review package source before you install it.

## Extensions

Each extension has two documents:

- `README.md` is for users. It explains purpose, installation, configuration, commands, tools, and visible behavior.
- `AGENTS.md` is for coding agents. It explains module ownership, implementation details, invariants, and change checks.

- [`bwrap-sandbox`](extensions/bwrap-sandbox/README.md) provides a Linux Bubblewrap boundary and approval gate for Bash and selected Pi file tools.
- [`delete-session`](extensions/delete-session/README.md) deletes the current session file after confirmation and starts a new session.
- [`keybinding-shortcuts`](extensions/keybinding-shortcuts/README.md) adds OpenCode-style command and word-deletion shortcuts to the Pi TUI editor.
- [`websearch`](extensions/websearch/README.md) provides provider-native grounded web search with citations and ordered fallback.

Read the matching `AGENTS.md` before you change an extension.

## Configuration and setup notes

### Bubblewrap sandbox

`bwrap-sandbox` is Linux-only.
It requires a trusted, root-owned `bubblewrap` installation:

```bash
# Debian or Ubuntu
sudo apt update
sudo apt install bubblewrap

# Fedora or RHEL
sudo dnf install bubblewrap

# Arch or Manjaro
sudo pacman -S bubblewrap
```

The extension starts from a read-only host root and uses deterministic path and direct secret checks, Bubblewrap mounts, user-approved session grants, and a two-stage classifier for model-generated Bash.
Bubblewrap is the primary security boundary.
Read its [user guide](extensions/bwrap-sandbox/README.md) before you configure it.

The extension's global configuration is:

```text
~/.pi/agent/extensions/sandbox.json
```

Trusted project configuration is:

```text
.pi/sandbox.json
```

The extension provides `/sandbox`, `/sandbox-test`, and `sandbox_access`.
These surfaces and their safety rules are documented in the extension guide.

Starting Pi with `--no-sandbox` disables the sandbox for the parent and all subagent sessions in that Pi process.
A child cannot restore it silently.

### Web search

`websearch` registers `websearch_cited`.
It uses Pi's model registry and authentication.
It does not need separate API keys.
Its global and project configuration files are:

```text
~/.pi/agent/extensions/websearch.json
.pi/websearch.json
```

Read the [websearch user guide](extensions/websearch/README.md) for model fallback, tool parameters, provider behavior, and errors.

### Delete session

`delete-session` registers `/delete`.
The command asks for confirmation, waits for Pi to become idle, removes the current session file, and starts a new session.
It does nothing for an ephemeral session.

Read the [delete-session user guide](extensions/delete-session/README.md) for installation and use.

### Keybinding shortcuts

`keybinding-shortcuts` replaces the editor component only in TUI mode.
It maps `ctrl+p` to Pi's slash-command menu, and maps `ctrl+backspace` and `ctrl+delete` to word deletion.

The extension needs the conflicting default `ctrl+p` actions removed from `~/.pi/agent/keybindings.json`.
Read the [keybinding user guide](extensions/keybinding-shortcuts/README.md) for the exact entries.

## Repository development

The extension source is under `extensions/`.
Keep user documentation and agent documentation in the same extension folder.
Keep the root README focused on setup and the extension index.

Use the repository's existing Pi-native test commands for extensions that provide them.
For `bwrap-sandbox`, run `/sandbox-test` inside Pi.
It runs the native unit tests and the live Bubblewrap integration checks.

Do not commit credentials, provider responses, session files, or generated runtime resources.
