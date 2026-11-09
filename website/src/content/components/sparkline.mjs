import { sparkline } from '@ttylabs/sigil/components/chart';

const latency = [12, 14, 13, 18, 25, 22, 19, 31, 44, 38, 29, 21, 17, 15, 16, 24, 33, 47, 52, 41];

console.log(`latency ${sparkline(latency)}  ${latency.at(-1)}ms`);
