import { gauge } from '@ttylabs/sigil/components/chart';

console.log(gauge(0.72, { label: 'disk', width: 40 }));
console.log(gauge(0.94, { label: 'memory', width: 40 }));
