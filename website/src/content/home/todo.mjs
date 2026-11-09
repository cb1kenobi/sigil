import { main } from '@ttylabs/sigil';
import { text } from '@ttylabs/sigil/components/prompt';

await main({
  schema: {
    name: 'todo',
    desc: 'Keep a list of things to do',
    commands: {
      add: {
        desc: 'Add a task',
        args: ['[title]'],
        async run({ argv }) {
          // ask when there is no title, fail when nobody can answer
          const title = argv.title ?? (await text({ message: 'Title' }));
          console.log(`Added "${title}"`);
        },
      },
      'list, ls': {
        desc: 'List the tasks',
        run: () => console.log('2 tasks'),
      },
      remove: {
        // runs the command, but stays out of help and completion
        alias: 'rm',
        desc: 'Remove a task',
        args: ['<id>'],
        run: ({ argv }) => console.log(`Removed ${argv.id}`),
      },
    },
  },
});
