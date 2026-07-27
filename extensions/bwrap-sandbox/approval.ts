import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ApprovalBroker {
  owner?: symbol;
  ownerSession?: string;
  select?: (message: string, choices: string[]) => Promise<string | undefined>;
  notify?: (message: string) => void;
  tail: Promise<void>;
}

export interface ApprovalChannel {
  attach(ctx: ExtensionContext): void;
  detach(): void;
  request(message: string, choices: readonly string[]): Promise<string | undefined>;
  notify(message: string): void;
}

const BROKER_KEY = Symbol.for("gotenksIN.pi-extensions.bwrap-sandbox.approval-broker.v3");

function broker(): ApprovalBroker {
  const globals = globalThis as typeof globalThis & { [BROKER_KEY]?: ApprovalBroker };
  globals[BROKER_KEY] ??= { tail: Promise.resolve() };
  return globals[BROKER_KEY];
}

/** Create an opaque session endpoint for the shared parent/subagent broker. */
export function createApprovalChannel(): ApprovalChannel {
  const token = Symbol("bwrap-sandbox-session");
  let sessionLabel = "unknown";
  let generation = 0;
  let active = false;
  let isOwner = false;
  let localNotify: ((message: string) => void) | undefined;

  function current(expected: number, owner: symbol, shared: ApprovalBroker): void {
    if (!active || generation !== expected) {
      throw new Error("Sandbox approval expired because the requesting session changed");
    }
    if (shared.owner !== owner || !shared.select) {
      throw new Error("Sandbox approval expired because the approval owner changed");
    }
  }

  return {
    attach(ctx) {
      const shared = broker();
      generation += 1;
      sessionLabel = ctx.sessionManager.getSessionId();
      active = true;
      isOwner = false;
      localNotify = ctx.hasUI ? (message) => ctx.ui.notify(message, "warning") : undefined;

      if (ctx.hasUI && (!shared.owner || shared.owner === token)) {
        shared.owner = token;
        shared.ownerSession = sessionLabel;
        shared.select = (message, choices) => ctx.ui.select(message, choices);
        shared.notify = (message) => ctx.ui.notify(message, "warning");
        isOwner = true;
      }
    },

    detach() {
      const shared = broker();
      generation += 1;
      active = false;
      isOwner = false;
      localNotify = undefined;
      if (shared.owner !== token) return;
      shared.owner = undefined;
      shared.ownerSession = undefined;
      shared.select = undefined;
      shared.notify = undefined;
    },

    async request(message, choices) {
      const shared = broker();
      if (!active) throw new Error("Sandbox approval session is inactive");
      const requestedGeneration = generation;
      const owner = shared.owner;
      let display = message;

      if (isOwner) {
        if (owner !== token || !shared.select) throw new Error("Sandbox approval owner is no longer available");
      } else {
        if (!owner || !shared.select) throw new Error("Sandbox approval requires an interactive parent broker");
        if (owner === token) throw new Error("A child sandbox session cannot approve its own request");
        display = [
          "SUBAGENT SANDBOX REQUEST",
          `Requesting session: ${sessionLabel}`,
          `Approval owner: ${shared.ownerSession ?? "unknown"}`,
          "",
          message,
        ].join("\n");
      }
      if (!owner) throw new Error("Sandbox approval owner is unavailable");

      // Pi select has no cancellation signal. A stale displayed prompt holds
      // the queue until dismissal, but private generation/owner checks reject
      // its eventual result before it can authorize anything.
      const pending = shared.tail.then(async () => {
        current(requestedGeneration, owner, shared);
        const choice = await shared.select!(display, [...choices]);
        current(requestedGeneration, owner, shared);
        return choice;
      });
      shared.tail = pending.then(() => undefined, () => undefined);
      return pending;
    },

    notify(message) {
      if (!active) return;
      if (isOwner) localNotify?.(message);
      else broker().notify?.(`Subagent ${sessionLabel}: ${message}`);
    },
  };
}
