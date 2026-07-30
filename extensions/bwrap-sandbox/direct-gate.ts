import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
}

export function isDirectFilesystemTool(name: string): boolean {
  return Object.hasOwn(DIRECT_TOOLS, name);
}

/**
 * Application-level gate for direct Pi filesystem tools. These tools run in
 * Pi's host process and are not OS-contained by Bubblewrap.
 */
export async function authorizeDirectTool(
  toolCallId: string,
  toolName: string,
  rawPath: string,
  input: unknown,
  session: DirectAuthorizationSession,
  ctx: ExtensionContext,
): Promise<void> {
  const requested = DIRECT_TOOLS[toolName];
  if (requested === "read") await session.authorizeDirectRead(toolCallId, toolName, rawPath, input, ctx);
  else if (requested === "write") await session.authorizeDirectWrite(toolCallId, toolName, rawPath, input, ctx);
}
