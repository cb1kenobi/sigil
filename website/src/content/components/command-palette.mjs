import { main } from '@ttylabs/sigil';
import { commandPalette } from '@ttylabs/sigil/components/palette';

await main({
  schema: {
    name: 'shop',
    commands: {
      // with no command named, ask for one
      '!palette': { default: true, run: (state) => commandPalette(state) },
      build: { desc: 'Build the app', run: () => {} },
      deploy: { desc: 'Ship it to an environment', args: ['<env>'], run: () => {} },
      'db migrate': { desc: 'Run the migrations', run: () => {} },
      test: { desc: 'Run the tests', run: () => {} },
    },
  },
});
