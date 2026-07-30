# Keybinding Shortcuts Extension

## Purpose

This extension adds OpenCode-style terminal keyboard shortcuts to the Pi chat editor.
It provides quick access to slash commands and word-level text deletion.

## Features

- **`ctrl+p`**: Inserts a `/` character into the chat editor to open Pi's slash-command menu.
- **`ctrl+backspace`**: Deletes the word before the cursor (translates Ctrl+Backspace and ASCII `0x08` to Alt+Backspace).
- **`ctrl+delete`**: Deletes the word after the cursor (translates Ctrl+Delete to modifier-aware Alt+Delete).

## Installation

When you install the complete `pi-extensions` package, Pi loads this extension automatically.

To install this extension separately, copy the file to Pi's global extension folder:

```bash
cp extensions/keybinding-shortcuts/index.ts ~/.pi/agent/extensions/keybinding-shortcuts.ts
```

Then restart Pi or run:

```text
/reload
```

## Keybinding Configuration

Pi binds default actions to `ctrl+p`.
Unbind those actions in `~/.pi/agent/keybindings.json` to prevent keybinding conflicts:

```json
{
  "app.model.cycleForward": [],
  "app.session.togglePath": [],
  "app.models.toggleProvider": []
}
```

These entries remove default bindings:

- `app.model.cycleForward`: Cycles models in the main app.
- `app.session.togglePath`: Toggles path display in the session picker.
- `app.models.toggleProvider`: Toggles providers in `/scoped-models`.

Note: `app.model.cycleBackward` uses `shift+ctrl+p` and does not conflict with this extension.

## Usage

Start Pi in terminal UI (TUI) mode.
The editor component replaces the standard input editor automatically.
Press `ctrl+p` in the chat input to display available slash commands.
