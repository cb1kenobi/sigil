import { runApp, useApp } from '@ttylabs/sigil/app';
import { Menubar } from '@ttylabs/sigil/components/menubar';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() => {
  const { input } = useApp();
  return box(
    { 'flex-direction': 'column', height: 10 },
    Menubar({
      input,
      menus: [
        {
          label: '&File',
          items: [
            { label: '&New', hint: 'ctrl+n', value: 'new' },
            { label: '&Open...', hint: 'ctrl+o', value: 'open' },
            { label: 'Open &Recent', items: [{ label: 'notes.md', value: 'notes' }] },
            { separator: '' },
            { label: '&Quit', value: 'quit' },
          ],
        },
        { label: '&Edit', items: [{ label: '&Undo', disabled: 'Nothing to undo', value: 'undo' }] },
        { label: '&Help', items: [{ label: '&About', value: 'about' }] },
      ],
      onSelect: () => app.exit(0),
    }),
    text('F10 or Alt-F opens the menus')
  );
});

process.exitCode = await app.exited;
