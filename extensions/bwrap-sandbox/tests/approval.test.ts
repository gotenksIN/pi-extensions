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

test("approval overlay keeps choices usable while a long prompt scrolls", () => {
  let selected: string | undefined;
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const message = Array.from({ length: 40 }, (_, index) => `prompt-${index + 1}`).join("\n");
  const choices = ["No - block", "Yes - allow"];
  const overlay = new ApprovalOverlay(tui, theme, message, choices, (value) => {
    selected = value;
  });

  const initial = overlay.render(80);
  overlay.handleInput("\u001b[6~");
  overlay.handleInput("\u001b[6~");
  const scrolled = overlay.render(80);

  for (const choice of choices) {
    assert.ok(initial.some((line) => line.includes(choice)));
    assert.ok(scrolled.some((line) => line.includes(choice)));
  }
  assert.notEqual(
    initial.filter((line) => line.includes("prompt-")).join("\n"),
    scrolled.filter((line) => line.includes("prompt-")).join("\n"),
  );

  overlay.handleInput("\r");
  assert.equal(selected, "No - block");

  const selectionOverlay = new ApprovalOverlay(tui, theme, message, choices, (value) => {
    selected = value;
  });
  selectionOverlay.handleInput("\u001b[B");
  selectionOverlay.handleInput("\r");
  assert.equal(selected, "Yes - allow");
});
