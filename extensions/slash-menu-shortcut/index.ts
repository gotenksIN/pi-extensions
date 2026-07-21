import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class SlashMenuShortcutEditor extends CustomEditor {
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+p")) {
      // Match the user's muscle memory for typing `/`: feed a literal slash
      // into the editor so Pi's built-in slash-command autocomplete opens.
      super.handleInput("/");
      return;
    }

    super.handleInput(data);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new SlashMenuShortcutEditor(tui, theme, keybindings));
  });
}
