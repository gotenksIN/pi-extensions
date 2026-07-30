export type FileAccess = "none" | "read" | "write";
export type RequestedAccess = Exclude<FileAccess, "none">;

/** Filesystem rules exactly as written in configuration. */
export type RawFilesystemRules = Readonly<Record<string, FileAccess>>;

declare const compiledPolicyBrand: unique symbol;
/** Canonical, absolute filesystem policy produced only by policy compilation. */
export type CompiledFilesystemPolicy = Readonly<Record<string, FileAccess>> & {
  readonly [compiledPolicyBrand]: true;
};

export type ClassifierReasoning = "none" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ClassifierStageConfig {
  readonly model: string;
  readonly reasoning: ClassifierReasoning;
}

export interface ClassifierPairConfig {
  readonly provider: string;
  readonly stage1: ClassifierStageConfig;
  readonly stage2: ClassifierStageConfig;
}

export interface ClassifierConfig {
  readonly enabled: boolean;
  readonly pairs: readonly ClassifierPairConfig[];
  readonly stage1TimeoutMs: number;
  readonly stage2TimeoutMs: number;
  readonly maxRetries: number;
}

export interface RawSandboxConfig {
  readonly enabled: boolean;
  readonly filesystem: RawFilesystemRules;
  readonly isolateNetwork: boolean;
  readonly sshAgent: boolean;
  readonly classifier: ClassifierConfig;
}

export interface CompiledSandboxConfig {
  readonly enabled: boolean;
  readonly filesystem: CompiledFilesystemPolicy;
  readonly isolateNetwork: boolean;
  readonly sshAgent: boolean;
  readonly classifier: ClassifierConfig;
}

declare const approvedGrantBrand: unique symbol;
/** Canonical write grants explicitly approved by a human for this session. */
export interface ApprovedWriteGrants {
  readonly paths: readonly string[];
  readonly [approvedGrantBrand]: true;
}

export interface PrivateTempCapability {
  readonly kind: "private-temp";
  readonly path: string;
}

export interface TrustedRuntimeResources {
  readonly kind: "trusted-runtime-resources";
  readonly root: string;
  readonly deniedFile: string;
  readonly sshClientConfig: string;
  readonly sshClientConfigDestination: string;
}

export type SshAgentCapability =
  | { readonly kind: "ssh-agent"; readonly disposition: "enabled"; readonly socket: string }
  | { readonly kind: "ssh-agent"; readonly disposition: "masked"; readonly socket: string }
  | {
    readonly kind: "ssh-agent";
    readonly disposition: "unavailable";
    readonly requested: boolean;
    readonly reason: string;
  };

declare const runtimeCapabilitiesBrand: unique symbol;
/** Closed runtime resources constructed only by capabilities.ts. */
export interface RuntimeCapabilities {
  readonly resources: TrustedRuntimeResources;
  readonly privateTemp: PrivateTempCapability;
  readonly sshAgent: SshAgentCapability;
  readonly [runtimeCapabilitiesBrand]: true;
}

export type SshCapabilityStatus =
  | { readonly state: "enabled-mounted"; readonly socket: string }
  | { readonly state: "enabled-unavailable"; readonly reason: string }
  | { readonly state: "disabled-masked"; readonly socket: string }
  | { readonly state: "disabled"; readonly reason: string };

export type SandboxState = "disabled" | "ready" | "error";
export type PathKind = "directory" | "file" | "missing";
export type MountSourceType = "directory" | "file" | "socket";

export type MountOperation =
  | { readonly kind: "ensure-directory"; readonly path: string }
  | {
    readonly kind: "bind";
    readonly source: string;
    readonly destination: string;
    readonly sourceType: MountSourceType;
    readonly writable: boolean;
  }
  | { readonly kind: "mask-directory"; readonly path: string; readonly inaccessible: boolean }
  | { readonly kind: "mask-file"; readonly path: string; readonly source: string }
  | { readonly kind: "remount-readonly"; readonly path: string };
