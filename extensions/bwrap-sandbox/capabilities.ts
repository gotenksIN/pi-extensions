import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { effectiveAccess } from "./policy.ts";
import type {
  CompiledSandboxConfig,
  RuntimeCapabilities,
  SshAgentCapability,
  SshCapabilityStatus,
} from "./types.ts";

interface CapabilityStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
}

export interface CapabilityFilesystem {
  realpath(path: string): string;
  lstat(path: string): CapabilityStat;
}

const nodeFilesystem: CapabilityFilesystem = {
  realpath(path) { return realpathSync(path); },
  lstat(path) { return lstatSync(path); },
};

export const SSH_CLIENT_CONFIG_DESTINATION = "/etc/ssh/ssh_config";

export interface CapabilityConstructionInput {
  readonly resourceRootPath: string;
  readonly privateTempPath: string;
  readonly deniedFilePath: string;
  readonly sshClientConfigPath: string;
  readonly config: CompiledSandboxConfig;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly filesystem?: CapabilityFilesystem;
}

interface SocketDiscovery {
  readonly socket?: string;
  readonly reason?: string;
}

function discoverInheritedSocket(
  environment: NodeJS.ProcessEnv,
  filesystem: CapabilityFilesystem,
): SocketDiscovery {
  const inherited = environment.SSH_AUTH_SOCK;
  if (!inherited) return { reason: "inherited SSH_AUTH_SOCK is not set" };
  if (!isAbsolute(inherited)) return { reason: "inherited SSH_AUTH_SOCK is not an absolute path" };

  let canonical: string;
  try {
    canonical = filesystem.realpath(inherited);
  } catch (error) {
    return {
      reason: `inherited SSH_AUTH_SOCK is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isAbsolute(canonical)) return { reason: "canonical SSH_AUTH_SOCK is not an absolute path" };

  try {
    if (!filesystem.lstat(canonical).isSocket()) {
      return { reason: `inherited SSH_AUTH_SOCK is not a socket: ${canonical}` };
    }
  } catch (error) {
    return {
      reason: `inherited SSH_AUTH_SOCK cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { socket: canonical };
}

function constructSshCapability(
  config: CompiledSandboxConfig,
  environment: NodeJS.ProcessEnv,
  filesystem: CapabilityFilesystem,
): SshAgentCapability {
  const discovery = discoverInheritedSocket(environment, filesystem);
  if (!discovery.socket) {
    return {
      kind: "ssh-agent",
      disposition: "unavailable",
      requested: config.sshAgent,
      reason: discovery.reason ?? "inherited SSH agent socket is unavailable",
    };
  }

  const socket = discovery.socket;
  if (config.sshAgent) {
    if (Object.prototype.hasOwnProperty.call(config.filesystem, socket) && config.filesystem[socket] === "none") {
      throw new Error(`SSH agent socket is explicitly denied by policy: ${socket}`);
    }
    return { kind: "ssh-agent", disposition: "enabled", socket };
  }

  if (effectiveAccess(socket, config.filesystem) !== "none") {
    return { kind: "ssh-agent", disposition: "masked", socket };
  }
  return {
    kind: "ssh-agent",
    disposition: "unavailable",
    requested: false,
    reason: "disabled; the inherited socket is already hidden by filesystem policy",
  };
}

function canonicalResource(
  label: string,
  path: string,
  kind: "directory" | "file",
  filesystem: CapabilityFilesystem,
): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
  try {
    const canonical = filesystem.realpath(path);
    const stat = filesystem.lstat(canonical);
    const valid = kind === "directory" ? stat.isDirectory() : stat.isFile();
    if (!valid) throw new Error(`path is not a ${kind}: ${canonical}`);
    return canonical;
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Construct and validate the complete, closed runtime capability bundle. */
export function createRuntimeCapabilities(input: CapabilityConstructionInput): RuntimeCapabilities {
  const filesystem = input.filesystem ?? nodeFilesystem;
  const resourceRoot = canonicalResource("trusted runtime resource root", input.resourceRootPath, "directory", filesystem);
  const privateTemp = canonicalResource("private temporary directory", input.privateTempPath, "directory", filesystem);
  const deniedFile = canonicalResource("denied-file resource", input.deniedFilePath, "file", filesystem);
  const sshClientConfig = canonicalResource("SSH client configuration resource", input.sshClientConfigPath, "file", filesystem);

  for (const [label, path] of [
    ["private temporary directory", privateTemp],
    ["denied-file resource", deniedFile],
    ["SSH client configuration resource", sshClientConfig],
  ] as const) {
    if (dirname(path) !== resourceRoot) {
      throw new Error(`${label} must be an immediate child of trusted runtime resource root: ${path}`);
    }
  }
  if (new Set([privateTemp, deniedFile, sshClientConfig]).size !== 3) {
    throw new Error("trusted runtime resource children must be distinct");
  }

  return {
    resources: {
      kind: "trusted-runtime-resources",
      root: resourceRoot,
      deniedFile,
      sshClientConfig,
      sshClientConfigDestination: SSH_CLIENT_CONFIG_DESTINATION,
    },
    privateTemp: { kind: "private-temp", path: privateTemp },
    sshAgent: constructSshCapability(
      input.config,
      input.inheritedEnvironment ?? process.env,
      filesystem,
    ),
  } as RuntimeCapabilities;
}

/** Fail if trusted resource or enabled socket types changed after construction. */
export function revalidateRuntimeCapabilities(
  capabilities: RuntimeCapabilities,
  filesystem: CapabilityFilesystem = nodeFilesystem,
): void {
  const resources = capabilities.resources;
  const expected = [
    [resources.root, "directory"],
    [capabilities.privateTemp.path, "directory"],
    [resources.deniedFile, "file"],
    [resources.sshClientConfig, "file"],
  ] as const;
  for (const [path, kind] of expected) {
    try {
      const stat = filesystem.lstat(path);
      const valid = kind === "directory" ? stat.isDirectory() : stat.isFile();
      if (!valid) throw new Error(`path is no longer a ${kind}`);
    } catch (error) {
      throw new Error(
        `trusted runtime resource failed pre-spawn revalidation at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const ssh = capabilities.sshAgent;
  if (ssh.disposition !== "enabled") return;
  try {
    if (!filesystem.lstat(ssh.socket).isSocket()) {
      throw new Error("path is no longer a socket");
    }
  } catch (error) {
    throw new Error(
      `enabled SSH agent socket failed pre-spawn revalidation at ${ssh.socket}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Derive all capability-coupled child variables after caller overrides. */
export function deriveCapabilityEnvironment(
  capabilities: RuntimeCapabilities,
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited, ...overrides };
  const temp = capabilities.privateTemp.path;
  environment.TMPDIR = temp;
  environment.TMP = temp;
  environment.TEMP = temp;

  if (capabilities.sshAgent.disposition === "enabled") {
    environment.SSH_AUTH_SOCK = capabilities.sshAgent.socket;
  } else {
    delete environment.SSH_AUTH_SOCK;
  }
  return environment;
}

export function sshCapabilityStatus(capabilities: RuntimeCapabilities): SshCapabilityStatus {
  const ssh = capabilities.sshAgent;
  if (ssh.disposition === "enabled") return { state: "enabled-mounted", socket: ssh.socket };
  if (ssh.disposition === "masked") return { state: "disabled-masked", socket: ssh.socket };
  return ssh.requested
    ? { state: "enabled-unavailable", reason: ssh.reason }
    : { state: "disabled", reason: ssh.reason };
}
