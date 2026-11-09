import { note } from '@ttylabs/sigil/components/note';

console.log(
  note('Run `pnpm build` before the tests: they read dist/.', {
    title: 'Before you start',
    variant: 'info',
  })
);
