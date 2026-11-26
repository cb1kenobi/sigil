// An app that serves itself over MCP. No `package.json` of its own: the nearest
// one is `@ttylabs/mcp`'s, so `@ttylabs/mcp` resolves to the package itself by
// self-reference and `@ttylabs/sigil` from its `node_modules`.
import { mcpCommand } from '@ttylabs/mcp';
import type { Schema } from '@ttylabs/sigil';
import { writeFileSync } from 'node:fs';

const schema: Schema = {
  commands: {
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
