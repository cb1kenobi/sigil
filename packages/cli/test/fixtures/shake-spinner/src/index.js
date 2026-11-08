// One component from the barrel that holds the PNG codec, and nothing that
// decodes a picture: what `sigil build` keeps of the codec here is what an app
// pays for a capability it never used. SIG-328.
import { createSpinner } from '@ttylabs/sigil/components';

export default {
  desc: 'A fixture app that draws one spinner',
  name: 'shake-spinner',
  run() {
    const spinner = createSpinner({ text: 'working' });
    spinner.start();
    spinner.stop();
  },
};
