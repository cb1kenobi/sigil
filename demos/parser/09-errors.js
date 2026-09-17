/**
 * What happens when something is wrong, and how to take it over.
 *
 *   node demos/parser/09-errors.js
 *   node demos/parser/09-errors.js --port nope
 */
import { errorExitCode, main, renderError } from '@ttylabs/sigil';

const schema = {
	name: 'errors',
	commands: {
		serve: {
			default: true,
			args: ['<host>'],
			options: { '--port [n]': { type: 'int' } },
			run: ({ argv }) => console.log('serving', argv.host, argv.port),
		},
	},
};

// 1. the default: the message on stderr, a non-zero exit code, and no stack
console.log('--- handled by main() ---');
await main({ argv: [], schema });
console.log('exit code is now', process.exitCode);
process.exitCode = 0;

// 2. your own handler
console.log('\n--- a handler of your own ---');
await main({
	argv: [],
	schema,
	settings: {
		errorHandler(err) {
			console.error(`sorry: ${renderError(err)}`);
			process.exitCode = errorExitCode(err);
		},
	},
});
process.exitCode = 0;

// 3. or turn it off and catch it yourself
console.log('\n--- rethrown ---');
try {
	await main({ argv: [], schema, settings: { errorHandler: false } });
} catch (err) {
	console.log('caught:', err.message);
}
process.exitCode = 0;
