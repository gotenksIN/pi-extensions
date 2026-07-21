import { unlinkSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("delete", {
    description: "Delete the current session file and start a new session",
    handler: async (_args, ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        ctx.ui.notify("No session file to delete (ephemeral session).", "info");
        return;
      }

      const confirmed = await ctx.ui.select(
        `Delete this session?\n\n  ${file}\n\nThis cannot be undone.`,
        ["No - keep it", "Yes - delete and start new"],
      );

      if (confirmed !== "Yes - delete and start new") return;

      await ctx.waitForIdle();
      unlinkSync(file);
      ctx.ui.notify(`Deleted: ${file}`, "info");
      await ctx.newSession({});
    },
  });
}
