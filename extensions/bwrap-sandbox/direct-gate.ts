import type { RequestedAccess } from "./types.ts";

const DIRECT_TOOLS: Readonly<Record<string, RequestedAccess>> = {
  read: "read",
  write: "write",
  edit: "write",
  grep: "read",
  find: "read",
  ls: "read",
};

export interface DirectAuthorizationSession {
  authorizeDirectRead(toolName: string, rawPath: string): void;
  authorizeDirectWrite(toolName: string, rawPath: string): Promise<void>;
}

export function isDirectFilesystemTool(name: string): boolean {
  return Object.hasOwn(DIRECT_TOOLS, name);
}

/**
 * Application-level gate for direct Pi filesystem tools. These tools run in
 * Pi's host process and are not OS-contained by Bubblewrap.
 */
export async function authorizeDirectTool(
  toolName: string,
  rawPath: string,
  session: DirectAuthorizationSession,
): Promise<void> {
  const requested = DIRECT_TOOLS[toolName];
  if (requested === "read") session.authorizeDirectRead(toolName, rawPath);
  else if (requested === "write") await session.authorizeDirectWrite(toolName, rawPath);
}
