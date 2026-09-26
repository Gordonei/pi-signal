/**
 * Global test setup — captures console output and restores environment
 * variables between tests to avoid cross-test pollution.
 */

// Save original console methods
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

// Capture output for inspection
let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  // Redirect console output
  console.log = jest.fn((...args: any[]) => logs.push(args.join(' ')));
  console.error = jest.fn((...args: any[]) => errors.push(args.join(' ')));
  console.warn = jest.fn((...args: any[]) => {});
  logs = [];
  errors = [];
});

afterEach(() => {
  // Restore console methods
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;

  // Clean up timers
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// Expose captured output for assertions
export function getLogs(): string[] { return logs; }
export function getErrors(): string[] { return errors; }
