import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { selectApprovalOverlay } from "./approval-ui.ts";
import { registerSandboxCommands } from "./commands.ts";
import { authorizeDirectTool, isDirectFilesystemTool } from "./direct-gate.ts";
import { sandboxDisableSource } from "./process-state.ts";
import { createSandboxSession } from "./session.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function sandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Explicitly disable the Linux Bubblewrap sandbox",
    type: "boolean",
    default: false,
  });

  const session = createSandboxSession(selectApprovalOverlay);

  const initialRead = createReadTool(process.cwd());
  pi.registerTool({
    ...initialRead,
    async execute(id, params, signal, onUpdate) {
      if (session.state() === "ready") session.consumeSafetyPermit(id, "read", params);
      return createReadTool(session.projectCwd()).execute(id, params, signal, onUpdate);
    },
  });

  const initialGrep = createGrepTool(process.cwd());
  pi.registerTool({
    ...initialGrep,
    async execute(id, params, signal, onUpdate) {
      if (session.state() === "ready") session.consumeSafetyPermit(id, "grep", params);
      return createGrepTool(session.projectCwd()).execute(id, params, signal, onUpdate);
    },
  });

  const initialWrite = createWriteTool(process.cwd());
  pi.registerTool({
    ...initialWrite,
    async execute(id, params, signal, onUpdate) {
      if (session.state() === "ready") session.consumeSafetyPermit(id, "write", params);
      return createWriteTool(session.projectCwd()).execute(id, params, signal, onUpdate);
    },
  });

  const initialEdit = createEditTool(process.cwd());
  pi.registerTool({
    ...initialEdit,
    async execute(id, params, signal, onUpdate) {
      if (session.state() === "ready") session.consumeSafetyPermit(id, "edit", params);
      return createEditTool(session.projectCwd()).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createBashTool(process.cwd()),
    label: "bash (Linux Bubblewrap)",
    async execute(id, params, signal, onUpdate) {
      const cwd = session.projectCwd();
      if (session.state() === "ready") session.consumeSafetyPermit(id, "bash", params);
      const baseOperations = session.state() === "ready" ? session.operations() : undefined;
      const bash = session.state() === "disabled"
        ? createBashTool(cwd)
        : createBashTool(cwd, {
          operations: {
            async exec(command, execCwd, options) {
              const result = await baseOperations!.exec(command, execCwd, options);
              if (session.state() === "ready") session.recordBashResult(params, result.exitCode);
              return result;
            },
          },
        });
      return bash.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "sandbox_access",
    label: "Sandbox Write Access",
    description:
      "Request a human-approved exact-path or parent-directory write grant before a known write or after Bubblewrap blocks one. Include bash to classify and approve one exact future Bash call in the same prompt. A grant after a failed approved Bash call can also authorize one exact retry. Use parent scope for create, delete, rename, and move operations. Policy none entries can never be granted.",
    promptSnippet: "Request a human-approved session write grant before a known write or after a blocked sandbox operation",
    promptGuidelines: [
      "Request access before an operation when its required write path and scope are already known. Include the exact Bash input when the grant is for one known Bash call.",
      "Use exact scope for content changes to an existing path.",
      "Use parent scope for operations that create, delete, rename, or move a directory entry. Do not grant the exact file first because an exact bind mount cannot be deleted or renamed during that session.",
      "Do not infer authorization from shell command text. Request only the narrow path and scope that the operation requires.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Target path, relative to the project or absolute. The target can be missing when scope is parent." }),
      scope: Type.Optional(Type.Union([
        Type.Literal("exact"),
        Type.Literal("parent"),
      ], { description: "Grant the exact path, or grant its parent directory for directory-entry changes. Default: exact." })),
      bash: Type.Optional(Type.Object({
        command: Type.String({ description: "Exact Bash command that will use this grant." }),
        timeout: Type.Optional(Type.Number({ description: "Exact Bash timeout in seconds, when the later Bash call uses one." })),
      }, { description: "Classify and approve one exact future Bash call together with this grant." })),
    }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "exact";
      const result = await session.requestPersistentWrite(
        params.path,
        scope,
        params.bash ? { toolCallId: id, input: params.bash, ctx } : undefined,
      );
      const text = result.granted
        ? result.bashApproved
          ? params.bash
            ? `Granted write access for this session: ${result.path}. Run the exact Bash command once without another classifier review.`
            : `Granted write access for this session: ${result.path}. Retry the exact failed Bash command once without another classifier review.`
          : `Granted write access for this session: ${result.path}. Retry the command.`
        : `${result.path} is already writable.`;
      return {
        content: [{ type: "text", text }],
        details: { path: result.path, scope, granted: result.granted, bashApproved: result.bashApproved },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const explicit = pi.getFlag("no-sandbox") as boolean;
    await session.start(ctx, sandboxDisableSource(explicit));
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
      if (event.toolName === "bash") {
        await session.authorizeBash(event.toolCallId, event.input, ctx);
        return undefined;
      }
      if (!isDirectFilesystemTool(event.toolName)) return undefined;
      const input = event.input as { path?: unknown };
      const rawPath = typeof input.path === "string" && input.path.length > 0
        ? input.path
        : session.projectCwd();
      await authorizeDirectTool(event.toolCallId, event.toolName, rawPath, event.input, session, ctx);
      return undefined;
    } catch (error) {
      return { block: true, reason: errorMessage(error) };
    }
  });

  registerSandboxCommands(pi, session);
}
