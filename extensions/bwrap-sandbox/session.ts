import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createApprovalChannel, type ApprovalChannel, type ApprovalSelector } from "./approval.ts";
import { sshCapabilityStatus } from "./capabilities.ts";
import { loadConfig } from "./config.ts";
import {
  addApprovedGrant,
  approvedGrantPaths,
  emptyApprovedGrants,
  validateDirectWrite,
  validatePersistentGrantRequest,
  type GrantContext,
  type GrantScope,
} from "./grants.ts";
import {
  buildDirectAccessAssessment,
  isSecretCheckedTool,
} from "./direct-secret-evidence.ts";
import type { SandboxDisableSource } from "./process-state.ts";
import { effectiveAccess, resolveExistingPath } from "./policy.ts";
import { BubblewrapRuntime, findTrustedBwrap, probeBwrap } from "./runtime.ts";
import { SafetyGate } from "./safety-gate.ts";
import type { ClassifierStatus } from "./classifier.ts";
import type { ClassifierModelRegistry } from "./classifier-provider.ts";
import type {
  ApprovedWriteGrants,
  ClassifierConfig,
  CompiledSandboxConfig,
  FileAccess,
  SandboxDirectoryStatus,
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
  readonly sandboxDirectory?: SandboxDirectoryStatus;
  readonly policy: readonly (readonly [string, FileAccess])[];
  readonly grants: readonly string[];
  readonly classifier?: ClassifierStatus;
}

export interface PersistentGrantResult {
  readonly path: string;
  readonly granted: boolean;
  readonly bashApproved: boolean;
}

export interface ProactiveBashAccess {
  readonly toolCallId: string;
  readonly input: unknown;
  readonly ctx: ExtensionContext;
}

export interface ManualTestExecution {
  readonly projectCwd: string;
  readonly unavailableReason?: string;
  exec?(command: string, onData: (data: Buffer) => void): Promise<{ exitCode: number | null }>;
}

export interface SandboxSession {
  start(ctx: ExtensionContext, disableSource: SandboxDisableSource): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  state(): SandboxState;
  reason(): string;
  projectCwd(): string;
  operations(): BashOperations;
  authorizeDirectRead(
    toolCallId: string,
    toolName: string,
    rawPath: string,
    input: unknown,
    ctx: ExtensionContext,
  ): Promise<void>;
  authorizeDirectWrite(
    toolCallId: string,
    toolName: string,
    rawPath: string,
    input: unknown,
    ctx: ExtensionContext,
  ): Promise<void>;
  authorizeBash(toolCallId: string, input: unknown, ctx: ExtensionContext): Promise<void>;
  consumeSafetyPermit(toolCallId: string, toolName: string, input: unknown): void;
  recordBashResult(input: unknown, exitCode: number | null): void;
  requestPersistentWrite(
    rawPath: string,
    scope: GrantScope,
    proactiveBash?: ProactiveBashAccess,
  ): Promise<PersistentGrantResult>;
  status(): SessionStatusSnapshot;
  classifierTestConfig(): ClassifierConfig | undefined;
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
  private readonly approval: ApprovalChannel;
  private safetyGate: SafetyGate | undefined;
  private current: LifecycleState = {
    kind: "error",
    reason: "session has not started",
    projectCwd: process.cwd(),
  };

  constructor(approvalSelector?: ApprovalSelector) {
    this.approval = createApprovalChannel(approvalSelector);
  }

  state(): SandboxState { return this.current.kind; }
  reason(): string { return this.current.reason; }
  projectCwd(): string { return this.current.projectCwd; }

