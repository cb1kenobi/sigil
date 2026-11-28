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

import type { Answer, FromChild, ToChild } from './server.js';
import { main, type ParseState, type RunResult } from '@ttylabs/sigil';
import type { RemoteAnswer, RemoteQuestion } from '@ttylabs/sigil/components/prompt';
import { observeProgress } from '@ttylabs/sigil/output';

/** The call itself, out of what the server sends. */
type Call = Extract<ToChild, { type: 'call' }>;

/**
 * Whether a question can be put to the client as an elicitation (SIG-722): a
 * list of several is `2025-11-25`'s, and a choice is offered by its label, so two
 * choices that share one cannot be told apart.
 *
 * @param question - The question.
 * @param version - The revision the server and the client settled on.
 * @returns Whether to ask it.
 */
function canElicit(question: RemoteQuestion, version: string): boolean {
  if (question.kind === 'multiselect' && version < '2025-11-25') {
    return false;
  }
  const labels = question.choices?.map((choice) => choice.label) ?? [];
  return new Set(labels).size === labels.length;
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

  // the call first, and after it the answers to whatever the command asked
  const waiting = new Map<number, (answer: RemoteAnswer) => void>();
  const call = await new Promise<Call>((resolve) => {
    process.on('message', (raw) => {
      const message = raw as ToChild;
      if (message.type === 'call') {
        resolve(message);
      } else if (message.type === 'elicited') {
        waiting.get(message.id)?.(message.answer);
        waiting.delete(message.id);
      }
    });
  });

  // progress and prompts, where the client can hear and answer them. The prompt
  // module is loaded only then, because most calls never ask anything
  const stops: (() => void)[] = [];
  if (call.progress) {
    stops.push(
      observeProgress((update) => send({ type: 'progress', ...update } satisfies FromChild))
    );
  }
  if (call.elicit !== false) {
    const version = call.elicit;
    const { askRemotely } = await import('@ttylabs/sigil/components/prompt');
    let asked = 0;
    stops.push(
      askRemotely((question) => {
        if (!canElicit(question, version)) {
          return undefined;
        }
        const id = ++asked;
        send({ id, question, type: 'elicit' } satisfies FromChild);
        return new Promise((resolve) => waiting.set(id, resolve));
      })
    );
  }

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

  for (const stop of stops) {
    stop();
  }

  await new Promise<void>((resolve) => {
    try {
      send({ type: 'answer', ...answer } satisfies FromChild, () => resolve());
    } catch (err) {
      // a value IPC cannot carry -- a `BigInt`, a cycle -- is the command's
      // answer failing to arrive, which is a failure to report rather than a
      // call that never ends
      send({ error: described(err), ok: false, type: 'answer' } satisfies FromChild, () =>
        resolve()
      );
    }
  });

  // and then end, rather than waiting for the event loop to drain: a command
  // that returns with a pool, a timer or a socket still open would otherwise
  // hold this process, and the call, open for ever. What it printed is flushed
  // first, since the server answers a command that returned nothing with that
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))
    )
  );
  process.exit();
}
