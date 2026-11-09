import { selectKey } from '@ttylabs/sigil/components/select-key';

const action = await selectKey({
  message: 'src/index.ts exists',
  choices: [
    { key: 'o', label: 'Overwrite', value: 'overwrite' },
    { key: 's', label: 'Skip', value: 'skip' },
    { key: 'd', label: 'Show the diff', value: 'diff' },
  ],
});

console.log(action);
