import { largeText, parseFlf } from '@ttylabs/sigil/components/large-text';
import { readFileSync } from 'node:fs';

const font = parseFlf(readFileSync('blocks.flf', 'utf8'));

console.log(largeText('sigil', { font }));
