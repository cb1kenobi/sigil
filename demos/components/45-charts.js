/**
 * Charts: a sparkline, bars, a braille line chart and a gauge.
 *
 *   node demos/components/45-charts.js
 *   NO_COLOR=1 node demos/components/45-charts.js
 */
import { barChart, gauge, lineChart, sparkline } from '@ttylabs/sigil/components';

// a fixed width, so the demo prints the same thing in any terminal
const width = 48;

// latency in milliseconds, with a dropped sample in the middle
const latency = [
  12,
  14,
  13,
  18,
  25,
  22,
  19,
  31,
  44,
  38,
  29,
  Number.NaN,
  21,
  17,
  15,
  16,
  24,
  33,
  47,
  52,
  41,
  30,
  22,
  18,
];

console.log('a sparkline fits a trend on a line; a dropped sample is a gap:\n');
console.log(`  p50 ${sparkline(latency)}  ${latency.at(-1)}ms`);
console.log(`  p99 ${sparkline(latency, { role: 'warn', width: 12 })}  (latest 12 only)`);

console.log('\n\nthe same bounds make two sparklines mean the same height:\n');
console.log(`  idle ${sparkline([2, 3, 2, 4], { max: 100, min: 0 })}`);
console.log(`  busy ${sparkline([60, 80, 95, 70], { max: 100, min: 0 })}`);

console.log('\n\nbars, horizontal and in eighths of a cell:\n');
console.log(barChart({ build: 12.4, test: 7.2, lint: 2.1, docs: 0.05 }, { width }));

console.log('\n\nvertical, with the labels under the columns:\n');
console.log(
  barChart(
    [
      { label: 'Mon', value: 4 },
      { label: 'Tue', value: 9 },
      { label: 'Wed', value: 6 },
      { label: 'Thu', value: 12 },
      { label: 'Fri', value: 7 },
    ],
    { direction: 'vertical', format: (n) => `${n}h`, height: 6 }
  )
);

console.log('\n\na line chart is braille: two dots across and four down a cell:\n');
console.log(lineChart(latency, { height: 6, width, xLabels: ['00:00', '00:23'] }));

console.log('\n\na gauge is a reading against a range, and changes role as it gets worse:\n');
for (const used of [0.35, 0.72, 0.93]) {
  console.log(gauge(used, { label: 'Disk', thresholds: { error: 0.9, warn: 0.7 }, width: 24 }));
}
console.log(
  gauge(512, { detail: '512 MiB / 1 GiB', label: 'Memory', max: 1024, style: 'line', width: 24 })
);

console.log('\n\nASCII where the terminal cannot draw blocks or braille:\n');
console.log(`  ${sparkline(latency, { ascii: true })}`);
console.log(barChart({ a: 3, b: 7 }, { ascii: true, width: 20 }));
console.log(lineChart([1, 4, 2, 6, 3], { ascii: true, height: 4, width: 24 }));
