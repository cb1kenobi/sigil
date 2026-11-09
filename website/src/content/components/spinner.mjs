import { createSpinner } from '@ttylabs/sigil/components/spinner';

const spinner = createSpinner({ text: 'Resolving dependencies' }).start();

await new Promise((resolve) => setTimeout(resolve, 2_000));
spinner.succeed('Resolved 42 packages');
