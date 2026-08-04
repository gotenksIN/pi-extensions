import { dirname, sep } from "node:path";
import { FRESH_RUNTIME_PATHS, intersectsFreshRuntimePath } from "./layout.ts";
import { configuredAccess, effectiveAccess, isPathWithin } from "./policy.ts";
import type {
  ApprovedWriteGrants,
  CompiledFilesystemPolicy,
  FileAccess,
  MountOperation,
  MountSourceType,
  PathKind,
  RuntimeCapabilities,
} from "./types.ts";

export type InspectPath = (path: string) => PathKind;

export interface MountPlanInput {
  readonly policy: CompiledFilesystemPolicy;
  readonly grants: ApprovedWriteGrants;
  readonly capabilities: RuntimeCapabilities;
  readonly transientWritePaths?: readonly string[];
}

interface PlanNode {
  readonly path: string;
  readonly access: FileAccess;
  readonly pathKind: PathKind;
  readonly source: string;
  readonly sourceType: MountSourceType;
}

function depth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

function sortedNodes(input: MountPlanInput, inspect: InspectPath): PlanNode[] {
  const { policy, grants, capabilities } = input;
  const resources = capabilities.resources;
  const privateTemp = capabilities.privateTemp.path;
  const ssh = capabilities.sshAgent;
  const sshPath = ssh.disposition === "unavailable" ? undefined : ssh.socket;
  const transientWritePaths = input.transientWritePaths ?? [];
  const writablePaths = [...grants.paths, ...transientWritePaths, privateTemp];
  const paths = new Set([
    ...Object.keys(policy),
    ...grants.paths,
    ...transientWritePaths,
    resources.root,
    privateTemp,
    resources.sshClientConfigDestination,
    ...(sshPath ? [sshPath] : []),
  ]);

  return [...paths]
    .map((path): PlanNode => {
      if (path === resources.root) {
        return { path, access: "none", pathKind: "directory", source: path, sourceType: "directory" };
      }
      if (path === privateTemp) {
        return { path, access: "write", pathKind: "directory", source: path, sourceType: "directory" };
      }
      if (path === resources.sshClientConfigDestination) {
        const access = effectiveAccess(path, policy) === "none" ? "none" : "read";
        return {
          path,
          access,
          pathKind: "file",
          source: access === "read" ? resources.sshClientConfig : path,
          sourceType: "file",
        };
      }
      if (ssh.disposition === "enabled" && path === ssh.socket) {
        return { path, access: "read", pathKind: "file", source: ssh.socket, sourceType: "socket" };
      }
      if (ssh.disposition === "masked" && path === ssh.socket) {
        return { path, access: "none", pathKind: "file", source: path, sourceType: "socket" };
      }
      const pathKind = inspect(path);
      return {
        path,
        access: effectiveAccess(path, policy, writablePaths),
        pathKind,
        source: path,
        sourceType: pathKind === "directory" ? "directory" : "file",
      };
    })
    .sort((left, right) => depth(left.path) - depth(right.path) || left.path.localeCompare(right.path));
}

function hasDescendant(nodes: PlanNode[], parent: PlanNode, predicate: (node: PlanNode) => boolean): boolean {
  return nodes.some(
    (node) => node.path !== parent.path && isPathWithin(node.path, parent.path) && predicate(node),
  );
}

function writableAncestor(nodes: PlanNode[], child: PlanNode): PlanNode | undefined {
  return nodes.find(
    (node) => node.path !== child.path && node.access === "write" && isPathWithin(child.path, node.path),
  );
}

function scaffoldFor(path: string, masks: string[]): string[] {
  const mask = masks
    .filter((candidate) => candidate !== path && isPathWithin(path, candidate))
    .sort((left, right) => depth(right) - depth(left))[0];
  if (!mask) return [];

  const result: string[] = [];
  let current = dirname(path);
  while (current !== mask && isPathWithin(current, mask)) {
    result.unshift(current);
    current = dirname(current);
  }
  return result;
}

