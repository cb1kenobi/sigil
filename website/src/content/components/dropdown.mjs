import { runApp, useApp } from '@ttylabs/sigil/app';
import { Dropdown } from '@ttylabs/sigil/components/dropdown';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() => {
  const { input } = useApp();
  return box(
    { 'column-gap': 1, 'flex-direction': 'row', height: 8 },
    text('Log level'),
    Dropdown({
      input,
      options: [
        'debug',
        'info',
        'warn',
        'error',
        { label: 'trace', value: 'trace', disabled: 'Not in this build' },
      ],
      value: 'info',
      onChange: (level) => app.exit(level === 'warn' ? 0 : 1),
    })
  );
});

process.exitCode = await app.exited;
