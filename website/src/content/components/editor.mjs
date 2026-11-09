import { editor } from '@ttylabs/sigil/components/editor';

const notes = await editor({ message: 'Release notes', postfix: '.md' });

console.log(notes);
