import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApprovalChannel } from "../approval.ts";
import { assert, test } from "./harness.ts";

function context(sessionId: string): ExtensionContext {
  return {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      select: async () => "Yes",
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "did not reject";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("approval generations expire when a session is replaced", async () => {
  const channel = createApprovalChannel();
  channel.attach(context("session-one"));
  const stale = channel.request("request", ["Yes"]);
  channel.attach(context("session-two"));
  assert.ok((await rejectionMessage(stale)).includes("requesting session changed"));
  channel.detach();
});

test("detached approval sessions cannot apply queued results", async () => {
  const channel = createApprovalChannel();
  channel.attach(context("session-one"));
  const stale = channel.request("request", ["Yes"]);
  channel.detach();
  assert.ok((await rejectionMessage(stale)).includes("requesting session changed"));
});
