/**
 * Bubblewrap sandbox for Pi's model-facing bash and filesystem tools.
 *
 * Config (global, then trusted project overrides):
 *   ~/.pi/agent/extensions/sandbox.json
 *   <project>/.pi/sandbox.json
 *
 * Structured filesystem policy:
 *   "none"  = inaccessible
 *   "read"  = visible read-only; write/edit require explicit/session grant
 *   "write" = readable and writable
 *
 * More-specific paths override broader paths.
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  createBashTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

type FileAccess = "none" | "read" | "write";
type SandboxState = "disabled" | "ready" | "error";

interface SandboxConfig {
  enabled: boolean;
  /** Structured path policy; more-specific paths override broader paths. */
  filesystem: Record<string, FileAccess>;
  /** Legacy path lists, retained for backward compatibility. */
  extraWritePaths: string[];
  extraReadPaths: string[];
  systemPaths: string[];
  /** Off by default. When true, bash runs with --unshare-net. */
  isolateNetwork: boolean;
  autoApproveCommands: string[];
  blockOutsideAccess: boolean;
}

interface ApprovedMount {
  path: string;
  writable: boolean;
}

interface SessionFileGrants {
  read: string[];
  write: string[];
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  filesystem: {
    ":project": "write",
    ":project/.git": "read",
    ":project/.agents": "read",
    ":project/.codex": "read",
    ":project/.pi": "read",
    ":project/.env": "read",
    "~/sandbox": "write",
    "~/.config": "read",
    "~/.gitconfig": "read",
    "~/.pi": "read",
  },
  extraWritePaths: [],
  extraReadPaths: [],
  systemPaths: ["/usr", "/bin", "/lib", "/lib64", "/etc", "/opt"],
  isolateNetwork: false,
  autoApproveCommands: [],
  blockOutsideAccess: false,
};

