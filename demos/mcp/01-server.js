/**
 * A sigil app served to an agent over MCP, by adding one command.
 *
 *   node demos/mcp/01-server.js                    # the tour: it starts itself as a server and calls it
 *   node demos/mcp/01-server.js mcp                # the server, on stdin and stdout, for a real client
 *   node demos/mcp/01-server.js sum 12 30 --json   # the same app, run as a CLI
 *   node demos/mcp/01-server.js sum -- -5 12       # which cannot pass -5 as a number
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
 * Needs no terminal: every line is `console.log`, so this is the same output
 * piped as it is on a screen.
 */
import { mcpCommand } from '@ttylabs/mcp';
import { main } from '@ttylabs/sigil';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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

/** Starts this file as a server, and calls it the way an agent would. */
async function tour() {
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), 'mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  let next = 1;
  createInterface({ input: server.stdout }).on('line', (line) => {
    // every line the server writes is JSON-RPC: this would throw on anything else
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });

  /** Sends a request, prints it, and waits for the response. */
  function request(method, params) {
    const id = next++;
    server.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
    return new Promise((resolve) => waiting.set(id, resolve));
  }

  /** Calls a tool and prints what came back. */
  async function call(name, args, why) {
    console.log(`→ tools/call ${name} ${JSON.stringify(args)}`);
    if (why) {
      console.log(`  ${why}`);
    }
    const { result } = await request('tools/call', { arguments: args, name });
    const answer = result.structuredContent ?? result.content.map((it) => it.text).join('\n');
    console.log(`← ${result.isError ? 'isError ' : ''}${JSON.stringify(answer)}`);
    console.log();
  }

  // the handshake: the client names the revision it speaks and what it can do
  const init = await request('initialize', {
    capabilities: {},
    clientInfo: { name: 'demo', version: '1.0.0' },
    protocolVersion: '2025-11-25',
  });
  const { protocolVersion, serverInfo } = init.result;
  console.log(`→ initialize`);
  console.log(`← ${serverInfo.name} ${serverInfo.version}, protocol ${protocolVersion}`);
  console.log();
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
  );

  // the tools: one per command that runs, so not `cache` itself, which only
  // lists what is under it, and not `mcp`, which is the server
  const { tools } = (await request('tools/list', {})).result;
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

  await call('status', {}, "what a command returns is the tool's structuredContent");
  await call(
    'sum',
    { numbers: [-5, 12, 30] },
    'the arguments travel as data, so -5 is a number and not an option'
  );
  await call(
    'greet',
    { shout: true, who: 'Ada' },
    'a command that prints answers with what it printed, and never into the protocol'
  );
  await call(
    'sum',
    { numbers: ['ten'] },
    'a usage error is isError, with the code an agent can act on'
  );
  await call('cache_clear', {}, 'a subcommand is a tool named after its path');

  // closing stdin is how a client ends the session
  server.stdin.end();
  await new Promise((resolve) => server.on('exit', resolve));
}
