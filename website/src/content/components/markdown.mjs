import { markdown } from '@ttylabs/sigil/components';

console.log(
  markdown(
    [
      '## Unreleased',
      '',
      '- Tooltips follow a **scrolled** anchor',
      '- `select()` takes an AbortSignal',
      '',
      '> Run `pnpm build` once before the tests.',
    ].join('\n')
  )
);
