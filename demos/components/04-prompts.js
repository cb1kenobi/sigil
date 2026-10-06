/**
 * Every prompt. Needs a real terminal -- which is the point of the last part.
 *
 *   node demos/components/04-prompts.js
 *   node demos/components/04-prompts.js < /dev/null    <- fails loudly, does not hang
 */
import {
	confirm,
	multiline,
	multiselect,
	password,
	PromptError,
	select,
	text,
} from '@ttylabs/sigil/components';

try {
	const name = await text({
		message: 'Project name',
		default: 'my-app',
		validate: (value) => (/^[a-z][\w-]*$/.test(value) ? undefined : 'Lowercase, no spaces'),
	});

	const token = await password({ message: 'Access token' });

	const target = await select({
		message: 'Build target',
		choices: ['esm', 'cjs', { label: 'Both', value: 'both', hint: 'slower' }],
	});

	const features = await multiselect({
		message: 'Features',
		choices: [
			{ label: 'TypeScript', selected: true },
			{ label: 'Tests' },
			{ label: 'Linting', hint: 'oxlint' },
		],
		required: true,
	});

	// the multiline field: Enter is a newline, so Ctrl-D is what submits. Arrow
	// keys move between rows with a remembered column, Ctrl-Left and Ctrl-Right
	// move by words, and a pasted block keeps its line breaks -- which is the
	// deliberate inverse of what the one-line field above does with one
	const notes = await multiline({
		message: 'Release notes',
		placeholder: 'what changed, and why',
		rows: 6,
	});

	const ok = await confirm({ message: `Create ${name}?` });

	console.log('\n---');
	console.log({ name, token: '*'.repeat(token.length), target, features, notes, ok });
} catch (err) {
	if (err instanceof PromptError) {
		// the two ways a prompt does not get answered, which are different in kind
		console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
		process.exitCode = 1;
	} else {
		throw err;
	}
}
