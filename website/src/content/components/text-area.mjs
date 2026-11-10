import { runApp } from '@ttylabs/sigil/app';
import { TextArea } from '@ttylabs/sigil/components/text-area';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'column' },
    text('Commit message', { class: 'sigil-heading' }),
    TextArea({ lineNumbers: true, placeholder: 'A summary on the first line', rows: 4 }),
    text('Shift-arrows select · Ctrl-C quits', { class: 'sigil-muted' })
  )
);

process.exitCode = await app.exited;
