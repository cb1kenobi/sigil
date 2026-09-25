import { extractCommand } from '../../src/build/extract.js';
import { describe, it, expect } from 'vitest';

/**
 * What `sigil build` can read out of a command module without importing it.
 *
 * The whole reason this exists is that a lazily loaded command appears in help
 * by name alone, because its `desc` is inside the module and reading it means
 * importing it. Filesystem routing makes that the common case rather than a
 * rare one, so the build reads each module statically and bakes the answer in.
 *
 * Every case here is one of three things: a spelling of a literal that has to
 * be read, a spelling of a computed value that has to be *reported* rather
 * than guessed at, and the handful where guessing would be silently wrong.
 */
describe('extracting a command module', () => {
	describe('a literal', () => {
		it('should lift a description and a hidden flag', () => {
			const { diagnostics, facts } = extractCommand(
				'build.js',
				`export default { desc: 'build the app', hidden: true, run: () => {} };`
			);
			expect(facts).to.deep.equal({ desc: 'build the app', hidden: true });
			expect(diagnostics).to.deep.equal([]);
		});

		it('should read a template literal with nothing in it', () => {
			// `\`build the app\`` is a string somebody wrote, and refusing it would
			// make the two spellings of one thing disagree
			const { diagnostics, facts } = extractCommand(
				'build.ts',
				'export default { desc: `build the app` };'
			);
			expect(facts.desc).to.equal('build the app');
			expect(diagnostics).to.deep.equal([]);
		});

		it('should read a quoted key', () => {
			const { facts } = extractCommand('build.js', `export default { 'desc': 'quoted' };`);
			expect(facts.desc).to.equal('quoted');
		});

		it('should read false as a hidden flag rather than as nothing', () => {
			// `undefined` and `false` are different answers: one is "the module said
			// nothing" and the other is "the module said no"
			const { facts } = extractCommand('a.js', `export default { hidden: false };`);
			expect(facts.hidden).to.equal(false);
		});

		it('should leave a module that declares neither with no facts and no complaints', () => {
			const { diagnostics, facts } = extractCommand('a.js', `export default { run: () => {} };`);
			expect(facts).to.deep.equal({});
			expect(diagnostics).to.deep.equal([]);
		});
	});

	describe('the wrappers that change nothing', () => {
		it('should look through command()', () => {
			// `command()` is documented as the identity function and exists only so
			// inference reaches a nested literal, so what it wraps says exactly what
			// the bare literal says
			const { facts } = extractCommand(
				'a.ts',
				`import { command } from '@ttylabs/sigil';
				 export default command({ desc: 'wrapped' });`
			);
			expect(facts.desc).to.equal('wrapped');
		});

		it('should look through satisfies and as', () => {
			expect(
				extractCommand('a.ts', `export default { desc: 'sat' } satisfies Command;`).facts.desc
			).to.equal('sat');
			expect(
				extractCommand('a.ts', `export default { desc: 'as' } as Command;`).facts.desc
			).to.equal('as');
		});

		it('should look through parentheses', () => {
			expect(extractCommand('a.js', `export default ({ desc: 'paren' });`).facts.desc).to.equal(
				'paren'
			);
		});

		it('should not step into a call that takes more than the object', () => {
			// a wrapper doing anything more interesting than passing its argument
			// through almost always takes something else too, and reading the literal
			// out of one that transforms it is a wrong answer with no warning on it
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`export default withDefaults({ desc: 'inner' }, { desc: 'outer' });`
			);
			expect(facts.desc).to.equal(undefined);
			expect(diagnostics).to.have.lengthOf(1);
			expect(diagnostics[0]!.severity).to.equal('warning');
		});
	});

	describe('a computed value', () => {
		it('should report a computed description rather than guess at it', () => {
			const { diagnostics, facts } = extractCommand(
				'deploy.js',
				`export default { desc: describe() };`
			);
			expect(facts.desc).to.equal(undefined);
			expect(diagnostics).to.have.lengthOf(1);
			expect(diagnostics[0]).to.include({ file: 'deploy.js', line: 1, severity: 'warning' });
			expect(diagnostics[0]!.message).to.contain('"desc" is computed');
		});

		it('should report a concatenation, which is computed however simple it looks', () => {
			const { diagnostics, facts } = extractCommand('a.js', `export default { desc: 'a' + 'b' };`);
			expect(facts.desc).to.equal(undefined);
			expect(diagnostics[0]!.message).to.contain('"desc" is computed');
		});

		it('should report a template literal that interpolates', () => {
			const { facts, diagnostics } = extractCommand(
				'a.js',
				'export default { desc: `build ${target}` };'
			);
			expect(facts.desc).to.equal(undefined);
			expect(diagnostics[0]!.message).to.contain('"desc" is computed');
		});

		it('should report a shorthand, which names a binding rather than a value', () => {
			const { facts, diagnostics } = extractCommand(
				'a.js',
				`const desc = 'x';
				export default { desc };`
			);
			expect(facts.desc).to.equal(undefined);
			expect(diagnostics[0]!.message).to.contain('"desc" is computed');
		});

		it('should report a computed key even when it happens to hold a string', () => {
			// `['desc']` and `[key]` are the same syntax and only one of them is
			// readable; a pass that reads the easy half is worse than one that skips
			// both, because the half it skipped is silent
			const { facts } = extractCommand('a.js', `export default { ['desc']: 'sneaky' };`);
			expect(facts.desc).to.equal(undefined);
		});

		it('should report an accessor', () => {
			const { facts, diagnostics } = extractCommand(
				'a.js',
				`export default { get desc() { return 'x'; } };`
			);
			expect(facts.desc).to.equal(undefined);
			expect(diagnostics[0]!.message).to.contain('accessor');
		});

		it('should refuse a non-boolean hidden rather than read it as truthy', () => {
			// the runtime throws on a non-boolean `hidden` rather than coercing it,
			// so reading this as `true` would bake a value the app refuses to start
			// with
			const { facts, diagnostics } = extractCommand('a.js', `export default { hidden: 1 };`);
			expect(facts.hidden).to.equal(undefined);
			expect(diagnostics[0]!.message).to.contain('"hidden" is computed');
		});

		it('should carry a line and a column to the value rather than to the file', () => {
			const { diagnostics } = extractCommand('a.js', `export default {\n\tdesc: compute(),\n};`);
			expect(diagnostics[0]).to.include({ line: 2 });
			expect(diagnostics[0]!.column).to.be.greaterThan(1);
		});
	});

	describe('a default export that is a reference', () => {
		// not a style anybody chose: `--isolatedDeclarations` refuses to infer a
		// default export, so an app that has it on cannot write the literal
		// inline -- and this toolchain is one of those apps, so a lift that
		// stopped at the reference reported "help will list this command by name
		// alone" about every one of its own commands
		it('should follow `export default cmd` to the const it names', () => {
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`const cmd = { desc: 'x' };\nexport default cmd;`
			);
			expect(facts).to.deep.equal({ desc: 'x' });
			expect(diagnostics).to.have.lengthOf(0);
		});

		it('should follow `export { cmd as default }` the same way', () => {
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`const cmd = { desc: 'x' };\nexport { cmd as default };`
			);
			expect(facts).to.deep.equal({ desc: 'x' });
			expect(diagnostics).to.have.lengthOf(0);
		});

		it('should follow one through the wrappers that change nothing', () => {
			// `command()` is the identity function, and it is what every command
			// module in this repo is written with
			const { facts } = extractCommand(
				'a.js',
				`const cmd = command({ desc: 'x' });\nexport default cmd;`
			);
			expect(facts).to.deep.equal({ desc: 'x' });
		});

		it('should follow one the const exports in place', () => {
			const { facts } = extractCommand(
				'a.js',
				`export const cmd = { desc: 'x' };\nexport default cmd;`
			);
			expect(facts).to.deep.equal({ desc: 'x' });
		});

		it('should refuse a `let`, which can be reassigned before the module runs', () => {
			// what the binding held when the file was read is not what it holds
			// when the module runs, and a lift that guessed would bake a
			// description the app does not have
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`let cmd = { desc: 'x' };\ncmd = { desc: 'y' };\nexport default cmd;`
			);
			expect(facts).to.deep.equal({});
			expect(diagnostics[0]!.severity).to.equal('warning');
		});

		it('should warn when the reference does not resolve to a literal', () => {
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`const cmd = build();\nexport default cmd;`
			);
			expect(facts).to.deep.equal({});
			expect(diagnostics[0]!.severity).to.equal('warning');
		});

		it('should warn when the reference names nothing in the module', () => {
			const { diagnostics } = extractCommand(
				'a.js',
				`import cmd from './x.js';\nexport default cmd;`
			);
			expect(diagnostics[0]!.severity).to.equal('warning');
		});
	});

	describe('a default export it cannot read', () => {
		it('should report no default export at all as an error', () => {
			// a module the runtime would refuse too; the build is finding out first
			const { diagnostics } = extractCommand('a.js', `export const nope = 1;`);
			expect(diagnostics).to.have.lengthOf(1);
			expect(diagnostics[0]!.severity).to.equal('error');
			expect(diagnostics[0]!.message).to.contain('no default export');
		});

		it('should report a function export as a warning', () => {
			const { diagnostics } = extractCommand('a.js', `export default function build() {}`);
			expect(diagnostics[0]!.severity).to.equal('warning');
			expect(diagnostics[0]!.message).to.contain('not an object literal');
		});
	});

	describe('a spread', () => {
		it('should report an absent description beside one as unknown rather than absent', () => {
			// the spread may well carry a `desc`, and nothing here can see it -- which
			// is the difference between a description the build missed and one nobody
			// wrote
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`export default { ...base, hidden: true };`
			);
			expect(facts.hidden).to.equal(true);
			expect(diagnostics).to.have.lengthOf(1);
			expect(diagnostics[0]!.message).to.contain('spreads another object');
		});

		it('should say nothing when the object writes its own description anyway', () => {
			const { diagnostics, facts } = extractCommand(
				'a.js',
				`export default { ...base, desc: 'mine' };`
			);
			expect(facts.desc).to.equal('mine');
			expect(diagnostics).to.deep.equal([]);
		});
	});

	describe('TypeScript', () => {
		it('should read a .ts module with types in it', () => {
			const { diagnostics, facts } = extractCommand(
				'deploy.ts',
				`import type { Command } from '@ttylabs/sigil';
				 const target: string = 'prod';
				 export default { desc: 'deploy', run: (): void => { void target; } } satisfies Command;`
			);
			expect(facts.desc).to.equal('deploy');
			expect(diagnostics).to.deep.equal([]);
		});

		it('should read a .cts module, which is CommonJS syntax with types', () => {
			// a `.cts` is CommonJS and exports with `module.exports`, so there is no
			// ESM default export to find -- which is a warning rather than a wrong
			// description
			const { diagnostics } = extractCommand(
				'edit.cts',
				`const cmd: unknown = { desc: 'edit' };\nmodule.exports = cmd;`
			);
			expect(diagnostics).to.have.lengthOf(1);
			expect(diagnostics[0]!.severity).to.equal('error');
		});
	});

	it('should throw on a module that does not parse rather than warn about it', () => {
		// guessing past a syntax error is how a build reports a missing description
		// for a file whose real problem is a missing brace
		expect(() => extractCommand('broken.js', `export default { desc:`)).to.throw(
			/Failed to parse broken\.js:1:/
		);
	});
});
