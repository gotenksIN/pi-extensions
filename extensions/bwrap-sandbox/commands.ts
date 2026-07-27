import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ManualTestExecution, SessionStatusSnapshot } from "./session.ts";

export interface CommandSession {
  status(): SessionStatusSnapshot;
  manualTestExecution(): ManualTestExecution;
}

function formatStatus(status: SessionStatusSnapshot): string {
  const capability = status.sshCapability;
  const ssh = capability?.state === "enabled-mounted"
    ? `enabled and mounted (${capability.socket})`
    : capability?.state === "enabled-unavailable"
      ? `enabled but unavailable (${capability.reason})`
      : capability?.state === "disabled-masked"
        ? `disabled; exact inherited socket masked (${capability.socket})`
        : capability?.state === "disabled"
          ? `disabled (${capability.reason})`
          : status.sshAgent
            ? "enabled, but runtime capability status is unavailable"
            : "disabled; runtime capability status is unavailable";
  return [
    `Bubblewrap sandbox: ${status.state.toUpperCase()}`,
    `Reason: ${status.reason}`,
    `Bubblewrap: ${status.bwrapExecutable ?? "not available"}`,
    `Project: ${status.projectCwd}`,
    `Network isolation: ${status.isolateNetwork === undefined ? "unknown" : status.isolateNetwork ? "enabled" : "disabled"}`,
    `SSH agent capability: ${ssh}`,
    `Private TMPDIR: ${status.tempDirectory ?? "not active"}`,
    "Filesystem policy (unmatched paths are read-only):",
    ...(status.policy.length ? status.policy.map(([path, access]) => `  ${access}: ${path}`) : ["  (unavailable)"]),
    "Session grants:",
    ...(status.grants.length ? status.grants.map((path) => `  write: ${path}`) : ["  (none)"]),
    "Direct read/write/edit/grep/find/ls checks are application-level permission gates, not OS containment.",
  ].join("\n");
}

export function registerSandboxCommands(pi: ExtensionAPI, session: CommandSession): void {
  pi.registerCommand("sandbox", {
    description: "Show Linux Bubblewrap sandbox status and policy",
    handler: async (_args, ctx) => {
      const status = session.status();
      ctx.ui.notify(formatStatus(status), status.state === "error" ? "error" : "info");
    },
  });

  pi.registerCommand("sandbox-test", {
    description: "Run sandbox unit and Linux Bubblewrap integration tests",
    handler: async (_args, ctx) => {
      try {
        const { runSandboxTestCommand } = await import("./tests/command.ts");
        const result = await runSandboxTestCommand(session.manualTestExecution());
        ctx.ui.notify(result.summary, result.failed ? "error" : "info");
      } catch (error) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        ctx.ui.notify(`Sandbox tests could not run:\n${detail}`, "error");
      }
    },
  });
}
