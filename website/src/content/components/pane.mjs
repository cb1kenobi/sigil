import { runApp } from '@ttylabs/sigil/app';
import { Pane } from '@ttylabs/sigil/components/pane';
import { Panel } from '@ttylabs/sigil/components/panel';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'row', 'flex-grow': 1 },
    Pane(
      { size: 18, min: 12, collapsible: true },
      Panel(
        { title: 'files', footer: '3 files' },
        text('src/'),
        text('  main.js'),
        text('README.md')
      )
    ),
    box({ 'flex-grow': 1, 'min-width': 0 }, text('the main region takes what the panes leave')),
    Pane(
      { size: 16, min: 10, edge: 'start' },
      Panel({ title: 'log', annotation: 'tail' }, text('12:01 build ok'), text('12:02 watching'))
    )
  )
);

process.exitCode = await app.exited;
