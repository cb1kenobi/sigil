/**
 * A sigil app served over MCP, end to end (SIG-721): the fixture app's own
 * `mcp` command is started as a client would start it, and spoken to in
 * newline-delimited JSON-RPC over its stdin and stdout.
 */

import { PROTOCOL_VERSIONS, toolName } from '../src/index.js';
import { tempDir } from './temp.js';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const app = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app');

interface Response {
  readonly error?: { readonly code: number; readonly message: string };
  readonly id: number | string | null;
  readonly result?: Record<string, unknown>;
}

/** A client over one server process. */
class Client {
  readonly #server: ChildProcessWithoutNullStreams;
  readonly #waiting = new Map<number | string | null, (response: Response) => void>();
  readonly lines: string[] = [];
  #next = 1;

  constructor() {
    this.#server = spawn(process.execPath, ['dev.mjs', 'mcp'], { cwd: app });
    createInterface({ input: this.#server.stdout }).on('line', (line) => {
      this.lines.push(line);
      // every line on stdout has to be protocol: this throws on anything else,
      // which is the claim that a command's own output never reaches it
      const response = JSON.parse(line) as Response;
      this.#waiting.get(response.id)?.(response);
      this.#waiting.delete(response.id);
    });
  }

  /** Sends a request and waits for its response. */
  request(method: string, params?: Record<string, unknown>): Promise<Response> {
    const id = this.#next++;
    const answered = this.expect(id);
    this.write({ id, jsonrpc: '2.0', method, params });
    return answered;
  }

  /** Waits for the response to an id, however it was sent. */
  expect(id: number | string | null): Promise<Response> {
    return new Promise((resolve) => this.#waiting.set(id, resolve));
  }

  /** Writes a message, or a raw line. */
  write(message: Record<string, unknown> | string): void {
    this.#server.stdin.write(
      `${typeof message === 'string' ? message : JSON.stringify(message)}\n`
    );
  }

  /** Closes stdin and waits for the server to exit. */
  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.#server.once('exit', (code) => resolve(code));
      this.#server.stdin.end();
    });
  }

  /** Whether the server has already exited. */
  get exited(): boolean {
    return this.#server.exitCode !== null || this.#server.signalCode !== null;
  }

  kill(): void {
    this.#server.kill();
  }
}

const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    if (!client.exited) {
      client.kill();
    }
  }
});

/** A server, initialized. */
async function connect(): Promise<Client> {
  const client = new Client();
  clients.push(client);
  await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
    protocolVersion: PROTOCOL_VERSIONS[0],
  });
  client.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return client;
}

/** Calls a tool and answers with its result. */
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.request('tools/call', { arguments: args, name });
  expect(response.error).toBeUndefined();
  return response.result as {
    content: { text: string; type: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

describe('a sigil app over MCP', () => {
  it('should negotiate a protocol version and say what it is', async () => {
    const client = new Client();
    clients.push(client);

    const asked = await client.request('initialize', { protocolVersion: '2025-06-18' });
    expect(asked.result).toEqual({
      capabilities: { tools: { listChanged: false } },
      instructions: 'A fixture app',
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fixture', version: '1.2.3' },
    });

    const unknown = await client.request('initialize', { protocolVersion: '1999-01-01' });
    expect(unknown.result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('should list every runnable command as a tool, and nothing that is not one', async () => {
    const client = await connect();
    const { tools } = (await client.request('tools/list')).result as {
      tools: {
        annotations?: unknown;
        inputSchema: { properties: object };
        name: string;
        title: string;
      }[];
    };

    // not the server itself, not a hidden command, not one `exclude` names, and
    // not `db`, which only lists what is under it
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'db_migrate',
      'echo',
      'fail',
      'print',
      'status',
      'wait',
    ]);

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('status')?.annotations).toEqual({ idempotentHint: true, readOnlyHint: true });
    expect(byName.get('db_migrate')?.annotations).toEqual({ destructiveHint: true });
    expect(byName.get('db_migrate')?.title).toBe('fixture db migrate');
    expect(Object.keys(byName.get('echo')!.inputSchema.properties)).toEqual(['value']);
  });

  it('should hand a positional starting with a dash to the command unchanged', async () => {
    // rebuilt as argv, `-5` would be an undeclared option and accepted as one
    const client = await connect();
    const result = await callTool(client, 'echo', { value: '-5' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ value: '-5' });
  });

  it('should answer with what a command printed, and keep it out of the protocol', async () => {
    const client = await connect();
    const result = await callTool(client, 'print');

    expect(result.content).toEqual([{ text: 'hello from stdout', type: 'text' }]);
    // every line the server wrote was a JSON-RPC message, or the client above
    // would have thrown reading it
    expect(client.lines.every((line) => line.startsWith('{"jsonrpc":"2.0"'))).toBe(true);
    expect((await client.request('ping')).result).toEqual({});
  });

  it('should report a usage error with its code, and a value the type refuses', async () => {
    const client = await connect();

    const missing = await callTool(client, 'fail');
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      error: { code: 'missing-option', name: 'UsageError' },
    });

    const invalid = await callTool(client, 'fail', { port: 'eighty' });
    expect(invalid.structuredContent).toMatchObject({ error: { code: 'invalid-value' } });

    const fine = await callTool(client, 'fail', { port: 8080 });
    expect(fine.structuredContent).toEqual({ port: 8080 });
  });

  it('should answer a protocol mistake with the JSON-RPC error for it', async () => {
    const client = await connect();

    expect((await client.request('tools/call', { name: 'nope' })).error?.code).toBe(-32602);
    expect((await client.request('resources/list')).error?.code).toBe(-32601);

    const parsed = client.expect(null);
    client.write('{not json');
    expect((await parsed).error?.code).toBe(-32700);
  });

  it('should kill a call that is cancelled, and not answer it', async () => {
    const client = await connect();
    const pidfile = join(tempDir('sigil-mcp-'), 'pid');

    let answered = false;
    const id = 'slow';
    void client.expect(id).then(() => (answered = true));
    client.write({
      id,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { pidfile }, name: 'wait' },
    });

    await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8') !== '');
    const pid = Number(readFileSync(pidfile, 'utf8'));
    client.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });

    await until(() => !alive(pid));
    // still serving, and the cancelled call never answered
    expect((await client.request('ping')).result).toEqual({});
    expect(answered).toBe(false);
  });

  it('should exit when the client closes stdin', async () => {
    const client = await connect();
    expect(await client.close()).toBe(0);
  });
});

describe('toolName()', () => {
  it.each([
    [[], 'fixture'],
    [['db', 'migrate'], 'db_migrate'],
    [['a:b', 'c d'], 'a_b_c_d'],
  ])('should name %j %s', (path, name) => {
    expect(toolName('fixture', path)).toBe(name);
  });
});

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a condition, polling, for up to five seconds. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
