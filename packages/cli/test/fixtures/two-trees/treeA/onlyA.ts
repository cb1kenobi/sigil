import { command, type AnyCommand } from '@ttylabs/sigil';

/** Present in tree A and nowhere else. */
const onlyA: AnyCommand = command({
	desc: 'from tree A',
	run() {
		process.stdout.write('A\n');
	},
});

export default onlyA;
