// The other half of `shake-spinner`: an app that does draw a picture from PNG
// bytes, so the codec and its zlib really are in the bundle and their absence
// from the spinner's means something. SIG-328.
import { image } from '@ttylabs/sigil/components';
import { readFileSync } from 'node:fs';

export default {
  args: ['<file>'],
  desc: 'A fixture app that draws a picture',
  name: 'shake-image',
  run({ argv }) {
    process.stdout.write(`${image(readFileSync(argv.file))}\n`);
  },
};
