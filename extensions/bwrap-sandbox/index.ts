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
      const transientWritePaths = session.state() === "ready"
        ? session.consumeSafetyPermit(id, "bash", params)
        : [];
      const baseOperations = session.state() === "ready"
        ? session.operations(transientWritePaths)
        : undefined;
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
      "Request write access for an explicit path and scope. Session mode asks for a persistent human-approved grant. One-shot mode requires bash and can authorize only that exact future model-generated Bash call from recent user instructions or one human prompt. One-shot access does not create a session grant. Use parent scope for create, delete, rename, and move operations. Policy none entries and protected runtime paths can never be granted.",
    promptSnippet: "Request a session or one-shot write path before one known model-generated Bash operation",
    promptGuidelines: [
      "Request access before an operation when its required write path and scope are already known. Use one-shot mode with the exact Bash input for one known model-generated Bash call.",
      "Use exact scope for content changes to an existing path.",
      "Use parent scope for operations that create, delete, rename, or move a directory entry. Do not grant the exact file first because an exact bind mount cannot be deleted or renamed during that session.",
      "Supply path and scope explicitly. Do not infer them from shell or Git commands.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Target path, relative to the project or absolute. The target can be missing when scope is parent." }),
      mode: Type.Optional(Type.Union([
        Type.Literal("session"),
        Type.Literal("one-shot"),
      ], { description: "Create a human-approved session grant, or authorize one exact future Bash call. Default: session." })),
      scope: Type.Optional(Type.Union([
        Type.Literal("exact"),
        Type.Literal("parent"),
      ], { description: "Grant the exact path, or grant its parent directory for directory-entry changes. Default: exact." })),
      bash: Type.Optional(Type.Object({
        command: Type.String({ description: "Exact Bash command that will use this grant." }),
        timeout: Type.Optional(Type.Number({ description: "Exact Bash timeout in seconds, when the later Bash call uses one." })),
      }, { description: "Exact future Bash input. Required in one-shot mode. In session mode, it can combine grant and exact-call review." })),
    }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      const mode = params.mode ?? "session";
      const scope = params.scope ?? "exact";
      if (mode === "one-shot") {
        if (!params.scope) throw new Error("sandbox_access mode one-shot requires an explicit scope");
        if (!params.bash) throw new Error("sandbox_access mode one-shot requires bash input");
        const result = await session.requestOneShotWrite(
          params.path,
          scope,
          { toolCallId: id, input: params.bash, ctx },
        );
        return {
          content: [{
            type: "text",
            text: `Prepared one-shot write access for ${result.path}. Run the exact Bash input next. The path is not a session grant.`,
          }],
          details: { path: result.path, mode, scope, authorizedBy: result.authorizedBy },
        };
      }

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
        details: { path: result.path, mode, scope, granted: result.granted, bashApproved: result.bashApproved },
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
