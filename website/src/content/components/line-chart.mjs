import { lineChart } from '@ttylabs/sigil/components/chart';

const requests = [3, 4, 4, 6, 9, 14, 18, 17, 15, 12, 10, 12, 16, 21, 26, 24, 19, 14, 9, 6];

console.log(lineChart(requests, { height: 6, width: 48 }));
