import { confirm } from '@ttylabs/sigil/components';

const overwrite = await confirm({ message: 'Overwrite dist/?', default: false });

console.log(overwrite ? 'Overwriting' : 'Leaving dist/ alone');