/** Compile all filesystem trust inputs into one deterministic broad-to-narrow plan. */
export function createMountPlan(input: MountPlanInput, inspect: InspectPath): MountOperation[] {
  const nodes = sortedNodes(input, inspect);
  const invalidRuntimeWrite = nodes.find(
    (node) => node.access === "write" && intersectsFreshRuntimePath(node.path),
  );
  if (invalidRuntimeWrite) {
    throw new Error(`Writable sandbox path conflicts with fresh /dev or /proc mounts: ${invalidRuntimeWrite.path}`);
  }
  const invalidSocket = nodes.find(
    (node) => node.sourceType === "socket" && node.access === "read" && intersectsFreshRuntimePath(node.path),
  );
  if (invalidSocket) {
    throw new Error(`SSH agent capability conflicts with fresh /dev or /proc mounts: ${invalidSocket.path}`);
  }
  const unsupportedVirtualRead = nodes.find(
    (node) => node.access === "read" && intersectsFreshRuntimePath(node.path) &&
      nodes.some((parent) => parent.access === "none" && parent.path !== node.path && isPathWithin(node.path, parent.path)),
  );
  if (unsupportedVirtualRead) {
    throw new Error(`Readable overrides beneath denied /dev or /proc paths are unsupported: ${unsupportedVirtualRead.path}`);
  }

  const operations: MountOperation[] = [];
  const lateReadOnly = new Set<string>();
  const masks: string[] = [];
  const scaffolded = new Set<string>();

  for (const node of nodes) {
    if (node.pathKind === "missing") {
      const protectedAccess = configuredAccess(node.path, input.policy);
      const ancestor = writableAncestor(nodes, node);
      if ((protectedAccess === "read" || protectedAccess === "none") && ancestor) {
        throw new Error(
          `Missing protected sandbox path ${node.path} is beneath writable path ${ancestor.path}; create it before starting Pi or remove the rule`,
        );
      }
      if (node.access === "write") {
        throw new Error(`Writable sandbox path does not exist and cannot be bind-mounted: ${node.path}`);
      }
      continue;
    }

    if (node.access === "read" && intersectsFreshRuntimePath(node.path)) continue;

    for (const directory of scaffoldFor(node.path, masks)) {
      if (!scaffolded.has(directory)) {
        operations.push({ kind: "ensure-directory", path: directory });
        scaffolded.add(directory);
      }
    }

    if (node.access === "write") {
      operations.push({
        kind: "bind",
        source: node.source,
        destination: node.path,
        sourceType: node.sourceType,
        writable: true,
      });
      continue;
    }

    if (node.access === "read") {
      const writableChild = node.pathKind === "directory" &&
        hasDescendant(nodes, node, (child) => child.access === "write");
      operations.push({
        kind: "bind",
        source: node.source,
        destination: node.path,
        sourceType: node.sourceType,
        writable: writableChild,
      });
      if (writableChild) lateReadOnly.add(node.path);
      continue;
    }

    if (node.pathKind === "file") {
      operations.push({ kind: "mask-file", path: node.path, source: input.capabilities.resources.deniedFile });
      continue;
    }

    const allowedChild = hasDescendant(
      nodes,
      node,
      (child) => child.pathKind !== "missing" && child.access !== "none",
    );
    operations.push({ kind: "mask-directory", path: node.path, inaccessible: !allowedChild });
    masks.push(node.path);
    if (allowedChild) lateReadOnly.add(node.path);
  }

  for (const path of [...lateReadOnly].sort(
    (left, right) => depth(right) - depth(left) || left.localeCompare(right),
  )) {
    operations.push({ kind: "remount-readonly", path });
  }
  return operations;
}

function pushOperation(args: string[], operation: MountOperation): void {
  switch (operation.kind) {
    case "ensure-directory": args.push("--dir", operation.path); break;
    case "bind":
      args.push(operation.writable ? "--bind" : "--ro-bind", operation.source, operation.destination);
      break;
    case "mask-directory":
      args.push("--tmpfs", operation.path);
      if (operation.inaccessible) args.push("--chmod", "0000", operation.path);
      break;
    case "mask-file": args.push("--ro-bind", operation.source, operation.path); break;
    case "remount-readonly": args.push("--remount-ro", operation.path); break;
  }
}

export function buildMountNamespaceArgs(plan: readonly MountOperation[]): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--dev", FRESH_RUNTIME_PATHS[0],
    "--proc", FRESH_RUNTIME_PATHS[1],
  ];
  for (const operation of plan) pushOperation(args, operation);
  return args;
}