  async start(ctx: ExtensionContext, disableSource: SandboxDisableSource): Promise<void> {
    const previous = this.current.kind === "ready" ? this.current.runtime : undefined;
    this.current = { kind: "error", reason: "initializing", projectCwd: ctx.cwd };
    this.approval.detach();
    this.safetyGate?.stop();
    this.safetyGate = undefined;
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

      if (disableSource !== "none" || !config.enabled) {
        const reason = disableSource === "cli"
          ? "explicitly disabled by --no-sandbox"
          : disableSource === "parent-cli"
            ? "disabled because the parent Pi process uses --no-sandbox"
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
      this.safetyGate = new SafetyGate(
        config.classifier,
        ctx.modelRegistry as unknown as ClassifierModelRegistry,
      );
      const classifier = await this.safetyGate.start();
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "bwrap sandbox active"));
      if (classifier.state === "unavailable") {
        ctx.ui.notify(
          "Bash safety classification is unavailable. Model-generated Bash calls will require human review. Set classifier.pairs in the global sandbox configuration. Set the provider, model, and reasoning level for both stages.",
          "warning",
        );
      } else if (classifier.state === "disabled") {
        ctx.ui.notify("Safety classification is disabled by global configuration. Bubblewrap remains active.", "warning");
      }
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
    this.safetyGate?.stop();
    this.safetyGate = undefined;
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

  authorizeDirectRead(
    toolCallId: string,
    toolName: string,
    rawPath: string,
    input: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    return this.authorizeDirectReadAsync(toolCallId, toolName, rawPath, input, ctx);
  }

  private async authorizeDirectReadAsync(
    toolCallId: string,
    toolName: string,
    rawPath: string,
    input: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    const state = this.ready();
    const path = resolveExistingPath(rawPath, { cwd: state.projectCwd, home: this.home });
    if (effectiveAccess(path, state.config.filesystem, state.grants.paths) === "none") {
      throw new Error(`Sandbox policy denies ${toolName} access to ${path}`);
    }
    if (!isSecretCheckedTool(toolName)) return;
    const gate = this.safetyGate;
    if (!gate) throw new Error("Safety permit service is unavailable");
    const assessment = buildDirectAccessAssessment(toolName, input, path, state.projectCwd);
    if (assessment.reviewReasons.length > 0) {
      const choice = await this.approval.request(
        [
          `Direct ${toolName} access requires human review.`,
          `Requested path: ${rawPath}`,
          `Resolved path: ${path}`,
          "Safety triggers:",
          ...assessment.reviewReasons.map((reason) => `- ${reason}`),
          "This approval applies to this exact call only.",
        ].join("\n"),
        ["No - block", `Yes - allow this ${toolName} (single-use)`],
      );
      if (choice !== `Yes - allow this ${toolName} (single-use)`) {
        throw new Error(`Deterministic safety checks blocked the ${toolName} action`);
      }
      if (ctx.signal?.aborted) throw new Error("Direct tool review was cancelled");
      this.ready();
      if (this.safetyGate !== gate) throw new Error("Safety approval expired because the session changed");
    }
    gate.approveOnce(toolCallId, toolName, input, state.projectCwd);
  }

