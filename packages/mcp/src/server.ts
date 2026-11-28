/**
 * The MCP server: newline-delimited JSON-RPC 2.0 over stdin and stdout, and one
 * child process per tool call.
 *
 * Written by hand rather than over the official SDK, which would be this
 * package's first dependency and its larger half: the stdio transport is a
 * line reader and `JSON.stringify`, and the methods a tool server answers are
 * five. What that costs is following the specification's revisions here, which
 * an SDK would only move to its own release notes.
 *
 * ## Why a child per call
 *
 * The command runs where its writes cannot reach the protocol. A command that
 * prints to stdout -- which is most of them -- would write into the JSON-RPC
 * stream if it ran in this process, and everything process-wide would leak from
 * one call into the next: `process.exitCode`, the quiet axis, the locale, the
 * working directory, and a command that calls `process.exit()`. A child gives
 * each call a fresh process, and its stdout becomes the call's text where the
 * command returned nothing.
 */

import type { ParseState } from '@ttylabs/sigil';
import type { RemoteAnswer, RemoteQuestion } from '@ttylabs/sigil/components/prompt';
import type { ProgressUpdate } from '@ttylabs/sigil/output';
import {
  commandSurface,
  type CommandInputSchema,
  inputSchemas,
  type ToolAnnotations,
} from '@ttylabs/sigil/reference';
import { type ChildProcess, spawn } from 'node:child_process';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The protocol revisions this server speaks, newest first. A client asking for
 * one of them gets it; any other gets the newest, which is the negotiation the
 * specification describes -- the client decides whether it can go on.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The flag a call's child is started with. */
export const CALL_FLAG = '--mcp-call';

/**
 * How long a call waits after its child exits for the child's pipes to close,
 * which they do with it unless a process it started holds them open.
 */
const EXIT_GRACE_MS = 250;

/** What `mcpCommand()` may be told. */
export interface McpOptions {
  /**
   * Commands to leave out, each as its path in words -- `'db migrate'`. A hidden
   * command is left out already.
   */
  readonly exclude?: readonly string[];
  /** The version `initialize` reports. The schema's `version` by default. */
  readonly version?: string;
}

/** One tool, and the command it calls. */
interface Tool {
  readonly entry: CommandInputSchema;
  readonly name: string;
}

/**
 * What the server sends a call's child: the call, and the answers to the
 * questions the child asked (SIG-722).
 */
export type ToChild =
  | {
      readonly arguments: Record<string, unknown>;
      /** The protocol revision elicitation speaks, or `false` where the client cannot elicit. */
      readonly elicit: string | false;
      readonly path: readonly string[];
      /** Whether the client asked for progress, by sending a token. */
      readonly progress: boolean;
      readonly type: 'call';
    }
  | { readonly answer: RemoteAnswer; readonly id: number; readonly type: 'elicited' };

/** What a call's child sends the server: progress, questions, and its answer. */
export type FromChild =
  | ({ readonly type: 'answer' } & Answer)
  | { readonly id: number; readonly question: RemoteQuestion; readonly type: 'elicit' }
  | ({ readonly type: 'progress' } & ProgressUpdate);

/** What the server does with what a call's child says along the way. */
interface Along {
  /** Asks the client's user, for a prompt. */
  readonly elicit: (question: RemoteQuestion) => Promise<RemoteAnswer>;
  /** Tells the client how far along the call is. */
  readonly progress: (update: ProgressUpdate) => void;
}

/**
 * A prompt's question as an elicitation's `requestedSchema`: an object of one
 * property, `value`, which is the restricted shape the specification allows --
 * a string, a boolean, a string out of a list, or (from `2025-11-25`) a list of
 * them. A choice is offered by its label; the prompt maps the label back.
 *
 * @param question - The question.
 * @returns The schema.
 */
export function elicitationSchema(question: RemoteQuestion): Record<string, unknown> {
  const labels = question.choices?.map((choice) => choice.label) ?? [];
  const value =
    question.kind === 'confirm'
      ? {
          type: 'boolean',
          ...(typeof question.default === 'boolean' ? { default: question.default } : {}),
        }
      : question.kind === 'text'
        ? {
            type: 'string',
            ...(typeof question.default === 'string' ? { default: question.default } : {}),
          }
        : question.kind === 'select'
          ? { enum: labels, type: 'string' }
          : {
              items: { enum: labels, type: 'string' },
              ...(question.min ? { minItems: question.min } : {}),
              ...(question.max !== undefined ? { maxItems: question.max } : {}),
              type: 'array',
            };
  return {
    properties: { value: { title: question.message, ...value } },
    required: ['value'],
    type: 'object',
  };
}

