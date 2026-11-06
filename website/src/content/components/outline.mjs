import { outline } from '@ttylabs/sigil/components';

console.log(
  outline(
    [
      'Install the package',
      { text: 'Configure it', items: ['Pick a theme', 'Pick a shell for completions'] },
      'Ship it',
    ],
    { enumerator: ['arabic', 'alpha'] }
  )
);
