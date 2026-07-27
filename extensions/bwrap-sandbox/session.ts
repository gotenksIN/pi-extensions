import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createApprovalChannel, type ApprovalChannel } from "./approval.ts";
import { sshCapabilityStatus } from "./capabilities.ts";
import { loadConfig } from "./config.ts";
import {
  addApprovedGrant,
  approvedGrantPaths,
  emptyApprovedGrants,
  validateDirectWrite,
  validatePersistentGrant,
  type GrantContext,
} from "./grants.ts";
import { effectiveAccess, resolveExistingPath } from "./policy.ts";
import { BubblewrapRuntime, findTrustedBwrap, probeBwrap } from "./runtime.ts";
import type {
  ApprovedWriteGrants,
  CompiledSandboxConfig,
  FileAccess,
  SandboxState,
  SshCapabilityStatus,
} from "./types.ts";

interface ErrorState {
  readonly kind: "error";
  readonly reason: string;
  readonly projectCwd: string;
  readonly config?: CompiledSandboxConfig;
}

interface DisabledState {
  readonly kind: "disabled";
  readonly reason: string;
  readonly projectCwd: string;
  readonly config: CompiledSandboxConfig;
}

interface ReadyState {
  readonly kind: "ready";
  readonly reason: "active";
  readonly projectCwd: string;
  readonly config: CompiledSandboxConfig;
  readonly grants: ApprovedWriteGrants;
  readonly runtime: BubblewrapRuntime;
  readonly bwrapExecutable: string;
}

type LifecycleState = ErrorState | DisabledState | ReadyState;

export interface SessionStatusSnapshot {
  readonly state: SandboxState;
  readonly reason: string;
  readonly projectCwd: string;
  readonly bwrapExecutable?: string;
  readonly isolateNetwork?: boolean;
  readonly sshAgent?: boolean;
  readonly sshCapability?: SshCapabilityStatus;
  readonly tempDirectory?: string;
  readonly policy: readonly (readonly [string, FileAccess])[];
  readonly grants: readonly string[];
}

export interface PersistentGrantResult {
  readonly path: string;
  readonly granted: boolean;
}

export interface ManualTestExecution {
  readonly projectCwd: string;
  readonly unavailableReason?: string;
  exec?(command: string, onData: (data: Buffer) => void): Promise<{ exitCode: number | null }>;
}

export interface SandboxSession {
  start(ctx: ExtensionContext, explicitlyDisabled: boolean): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  state(): SandboxState;
  reason(): string;
  projectCwd(): string;
  operations(): BashOperations;
  authorizeDirectRead(toolName: string, rawPath: string): void;
  authorizeDirectWrite(toolName: string, rawPath: string): Promise<void>;
  requestPersistentWrite(rawPath: string): Promise<PersistentGrantResult>;
  status(): SessionStatusSnapshot;
  manualTestExecution(): ManualTestExecution;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableOperations(reason: string): BashOperations {
  return { async exec() { throw new Error(`Sandbox unavailable; refusing unsandboxed bash: ${reason}`); } };
}

class Session implements SandboxSession {
  private readonly home = homedir();
  private readonly approval: ApprovalChannel = createApprovalChannel();
  private current: LifecycleState = {
    kind: "error",
    reason: "session has not started",
    projectCwd: process.cwd(),
  };

  state(): SandboxState { return this.current.kind; }
  reason(): string { return this.current.reason; }
  projectCwd(): string { return this.current.projectCwd; }

