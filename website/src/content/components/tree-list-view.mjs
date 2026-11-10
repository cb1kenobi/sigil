import { runApp } from '@ttylabs/sigil/app';
import { TreeListView } from '@ttylabs/sigil/components/tree-list-view';

const app = runApp(() =>
  TreeListView({
    items: {
      text: 'my-app/',
      expanded: true,
      items: [
        {
          text: 'src/',
          items: ['index.ts', { text: 'commands/', items: ['build.ts', 'deploy.ts'] }],
        },
        { text: 'test/', items: ['build.test.ts'] },
        'package.json',
        'README.md',
      ],
    },
  })
);

process.exitCode = await app.exited;
