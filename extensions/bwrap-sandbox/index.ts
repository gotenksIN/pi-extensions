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
      "Request missing write access for explicit paths and scopes. Do not request access when active policy or a current grant already provides it. Session mode accepts one path and asks for a persistent human-approved grant. One-shot mode requires bash and accepts either one path or an atomic paths list for that exact future model-generated Bash call. One-shot access does not create a session grant. Policy none entries and protected runtime paths can never be granted.",
    promptSnippet: "Request session or atomic one-shot write paths only when current sandbox access is insufficient",
    promptGuidelines: [
      "Request access only when active policy and current grants do not already provide all required write access. Account for explicit outputs and implicit tool cache paths.",
      "For one known Bash call, use one-shot mode and supply every required path with an explicit exact or parent scope. Use paths for multiple atomic writes.",
      "Use exact scope for content changes to an existing path.",
      "Use parent scope for operations that create, delete, rename, or move a directory entry. Do not grant the exact file first because an exact bind mount cannot be deleted or renamed during that session.",
      "Supply paths and scopes explicitly. Do not infer them from shell commands or assume configurable default locations.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "One target path, relative to the project or absolute. The target can be missing when scope is parent." })),
      paths: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ description: "Target path, relative to the project or absolute." }),
        scope: Type.Union([Type.Literal("exact"), Type.Literal("parent")]),
      }, { additionalProperties: false }), {
        description: "Atomic one-shot write paths. Each entry requires an explicit scope.",
        minItems: 1,
        maxItems: 16,
      })),
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
      const hasPath = typeof params.path === "string";
      const hasPaths = Array.isArray(params.paths);
      if (mode === "one-shot") {
        if (hasPath === hasPaths) throw new Error("sandbox_access mode one-shot requires exactly one of path or paths");
        if (!params.bash) throw new Error("sandbox_access mode one-shot requires bash input");
        if (hasPaths && params.scope !== undefined) {
          throw new Error("sandbox_access paths entries contain their own scopes; do not set top-level scope");
        }
        if (hasPath && !params.scope) throw new Error("sandbox_access singular one-shot mode requires an explicit scope");
        const requests = hasPaths
          ? params.paths!
          : [{ path: params.path!, scope: params.scope! }];
        const result = await session.requestOneShotWrites(
          requests,
          { toolCallId: id, input: params.bash, ctx },
        );
        const resolved = result.paths.map(({ requestedPath, path, scope, transient }) => ({
          requestedPath,
          path,
          scope,
          transient,
        }));
        const singularDetails = hasPath && result.paths[0]
          ? { path: result.paths[0].path, scope: result.paths[0].scope }
          : {};
        if (!result.prepared) {
          return {
            content: [{
              type: "text",
              text: "All requested paths are already writable. Run the Bash input normally so it receives normal safety classification.",
            }],
            details: { ...singularDetails, paths: resolved, mode, prepared: false },
          };
        }
        return {
          content: [{
            type: "text",
            text: `Prepared ${resolved.filter(({ transient }) => transient).length} one-shot write path(s). Run the exact Bash input next. These paths are not session grants.`,
          }],
          details: { ...singularDetails, paths: resolved, mode, prepared: true, authorizedBy: result.authorizedBy },
        };
      }

      if (!hasPath) throw new Error("sandbox_access session mode requires path");
      if (hasPaths) throw new Error("sandbox_access paths is available only in one-shot mode");
      const result = await session.requestPersistentWrite(
        params.path!,
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
