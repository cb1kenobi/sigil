import { runApp } from '@ttylabs/sigil/app';
import { Slider } from '@ttylabs/sigil/components/slider';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'row' },
    text('Volume', { 'margin-right': 1 }),
    Slider({ value: 40, format: (v) => `${v}%` })
  )
);

process.exitCode = await app.exited;
