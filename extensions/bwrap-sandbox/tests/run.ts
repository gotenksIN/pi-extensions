import "./approval.test.ts";
import "./capabilities.test.ts";
import "./classifier-provider.test.ts";
import "./classifier.test.ts";
import "./config.test.ts";
import "./grants.test.ts";
import "./mount-plan.test.ts";
import "./policy.test.ts";
import "./registration.test.ts";
import "./safety-evidence.test.ts";
import "./safety-gate.test.ts";
import {
  formatTestSummary,
  runRegisteredTests,
  type TestSuiteResult,
} from "./harness.ts";

export interface SandboxUnitTestResult extends TestSuiteResult {
  output: string;
}

let activeRun: Promise<SandboxUnitTestResult> | undefined;

export function runSandboxUnitTests(): Promise<SandboxUnitTestResult> {
  if (activeRun) return activeRun;

  const run = runRegisteredTests()
    .then((result) => ({ ...result, output: formatTestSummary(result) }))
    .finally(() => {
      activeRun = undefined;
    });
  activeRun = run;
  return run;
}
