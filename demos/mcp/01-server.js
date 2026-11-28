/**
 * A sigil app served to an agent over MCP, by adding one command.
 *
 *   node demos/mcp/01-server.js                    # the tour: it starts itself as a server and calls it
 *   node demos/mcp/01-server.js mcp                # the server, on stdin and stdout, for a real client
 *   node demos/mcp/01-server.js sum 12 30 --json   # the same app, run as a CLI
 *   node demos/mcp/01-server.js sum -- -5 12       # which cannot pass -5 as a number
 *   node demos/mcp/01-server.js deploy             # asks for the region, on a terminal
 *   node demos/mcp/01-server.js deploy --region eu --json
 *
 *   claude mcp add sigil-ops -- node "$PWD/demos/mcp/01-server.js" mcp
 *
 * `mcpCommand()` from `@ttylabs/mcp` is the whole of the wiring: every command
 * the app can run becomes a tool, its options and arguments become the tool's
 * input schema, and what it declares about running it -- `readOnly`,
 * `destructive`, `idempotent` -- become the tool's annotations.
 *
 * With no arguments this file is the client as well. It starts itself with
 * `mcp`, speaks JSON-RPC to it over a pipe the way Claude Code or any other MCP
 * client would, and prints both halves of each exchange. Every call the server
 * answers runs in a child process of its own, which is what keeps a command
 * that prints from writing into the protocol stream.
 *
 * `deploy` is the command a terminal would draw: a prompt for the region and a
 * progress bar. Under MCP neither has a terminal, so the bar is reported as
 * progress notifications, and the prompt is asked of the client's user as an
 * elicitation -- unless the call's arguments already answered it, or the client
 * cannot elicit, in which case the call fails naming the argument to pass.
 *
 * Needs no terminal: every line is `console.log`, so this is the same output
 * piped as it is on a screen.
 */
import { mcpCommand } from '@ttylabs/mcp';
import { main } from '@ttylabs/sigil';
import { createProgress } from '@ttylabs/sigil/components/progress';
import { select } from '@ttylabs/sigil/components/prompt';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const schema = {
  name: 'ops',
  desc: 'Look after a handful of services',
  completion: false,
  schema: false,
  commands: {
    status: {
      desc: 'Show the services and whether each is up',
      readOnly: true,
      idempotent: true,
      format: true,
      run() {
        return {
          services: [
            { name: 'api', up: true },
            { name: 'worker', up: false },
          ],
        };
      },
    },
    sum: {
      desc: 'Add some numbers up',
      readOnly: true,
      format: true,
      args: [{ name: '<numbers...>', type: 'int', desc: 'What to add' }],
      run({ argv }) {
        return { total: argv.numbers.reduce((sum, n) => sum + n, 0) };
      },
    },
    greet: {
      desc: 'Say hello, on stdout',
      args: [{ name: '[who]', desc: 'Who to greet' }],
      options: { '--shout': { desc: 'Louder' } },
      run({ argv }) {
        // printed rather than returned, so the tool's answer is what it printed
        const line = `hello ${argv.who ?? 'world'}`;
        console.log(argv.shout ? line.toUpperCase() : line);
      },
    },
    cache: {
      desc: 'Manage the cache',
      commands: {
        clear: {
          desc: 'Throw the cache away',
          destructive: true,
          idempotent: true,
          format: true,
          run() {
            return { cleared: 42 };
          },
        },
      },
    },
    deploy: {
      desc: 'Ship a release to a region',
      format: true,
      options: { '--region [name]': { choices: ['us', 'eu'], desc: 'Where to ship it' } },
      async run(state) {
        // answered by --region where it was given; asked where it was not
        const region = await select({
          choices: ['us', 'eu'],
          message: 'Which region?',
          option: '--region',
          state,
        });
        const steps = ['build', 'upload', 'switch over'];
        const bar = createProgress({ text: steps[0], total: steps.length });
        for (const step of steps) {
          await sleep(100);
          bar.text = step;
          bar.tick();
        }
        bar.done('shipped');
        return { region, shipped: true };
      },
    },
    mcp: mcpCommand(),
  },
};

if (process.argv.length > 2) {
  // the app: run by a person, by a client as `mcp`, and by the server for each
  // call it answers, as `mcp --mcp-call`
  await main({ schema });
} else {
  await tour();
}

/**
 * Starts this file as a server and opens a session with it, as a client that can
 * do what `capabilities` says.
 */
