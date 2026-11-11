import { __ } from '@ttylabs/sigil/i18n';

export default {
  desc: __`Build the app`,
  run(): void {
    process.stdout.write('built\n');
  },
};
