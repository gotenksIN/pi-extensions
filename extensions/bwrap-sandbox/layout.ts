import { effectiveAccess, isPathWithin } from "./policy.ts";
import type { CompiledFilesystemPolicy } from "./types.ts";

export const FRESH_RUNTIME_PATHS = ["/dev", "/proc"] as const;

export interface ProtectedRuntimePaths {
  readonly bwrapExecutable: string;
  readonly hostTempParent: string;
  readonly resourceRoot: string;
  readonly sshClientConfigDestination: string;
}

export function pathsIntersect(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

export function intersectsFreshRuntimePath(path: string): boolean {
  return FRESH_RUNTIME_PATHS.some((fresh) => pathsIntersect(path, fresh));
}

/**
 * Validate a path that may become writable. A persistent subtree grant can
 * cover the trusted executable; a one-time direct write protects the exact
 * target while still rejecting fresh namespace intersections and attempts to
 * make the host temporary parent writable.
 */
export function validateWritableRuntimePath(
  path: string,
  protectedPaths: ProtectedRuntimePaths,
  scope: "subtree" | "exact",
): void {
  if (intersectsFreshRuntimePath(path)) {
    throw new Error(`Sandbox cannot allow writes intersecting fresh /dev or /proc: ${path}`);
  }
  if (
    (scope === "subtree" && isPathWithin(protectedPaths.bwrapExecutable, path)) ||
    (scope === "exact" && path === protectedPaths.bwrapExecutable)
  ) {
    throw new Error(`Sandbox cannot allow writes over its trusted Bubblewrap executable: ${path}`);
  }
  if (isPathWithin(protectedPaths.hostTempParent, path)) {
    throw new Error(`Sandbox cannot make the host temporary directory writable: ${path}`);
  }
  if (pathsIntersect(path, protectedPaths.resourceRoot)) {
    throw new Error(`Sandbox cannot grant writes intersecting trusted runtime resources: ${path}`);
  }
  if (pathsIntersect(path, protectedPaths.sshClientConfigDestination)) {
    throw new Error(`Sandbox cannot grant writes intersecting the fixed SSH client configuration: ${path}`);
  }
}

/** Assert startup invariants that must hold before runtime overlays are added. */
export function validateRuntimePolicy(
  policy: CompiledFilesystemPolicy,
  protectedPaths: ProtectedRuntimePaths,
): void {
  if (effectiveAccess(protectedPaths.bwrapExecutable, policy) === "write") {
    throw new Error(`trusted Bubblewrap executable is writable by policy: ${protectedPaths.bwrapExecutable}`);
  }
  if (effectiveAccess(protectedPaths.hostTempParent, policy) === "write") {
    throw new Error(`host temporary directory must remain read-only: ${protectedPaths.hostTempParent}`);
  }
  if (effectiveAccess(protectedPaths.sshClientConfigDestination, policy) === "write") {
    throw new Error(
      `fixed SSH client configuration destination must remain read-only: ${protectedPaths.sshClientConfigDestination}`,
    );
  }
}
