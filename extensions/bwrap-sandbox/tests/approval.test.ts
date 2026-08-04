import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createApprovalChannel, selectApproval } from "../approval.ts";
import { ApprovalOverlay } from "../approval-ui.ts";
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

test("approval overlay pins choices below a scrollable long prompt", () => {
  let renderRequests = 0;
  const tui = {
    terminal: { rows: 24 },
    requestRender: () => {
      renderRequests += 1;
    },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const message = Array.from({ length: 40 }, (_, index) => `prompt-${index + 1}`).join("\n");
  const overlay = new ApprovalOverlay(tui, theme, message, ["No - block", "Yes - allow"], () => undefined);

  const initial = overlay.render(80);
  assert.equal(initial.length, 20);
  assert.ok(initial.some((line) => line.includes("prompt-1")));
  assert.ok(initial.some((line) => line.includes("No - block")));
  assert.ok(initial.some((line) => line.includes("Yes - allow")));
  assert.ok(initial.findIndex((line) => line.includes("Yes - allow")) > initial.findIndex((line) => line.includes("prompt-1")));

  overlay.handleInput("\u001b[6~");
  const scrolled = overlay.render(80);
  assert.equal(renderRequests, 1);
  assert.ok(!scrolled.some((line) => line.trim() === "prompt-1"));
  assert.ok(scrolled.some((line) => line.trim() === "prompt-14"));
  assert.ok(scrolled.some((line) => line.includes("Yes - allow")));
});