  async authorizeDirectWrite(
    toolCallId: string,
    toolName: string,
    rawPath: string,
    input: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    let state = this.ready();
    const admission = validateDirectWrite(rawPath, this.grantContext(state), state.grants);
    const gate = this.safetyGate;
    if (!gate) throw new Error("Safety permit service is unavailable");
    const assessment = isSecretCheckedTool(toolName)
      ? buildDirectAccessAssessment(toolName, input, admission.path, state.projectCwd)
      : undefined;
    const needsSafetyReview = assessment !== undefined && assessment.reviewReasons.length > 0;
    if (!needsSafetyReview && admission.alreadyWritable) {
      if (assessment) gate.approveOnce(toolCallId, toolName, input, state.projectCwd);
      return;
    }

    const choices = admission.alreadyWritable
      ? ["No - block", "Yes - allow this write (single-use)"]
      : ["No - block", "Yes - allow this write (single-use)", "Yes - grant path for session", "Yes - grant parent for session"];
    const choice = await this.approval.request(
      [
        needsSafetyReview
          ? `Direct tool ${toolName} requires safety review and write access.`
          : `Direct tool ${toolName} requests write access.`,
        `Requested path: ${rawPath}`,
        `Resolved path: ${admission.path}`,
        ...(assessment && assessment.reviewReasons.length > 0
          ? ["Safety triggers:", ...assessment.reviewReasons.map((reason) => `- ${reason}`)]
          : []),
      ].join("\n"),
      choices,
    );
    if (!choice || choice.startsWith("No")) {
      throw new Error(needsSafetyReview
        ? `Deterministic safety checks blocked the ${toolName} action`
        : `Sandbox denied ${toolName} access to ${admission.path}`);
    }
    if (ctx.signal?.aborted) throw new Error("Direct tool review was cancelled");

    state = this.ready();
    if (this.safetyGate !== gate) throw new Error("Safety approval expired because the session changed");
    if (assessment) gate.approveOnce(toolCallId, toolName, input, state.projectCwd);

    if (choice === "Yes - allow this write (single-use)") {
      validateDirectWrite(admission.path, this.grantContext(state), state.grants);
    } else {
      const grantPath = choice.includes("parent") ? dirname(admission.path) : admission.path;
      const next = addApprovedGrant(state.grants, grantPath, this.grantContext(state));
      this.current = { ...state, grants: next };
      this.approval.notify(`Sandbox granted write access for this session: ${grantPath}`);
    }
  }

  async authorizeBash(toolCallId: string, input: unknown, ctx: ExtensionContext): Promise<void> {
    const state = this.ready();
    const gate = this.safetyGate;
    if (!gate) throw new Error("Safety classification is unavailable");
    if (gate.authorizeBashRetry(toolCallId, input, state.projectCwd)) return;
    const result = await gate.authorize({
      branch: ctx.sessionManager.getBranch(),
      toolCallId,
      toolName: "bash",
      input,
      cwd: state.projectCwd,
      signal: ctx.signal,
    });
    if (!result.allowed) {
      if (ctx.signal?.aborted) throw new Error("Safety classification was cancelled");
      const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const command = typeof data.command === "string" ? data.command : JSON.stringify(input);
      const choice = await this.approval.request(
        [
          "The safety classifier requires human review for this Bash call.",
          `Command: ${command}`,
          `Classifier result: ${result.reason ?? "review required"}`,
          "This approval applies to this call only. Bubblewrap remains active.",
        ].join("\n"),
        ["No - block", "Yes - create a single-use Bash approval"],
      );
      if (choice !== "Yes - create a single-use Bash approval") {
        throw new Error(result.reason ?? "Safety classification blocked the Bash action");
      }
      if (ctx.signal?.aborted) throw new Error("Bash review was cancelled");
      this.ready();
      if (this.safetyGate !== gate) throw new Error("Safety approval expired because the session changed");
      gate.approveBashOnce(toolCallId, input, state.projectCwd);
      this.approval.notify("The user created a single-use Bash approval. Bubblewrap remains active.");
    }
  }

  consumeSafetyPermit(toolCallId: string, toolName: string, input: unknown): void {
    this.ready();
    const gate = this.safetyGate;
    if (!gate) throw new Error("Safety classification is unavailable");
    gate.consumePermit(toolCallId, toolName, input, this.projectCwd());
  }

  recordBashResult(input: unknown, exitCode: number | null): void {
    const state = this.ready();
    const gate = this.safetyGate;
    if (!gate) throw new Error("Safety classification is unavailable");
    gate.recordBashResult(input, state.projectCwd, exitCode);
  }

