import { barChart } from '@ttylabs/sigil/components/chart';

console.log(
  barChart(
    [
      { label: 'parser', value: 412 },
      { label: 'prompts', value: 388 },
      { label: 'renderer', value: 1_200 },
      { label: 'layout', value: 640 },
    ],
    { showValues: true, width: 48 }
  )
);