async function connect(capabilities) {
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), 'mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  const session = { answer: undefined, request, server };
  let next = 1;

  /** Writes one JSON-RPC message. */
  function send(message) {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  /** Sends a request and waits for its response. */
  function request(method, params) {
    const id = next++;
    send({ id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
  }

  createInterface({ input: server.stdout }).on('line', (line) => {
    // every line the server writes is JSON-RPC: this would throw on anything else
    const message = JSON.parse(line);
    if (message.method === 'notifications/progress') {
      const { message: said, progress, total } = message.params;
      console.log(`  ← progress ${progress}/${total} ${said}`);
    } else if (message.method === 'elicitation/create') {
      // the server asking the client's user something, which a real client
      // would show them; this one answers from the session's script
      const { message: asked, requestedSchema } = message.params;
      const offered = requestedSchema.properties.value.enum;
      console.log(`  ← elicitation/create "${asked}" of ${JSON.stringify(offered)}`);
      console.log(`  → ${JSON.stringify(session.answer)}`);
      send({ id: message.id, result: session.answer });
    } else {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });

  // the handshake: the client names the revision it speaks and what it can do
  const init = await request('initialize', {
    capabilities,
    clientInfo: { name: 'demo', version: '1.0.0' },
    protocolVersion: '2025-11-25',
  });
  send({ method: 'notifications/initialized' });
  session.init = init.result;
  return session;
}

/** Calls a tool and prints what came back, and what the server sent meanwhile. */
async function call(session, name, args, why, meta) {
  console.log(`→ tools/call ${name} ${JSON.stringify(args)}`);
  if (why) {
    console.log(`  ${why}`);
  }
  const { result } = await session.request('tools/call', {
    arguments: args,
    name,
    ...(meta ? { _meta: meta } : {}),
  });
  const answer = result.structuredContent ?? result.content.map((it) => it.text).join('\n');
  console.log(`← ${result.isError ? 'isError ' : ''}${JSON.stringify(answer)}`);
  console.log();
}

/** Ends a session: closing stdin is how a client says it is done. */
async function close(session) {
  session.server.stdin.end();
  await new Promise((resolve) => session.server.on('exit', resolve));
}

/** Starts this file as a server, and calls it the way an agent would. */
async function tour() {
  // a client that can put a question to its user, which is what elicitation is
  const session = await connect({ elicitation: {} });
  const { protocolVersion, serverInfo } = session.init;
  console.log('→ initialize, as a client that can elicit');
  console.log(`← ${serverInfo.name} ${serverInfo.version}, protocol ${protocolVersion}`);
  console.log();

  // the tools: one per command that runs, so not `cache` itself, which only
  // lists what is under it, and not `mcp`, which is the server
  const { tools } = (await session.request('tools/list', {})).result;
  console.log('→ tools/list');
  for (const tool of tools) {
    const said = Object.keys(tool.annotations ?? {}).join(', ') || 'no annotations';
    console.log(`← ${tool.name.padEnd(12)} ${tool.description.padEnd(42)} ${said}`);
  }
  console.log();
  const sum = tools.find((tool) => tool.name === 'sum');
  console.log("sum's input schema, from its declared argument:");
  console.log(JSON.stringify(sum.inputSchema, null, 2).replace(/^/gm, '  '));
  console.log();

  await call(session, 'status', {}, "what a command returns is the tool's structuredContent");
  await call(
    session,
    'sum',
    { numbers: [-5, 12, 30] },
    'the arguments travel as data, so -5 is a number and not an option'
  );
  await call(
    session,
    'greet',
    { shout: true, who: 'Ada' },
    'a command that prints answers with what it printed, and never into the protocol'
  );
  await call(
    session,
    'sum',
    { numbers: ['ten'] },
    'a usage error is isError, with the code an agent can act on'
  );
  await call(session, 'cache_clear', {}, 'a subcommand is a tool named after its path');

  session.answer = { action: 'accept', content: { value: 'eu' } };
  await call(
    session,
    'deploy',
    {},
    'no region was passed, so the prompt is asked of the user; the bar is progress',
    { progressToken: 'deploy-1' }
  );
  await call(session, 'deploy', { region: 'us' }, 'a region was passed, so nobody is asked');
  await close(session);

  // a client that cannot elicit is told which argument would have answered it
  const plain = await connect({});
  console.log('→ initialize, as a client that cannot elicit');
  console.log();
  await call(plain, 'deploy', {}, 'nobody to ask, so the call says what to pass');
  await close(plain);
}
