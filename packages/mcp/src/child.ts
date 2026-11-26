/**
 * The child side of a tool call: take one call over IPC, run the command it
 * names, send back what it came to.
 *
 * The arguments reach the command as `input`, which puts each value on its
 * destination as data. Rebuilt as argv they would lose what argv cannot say: a
 * positional starting with a dash is read as an option, and with unknown options
 * allowed -- the default -- it would be accepted as one and the command would run
 * with the wrong input and nothing said.
 */

import type { Answer } from './server.js';
import { main, type ParseState, type RunResult } from '@ttylabs/sigil';

/** What the server sends a call's child. */
interface Call {
  readonly arguments: Record<string, unknown>;
  readonly path: readonly string[];
}

/**
 * An error as the server reports it: its message, its name, and a usage error's
 * `code`.
 *
 * @param err - What was thrown.
 * @returns The description.
 */
function described(err: unknown): Extract<Answer, { ok: false }>['error'] {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    message: err instanceof Error ? err.message : String(err),
    ...(typeof name === 'string' ? { name } : {}),
  };
}

/**
 * Answers the one call the server hands this process.
 *
 * The command runs through a nested `main()` with the app's own schema, so it is
 * matched, parsed and dispatched exactly as from a terminal, and the error is
 * rethrown rather than rendered so that it can be sent. Its return value is read
 * off an `afterRun` hook wrapped around the app's own, because `main()` answers
 * with the parse state for a command that returned nothing.
 *
 * @param state - The parse state of `mcp --mcp-call`.
 * @throws Where there is no IPC channel, which is a person running it by hand.
 */
export async function answerCall(state: ParseState): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) {
    throw new Error(
      '--mcp-call is how the MCP server runs one tool call, and needs the server to have started it'
    );
  }

  const call = await new Promise<Call>((resolve) => {
    process.once('message', (message) => resolve(message as Call));
  });

  let result: RunResult | undefined;
  const hooks = state.schema.hooks;
  const schema = {
    ...state.schema,
    hooks: {
      ...hooks,
      async afterRun(data: Parameters<NonNullable<NonNullable<typeof hooks>['afterRun']>>[0]) {
        result = data.result;
        await hooks?.afterRun?.(data);
      },
    },
  };

  let answer: Answer;
  try {
    await main({
      argv: [...call.path],
      input: call.arguments,
      schema,
      settings: { errorHandler: false },
    });
    answer = result?.ok === true ? { ok: true, value: result.value } : { ok: true };
  } catch (err) {
    answer = { error: described(err), ok: false };
  }

  await new Promise<void>((resolve) => {
    try {
      send(answer, () => resolve());
    } catch (err) {
      // a value IPC cannot carry -- a `BigInt`, a cycle -- is the command's
      // answer failing to arrive, which is a failure to report rather than a
      // call that never ends
      send({ error: described(err), ok: false } satisfies Answer, () => resolve());
    }
  });
  process.disconnect?.();
}