// These exist only inside bash's mount namespace. They must not authorize the
// corresponding host paths for read/write/edit tools.
const BASH_INTERNAL_PATHS = ["/dev", "/proc", "/tmp"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfigFile(path: string): Partial<SandboxConfig> {
  if (!existsSync(path)) return {};

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Sandbox: could not parse ${path}: ${String(error)}`);
    return {};
  }

  if (!isRecord(value)) {
    console.error(`Sandbox: ignoring non-object config in ${path}`);
    return {};
  }

  const result: Partial<SandboxConfig> = {};
  const booleans = ["enabled", "isolateNetwork", "blockOutsideAccess"] as const;
  const arrays = [
    "extraWritePaths",
    "extraReadPaths",
    "systemPaths",
    "autoApproveCommands",
  ] as const;

  for (const key of booleans) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === "boolean") result[key] = value[key];
    else console.error(`Sandbox: ignoring invalid ${key} in ${path}`);
  }

  // Legacy compatibility: allowNetwork false means isolateNetwork true.
  if (value.isolateNetwork === undefined && typeof value.allowNetwork === "boolean") {
    result.isolateNetwork = !value.allowNetwork;
  }

  for (const key of arrays) {
    if (value[key] === undefined) continue;
    if (Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")) {
      result[key] = value[key];
    } else {
      console.error(`Sandbox: ignoring invalid ${key} in ${path}`);
    }
  }

  if (value.filesystem !== undefined) {
    if (isRecord(value.filesystem)) {
      const filesystem: Record<string, FileAccess> = {};
      for (const [policyPath, access] of Object.entries(value.filesystem)) {
        if (access === "none" || access === "read" || access === "write") {
          filesystem[policyPath] = access;
        } else {
          console.error(`Sandbox: ignoring invalid filesystem access for ${policyPath} in ${path}`);
        }
      }
      result.filesystem = filesystem;
    } else {
      console.error(`Sandbox: ignoring invalid filesystem policy in ${path}`);
    }
  }

  return result;
}

function mergeConfig(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  return {
    ...base,
    ...overrides,
    filesystem: { ...base.filesystem, ...overrides.filesystem },
    extraWritePaths: overrides.extraWritePaths ?? base.extraWritePaths,
    extraReadPaths: overrides.extraReadPaths ?? base.extraReadPaths,
    systemPaths: overrides.systemPaths ?? base.systemPaths,
    autoApproveCommands: overrides.autoApproveCommands ?? base.autoApproveCommands,
  };
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Resolve through the deepest existing ancestor, so new paths under symlinks are safe. */
function resolvePath(path: string, cwd: string): string {
  const expanded = expandTilde(path);
  const absolute = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));

  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(existing.slice(parent.length + (parent === "/" ? 0 : 1)));
    existing = parent;
  }

  try {
    return join(realpathSync(existing), ...suffix);
  } catch {
    return absolute;
  }
}

function normalizeConfiguredPath(path: string, cwd: string): string {
  const expanded = expandTilde(path);
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

function normalizePolicyPath(path: string, cwd: string): string {
  if (path === ":project") return cwd;
  if (path.startsWith(":project/")) return resolve(cwd, path.slice(9));
  return normalizeConfiguredPath(path, cwd);
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function loadConfig(cwd: string, includeProjectConfig: boolean): SandboxConfig {
  const globalPath = join(getAgentDir(), "extensions", "sandbox.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");

  let config = mergeConfig(DEFAULT_CONFIG, parseConfigFile(globalPath));
  if (includeProjectConfig) {
    config = mergeConfig(config, parseConfigFile(projectPath));
  }

  return {
    ...config,
    extraWritePaths: unique(config.extraWritePaths.map((path) => normalizeConfiguredPath(path, cwd))),
    extraReadPaths: unique(config.extraReadPaths.map((path) => normalizeConfiguredPath(path, cwd))),
    systemPaths: unique(config.systemPaths.map((path) => normalizeConfiguredPath(path, cwd))),
    filesystem: Object.fromEntries(
      Object.entries(config.filesystem).map(([path, access]) => [normalizePolicyPath(path, cwd), access]),
    ),
  };
}

function isPathWithin(target: string, base: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isPathWithinAny(target: string, bases: string[]): boolean {
  return bases.some((base) => isPathWithin(target, resolvePath(base, "/")));
}

function filesystemAccess(target: string, filesystem: Record<string, FileAccess>): FileAccess | undefined {
  let selected: { path: string; access: FileAccess } | undefined;
  for (const [path, access] of Object.entries(filesystem)) {
    const base = resolvePath(path, "/");
    if (!isPathWithin(target, base)) continue;
    if (!selected || base.length > selected.path.length) {
      selected = { path: base, access };
    }
  }
  return selected?.access;
}

function filesystemRootsWithAccess(config: SandboxConfig, predicate: (access: FileAccess) => boolean): string[] {
  return Object.entries(config.filesystem)
    .filter(([, access]) => predicate(access))
    .map(([path]) => path);
}

/** Best-effort extraction for approval UX; bwrap remains the security boundary. */
function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  const tokenPattern = /(?:^|\s)(?:"([^"]*)"|'([^']*)'|([^\s"';&|`$()<>]+))/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token) continue;

    const candidate = token.replace(/[,;:]$/, "");
    if (
      candidate.startsWith("/") ||
      candidate.startsWith("./") ||
      candidate.startsWith("../") ||
      candidate.startsWith("~/")
    ) {
      paths.push(candidate);
    }
  }

  return unique(paths);
}

function nearestExistingPath(path: string): string | undefined {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return resolvePath(current, "/");
}

