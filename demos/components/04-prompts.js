/**
 * Every prompt. Needs a real terminal -- which is the point of the last part.
 *
 *   node demos/components/04-prompts.js
 *   node demos/components/04-prompts.js < /dev/null    <- fails loudly, does not hang
 */
import {
	confirm,
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

	const ok = await confirm({ message: `Create ${name}?` });

	console.log('\n---');
	console.log({ name, token: '*'.repeat(token.length), target, features, ok });
} catch (err) {
	if (err instanceof PromptError) {
		// the two ways a prompt does not get answered, which are different in kind
		console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
		process.exitCode = 1;
	} else {
		throw err;
	}
}
