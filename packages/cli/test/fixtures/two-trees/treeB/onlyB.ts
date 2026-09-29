import { command, type AnyCommand } from '@ttylabs/sigil';

/** Present in tree B and nowhere else. */
const onlyB: AnyCommand = command({
	desc: 'from tree B',
	run() {
		process.stdout.write('B\n');
	},
});

export default onlyB;
