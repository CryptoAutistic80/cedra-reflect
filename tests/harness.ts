type TestFunction = () => void | Promise<void>;

interface RegisteredTest {
  readonly name: string;
  readonly execute: TestFunction;
}

const registered: RegisteredTest[] = [];

export function test(name: string, execute: TestFunction): void {
  registered.push({ name, execute });
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

export function ok(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

export async function rejects(
  execute: () => Promise<unknown>,
  expectedError: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await execute();
  } catch (error) {
    if (error instanceof expectedError) {
      return;
    }
    throw new Error(`Expected ${expectedError.name}, received ${error instanceof Error ? error.name : "unknown error"}.`);
  }
  throw new Error(`Expected ${expectedError.name}, but operation resolved.`);
}

export async function run(): Promise<void> {
  for (const current of registered) {
    await current.execute();
    console.log(`PASS ${current.name}`);
  }
  console.log(`PASS ${registered.length} deterministic TypeScript tests`);
}
