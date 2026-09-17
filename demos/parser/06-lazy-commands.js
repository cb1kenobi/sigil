import { main } from '@ttylabs/sigil';
/**
 * Commands loaded from disk. Point at a directory and every module in it is a
 * command; the module is not read until that command is matched.
 *
 *   node demos/parser/06-lazy-commands.js deploy staging --dry-run
 *   node demos/parser/06-lazy-commands.js status
 *   node demos/parser/06-lazy-commands.js --help
 *
 * Note that `--help` lists the commands by name alone: their descriptions live
 * in modules nothing has read yet. `help deploy` loads that one and describes it.
 */
import { join } from 'node:path';

await main({
	argv: process.argv.length > 2 ? undefined : ['deploy', 'staging', '--dry-run'],
	schema: {
		name: 'lazy',
		desc: 'Commands read from a directory',
		commands: join(import.meta.dirname, 'commands'),
	},
});
