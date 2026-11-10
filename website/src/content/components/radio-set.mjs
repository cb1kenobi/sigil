import { runApp, useApp } from '@ttylabs/sigil/app';
import { keyHelp } from '@ttylabs/sigil/components/key-help';
import { describeRadioSet, RadioSet } from '@ttylabs/sigil/components/radio-set';
import { box } from '@ttylabs/sigil/element';

const app = runApp(() => {
  const { input } = useApp();
  const region = RadioSet({
    options: ['eu-west', 'us-east', { label: 'ap-south', disabled: 'at capacity' }, 'us-west'],
    value: 'eu-west',
  });
  describeRadioSet(input, region);
  return box({ 'flex-direction': 'column', 'row-gap': 1 }, region, keyHelp(input));
});

process.exitCode = await app.exited;
