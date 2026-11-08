// The same app as `shake-spinner`, importing the spinner from its own subpath
// rather than from the barrel: what `sigil build` keeps here is what SIG-330
// measured a built one-component app at, against the barrel's.
import { createSpinner } from '@ttylabs/sigil/components/spinner';

export default {
  desc: 'A fixture app that draws one spinner, imported from its subpath',
  name: 'shake-spinner-subpath',
  run() {
    const spinner = createSpinner({ text: 'working' });
    spinner.start();
    spinner.stop();
  },
};
