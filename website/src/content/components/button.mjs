import { runApp } from '@ttylabs/sigil/app';
import { Button } from '@ttylabs/sigil/components/button';
import { box } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'row', 'column-gap': 1 },
    Button({ label: 'Deploy', onPress: () => app.exit(0) }),
    Button({ label: 'Cancel', onPress: () => app.exit(1) })
  )
);

process.exitCode = await app.exited;
