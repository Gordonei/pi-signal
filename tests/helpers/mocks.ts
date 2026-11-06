// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This test helper uses runtime-only imports; type checking is skipped.

/**
 * Mock helpers for testing the pi-signal extension.
 */

// ── Environment Variable Helper ──────────────────────────────────────

/** Snapshot of current environment variables, saved at setup time. */
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function saveOriginalEnv() {
  const keys = [
    'PI_SIGNAL_ACCOUNT',
    'PI_SIGNAL_DAEMON_URL',
    'PI_SIGNAL_ALLOWLIST',
    'PI_SIGNAL_PRIMARY',
    'PI_SIGNAL_STATS',
    'PI_SIGNAL_DEBUG',
    'PI_SIGNAL_ATTACHMENTS_DIR',
    'PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS',
  ];
  for (const key of keys) {
    if (!(key in ORIGINAL_ENV)) {
      ORIGINAL_ENV[key] = process.env[key];
    }
  }
}
saveOriginalEnv();

/**
 * Set environment variables for a test, then restore them afterward.
 * Usage:
 *   withEnv({ PI_SIGNAL_ACCOUNT: '+15551234567' }, () => { ... });
 */
export function withEnv(
  overrides: Record<string, string>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const restored: Record<string, string | undefined> = {};

  // Save current values and apply overrides
  for (const key of Object.keys(overrides)) {
    if (process.env[key] !== undefined) {
      restored[key] = process.env[key];
    }
    process.env[key] = overrides[key];
  }

  const result = fn();

  // Restore original values
  if (result instanceof Promise) {
    return result.then(() => {
      for (const key of Object.keys(overrides)) {
        if (key in restored) {
          process.env[key] = restored[key];
        } else {
          delete process.env[key];
        }
      }
    });
  }

  for (const key of Object.keys(overrides)) {
    if (key in restored) {
      process.env[key] = restored[key];
    } else {
      delete process.env[key];
    }
  }
  return undefined;
}

// ── Mock WebSocket ──────────────────────────────────────────────────

interface WebSocketEvents {
  onopen?: () => void;
  onmessage?: (data: string) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (err: unknown) => void;
}

export class MockWebSocket implements WebSocket {
  static instances: MockWebSocket[] = [];
  events: WebSocketEvents = {};
  url: string = '';
  readyState: number = WebSocket.CONNECTING;
  protocol: string = '';
  binaryType: BinaryType = 'blob';
  extensions: string = '';

  // Queue of messages sent TO the mock
  outgoing: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static getLastInstance() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1] || null;
  }

  send(data: string): void {
    this.outgoing.push(data);
  }

  connect() {
    this.readyState = WebSocket.OPEN;
    this.events.onopen?.();
  }

  dispatchMessage(data: string) {
    if (this.events.onmessage) {
      this.events.onmessage(data);
    }
  }

  close(code: number = 1000, reason: string = '') {
    this.readyState = WebSocket.CLOSED;
    this.events.onclose?.(code, reason);
  }

  setError(err: unknown) {
    if (this.events.onerror) {
      this.events.onerror(err);
    }
  }

  // WebSocket interface stubs (not fully implemented, just satisfy the compiler)
  addEventListener: never = null as never;
  removeEventListener: never = null as never;
  dispatchEvent: never = null as never;

  get onopen(): ((ev: Event) => void) | null {
    return (this.events.onopen as any) || null;
  }
  set onopen(fn: ((ev: Event) => void) | null) {
    this.events.onopen = fn as (() => void) | undefined;
  }

  get onmessage(): ((ev: MessageEvent) => void) | null {
    return (this.events.onmessage as any) || null;
  }
  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    this.events.onmessage = (data: string) => {
      if (fn) {
        fn(new MessageEvent('message', { data }));
      }
    };
  }

  get onclose(): ((ev: CloseEvent) => void) | null {
    return (this.events.onclose as any) || null;
  }
  set onclose(fn: ((ev: CloseEvent) => void) | null) {
    this.events.onclose = (code, reason) => {
      if (fn) {
        fn(new CloseEvent('close', { code, reason }));
      }
    };
  }

  get onerror(): ((ev: Event) => void) | null {
    return (this.events.onerror as any) || null;
  }
  set onerror(fn: ((ev: Event) => void) | null) {
    this.events.onerror = fn;
  }
}

// ── Mock HTTP/HTTPS Client ─────────────────────────────────────────

interface MockHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

interface MockHttpCall {
  method: string;
  path: string;
  body?: string;
  callback: (res: {
    writeHead: (status: number, headers?: Record<string, string>) => void;
    end: (data?: string) => void;
  }) => void;
}

export type HttpHandler = (
  method: string,
  path: string,
  body?: string,
) => MockHttpResponse | null;

/**
 * Create a mock HTTP/HTTPS module that routes requests to handler functions.
 */
