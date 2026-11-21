import { command, type AnyCommand } from '@ttylabs/sigil';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { Cascade, utilitySheet } from '@ttylabs/sigil/style';

/**
 * Two boxes drawn with the same classes, one of which holds the focus and one
 * of which is drawn in a wide terminal: `focus:` is a state variant and `md:`
 * a media one, and each one resolves through a different part of the cascade.
 */
function draw(focused: boolean, width: number): string {
  const field = box(
    { class: 'border border-white focus:border-green md:border-red' },
    text('x', { class: 'text-white' })
  );
  if (focused) {
    field.setState('focus');
  }
  return renderToString(field, {
    cascade: new Cascade([utilitySheet()]),
    colorLevel: 3,
    width,
  });
}

const panel: AnyCommand = command({
  desc: 'Draw a bordered box, focused or not, narrow or wide',

  options: {
    '--focused': { desc: 'Give the box the focus' },
    '--width [cells]': { default: 40, desc: 'How wide the terminal is', type: 'int' },
  },

  run({ argv }) {
    process.stdout.write(`${draw(Boolean(argv.focused), Number(argv.width))}\n`);
  },
});

export default panel;
