import { filePicker } from '@ttylabs/sigil/components/file-picker';

const entry = await filePicker({ message: 'Entry point', extensions: ['.ts'] });

console.log(`Building ${entry}`);
