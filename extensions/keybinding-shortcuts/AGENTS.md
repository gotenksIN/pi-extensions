# Keybinding Shortcuts Agent Guide

Read `README.md` before you modify this extension.
Keep code changes, `README.md`, and keybinding instructions consistent.

## Purpose

This extension provides a custom TUI editor component for Pi.
It intercepts terminal keypresses to provide OpenCode-style editor shortcuts.

## Code Responsibilities

`index.ts` is the single module for this extension:

- `KeybindingShortcutsEditor`: Extends `CustomEditor` from `@earendil-works/pi-coding-agent`.
- Overrides `handleInput(data: string)` to map terminal input sequences:
  - `ctrl+p` -> Feeds `/` to trigger the built-in slash-command menu.
  - `ctrl+backspace` or `0x08` -> Feeds `\x1b\x7f` (Alt+Backspace) for backward word deletion.
  - `ctrl+delete` -> Feeds `\x1b[3;3~` (Alt+Delete) for forward word deletion.
  - Fallback -> Passes unmodified input to `super.handleInput(data)`.
- Extension Export: Attaches to the `session_start` event.
- Replaces the TUI editor component via `ctx.ui.setEditorComponent` when `ctx.mode === "tui"`.

## Implementation Invariants

Follow these rules when you maintain `index.ts`:

- Only set the custom editor component when `ctx.mode === "tui"`.
- Preserve the fallback call `super.handleInput(data)` for all unmatched input.
- Do not introduce filesystem, network, or process operations in input handlers.
- Use `matchesKey` from `@earendil-works/pi-tui` for terminal sequence matching.
