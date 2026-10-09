import { __ } from '@ttylabs/sigil/i18n';

export default {
	desc: 'Build the app',
	run(): void {
		process.stdout.write(`${__`Building...`}\n`);
	},
};