/** What a call's child sends back. */
export type Answer =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly error: { readonly code?: string; readonly message: string; readonly name?: string };
      readonly ok: false;
    };

/** What `tools/call` answers with. */
interface CallResult {
  readonly content: readonly { readonly text: string; readonly type: 'text' }[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/**
 * A command's tool name: its path joined with `_`, or the program's name for the
 * root. MCP allows letters, digits, `_`, `-` and `.` and up to 128 of them, so
 * anything else a route name holds becomes `_`.
 *
 * @param program - What the program is called.
 * @param path - The command's path.
 * @returns The name.
 */
export function toolName(program: string, path: readonly string[]): string {
  const raw = path.length > 0 ? path.join('_') : program;
  return raw.replaceAll(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || 'run';
}

/**
 * The path of the command this server is, from the root: its own name and its
 * ancestors', which the parse put on `contexts` innermost first.
 *
 * @param state - The parse state `mcpCommand()`'s `run()` was handed.
 * @returns The path.
 */
export function ownPath(state: ParseState): string[] {
  return state.contexts
    .slice(0, -1)
    .map((cmd) => cmd.name)
    .reverse();
}

/**
 * The tools an app serves: every runnable command but the server itself and
 * what is under it, and what `exclude` names.
 *
 * @param state - The parse state.
 * @param opts - The server's options.
 * @returns The program's name and the tools.
 * @throws Where two commands come to one tool name, naming both.
 */
export async function toolsOf(
  state: ParseState,
  opts: McpOptions
): Promise<{ instructions?: string; program: string; tools: Tool[] }> {
  const own = ownPath(state);
  const program = state.schema.name ?? basename(process.argv[1] ?? 'cli');
  const surface = await commandSurface({ ...state.schema, name: program });
  const excluded = new Set((opts.exclude ?? []).map((it) => it.trim().split(/\s+/).join(' ')));

  const tools: Tool[] = [];
  const named = new Map<string, string>();
  for (const entry of inputSchemas(surface).commands) {
    const under = own.length > 0 && own.every((segment, i) => entry.path[i] === segment);
    if (under || excluded.has(entry.path.join(' '))) {
      continue;
    }

    const name = toolName(program, entry.path);
    const other = named.get(name);
    if (other !== undefined) {
      // refused rather than numbered: a tool name is what an agent calls, so one
      // that changes with the order commands were declared in is an agent
      // calling the wrong command after an unrelated edit
      throw new Error(
        `"${other}" and "${entry.path.join(' ')}" are both the MCP tool "${name}"; leave one out with exclude`
      );
    }
    named.set(name, entry.path.join(' '));
    tools.push({ entry, name });
  }

  const root = surface.commands.find((cmd) => cmd.path.length === 0);
  return { instructions: root?.desc, program, tools };
}

/**
 * How to start this app again: the same runtime and the same entry, unless the
 * app is a single executable, where the executable is the entry.
 *
 * Node's single executable applications say so through `node:sea`, and a Bun
 * compiled binary puts its entry under a virtual `/$bunfs/` path; either way
 * `process.argv[1]` is not a script to hand back.
 *
 * @returns The command and the arguments before the app's own.
 */
function self(): [string, string[]] {
  const sea = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
  const script = process.argv[1];

  if (sea?.isSea?.() || !script || /^\/\$bunfs\/|[\\/]~BUN[\\/]/.test(script)) {
    return [process.execPath, []];
  }
  return [process.execPath, [...process.execArgv, script]];
}

/**
 * What a call's child came to, as a `tools/call` result.
 *
 * A value goes in as JSON text and, where it is an object, as
 * `structuredContent` too; a command that returned nothing answers with what it
 * printed. A failure is `isError` with the error's message, and its name and
 * `code` in `structuredContent` -- a usage error's code is what lets an agent
 * tell a call it got wrong from a command that broke. A child that ended without
 * an answer -- it called `process.exit()`, or crashed hard -- is a failure with
 * what it wrote to stderr.
 */
function resultOf(
  answer: Answer | undefined,
  stdout: string,
  stderr: string,
  status: string
): CallResult {
  if (answer?.ok === true) {
    const { value } = answer;
    if (value === undefined) {
      return { content: [{ text: stdout.trimEnd(), type: 'text' }] };
    }
    const structured =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { structuredContent: value as Record<string, unknown> }
        : {};
    return {
      content: [{ text: JSON.stringify(value, undefined, 2), type: 'text' }],
      ...structured,
    };
  }

  if (answer?.ok === false) {
    return {
      content: [{ text: answer.error.message, type: 'text' }],
      isError: true,
      structuredContent: { error: answer.error },
    };
  }

  return {
    content: [
      { text: stderr.trim() || `The command ended without an answer (${status})`, type: 'text' },
    ],
    isError: true,
  };
}

/**
 * Runs one tool call in a child process.
 *
 * @param own - The server command's path, which the child is started at.
 * @param tool - The tool.
 * @param args - The call's arguments.
 * @param track - Told the child, so a cancellation can kill it.
 * @param along - What to do with progress and questions, and whether to ask for them.
 * @returns The result.
 */
function call(
  own: readonly string[],
  tool: Tool,
  args: Record<string, unknown>,
  track: (child: ChildProcess) => void,
  along: Along & { readonly elicits: string | false; readonly reports: boolean }
): Promise<CallResult> {
  return new Promise((resolve) => {
    const [command, before] = self();
    const child = spawn(command, [...before, ...own, CALL_FLAG], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    track(child);

    let stdout = '';
    let stderr = '';
    let answer: Answer | undefined;
    let grace: NodeJS.Timeout | undefined;
    const settle = (result: CallResult): void => {
      clearTimeout(grace);
      resolve(result);
    };
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('message', (raw) => {
      const message = raw as FromChild;
      if (message.type === 'answer') {
        answer = message;
      } else if (message.type === 'progress') {
        along.progress(message);
      } else if (message.type === 'elicit') {
        void along.elicit(message.question).then((reply) => {
          if (child.connected) {
            child.send({ answer: reply, id: message.id, type: 'elicited' } satisfies ToChild);
          }
        });
      }
    });
    child.on('error', (err) => {
      settle({ content: [{ text: err.message, type: 'text' }], isError: true });
    });
    child.on('close', (code, signal) => {
      settle(resultOf(answer, stdout, stderr, signal ?? `exit code ${code}`));
    });
    child.on('exit', (code, signal) => {
      // the pipes close with the child unless a process it started holds them,
      // and then `close` never comes. What the child wrote before it exited is
      // read well inside the grace; what that other process writes is not the
      // call's
      grace = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        settle(resultOf(answer, stdout, stderr, signal ?? `exit code ${code}`));
      }, EXIT_GRACE_MS);
    });

    child.send({
      arguments: args,
      elicit: along.elicits,
      path: tool.entry.path,
      progress: along.reports,
      type: 'call',
    } satisfies ToChild);
  });
}

/**
 * A tool as `tools/list` describes it.
 *
 * @param program - What the program is called, for the title.
 * @param tool - The tool.
 * @returns The description.
 */
function described(program: string, tool: Tool): Record<string, unknown> {
  const annotations: ToolAnnotations | undefined = tool.entry.annotations;
  return {
    ...(annotations ? { annotations } : {}),
    ...(tool.entry.description ? { description: tool.entry.description } : {}),
    inputSchema: tool.entry.inputSchema,
    name: tool.name,
    title: [program, ...tool.entry.path].join(' '),
  };
}

/** A JSON-RPC message, as far as this server reads one. */
interface Message {
  readonly error?: unknown;
  readonly id?: number | string | null;
  readonly jsonrpc?: unknown;
  readonly method?: unknown;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
}

/**
 * Serves the app's commands until stdin closes.
 *
 * @param state - The parse state `mcpCommand()`'s `run()` was handed.
 * @param opts - The server's options.
 */
export async function serve(state: ParseState, opts: McpOptions): Promise<void> {
  const own = ownPath(state);
  const { instructions, program, tools } = await toolsOf(state, opts);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const declared = state.schema.version;
  const version =
    opts.version ??
    (typeof declared === 'function'
      ? declared()
      : typeof declared === 'string'
        ? declared
        : '0.0.0');

  // what `initialize` settled, which decides whether a prompt can be an
  // elicitation and which schema shapes it may use (SIG-722)
  let negotiated: string = PROTOCOL_VERSIONS[0];
  let elicits = false;

  // the server's own requests to the client, answered on the same stream
  const asked = new Map<string, (response: Message) => void>();
  let asking = 0;

  const running = new Map<number | string, ChildProcess>();
  const cancelled = new Set<number | string>();
  const pending = new Set<Promise<void>>();

  const send = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const reply = (id: number | string, result: unknown): void => send({ id, result });
  const fail = (id: number | string | null, code: number, message: string): void =>
    send({ error: { code, message }, id });
  const askClient = (method: string, params: Record<string, unknown>): Promise<Message> => {
    const id = `sigil-${++asking}`;
    return new Promise((resolve) => {
      asked.set(id, resolve);
      send({ id, method, params });
    });
  };

  const handle = async (message: Message): Promise<void> => {
    const { id, method, params } = message;
    const request = id !== undefined && id !== null;

    if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
      if (request) {
        fail(id, -32600, 'Invalid Request');
      }
      return;
    }

    switch (method) {
      case 'initialize': {
        const wanted = params?.protocolVersion;
        const protocolVersion =
          PROTOCOL_VERSIONS.find((it) => it === wanted) ?? PROTOCOL_VERSIONS[0];
        negotiated = protocolVersion;
        // elicitation is `2025-06-18`'s, and a client says it can by declaring it
        const capabilities = params?.capabilities as Record<string, unknown> | undefined;
        elicits = capabilities?.elicitation !== undefined && protocolVersion >= '2025-06-18';
        if (request) {
          reply(id, {
            capabilities: { tools: { listChanged: false } },
            ...(instructions ? { instructions } : {}),
            protocolVersion,
            serverInfo: { name: program, version },
          });
        }
        return;
      }
      case 'ping':
        if (request) {
          reply(id, {});
        }
        return;
      case 'tools/list':
        if (request) {
          reply(id, { tools: tools.map((tool) => described(program, tool)) });
        }
        return;
      case 'tools/call': {
        if (!request) {
          return;
        }
        const tool = byName.get(String(params?.name));
        if (!tool) {
          fail(id, -32602, `Unknown tool: ${String(params?.name)}`);
          return;
        }
        const args = params?.arguments ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          fail(id, -32602, 'Invalid arguments: expected an object');
          return;
        }

        // progress is sent only where the client asked for it with a token, and
        // only when it grows, which the specification requires of it
        const token = (params?._meta as Record<string, unknown> | undefined)?.progressToken as
          | number
          | string
          | undefined;
        let last = -Infinity;

        const result = await call(
          own,
          tool,
          args as Record<string, unknown>,
          (child) => running.set(id, child),
          {
            elicit: async (question) => {
              const response = await askClient('elicitation/create', {
                message: question.message,
                requestedSchema: elicitationSchema(question),
              });
              const outcome = response.result as
                | { action?: unknown; content?: Record<string, unknown> }
                | undefined;
              return outcome?.action === 'accept'
                ? { answered: true, value: outcome.content?.value }
                : { answered: false };
            },
            elicits: elicits ? negotiated : false,
            progress: (update) => {
              if (token === undefined || !(update.progress > last)) {
                return;
              }
              last = update.progress;
              send({
                method: 'notifications/progress',
                params: {
                  ...(update.message ? { message: update.message } : {}),
                  progress: update.progress,
                  progressToken: token,
                  ...(update.total !== undefined ? { total: update.total } : {}),
                },
              });
            },
            reports: token !== undefined,
          }
        );
        running.delete(id);
        // a cancelled request is not answered, which is what the specification
        // asks of the receiver of the cancellation
        if (cancelled.delete(id)) {
          return;
        }
        reply(id, result);
        return;
      }
      case 'notifications/cancelled': {
        const target = params?.requestId as number | string | undefined;
        if (target !== undefined && running.has(target)) {
          cancelled.add(target);
          running.get(target)!.kill();
        }
        return;
      }
      default:
        if (request) {
          fail(id, -32601, `Method not found: ${method}`);
        }
    }
  };

  const lines = createInterface({ crlfDelay: Infinity, input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      fail(null, -32600, 'Invalid Request');
      continue;
    }

    // a response to a request of the server's own, which is an elicitation
    if (message.method === undefined && typeof message.id === 'string' && asked.has(message.id)) {
      asked.get(message.id)!(message);
      asked.delete(message.id);
      continue;
    }

    // concurrently, so a slow call does not hold up a ping or a cancellation
    // of itself, which is the one message it has to let through
    const handled = handle(message).catch((err: unknown) => {
      if (message.id !== undefined && message.id !== null) {
        fail(message.id, -32603, err instanceof Error ? err.message : String(err));
      }
    });
    pending.add(handled);
    void handled.finally(() => pending.delete(handled));
  }

  // stdin closed: the client is gone, and so is anybody to answer
  for (const child of running.values()) {
    child.kill();
  }
  await Promise.allSettled(pending);
}
