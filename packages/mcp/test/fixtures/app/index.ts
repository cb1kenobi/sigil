// An app that serves itself over MCP. No `package.json` of its own: the nearest
// one is `@ttylabs/mcp`'s, so `@ttylabs/mcp` resolves to the package itself by
// self-reference and `@ttylabs/sigil` from its `node_modules`.
import { mcpCommand } from '@ttylabs/mcp';
import type { Schema } from '@ttylabs/sigil';
import { createProgress } from '@ttylabs/sigil/components/progress';
import { confirm, multiselect, select } from '@ttylabs/sigil/components/prompt';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const schema: Schema = {
  commands: {
    build: {
      desc: 'Three steps, with a progress bar',
      run() {
        const bar = createProgress({ text: 'building', total: 3 });
        for (let step = 0; step < 3; step++) {
          bar.tick();
        }
        bar.done('built');
        return 'built';
      },
    },
    deploy: {
      // prompts an argument can answer (SIG-719), which a tool call passes as input
      options: { '--region [name]': {}, '--yes': {} },
      async run(state) {
        const region = await select({
          choices: ['us', 'eu'],
          message: 'Which region?',
          option: '--region',
          state,
        });
        const sure = await confirm({ message: 'Deploy?', option: '--yes', state });
        return { region, sure };
      },
    },
    pick: {
      async run() {
        return { region: await select({ choices: ['us', 'eu'], message: 'Which region?' }) };
      },
    },
    tags: {
      async run() {
        return { tags: await multiselect({ choices: ['a', 'b', 'c'], message: 'Which tags?' }) };
      },
    },
    db: { commands: { migrate: { destructive: true, desc: 'Migrate', run: () => 'migrated' } } },
    echo: {
      args: [{ name: '[value]' }],
      desc: 'Answer with what it was given',
      run: ({ argv }) => ({ value: argv.value }),
    },
    fail: {
      options: { '--port <port>': { type: 'int' } },
      run: ({ argv }) => ({ port: argv.port }),
    },
    hidden: { hidden: true, run() {} },
    mcp: mcpCommand({ exclude: ['skipped'] }),
    print: {
      run() {
        process.stdout.write('hello from stdout\n');
      },
    },
    skipped: { run() {} },
    status: { desc: 'Report', idempotent: true, readOnly: true, run: () => ({ healthy: true }) },
    linger: {
      // returns while a timer still holds the process open, as a pool or a
      // keep-alive socket would
      options: { '--pidfile <file>': {} },
      run({ argv }) {
        writeFileSync(String(argv.pidfile), String(process.pid));
        setInterval(() => {}, 1000);
        return { lingered: true };
      },
    },
    orphan: {
      // starts a process that outlives the call holding the call's stdout, and
      // says where both are
      options: { '--pidfile <file>': {} },
      run({ argv }) {
        const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        grandchild.unref();
        writeFileSync(String(argv.pidfile), `${process.pid} ${grandchild.pid}`);
        console.log('started');
        return { started: true };
      },
    },
    wait: {
      options: { '--pidfile <file>': {} },
      run({ argv }) {
        writeFileSync(String(argv.pidfile), String(process.pid));
        return new Promise(() => {
          setInterval(() => {}, 1000);
        });
      },
    },
  },
  desc: 'A fixture app',
  name: 'fixture',
  version: '1.2.3',
};

export default schema;
