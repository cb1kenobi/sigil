import { badgeView } from '@ttylabs/sigil/components/badge';
import { table } from '@ttylabs/sigil/components/table';

console.log(
  table(
    [
      ['parser', badgeView('PASS', { variant: 'success' }), '412ms'],
      ['prompts', badgeView('PASS', { variant: 'success' }), '388ms'],
      ['renderer', badgeView('FAIL', { variant: 'error' }), '1.20s'],
    ],
    {
      columns: [{ header: 'suite' }, { header: 'status' }, { header: 'time', align: 'right' }],
    }
  )
);
