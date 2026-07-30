import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApprovalChannel, selectApproval } from "../approval.ts";
import { assert, test } from "./harness.ts";

function context(sessionId: string, hasUI = true): ExtensionContext {
  return {
    hasUI,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      select: async () => "Yes",
      custom: async () => "Yes",
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

test("approval owner can replace the default selector with an overlay selector", async () => {
  let selected = "";
  const choices = ["Allow", "Block"];
  const result = await selectApproval(context("parent"), "review", choices, async (_ctx, message, values) => {
    selected = `${message}:${values.join(",")}`;
    return values[0];
  });
  assert.equal(result, "Allow");
  assert.equal(selected, "review:Allow,Block");
});

test("detached approval sessions cannot apply queued results", async () => {
  const channel = createApprovalChannel();
  channel.attach(context("session-one"));
  const stale = channel.request("request", ["Yes"]);
  channel.detach();
  assert.ok((await rejectionMessage(stale)).includes("requesting session changed"));
});