export function createMockHttp(
  handlers: HttpHandler,
  timeout: number = 0, // 0 = no timeout, >0 = simulate timeout
) {
  const calls: Array<{ method: string; path: string; body: string }> = [];

  const lib = {
    request: jest.fn((opts: any, callback: any) => {
      const method = opts.method;
      const path = opts.path;

      const handlerResult = handlers(method, path, '');
      const mockRes = {
        statusCode: handlerResult?.statusCode || 500,
        headers: handlerResult?.headers || {},
        on: jest.fn((event: string, fn: any) => {
          if (event === 'data') { /* captured */ }
          if (event === 'end') {
            if (handlerResult?.body && handlerResult.statusCode < 400) {
              fn(Buffer.from(handlerResult.body));
            } else if (handlerResult?.body && handlerResult.statusCode >= 400) {
              fn(Buffer.from(handlerResult.body));
            } else if (handlerResult && handlerResult.statusCode >= 200 && handlerResult.statusCode < 300) {
              fn(Buffer.from(handlerResult.body || ''));
            } else {
              fn(Buffer.from(handlerResult?.body || ''));
            }
          }
        }),
        statusCode: handlerResult?.statusCode || 500,
        headers: handlerResult?.headers || {},
      };

      calls.push({ method, path, body: '' });

      // Simulate timeout
      if (timeout > 0) {
        setTimeout(() => {
          // req already destroyed or would time out
        }, timeout);
        return {
          on: jest.fn((event: string, fn: any) => {
            if (event === 'timeout') {
              setTimeout(fn, timeout);
            }
          }),
          setTimeout: () => {},
          setHeader: () => {},
          end: () => {},
          destroy: () => {},
          write: () => {},
        } as any;
      }

      return {
        on: mockRes.on.bind(mockRes),
        setTimeout: () => {},
        setHeader: () => {},
        end: () => {},
        destroy: () => {},
        write: (data: string) => {
          calls[calls.length - 1].body = data;
        },
        removeListener: () => {},
      } as any;
    }),
    get: jest.fn((url: string, opts: any, callback: any) => {
      calls.push({ method: 'GET', path: new URL(url).pathname, body: '' });
      return {
        on: jest.fn(),
        removeListener: () => {},
        setTimeout: () => {},
      } as any;
    }),
    calls,
  };

  return lib;
}

// ── Mock PI Extension API ──────────────────────────────────────────

export interface MockPiApi {
  tools: Array<{ name: string; parameters: unknown }>;
  commands: Array<{ name: string; description: string }>;
  events: Array<{ event: string; handler: (...args: any[]) => void }>;
  setModelCalls: Array<{ model: unknown }>;
  sendUserMessageCalls: Array<{ message: string; options?: unknown }>;
  getSessionNameCalls: number;

  registerTool: (tool: any) => void;
  registerCommand: (name: string, cmd: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  setModel: (model: unknown) => Promise<boolean>;
  sendUserMessage: (message: string, options?: unknown) => void;
  getSessionName: () => string;
}

export function createMockPiApi(): MockPiApi {
  const tools: Array<{ name: string; parameters: unknown; execute: any }> = [];
  const commands: Array<{ name: string; description: string; handler: any }> = [];
  const events: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  const setModelCalls: Array<{ model: unknown }> = [];
  const sendUserMessageCalls: Array<{ message: string; options?: unknown }> = [];

  const pi = {
    registerTool: jest.fn((tool: any) => {
      tools.push(tool);
    }),
    registerCommand: jest.fn((name: string, cmd: any) => {
      commands.push({ name, description: cmd.description, handler: cmd.handler });
    }),
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      events.push({ event, handler });
    }),
    setModel: jest.fn((model: unknown) => {
      setModelCalls.push({ model });
      return Promise.resolve(true);
    }),
    sendUserMessage: jest.fn((message: string, options?: unknown) => {
      sendUserMessageCalls.push({ message, options });
    }),
    getSessionName: jest.fn(() => 'test-session'),
  };

  return {
    tools,
    commands,
    events,
    setModelCalls,
    sendUserMessageCalls,
    getSessionNameCalls: 0,
    registerTool: pi.registerTool,
    registerCommand: pi.registerCommand,
    on: pi.on,
    setModel: pi.setModel,
    sendUserMessage: pi.sendUserMessage,
    getSessionName: () => {
      pi.getSessionName();
      return 'test-session';
    },
  };
}

// ── Mock Extension Context ─────────────────────────────────────────

export interface MockExtensionContext {
  model: { name: string; id: string; provider: string } | null;
  getContextUsage: () => { tokens?: number; percent?: number; contextWindow?: number };
  modelRegistry: { getAll: () => Array<{ provider?: string; id?: string; name?: string }> };
  isIdle: () => boolean;
  abort: () => void;
  cwd: string;
  newSession: any;
}

export function createMockContext(
  overrides: Partial<MockExtensionContext> = {},
): MockExtensionContext {
  return {
    model: { name: 'claude-sonnet-4-20250514', id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
    getContextUsage: () => ({ tokens: 5000, percent: 0.5, contextWindow: 200000 }),
    modelRegistry: {
      getAll: () => [
        { provider: 'anthropic', id: 'claude-sonnet-4-20250514', name: 'claude-sonnet-4-20250514' },
        { provider: 'openai', id: 'gpt-4o', name: 'gpt-4o' },
        { provider: 'google', id: 'gemini-2.0-flash', name: 'gemini-2.0-flash' },
      ],
    },
    isIdle: () => true,
    abort: jest.fn(),
    cwd: '/test/workspace',
    newSession: jest.fn(),
    ...overrides,
  };
}
