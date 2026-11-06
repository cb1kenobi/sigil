import { tree } from '@ttylabs/sigil/components';

console.log(
  tree({
    text: 'my-app',
    items: [
      'package.json',
      { text: 'src', items: ['index.ts', { text: 'commands', items: ['build.ts', 'deploy.ts'] }] },
      { text: 'test', items: ['build.test.ts'] },
    ],
  })
);
