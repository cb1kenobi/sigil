// The settings live on the schema, so they survive a build. They are not passed
// to `main()` anywhere: the executable `sigil build` generates calls
// `main({ schema })` and nothing else, and this app has to behave the same built.
import type { Schema } from '@ttylabs/sigil';

const schema: Schema = {
  name: 'settings-app',
  baseDir: import.meta.dirname,
  commands: './commands',
  settings: {
    allowUnknownOptions: false,
    // a function, which rides the schema the way a hook does
    errorHandler(err: unknown): void {
      process.stderr.write(`custom handler: ${(err as Error).message}\n`);
      process.exitCode = 7;
    },
    helpExitCode: 3,
  },
};

export default schema;
