/**
 * Which declaration wins, and why.
 *
 *   pnpm build
 *   node demos/style/01-cascade.js
 *
 * There is no renderer yet, so this prints the answer rather than drawing it.
 * Each section is one contest: two declarations that both reach the same
 * property, and the rule that decides between them. The order is layer, then
 * origin, then specificity, then source order -- and `!important` inverts the
 * first two and nothing else.
 *
 * Edit a sheet and re-run it. That is the whole point of the file.
 */
import { ansi } from '@ttylabs/sigil/ansi';
import { applyProps, Cascade, parseStylesheet } from '@ttylabs/sigil/style';

/** The element every contest below is about: `<box id="go" class="button p-2">`. */
const button = { classes: ['button', 'p-2'], id: 'go', type: 'box' };

/** The sixteen palette indices, by the names the parser takes. */
const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** Prints what a set of sheets resolves one property to, and who won. */
function contest(title, why, sheets, property = 'color', props) {
	const cascade = new Cascade(sheets);
	const style = cascade.resolve(button, { props });
	const value = style[property];
	const name =
		property.toLowerCase().includes('color') && typeof value === 'number'
			? (COLORS[value] ?? value)
			: JSON.stringify(value);

	console.log(`${ansi.bold(title)}`);
	for (const sheet of sheets) {
		for (const rule of sheet.rules) {
			const selectors = rule.selectors.map((s) => s.source).join(', ');
			const sets = rule.declarations.map((d) => `${d.property}${d.important ? '!' : ''}`).join(' ');
			console.log(
				`  ${ansi.dim(`${sheet.origin}/${rule.layer}`.padEnd(21))}` +
					`${selectors.padEnd(24)} ${ansi.dim(sets)}`
			);
		}
	}
	if (props) {
		console.log(`  ${ansi.dim('props'.padEnd(21))}${JSON.stringify(props)}`);
	}
	console.log(`  ${ansi.dim('->')} ${property} is ${ansi.cyan(String(name))}   ${ansi.dim(why)}`);
	console.log();
}

const app = (source) => parseStylesheet(source);
const from = (source, origin) => parseStylesheet(source, { origin });

console.log();

// swap the two rules and nothing changes: that is the whole claim
contest('specificity beats source order', 'an id outranks a class, wherever it was written', [
	app('.button { color: blue } #go { color: red }'),
]);

contest('source order breaks a tie', 'both are (0,1,0), so the later one wins', [
	app('.button { color: red } .p-2 { color: blue }'),
]);

contest('origin is asked before specificity', 'the app beats the framework, id or not', [
	from('#go.button { color: red }', 'framework'),
	from('box { color: blue }', 'app'),
]);

contest(
	'layer is asked before origin',
	'your components lose to your utilities, deliberately',
	[app('.button { padding: 4 } @layer utilities { .p-2 { padding: 2 } }')],
	'paddingTop'
);

contest(
	'...but only within one origin',
	"the framework's utilities do not beat the app's base",
	[
		from('@layer utilities { .p-2 { padding: 4 } }', 'framework'),
		from('@layer base { .button { padding: 2 } }', 'app'),
	],
	'paddingTop'
);

contest(
	'props beat every normal declaration',
	'where style="" sits in a browser',
	[app('#go { color: red }')],
	'color',
	{ color: 'blue' }
);

contest(
	'!important beats props',
	'the escape hatch for a component that baked a value in',
	[app('.button { color: red !important }')],
	'color',
	{ color: 'blue' }
);

contest(
	'!important inverts origin',
	'so an app sheet can reach past a component it did not write',
	[
		from('.button { color: red !important }', 'framework'),
		from('.button { color: blue !important }', 'app'),
	]
);

// --- the fast path -------------------------------------------------------

const cascade = new Cascade([
	app('.button { color: red; padding: 1 } .button { width: 4 !important }'),
]);
const resolved = cascade.resolveSheets(button);

console.log(ansi.bold('the prop fast path'));
console.log(`  ${ansi.dim('locked by !important:')} ${[...resolved.locked].join(', ')}`);
for (const props of [{}, { padding: '3' }, { width: '9' }]) {
	const style = applyProps(resolved, props);
	console.log(
		`  ${JSON.stringify(props).padEnd(20)} ${ansi.dim('->')} ` +
			`padding ${style.paddingTop}, width ${JSON.stringify(style.width)}`
	);
}
console.log(`  ${ansi.dim('one match, three answers: a prop write cannot restyle anything else')}`);
console.log();

// --- media ---------------------------------------------------------------

const responsive = new Cascade([
	app('.button { padding: 1 2 } @media (max-width: 40) { .button { padding: 0 1 } }'),
]);

console.log(ansi.bold('media queries'));
for (const width of [120, 40, 20]) {
	responsive.media = { colorLevel: 3, height: 24, width };
	const style = responsive.resolve(button);
	console.log(
		`  ${String(width).padStart(3)} columns ${ansi.dim('->')} ` +
			`padding ${style.paddingTop} ${style.paddingRight}`
	);
}
console.log();

// --- errors --------------------------------------------------------------

console.log(ansi.bold('what it refuses, and what it says'));
for (const source of [
	'.button { colour: red }',
	'.button { padding: 1 nonsense }',
	'box[disabled] { color: red }',
	'@layer mine { .a { color: red } }',
	'@media (orientation: landscape) { .a { color: red } }',
]) {
	try {
		parseStylesheet(source);
		console.log(`  ${ansi.red('accepted?')} ${source}`);
	} catch (err) {
		console.log(`  ${ansi.dim(source)}\n    ${ansi.yellow(err.message)}`);
	}
}
console.log();
