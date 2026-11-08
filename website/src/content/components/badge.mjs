import { badge } from '@ttylabs/sigil/components/badge';

console.log(
  [
    badge('PASS', { variant: 'success' }),
    badge('FAIL', { variant: 'error' }),
    badge('beta', { variant: 'warning' }),
    badge('v2.0.0'),
  ].join(' ')
);
