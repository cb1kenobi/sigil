// an unbundled app: it reaches @ttylabs/sigil through the package exports map,
// and its command modules are TypeScript that nothing has compiled
import { main } from '@ttylabs/sigil';
import { fileURLToPath } from 'node:url';

await main({
	argv: process.argv.slice(2),
	schema: {
		name: 'ts-app',
		commands: fileURLToPath(new URL('./commands', import.meta.url)),
	},
});