  async requestPersistentWrite(
    rawPath: string,
    scope: GrantScope,
    proactiveBash?: ProactiveBashAccess,
  ): Promise<PersistentGrantResult> {
    let state = this.ready();
    const gate = this.safetyGate;
    if (!gate) throw new Error("Safety classification is unavailable");
    const admission = validatePersistentGrantRequest(rawPath, scope, this.grantContext(state), state.grants);
    if (admission.alreadyWritable) return { path: admission.path, granted: false, bashApproved: false };

    const retry = proactiveBash ? undefined : gate.getPendingBashRetry();
    const proactiveResult = proactiveBash
      ? await gate.classify({
        branch: proactiveBash.ctx.sessionManager.getBranch(),
        toolCallId: proactiveBash.toolCallId,
        toolName: "bash",
        input: proactiveBash.input,
        cwd: state.projectCwd,
        signal: proactiveBash.ctx.signal,
      })
      : undefined;
    if (proactiveBash?.ctx.signal?.aborted) throw new Error("Proactive Bash classification was cancelled");
    this.ready();
    if (this.safetyGate !== gate) throw new Error("Sandbox approval expired because the session changed");

    const proactiveData = proactiveBash?.input && typeof proactiveBash.input === "object"
      ? proactiveBash.input as Record<string, unknown>
      : {};
    const proactiveCommand = typeof proactiveData.command === "string" ? proactiveData.command : undefined;
    const hasExactBash = proactiveCommand !== undefined || retry !== undefined;
    const grantOnly = "Yes - grant write access only";
    const grantAndRetry = "Yes - grant access and allow one exact Bash call";
    const choice = await this.approval.request(
      [
        proactiveResult && !proactiveResult.allowed
          ? "The exact Bash call requires safety review and write access."
          : "The model requests write access for this session.",
        `Requested path: ${rawPath}`,
        `Grant scope: ${scope}`,
        `Resolved grant path: ${admission.path}`,
        "This grant will apply to later Bash calls and direct Pi filesystem tools.",
        ...(proactiveCommand ? ["", `Exact Bash command: ${proactiveCommand}`] : []),
        ...(proactiveResult && !proactiveResult.allowed
          ? [`Classifier result: ${proactiveResult.reason ?? "review required"}`]
          : []),
        ...(retry ? ["", "The last approved Bash call failed.", `Exact retry command: ${retry.command}`] : []),
      ].join("\n"),
      hasExactBash
        ? ["No - block", grantOnly, grantAndRetry]
        : ["No - block", "Yes - grant write access for this session"],
    );
    if (!choice || choice.startsWith("No")) {
      if (retry) gate.discardPendingBashRetry(retry.digest);
      throw new Error(`Sandbox access denied for ${admission.path}`);
    }

    state = this.ready();
    if (this.safetyGate !== gate) throw new Error("Sandbox approval expired because the session changed");
    const next = addApprovedGrant(state.grants, admission.path, this.grantContext(state));
    const bashApproved = choice === grantAndRetry;
    if (bashApproved) {
      if (proactiveBash) gate.approveExactBashRetry(proactiveBash.input, state.projectCwd);
      else if (!retry || !gate.approvePendingBashRetry(retry.digest)) {
        throw new Error("The exact Bash retry approval expired before the grant was applied");
      }
    }
    if (!bashApproved && retry) gate.discardPendingBashRetry(retry.digest);
    this.current = { ...state, grants: next };
    this.approval.notify(`Sandbox granted write access for this session: ${admission.path}`);
    return { path: admission.path, granted: true, bashApproved };
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
      ...(config ? {
        isolateNetwork: config.isolateNetwork,
        sshAgent: config.sshAgent,
        sandboxDirectory: config.sandboxDirectory,
      } : {}),
      policy: config ? Object.entries(config.filesystem) : [],
      grants: state.kind === "ready" ? approvedGrantPaths(state.grants) : [],
      ...(this.safetyGate ? { classifier: this.safetyGate.status() } : {}),
    };
  }

  classifierTestConfig(): ClassifierConfig | undefined {
    return this.current.config?.classifier;
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

export function createSandboxSession(approvalSelector?: ApprovalSelector): SandboxSession {
  return new Session(approvalSelector);
}
