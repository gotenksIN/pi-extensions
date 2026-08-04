import { inspect, isDeepStrictEqual } from "node:util";
import type { ClassifierModelRegistry } from "../classifier-provider.ts";
import type { ClassifierConfig } from "../types.ts";

export interface TestRunContext {
  readonly liveClassifier?: {
    readonly registry: ClassifierModelRegistry;
    readonly config: ClassifierConfig;
  };
}

type TestBody = (context: TestRunContext) => void | string | Promise<void | string>;
type ThrowsMatcher = RegExp | ((error: unknown) => boolean);

interface RegisteredTest {
  name: string;
  body: TestBody;
}

export interface TestFailure {
  name: string;
  message: string;
  stack?: string;
}

export type TestResult =
  | { name: string; status: "passed"; detail?: string }
  | { name: string; status: "skipped"; reason: string }
  | { name: string; status: "failed"; error: TestFailure };

export interface TestSuiteResult {
  total: number;
  passed: number;
  skipped: number;
  failed: number;
  tests: readonly TestResult[];
}

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

const registeredTests: RegisteredTest[] = [];
const registeredNames = new Set<string>();

function formatValue(value: unknown): string {
  return inspect(value, { depth: 8, sorted: true, breakLength: 100 });
}

class SkipTest extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SkipTest";
  }
}

function fail(message: string): never {
  throw new AssertionError(message);
}

export function skip(reason: string): never {
  throw new SkipTest(reason);
}

export function test(name: string, body: TestBody): void {
  if (!name.trim()) throw new Error("Test names must not be empty");
  if (registeredNames.has(name)) throw new Error(`Duplicate test name: ${name}`);
  registeredNames.add(name);
  registeredTests.push({ name, body });
}

export const assert = {
  equal(actual: unknown, expected: unknown): void {
    if (!Object.is(actual, expected)) {
      fail(`Expected ${formatValue(actual)} to equal ${formatValue(expected)}`);
    }
  },

  deepEqual(actual: unknown, expected: unknown): void {
    if (!isDeepStrictEqual(actual, expected)) {
      fail(`Expected deep equality:\nactual:   ${formatValue(actual)}\nexpected: ${formatValue(expected)}`);
    }
  },

  ok(value: unknown): void {
    if (!value) fail(`Expected a truthy value, received ${formatValue(value)}`);
  },

  notEqual(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) {
      fail(`Expected ${formatValue(actual)} not to equal ${formatValue(expected)}`);
    }
  },

  throws(body: () => unknown, expected: ThrowsMatcher): unknown {
    let caught: unknown;
    let didThrow = false;
    try {
      body();
    } catch (error) {
      caught = error;
      didThrow = true;
    }

    if (!didThrow) fail("Expected function to throw");

    if (expected instanceof RegExp) {
      expected.lastIndex = 0;
      const text = caught instanceof Error ? caught.message : String(caught);
      const matched = expected.test(text);
      expected.lastIndex = 0;
      if (!matched) fail(`Thrown value ${formatValue(caught)} did not match ${expected}`);
    } else if (!expected(caught)) {
      fail(`Thrown value did not satisfy predicate: ${formatValue(caught)}`);
    }

    return caught;
  },
};

function captureFailure(error: unknown): TestFailure {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "ThrownValue", message: formatValue(error) };
}

export async function runRegisteredTests(context: TestRunContext = {}): Promise<TestSuiteResult> {
  const results: TestResult[] = [];

  for (const registered of registeredTests) {
    try {
      const detail = await registered.body(context);
      results.push({ name: registered.name, status: "passed", ...(detail ? { detail } : {}) });
    } catch (error) {
      if (error instanceof SkipTest) {
        results.push({ name: registered.name, status: "skipped", reason: error.reason });
      } else {
        results.push({ name: registered.name, status: "failed", error: captureFailure(error) });
      }
    }
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    total: results.length,
    passed: results.length - failed - skipped,
    skipped,
    failed,
    tests: results,
  };
}

export function formatTestSummary(result: TestSuiteResult): string {
  const lines = [
    `Bubblewrap sandbox unit tests: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.total} total`,
  ];

  for (const testResult of result.tests) {
    if (testResult.status === "passed" && testResult.detail) {
      lines.push(`PASS ${testResult.name}: ${testResult.detail}`);
    } else if (testResult.status === "skipped") {
      lines.push(`SKIP ${testResult.name}: ${testResult.reason}`);
    } else if (testResult.status === "failed") {
      const detail = testResult.error.stack ?? `${testResult.error.name}: ${testResult.error.message}`;
      lines.push(`FAIL ${testResult.name}`, ...detail.split("\n").map((line) => `  ${line}`));
    }
  }

  return lines.join("\n");
}
