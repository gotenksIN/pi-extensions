import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+p", {
    description: "Open slash command menu",
    handler: async (ctx) => {
      // Match the user's muscle memory for typing `/`: insert a literal slash
      // into the focused editor so Pi's built-in slash-command autocomplete
      // opens normally and keeps all built-in command/menu behavior.
      ctx.ui.pasteToEditor("/");
    },
  });
}
