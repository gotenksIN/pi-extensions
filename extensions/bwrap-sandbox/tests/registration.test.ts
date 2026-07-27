import { assert, registeredTestCount, test } from "./harness.ts";

test("repeated lazy test-module loads do not duplicate registration", async () => {
  const before = registeredTestCount();
  await import("./run.ts");
  await import("./run.ts");
  assert.equal(registeredTestCount(), before);
});
