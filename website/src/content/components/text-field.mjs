import { runApp } from '@ttylabs/sigil/app';
import { TextField } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'row' },
    text('Name', { 'margin-right': 1 }),
    TextField({ placeholder: 'my-app', width: 24, onSubmit: (value) => app.exit(value ? 0 : 1) })
  )
);

process.exitCode = await app.exited;
