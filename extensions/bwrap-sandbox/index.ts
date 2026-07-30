import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSandboxCommands } from "./commands.ts";
import { authorizeDirectTool, isDirectFilesystemTool } from "./direct-gate.ts";
import { createSandboxSession } from "./session.ts";
import { requiresSafetyClassification } from "./safety-gate.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function sandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Explicitly disable the Linux Bubblewrap sandbox",
    type: "boolean",
    default: false,
  });

  const session = createSandboxSession();

  pi.registerTool({
    ...createBashTool(process.cwd()),
    label: "bash (Linux Bubblewrap)",
    async execute(id, params, signal, onUpdate) {
      const cwd = session.projectCwd();
      if (session.state() === "ready") session.consumeBashPermit(id, params);
      const bash = session.state() === "disabled"
        ? createBashTool(cwd)
        : createBashTool(cwd, { operations: session.operations() });
      return bash.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "sandbox_access",
    label: "Sandbox Write Access",
    description:
      "Request a human-approved write grant for one existing path for this session, then retry a Bubblewrap-blocked command. Policy none entries can never be granted.",
    promptSnippet: "Request a human-approved session write grant before retrying a blocked sandbox operation",
    promptGuidelines: [
      "Use sandbox_access with a specific existing path when Bubblewrap blocks a required write; do not infer authorization from shell command text.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Existing file or directory to make writable, relative to the project or absolute" }),
    }),
    async execute(_id, params) {
      const result = await session.requestPersistentWrite(params.path);
      const text = result.granted
        ? `Granted write access for this session: ${result.path}. Retry the command.`
        : `${result.path} is already writable.`;
      return {
        content: [{ type: "text", text }],
        details: { path: result.path, granted: result.granted },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await session.start(ctx, pi.getFlag("no-sandbox") as boolean);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await session.shutdown(ctx);
  });

  pi.on("user_bash", () => {
    if (session.state() === "disabled") return undefined;
    return { operations: session.operations() };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (session.state() === "disabled") return undefined;
    if (session.state() !== "ready") {
      return { block: true, reason: `Sandbox unavailable; refusing model tool execution: ${session.reason()}` };
    }

    try {
      if (requiresSafetyClassification(event.toolName)) {
        await session.authorizeBash(event.toolCallId, event.input, ctx);
        return undefined;
      }
      if (!isDirectFilesystemTool(event.toolName)) return undefined;
      const input = event.input as { path?: unknown };
      const rawPath = typeof input.path === "string" && input.path.length > 0
        ? input.path
        : session.projectCwd();
      await authorizeDirectTool(event.toolName, rawPath, session);
      return undefined;
    } catch (error) {
      return { block: true, reason: errorMessage(error) };
    }
  });

  registerSandboxCommands(pi, session);
}