  async start(ctx: ExtensionContext, explicitlyDisabled: boolean): Promise<void> {
    const previous = this.current.kind === "ready" ? this.current.runtime : undefined;
    this.current = { kind: "error", reason: "initializing", projectCwd: ctx.cwd };
    this.approval.detach();
    await previous?.shutdown();
    this.approval.attach(ctx);

    let config: CompiledSandboxConfig | undefined;
    let projectCwd = ctx.cwd;
    let runtime: BubblewrapRuntime | undefined;
    try {
      projectCwd = resolveExistingPath(ctx.cwd, { cwd: ctx.cwd, home: this.home });
      config = loadConfig(
        projectCwd,
        this.home,
        {
          global: join(getAgentDir(), "extensions", "sandbox.json"),
          project: join(projectCwd, CONFIG_DIR_NAME, "sandbox.json"),
        },
        ctx.isProjectTrusted(),
      );

      if (explicitlyDisabled || !config.enabled) {
        const reason = explicitlyDisabled
          ? "explicitly disabled by --no-sandbox"
          : "explicitly disabled by configuration";
        this.current = { kind: "disabled", reason, projectCwd, config };
        ctx.ui.setStatus("sandbox", undefined);
        ctx.ui.notify(`Sandbox ${reason}`, "warning");
        return;
      }
      if (process.platform !== "linux") throw new Error(`Linux is required; current platform is ${process.platform}`);

      const bwrapExecutable = findTrustedBwrap(config.filesystem);
      if (!bwrapExecutable) throw new Error("no trusted root-owned Bubblewrap executable was found");
      await probeBwrap(bwrapExecutable);
      runtime = new BubblewrapRuntime(bwrapExecutable, config);
      this.current = {
        kind: "ready",
        reason: "active",
        projectCwd,
        config,
        grants: emptyApprovedGrants(),
        runtime,
        bwrapExecutable,
      };
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "bwrap sandbox active"));
      const ssh = sshCapabilityStatus(runtime.capabilities);
      const sshSummary = ssh.state === "enabled-mounted"
        ? "SSH agent capability is enabled and mounted"
        : ssh.state === "enabled-unavailable"
          ? `SSH agent capability is enabled but unavailable: ${ssh.reason}`
          : ssh.state === "disabled-masked"
            ? "SSH agent capability is disabled and the inherited socket is masked"
            : "SSH agent capability is disabled";
      ctx.ui.notify(
        `Linux Bubblewrap sandbox initialized. Network isolation is ${config.isolateNetwork ? "enabled" : "disabled"}. ${sshSummary}.`,
        ssh.state === "enabled-unavailable" ? "warning" : "info",
      );
    } catch (error) {
      await runtime?.shutdown();
      this.current = { kind: "error", reason: errorMessage(error), projectCwd, ...(config ? { config } : {}) };
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "bwrap sandbox error"));
      ctx.ui.notify(`Sandbox initialization failed closed: ${this.current.reason}`, "error");
    }
  }

  async shutdown(ctx: ExtensionContext): Promise<void> {
    const runtime = this.current.kind === "ready" ? this.current.runtime : undefined;
    this.current = { kind: "error", reason: "session is shutting down", projectCwd: this.current.projectCwd };
    this.approval.detach();
    await runtime?.shutdown();
    ctx.ui.setStatus("sandbox", undefined);
  }

  operations(): BashOperations {
    return this.current.kind === "ready"
      ? this.current.runtime.operations(this.current.grants)
      : unavailableOperations(this.current.reason);
  }

  private ready(): ReadyState {
    if (this.current.kind !== "ready") throw new Error(`Sandbox access is unavailable: ${this.current.reason}`);
    return this.current;
  }

  private grantContext(state: ReadyState): GrantContext {
    return {
      cwd: state.projectCwd,
      home: this.home,
      policy: state.config.filesystem,
      protectedPaths: state.runtime.protectedPaths,
    };
  }

  authorizeDirectRead(toolName: string, rawPath: string): void {
    const state = this.ready();
    const path = resolveExistingPath(rawPath, { cwd: state.projectCwd, home: this.home });
    if (effectiveAccess(path, state.config.filesystem, state.grants.paths) === "none") {
      throw new Error(`Sandbox policy denies ${toolName} access to ${path}`);
    }
  }

  async authorizeDirectWrite(toolName: string, rawPath: string): Promise<void> {
    let state = this.ready();
    const context = this.grantContext(state);
    const admission = validateDirectWrite(rawPath, context, state.grants);
    if (admission.alreadyWritable) return;

    const choice = await this.approval.request(
      [
        `Direct tool ${toolName} requests write access.`,
        `Requested path: ${rawPath}`,
        `Resolved path: ${admission.path}`,
        "This is an application-level permission gate, not OS containment.",
      ].join("\n"),
      ["No - block", "Yes - allow once", "Yes - grant path for session", "Yes - grant parent for session"],
    );
    if (!choice || choice.startsWith("No")) {
      throw new Error(`Sandbox denied ${toolName} access to ${admission.path}`);
    }

    state = this.ready();
    if (choice === "Yes - allow once") {
      validateDirectWrite(admission.path, this.grantContext(state), state.grants);
      return;
    }

    const grantPath = choice.includes("parent") ? dirname(admission.path) : admission.path;
    const next = addApprovedGrant(state.grants, grantPath, this.grantContext(state));
    this.current = { ...state, grants: next };
    this.approval.notify(`Sandbox granted write access for this session: ${grantPath}`);
  }

  async requestPersistentWrite(rawPath: string): Promise<PersistentGrantResult> {
    let state = this.ready();
    const admission = validatePersistentGrant(rawPath, this.grantContext(state), state.grants);
    if (admission.alreadyWritable) return { path: admission.path, granted: false };

    const choice = await this.approval.request(
      [
        "The model requests write access for this session.",
        `Requested path: ${rawPath}`,
        `Resolved path: ${admission.path}`,
        "This grant will apply to later Bash calls and direct Pi filesystem tools.",
      ].join("\n"),
      ["No - block", "Yes - grant write access for this session"],
    );
    if (!choice || choice.startsWith("No")) throw new Error(`Sandbox access denied for ${admission.path}`);

    state = this.ready();
    const next = addApprovedGrant(state.grants, admission.path, this.grantContext(state));
    this.current = { ...state, grants: next };
    this.approval.notify(`Sandbox granted write access for this session: ${admission.path}`);
    return { path: admission.path, granted: true };
  }

  status(): SessionStatusSnapshot {
    const state = this.current;
    const config = state.config;
    return {
      state: state.kind,
      reason: state.reason,
      projectCwd: state.projectCwd,
      ...(state.kind === "ready" ? {
        bwrapExecutable: state.bwrapExecutable,
        sshCapability: sshCapabilityStatus(state.runtime.capabilities),
        tempDirectory: state.runtime.tempDirectory,
      } : {}),
      ...(config ? { isolateNetwork: config.isolateNetwork, sshAgent: config.sshAgent } : {}),
      policy: config ? Object.entries(config.filesystem) : [],
      grants: state.kind === "ready" ? approvedGrantPaths(state.grants) : [],
    };
  }

  manualTestExecution(): ManualTestExecution {
    const state = this.current;
    if (state.kind !== "ready") {
      return { projectCwd: state.projectCwd, unavailableReason: state.reason };
    }
    const operations = state.runtime.operations(state.grants);
    return {
      projectCwd: state.projectCwd,
      exec: (command, onData) => operations.exec(command, state.projectCwd, {
        env: process.env,
        onData,
        timeout: 30,
      }),
    };
  }
}

export function createSandboxSession(): SandboxSession {
  return new Session();
}
