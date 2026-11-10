import { runApp } from '@ttylabs/sigil/app';
import { Checkbox } from '@ttylabs/sigil/components/checkbox';
import { box } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'column' },
    Checkbox({ label: 'Run the tests first' }),
    Checkbox({ label: 'Tag the release', checked: true })
  )
);

process.exitCode = await app.exited;
