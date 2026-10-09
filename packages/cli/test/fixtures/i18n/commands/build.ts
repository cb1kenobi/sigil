import { __ } from '@ttylabs/sigil/i18n';

export default {
	// a tag rather than a string, which is what `sigil build` lifts as a key and
	// re-emits as `() => __`Build the app``
	desc: __`Build the app`,
	run(): void {
		process.stdout.write(`${__`Building...`}\n`);
	},
};
