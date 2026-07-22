import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class KeybindingShortcutsEditor extends CustomEditor {
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+p")) {
      // Match the user's muscle memory for typing `/`: feed a literal slash
      // into the editor so Pi's built-in slash-command autocomplete opens.
      super.handleInput("/");
      return;
    }

    // Most Linux terminals encode Ctrl+Backspace as BS (0x08), which Pi
    // intentionally treats as ambiguous. Plain Backspace is normally DEL (0x7f).
    if (matchesKey(data, "ctrl+backspace") || data === "\x08") {
      // Reuse Pi's built-in Alt+Backspace word-deletion behavior.
      super.handleInput("\x1b\x7f");
      return;
    }

    if (matchesKey(data, "ctrl+delete")) {
      // Use the modifier-aware Alt+Delete sequence. A legacy Alt+D sequence is
      // ignored while Kitty keyboard protocol is active.
      super.handleInput("\x1b[3;3~");
      return;
    }

    super.handleInput(data);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new KeybindingShortcutsEditor(tui, theme, keybindings));
  });
}
