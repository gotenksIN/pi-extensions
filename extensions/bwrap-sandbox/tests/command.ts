import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManualTestExecution } from "../session.ts";
import type { TestRunContext } from "./harness.ts";
import { runSandboxUnitTests } from "./run.ts";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function integrationSummary(output: string): string {
  return output
    .split("\n")
    .filter((line) => /^(?:PASS|FAIL|SKIP|SUMMARY|RESULT_LOG):/.test(line))
    .join("\n");
}

export interface SandboxTestCommandResult {
  readonly failed: boolean;
  readonly summary: string;
  readonly logPath: string;
}

export async function runSandboxTestCommand(
  execution: ManualTestExecution,
  context: TestRunContext = {},
): Promise<SandboxTestCommandResult> {
  const unit = await runSandboxUnitTests(context);
  const logPath = join(execution.projectCwd, "sandbox-manual-test.log");
  const fullOutput = [unit.output];
  const summary = [unit.output];
  let failed = unit.failed > 0;

  if (!execution.exec) {
    failed = true;
    const skipped = `Linux Bubblewrap integration tests skipped: ${execution.unavailableReason ?? "runtime unavailable"}`;
    fullOutput.push("", skipped);
    summary.push("", skipped, `Combined output: ${logPath}`);
  } else {
    const script = fileURLToPath(new URL("./manual-sandbox-test.sh", import.meta.url));
    const fixture = join("/tmp", `pi-clipboard-sandbox-test-${process.pid}-${Date.now()}.png`);
    const chunks: Buffer[] = [];
    try {
      writeFileSync(fixture, TEST_PNG, { mode: 0o600 });
      try {
        const result = await execution.exec(
          `bash ${shellQuote(script)} ${shellQuote(execution.projectCwd)} ${shellQuote(logPath)} ${shellQuote(fixture)}`,
          (data) => chunks.push(Buffer.from(data)),
        );
        failed ||= result.exitCode !== 0;
      } catch (error) {
        failed = true;
        chunks.push(Buffer.from(`\nIntegration execution error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`));
      }
      const integration = Buffer.concat(chunks).toString("utf8").trim();
      fullOutput.push("", "Linux Bubblewrap integration tests:", integration);
      summary.push("", "Linux Bubblewrap integration tests:", integrationSummary(integration), `Combined output: ${logPath}`);
    } finally {
      rmSync(fixture, { force: true });
    }
  }

  writeFileSync(logPath, `${fullOutput.join("\n")}\n`, { mode: 0o600 });
  return { failed, summary: summary.join("\n"), logPath };
}
