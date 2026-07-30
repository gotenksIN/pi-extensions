import { resolveSandboxDisableSource } from "../process-state.ts";
import { assert, test } from "./harness.ts";

test("parent CLI sandbox opt-out propagates without overriding an explicit child flag", () => {
  assert.equal(resolveSandboxDisableSource(false, false), "none");
  assert.equal(resolveSandboxDisableSource(true, false), "cli");
  assert.equal(resolveSandboxDisableSource(false, true), "parent-cli");
  assert.equal(resolveSandboxDisableSource(true, true), "cli");
});
