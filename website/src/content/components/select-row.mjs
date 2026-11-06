import { selectRow } from '@ttylabs/sigil/components';

const deployment = await selectRow({
  message: 'Which deployment?',
  rows: [
    { name: 'web', region: 'eu-west', status: 'running', age: 12 },
    { name: 'api', region: 'us-east', status: 'running', age: 3 },
    { name: 'worker', region: 'ap-south', status: 'failed', age: 40 },
    { name: 'cron', region: 'eu-west', status: 'stopped', age: 90 },
  ],
  columns: [
    { header: 'Name', key: 'name' },
    { header: 'Region', key: 'region' },
    { header: 'Status', key: 'status' },
    { header: 'Age (d)', key: 'age', align: 'right' },
  ],
  short: (row) => row.name,
});

console.log(`Restarting ${deployment.name}`);
