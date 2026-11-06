import { autocomplete } from '@ttylabs/sigil/components';

const region = await autocomplete({
  message: 'Region',
  choices: [
    { label: 'us-east-1', hint: 'N. Virginia' },
    { label: 'us-west-2', hint: 'Oregon' },
    { label: 'eu-central-1', hint: 'Frankfurt' },
    { label: 'eu-west-1', hint: 'Ireland' },
    { label: 'ap-northeast-1', hint: 'Tokyo' },
  ],
});

console.log(`Deploying to ${region}`);