function isAutoApproved(command: string, configuredCommands: string[]): boolean {
  const trimmed = command.trimStart();
  return configuredCommands.some((configured) => {
    const prefix = configured.trim();
    return prefix.length > 0 &&
      (trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`));
  });
}

function mergeApprovedMounts(...groups: ApprovedMount[][]): ApprovedMount[] {
  const merged = new Map<string, ApprovedMount>();
  for (const mount of groups.flat()) {
    const previous = merged.get(mount.path);
    merged.set(mount.path, {
      path: mount.path,
      writable: mount.writable || previous?.writable === true,
    });
  }
  return [...merged.values()];
}

function mountsFromFileGrants(grants: SessionFileGrants): ApprovedMount[] {
  return [
    ...grants.read.map((path) => ({ path, writable: false })),
    ...grants.write.map((path) => ({ path, writable: true })),
  ];
}

async function approveBashMounts(
  command: string,
  ctx: ExtensionContext,
  cwd: string,
  config: SandboxConfig,
  sessionMounts: ApprovedMount[],
): Promise<ApprovedMount[]> {
  const visible = [
    ...filesystemRootsWithAccess(config, (access) => access !== "none"),
    ...config.systemPaths,
    ...config.extraReadPaths,
    ...config.extraWritePaths,
    ...sessionMounts.map((mount) => mount.path),
    ...BASH_INTERNAL_PATHS,
  ];

  const outside = unique(
    extractPathsFromCommand(command)
      .map((path) => resolvePath(path, cwd))
      .filter((path) => {
        const access = filesystemAccess(path, config.filesystem);
        return access === "none" || !isPathWithinAny(path, visible);
      }),
  );

  if (outside.length === 0) return [...sessionMounts];

  const denied = outside.filter((path) => filesystemAccess(path, config.filesystem) === "none");
  if (denied.length > 0) {
    throw new Error(`Sandbox blocked denied paths:\n  ${denied.join("\n  ")}`);
  }

  if (config.blockOutsideAccess) {
    throw new Error(`Sandbox blocked paths outside configured roots:\n  ${outside.join("\n  ")}`);
  }

  const mountPaths = unique(
    outside
      .map(nearestExistingPath)
      .filter((path): path is string => path !== undefined),
  );
  if (mountPaths.length === 0) {
    throw new Error("Sandbox could not find an existing path to approve");
  }

  if (isAutoApproved(command, config.autoApproveCommands)) {
    return mergeApprovedMounts(sessionMounts, mountPaths.map((path) => ({ path, writable: true })));
  }

  if (!ctx.hasUI) {
    throw new Error(`Sandbox blocked outside paths in non-interactive mode:\n  ${outside.join("\n  ")}`);
  }

  const choice = await ctx.ui.select(
    `🔒 Bash requests paths outside configured roots:\n\n` +
      `Command: ${command.slice(0, 300)}${command.length > 300 ? "…" : ""}\n\n` +
      `Requested:\n  ${outside.join("\n  ")}\n\n` +
      `Mounts required:\n  ${mountPaths.join("\n  ")}\n\n` +
      "Allow?",
    [
      "No - block",
      "Yes - read-only once",
      "Yes - read-write once",
      "Yes - read-only for session",
      "Yes - read-write for session",
    ],
  );

  if (!choice || choice.startsWith("No")) {
    throw new Error(`Sandbox: outside access denied (${outside.join(", ")})`);
  }

  const writable = choice.includes("read-write");
  const mounts = mountPaths.map((path) => ({ path, writable }));
  if (choice.endsWith("for session")) {
    sessionMounts.splice(0, sessionMounts.length, ...mergeApprovedMounts(sessionMounts, mounts));
    return [...sessionMounts];
  }
  return mergeApprovedMounts(sessionMounts, mounts);
}

function pushMounts(args: string[], option: "--bind" | "--ro-bind", paths: string[]): void {
  for (const path of unique(paths)) {
    if (existsSync(path)) args.push(option, path, path);
  }
}

/** WSL keeps resolv.conf outside /etc; preserve the symlink target in bwrap. */
function resolverMountPaths(systemPaths: string[]): string[] {
  try {
    const target = realpathSync("/etc/resolv.conf");
    return isPathWithinAny(target, systemPaths) ? [] : [target];
  } catch {
    return [];
  }
}

function findTrustedBwrap(writableRoots: string[]): string | undefined {
  const candidates = [
    "/usr/bin/bwrap",
    "/usr/local/bin/bwrap",
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "bwrap")),
  ];

  for (const candidate of unique(candidates)) {
    try {
      const canonical = realpathSync(candidate);
      accessSync(canonical, constants.X_OK);
      if (!isPathWithinAny(canonical, writableRoots)) return canonical;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function probeBwrap(executable: string): Promise<string | undefined> {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--",
    "/bin/true",
  ];

  return new Promise((resolveProbe) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("bubblewrap capability probe timed out");
    }, 3000);

    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.reduce((total, chunk) => total + chunk.length, 0) < 16_384) stderr.push(data);
    });
    child.on("error", (error) => finish(error.message));
    child.on("close", (code) => {
      if (code === 0) finish();
      else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(`bubblewrap probe exited ${code}${detail ? `: ${detail}` : ""}`);
      }
    });
  });
}

function pushFilesystemPolicy(args: string[], filesystem: Record<string, FileAccess>): void {
  const entries = Object.entries(filesystem).sort(([left], [right]) => left.length - right.length);

  for (const [path, access] of entries) {
    if (!existsSync(path)) continue;
    if (access === "read") {
      args.push("--ro-bind", path, path);
    } else if (access === "write") {
      args.push("--bind", path, path);
    } else if (lstatSync(path).isDirectory()) {
      args.push("--tmpfs", path, "--remount-ro", path);
    } else {
      args.push("--ro-bind", "/dev/null", path);
    }
  }
}

function buildBwrapArgs(
  command: string,
  cwd: string,
  config: SandboxConfig,
  approvedMounts: ApprovedMount[],
): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
  ];

  pushMounts(args, "--ro-bind", [...config.systemPaths, ...resolverMountPaths(config.systemPaths)]);
  pushMounts(args, "--ro-bind", config.extraReadPaths);
  pushMounts(args, "--bind", config.extraWritePaths);

  // Structured entries are applied broad-to-narrow so specific rules win.
  pushFilesystemPolicy(args, config.filesystem);

  // Explicit one-time/session approval has final precedence.
  pushMounts(args, "--ro-bind", approvedMounts.filter((mount) => !mount.writable).map((mount) => mount.path));
  pushMounts(args, "--bind", approvedMounts.filter((mount) => mount.writable).map((mount) => mount.path));

  args.push("--dev", "/dev", "--proc", "/proc");
  if (!config.extraWritePaths.includes("/tmp")) args.push("--tmpfs", "/tmp");
  if (config.isolateNetwork) args.push("--unshare-net");
  args.push("--chdir", cwd, "--", "bash", "-c", command);
  return args;
}

function createSandboxedBashOps(
  executable: string,
  config: SandboxConfig,
  approvedMounts: ApprovedMount[],
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      const args = buildBwrapArgs(command, cwd, config, approvedMounts);

      return new Promise((resolvePromise, reject) => {
        const child = spawn(executable, args, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const kill = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const onAbort = () => kill();
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };

        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolvePromise({ exitCode: code });
        });
      });
    },
  };
}

async function runSandboxCheck(
  executable: string,
  cwd: string,
  config: SandboxConfig,
  command: string,
): Promise<{ ok: boolean; output: string }> {
  const chunks: Buffer[] = [];
  try {
    const result = await createSandboxedBashOps(executable, config, []).exec(command, cwd, {
      onData: (data) => chunks.push(Buffer.from(data)),
      timeout: 20,
    });
    return {
      ok: result.exitCode === 0,
      output: Buffer.concat(chunks).toString("utf8").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

async function promptForFileGrant(
  toolName: string,
  originalPath: string,
  resolved: string,
  readOnly: boolean,
  policyRestricted: boolean,
  ctx: ExtensionContext,
  grants: SessionFileGrants,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error(`Sandbox blocked ${toolName} in non-interactive mode: ${resolved}`);
  }

  const choice = await ctx.ui.select(
    `🔒 Allow ${policyRestricted ? "policy-restricted " : ""}${toolName}?\n\n` +
      `Path: ${originalPath}\nResolved: ${resolved}\n` +
      `Access: ${readOnly ? "read-only" : "read-write"}`,
    [
      "No - block",
      "Yes - allow once",
      "Yes - this path for session",
      "Yes - parent directory for session",
    ],
  );

  if (!choice || choice.startsWith("No")) throw new Error(`Sandbox: ${toolName} denied for ${resolved}`);
  if (choice === "Yes - allow once") return;

  const grantedPath = choice.includes("parent directory") ? dirname(resolved) : resolved;
  const target = readOnly ? grants.read : grants.write;
  target.splice(0, target.length, ...unique([...target, grantedPath]));
  ctx.ui.notify(
    `Sandbox: ${readOnly ? "read" : "write"} access granted for this session: ${grantedPath}`,
    "warning",
  );
}

async function authorizeFileTool(
  toolName: string,
  path: string,
  ctx: ExtensionContext,
  cwd: string,
  config: SandboxConfig,
  grants: SessionFileGrants,
): Promise<void> {
  const resolved = resolvePath(path, cwd);
  const readOnly = toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls";

  const sessionAllowed = readOnly ? [...grants.read, ...grants.write] : grants.write;
  if (isPathWithinAny(resolved, sessionAllowed)) return;

  const access = filesystemAccess(resolved, config.filesystem);
  if (access === "none") {
    throw new Error(`Sandbox blocked ${toolName} by filesystem policy: ${resolved}`);
  }
  if (readOnly && (access === "read" || access === "write")) return;
  if (!readOnly && access === "write") return;

  const legacyAllowed = readOnly
    ? [...config.systemPaths, ...config.extraReadPaths, ...config.extraWritePaths]
    : config.extraWritePaths;
  if (isPathWithinAny(resolved, legacyAllowed)) return;

  if (config.blockOutsideAccess) {
    throw new Error(`Sandbox blocked ${toolName} outside configured roots: ${resolved}`);
  }

  await promptForFileGrant(toolName, path, resolved, readOnly, access === "read", ctx, grants);
}

export default function sandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable bubblewrap sandbox",
    type: "boolean",
    default: false,
  });

  const initialCwd = process.cwd();
  const localBash = createBashTool(initialCwd);
  let state: SandboxState = "error";
  let stateReason = "session has not started";
  let config = DEFAULT_CONFIG;
  let projectCwd = initialCwd;
  let bwrapExecutable: string | undefined;
  const sessionFileGrants: SessionFileGrants = { read: [], write: [] };
  const sessionBashMounts: ApprovedMount[] = [];

  pi.registerTool({
    ...localBash,
    label: "bash (bwrap sandbox)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (state === "disabled") {
        return localBash.execute(id, params, signal, onUpdate);
      }
      if (state !== "ready") {
        throw new Error(`Sandbox unavailable; refusing unsandboxed bash: ${stateReason}`);
      }
      if (!bwrapExecutable) {
        throw new Error("Sandbox unavailable; trusted bubblewrap path was lost");
      }

      const sessionMounts = mergeApprovedMounts(sessionBashMounts, mountsFromFileGrants(sessionFileGrants));
      const approvedMounts = await approveBashMounts(params.command, ctx, projectCwd, config, sessionMounts);
      const tool = createBashTool(projectCwd, {
        operations: createSandboxedBashOps(bwrapExecutable, config, approvedMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionFileGrants.read.length = 0;
    sessionFileGrants.write.length = 0;
    sessionBashMounts.length = 0;
    projectCwd = resolvePath(ctx.cwd, ctx.cwd);

    if (pi.getFlag("no-sandbox") as boolean) {
      state = "disabled";
      stateReason = "disabled by --no-sandbox";
      ctx.ui.setStatus("sandbox", undefined);
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    config = loadConfig(projectCwd, ctx.isProjectTrusted());
    if (!config.enabled) {
      state = "disabled";
      stateReason = "disabled by config";
      ctx.ui.setStatus("sandbox", undefined);
      ctx.ui.notify("Sandbox disabled via config", "warning");
      return;
    }

    const writableRoots = [
      ...filesystemRootsWithAccess(config, (access) => access === "write"),
      ...config.extraWritePaths,
    ];
    bwrapExecutable = findTrustedBwrap(writableRoots);
    const missingWrites = config.extraWritePaths.filter((path) => !existsSync(path));
    if (!bwrapExecutable || missingWrites.length > 0) {
      state = "error";
      stateReason = !bwrapExecutable
        ? "no trusted executable bubblewrap binary was found"
        : `configured write paths do not exist: ${missingWrites.join(", ")}`;
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "🔓 Sandbox error"));
      ctx.ui.notify(`Sandbox error: ${stateReason}. Bash will fail closed.`, "error");
      return;
    }

    const probeError = await probeBwrap(bwrapExecutable);
    if (probeError) {
      state = "error";
      stateReason = probeError;
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "🔓 Sandbox error"));
      ctx.ui.notify(`Sandbox error: ${stateReason}. Bash will fail closed.`, "error");
      return;
    }

    state = "ready";
    stateReason = "active";
    const writableDisplay = filesystemRootsWithAccess(config, (access) => access === "write").join(", ");
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 bwrap | writable: ${writableDisplay}`));
    ctx.ui.notify(
      `Sandbox initialized. Network isolation ${config.isolateNetwork ? "enabled" : "disabled"}.`,
      "info",
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("sandbox", undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state === "disabled" || event.toolName === "bash") return undefined;

    const pathTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);
    if (!pathTools.has(event.toolName)) return undefined;

    const input = event.input as { path?: unknown };
    const path = typeof input.path === "string" && input.path.length > 0 ? input.path : projectCwd;
    try {
      await authorizeFileTool(event.toolName, path, ctx, projectCwd, config, sessionFileGrants);
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.registerCommand("sandbox-test", {
    description: "Run bubblewrap sandbox integration checks",
    handler: async (_args, ctx) => {
      if (state !== "ready" || !bwrapExecutable) {
        ctx.ui.notify(`Sandbox self-test unavailable: ${stateReason}`, "error");
        return;
      }

      const checks: Array<{ name: string; command: string }> = [
        {
          name: "shell argument preservation",
          command: "test \"$(printf '%s|' 'first; value' 'second value')\" = 'first; value|second value|'",
        },
        {
          name: "network and DNS",
          command: config.isolateNetwork
            ? "! curl -fsS --connect-timeout 5 --max-time 8 https://example.com -o /dev/null"
            : "curl -fsS --connect-timeout 10 --max-time 15 https://example.com -o /dev/null",
        },
        {
          name: "~/.pi read-only mount",
          command: "test -r \"$HOME/.pi/README.md\" && test ! -w \"$HOME/.pi\"",
        },
      ];

      for (const [policyPath, access] of Object.entries(config.filesystem)) {
        if (access === "read" && existsSync(policyPath)) {
          checks.push({ name: `read-only policy: ${policyPath}`, command: `test ! -w ${shellQuote(policyPath)}` });
        }
      }

      const results: string[] = [];
      let failed = 0;
      for (const check of checks) {
        const result = await runSandboxCheck(bwrapExecutable, projectCwd, config, check.command);
        if (!result.ok) failed += 1;
        results.push(`${result.ok ? "✅" : "❌"} ${check.name}` + `${result.output ? `\n    ${result.output.replaceAll("\n", "\n    ")}` : ""}`);
      }

      ctx.ui.notify(
        [`Sandbox self-test: ${checks.length - failed}/${checks.length} passed`, ...results].join("\n"),
        failed === 0 ? "info" : "error",
      );
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox status and configuration",
    handler: async (_args, ctx) => {
      const lines = [
        `Bubblewrap sandbox: ${state.toUpperCase()}`,
        `Reason: ${stateReason}`,
        `Bubblewrap: ${bwrapExecutable ?? "not available"}`,
        `Project: ${projectCwd}`,
        `Network isolation: ${config.isolateNetwork ? "enabled" : "disabled"}`,
        `Outside access: ${config.blockOutsideAccess ? "blocked" : "approval required"}`,
        "Filesystem policy:",
        ...Object.entries(config.filesystem).map(([path, access]) => `  • ${access}: ${path}`),
        "Legacy extra read paths:",
        ...(config.extraReadPaths.length ? config.extraReadPaths.map((path) => `  • ${path}`) : ["  (none)"]),
        "Legacy extra write paths:",
        ...(config.extraWritePaths.length ? config.extraWritePaths.map((path) => `  • ${path}`) : ["  (none)"]),
        "System read paths:",
        ...config.systemPaths.map((path) => `  • ${path}`),
        "Session grants:",
        ...(sessionFileGrants.read.length + sessionFileGrants.write.length + sessionBashMounts.length > 0
          ? [
              ...sessionFileGrants.read.map((path) => `  • read: ${path}`),
              ...sessionFileGrants.write.map((path) => `  • write: ${path}`),
              ...sessionBashMounts.map((mount) => `  • bash ${mount.writable ? "write" : "read"}: ${mount.path}`),
            ]
          : ["  (none)"]),
      ];
      ctx.ui.notify(lines.join("\n"), state === "error" ? "error" : "info");
    },
  });
}
