import { runApp } from '@ttylabs/sigil/app';
import { openMenu } from '@ttylabs/sigil/components/menu';
import { box, text } from '@ttylabs/sigil/element';

const file = text('report.md', { focusable: true });
const app = runApp(() => box({ 'flex-direction': 'column', height: 9 }, file));

const chosen = await openMenu(app.view, {
  at: file,
  input: app.input,
  items: [
    { label: '&Open', hint: 'enter', value: 'open' },
    { label: '&Rename...', value: 'rename' },
    { separator: '' },
    {
      label: 'Copy &path',
      items: [
        { label: 'Absolute', value: 'abs' },
        { label: 'Relative', value: 'rel' },
      ],
    },
    { label: '&Delete', disabled: 'Read-only', value: 'delete' },
  ],
}).result;
app.exit(chosen === undefined ? 1 : 0);
