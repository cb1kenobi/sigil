/**
 * `topicSeparator: ':'` -- oclif's spelling of a command path, beside the
 * space form rather than instead of it.
 *
 *   node demos/parser/13-topics.js db:migrate:up --steps 2
 *   node demos/parser/13-topics.js db migrate up --steps 2
 *   node demos/parser/13-topics.js db:migrate up
 *   node demos/parser/13-topics.js fetch http://example.com
 *   node demos/parser/13-topics.js fetch localhost:8080
 *   node demos/parser/13-topics.js db:bogus      # `db` is a command; still not split
 *   node demos/parser/13-topics.js --help
 *   node demos/parser/13-topics.js db:migrate --help
 *   node demos/parser/13-topics.js help db:migrate
 */
import { main } from '@ttylabs/sigil';

const schema = {
  name: 'stack',
  desc: 'One path, two spellings',

  // the whole of the declaration. Routes are untouched by it: a directory
  // tree produces the same commands either way
  topicSeparator: ':',

  completion: false,
  options: { '-v, --verbose': 'Say more' },
  commands: {
    db: {
      desc: 'Database commands',
      commands: {
        migrate: {
          desc: 'Run migrations',
          options: { '--steps [n]': { default: 1, type: 'int' } },
          commands: {
            up: {
              desc: 'Migrate forwards',
              run: ({ argv, contexts }) => {
                console.log('steps:', argv.steps, 'verbose:', argv.verbose);
                // the same chain either spelling produced it
                console.log('chain:', contexts.map((c) => c.name).join(' <- '));
              },
            },
          },
          run: ({ argv }) => console.log('migrate, steps:', argv.steps),
        },
      },
    },

    // the hazard, and the reason the split is conditional: both of these are
    // ordinary values and neither is touched, because `http` and `localhost`
    // are not commands
    fetch: {
      desc: 'Fetch a URL',
      args: ['<url>'],
      run: ({ argv }) => console.log('url:', argv.url),
    },
  },
};

await main({
  argv: process.argv.length > 2 ? undefined : ['db:migrate:up', '--steps', '2'],
  schema,
});
