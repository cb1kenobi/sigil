import {
	commandCatalog,
	type PaletteEntry,
	type PaletteSlot,
	slotsFor,
	slotTokens,
} from '../../src/components/catalog.js';
import { stateFromError } from '../../src/error-hooks.js';
import { parse } from '../../src/parser/parse.js';
import { Internal, type InternalCommand, type ParseState, type Schema } from '../../src/types.js';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The state a parse ends in, which is what the palette reads.
 *
 * Through the real parser rather than a hand-built chain, because the claim the
 * catalog rests on is that it reads *what the parser built* -- a literal context
 * chain would be a second spelling of the registries and would pass whatever the
 * catalog happened to do with them.
 *
 * `help: false` so that the `--help` flag and the `help` command the parser adds
 * to every schema stay out of the expectations, except where a test is about
 * them.
 *
 * @param schema - The app.
 * @param argv - What was typed.
 * @returns The parse state.
 */
async function state(schema: Schema, argv: string[] = []): Promise<ParseState> {
	try {
		return await parse({ argv, env: {}, schema: { help: false, name: 'mycli', ...schema } });
	} catch (err) {
		// a parse that threw still carries the state it died with, which is where
		// the context chain comes from -- the same thing `help.test.ts` does, and
		// it is needed here for a sharper reason: a schema declaring a required
		// option with no value is exactly the fixture the ancestor-option tests
		// below are about, so `parse({ argv: [] })` of it refuses by construction
		return stateFromError(err) as ParseState;
	}
}

/** The labels a catalog lists, in order. */
function labels(entries: PaletteEntry[]): string[] {
	return entries.map(({ label }) => label);
}

describe('commandCatalog()', () => {
	it("should list the root context's commands, sorted by name", async () => {
		const entries = commandCatalog(
			await state({
				commands: {
					deploy: { desc: 'ship it', run(): void {} },
					build: { desc: 'build it', run(): void {} },
				},
			})
		);

		expect(labels(entries)).toEqual(['build', 'deploy']);
		expect(entries.map(({ desc }) => desc)).toEqual(['build it', 'ship it']);
	});

	it('should read the description off the registry rather than off the declaration', async () => {
		// which is the whole claim: the catalog never sees a declaration, so a
		// command whose description was set by an `init` hook is described by it
		const entries = commandCatalog(
			await state({
				commands: {
					build: {
						hooks: {
							init({ cmd }): void {
								cmd.desc = 'set by a hook';
							},
						},
						desc: 'declared',
						run(): void {},
					},
				},
			})
		);

		expect(entries[0]?.desc).toBe('set by a hook');
	});

	it('should walk a loaded subtree depth first', async () => {
		const entries = commandCatalog(
			await state({
				commands: {
					db: {
						commands: {
							seed: { run(): void {} },
							migrate: { run(): void {} },
						},
						run(): void {},
					},
					build: { run(): void {} },
				},
			})
		);

		expect(labels(entries)).toEqual(['build', 'db', 'db migrate', 'db seed']);
	});

	it('should carry the argv path from the root', async () => {
		const entries = commandCatalog(
			await state({
				commands: { db: { commands: { migrate: { run(): void {} } }, run(): void {} } },
			})
		);

		expect(entries.map(({ path }) => path)).toEqual([['db'], ['db', 'migrate']]);
	});

	it('should list the nearest context first', async () => {
		// help's own rule for the options it lists under `Global options`, and the
		// reason is the same: what is reachable from here is more interesting than
		// what is reachable from the top
		const entries = commandCatalog(
			await state(
				{
					commands: {
						alpha: { run(): void {} },
						db: {
							commands: { migrate: { run(): void {} }, seed: { run(): void {} } },
							run(): void {},
						},
					},
				},
				['db']
			)
		);

		expect(labels(entries)).toEqual(['db migrate', 'db seed', 'alpha', 'db']);
	});

	it('should list a command once, however many contexts reach it', async () => {
		const entries = commandCatalog(
			await state(
				{
					commands: {
						db: { commands: { migrate: { run(): void {} } }, run(): void {} },
					},
				},
				['db', 'migrate']
			)
		);

		expect(labels(entries)).toEqual(['db migrate', 'db']);
	});

	it('should leave a hidden command and everything under it out', async () => {
		const entries = commandCatalog(
			await state({
				commands: {
					secret: { commands: { inner: { run(): void {} } }, hidden: true, run(): void {} },
					build: { run(): void {} },
				},
			})
		);

		expect(labels(entries)).toEqual(['build']);
	});

	it("should list a hidden command's subcommands when it is the context", async () => {
		// a context is in the chain because argv named it, so its subcommands are
		// listed from there: a command you are already running is not hidden from
		// you, and the alternative is an empty palette at the level you stand on
		const entries = commandCatalog(
			await state(
				{
					commands: {
						secret: { commands: { inner: { run(): void {} } }, hidden: true, run(): void {} },
					},
				},
				['secret']
			)
		);

		expect(labels(entries)).toEqual(['secret inner']);
	});

	it('should leave a namespace out, and offer it when asked', async () => {
		const schema: Schema = {
			commands: { db: { commands: { migrate: { run(): void {} } } } },
		};

		expect(labels(commandCatalog(await state(schema)))).toEqual(['db migrate']);
		expect(labels(commandCatalog(await state(schema), { namespaces: true }))).toEqual([
			'db',
			'db migrate',
		]);
	});

	it('should list a command whose module has not been loaded, by name alone', async () => {
		// which is what help does with the same question, and is the whole of what
		// the deferral buys: the description is in a module nothing has read
		const entries = commandCatalog(
			await state({ commands: { build: { load: () => Promise.resolve({}) } } })
		);

		expect(labels(entries)).toEqual(['build']);
		expect(entries[0]?.deferred).toBe(true);
		expect(entries[0]?.desc).toBeUndefined();
	});

	it("should list a placeholder's inline subcommands, which are real", async () => {
		// a placeholder may declare subcommands beside its `load`, and those are
		// handed over already built -- so its registry is not empty and the
		// command is not a namespace. Both halves need the deferred test: without
		// it the parent is read as a namespace and left out, and the walk into it
		// was guarded for a case that does not exist
		const entries = commandCatalog(
			await state({
				commands: {
					db: {
						commands: { migrate: { run(): void {} } },
						load: () => Promise.resolve({}),
					},
				},
			})
		);

		expect(labels(entries)).toEqual(['db', 'db migrate']);
		expect(entries[0]?.deferred).toBe(true);
		expect(entries[1]?.deferred).toBe(false);
	});

	it("should carry every ancestor's options down a tree two deep", async () => {
		// one level cannot see the chain being carried: `[child, cmd, ...above]`
		// with `above` empty is already the right answer there. A grandchild is
		// where the ancestors have to have been passed down the walk
		const entries = commandCatalog(
			await state({
				commands: {
					db: {
						commands: { migrate: { run(): void {} } },
						options: { '--conn <url>': {} },
					},
				},
				options: { '--config <file>': {} },
			})
		);

		const migrate = entries.find(({ label }) => label === 'db migrate');
		expect(migrate?.slots.map(({ label }) => label)).toEqual(['--conn <url>', '--config <file>']);
	});

	it('should carry the chain above the context argv landed in', async () => {
		// `contexts.slice(depth + 1)` is what the top of the walk starts with, and
		// a chain of one -- argv that named no command -- cannot see it, because
		// the slice is empty either way. Argv that named `db` is where the root has
		// to have been carried in
		const entries = commandCatalog(
			await state(
				{
					commands: { db: { commands: { migrate: { run(): void {} } }, run(): void {} } },
					options: { '--config <file>': {} },
				},
				['db']
			)
		);

		const migrate = entries.find(({ label }) => label === 'db migrate');
		expect(migrate?.slots.map(({ label }) => label)).toEqual(['--config <file>']);
	});

	it('should read a path from the root through a chain three deep', async () => {
		// the chain is innermost-first and ends at the root, so the path to a
		// context is that slice *reversed*. One level deep cannot see it -- a
		// one-element list reverses to itself -- which is why this one has two
		const entries = commandCatalog(
			await state(
				{
					commands: {
						db: {
							commands: {
								migrate: { commands: { up: { run(): void {} } }, run(): void {} },
							},
							run(): void {},
						},
					},
				},
				['db', 'migrate']
			)
		);

		// nearest context first: `migrate`'s own subtree, then `db`'s, then the
		// root's
		expect(labels(entries)).toEqual(['db migrate up', 'db migrate', 'db']);
		expect(entries[0]?.path).toEqual(['db', 'migrate', 'up']);
	});

	it('should import nothing to build a list', async () => {
		let imported = 0;
		const entries = commandCatalog(
			await state({
				commands: {
					build: {
						load: (): Promise<unknown> => {
							imported++;
							return Promise.resolve({ default: { desc: 'built', run(): void {} } });
						},
					},
				},
			})
		);

		expect(labels(entries)).toEqual(['build']);
		expect(imported).toBe(0);
	});

	it('should carry the aliases, and rank by them without showing them', async () => {
		const entries = commandCatalog(
			await state({ commands: { 'migrate, m, up': { run(): void {} } } })
		);

		expect(entries[0]?.label).toBe('migrate');
		expect(entries[0]?.aliases).toEqual(['m', 'up']);
		expect(entries[0]?.search).toBe('migrate m up');
	});

	it('should match the label to the search string where there are no aliases', async () => {
		const entries = commandCatalog(await state({ commands: { build: { run(): void {} } } }));
		expect(entries[0]?.search).toBe('build');
	});

	it('should hold the command the registry holds', async () => {
		const parsed = await state({ commands: { build: { run(): void {} } } });
		const entries = commandCatalog(parsed);
		expect(entries[0]?.cmd).toBe(parsed.contexts[0]?.[Internal].commands.get('build'));
	});

	it('should list the help command the parser adds, which has no run', async () => {
		// `help` is dispatched by the parser setting `state.help` rather than
		// through a handler, so a gate written as "has a run" left the one command
		// every schema gets for free out of the list. A leaf with no run is not a
		// namespace
		const entries = commandCatalog(
			await parse({ argv: [], env: {}, schema: { commands: { build: { run(): void {} } } } })
		);
		expect(labels(entries)).toContain('help');
	});

	it('should leave a leaf with no run in', async () => {
		const entries = commandCatalog(
			await state({ commands: { odd: {}, build: { run(): void {} } } })
		);
		expect(labels(entries)).toEqual(['build', 'odd']);
	});

	it('should refuse a target with no context chain', () => {
		expect(() => commandCatalog({ contexts: [] })).toThrow(/context chain/);
		expect(() => commandCatalog(undefined as unknown as { contexts: [] })).toThrow(/context chain/);
	});

	it('should answer nothing for a schema that declares no commands', async () => {
		expect(commandCatalog(await state({}))).toEqual([]);
	});

	it('should not walk a command that reaches itself', async () => {
		// a registry holds initialized commands and `initCommand()` hands one
		// straight back, so a declaration naming a command already in its own
		// subtree builds a cycle. Nothing here writes one; a palette that
		// overflowed the stack over it would be a worse answer than a list
		const parsed = await state({ commands: { db: { commands: {}, run(): void {} } } });
		const db = parsed.contexts[0]?.[Internal].commands.get('db') as InternalCommand;
		db[Internal].commands.add(db);

		// the self-reference is reachable -- `mycli db db` really does route -- so
		// it is listed once, and the guard is what stops the descent from there
		expect(labels(commandCatalog(parsed))).toEqual(['db', 'db db']);
	});
});

describe('slotsFor()', () => {
	/**
	 * The slots a command declares, through a real parse.
	 *
	 * The chain is the command and the schema's root, which is what `parse()`
	 * builds for `mycli build` -- and is what `slotsFor()` has to be handed,
	 * since a required option on an ancestor is enforced when a subcommand runs.
	 */
	async function slots(
		cmd: Record<string, unknown>,
		env?: Record<string, string>,
		schema: Schema = {}
	) {
		const parsed = await state({ ...schema, commands: { build: { run(): void {}, ...cmd } } });
		const root = parsed.contexts[0] as InternalCommand;
		const build = root[Internal].commands.get('build') as InternalCommand;
		return slotsFor([build, root], env);
	}

	it('should list every argument in declaration order', async () => {
		expect((await slots({ args: ['<entry>', '[out]'] })).map(({ label }) => label)).toEqual([
			'<entry>',
			'[out]',
		]);
	});

	it('should carry what a prompt validates against', async () => {
		const [slot] = await slots({
			args: [{ choices: [1, 2], desc: 'how loud', name: '<level>', type: 'int' }],
		});

		expect(slot).toEqual({
			choices: [1, 2],
			desc: 'how loud',
			label: '<level>',
			multiple: false,
			required: true,
			type: 'int',
		} satisfies PaletteSlot);
	});

	it('should spell a variadic argument the way it is typed', async () => {
		expect((await slots({ args: ['<files...>'] })).map(({ label }) => label)).toEqual([
			'<files...>',
		]);
		expect((await slots({ args: ['<files...>'] }))[0]?.multiple).toBe(true);
	});

	it('should report the promotion the parser applied', async () => {
		// `initArgs()` promotes an optional argument sitting before a required one,
		// and the slot has to say so or the palette would offer to skip a value the
		// parse then refuses
		expect((await slots({ args: ['[a]', '<b>'] })).map(({ required }) => required)).toEqual([
			true,
			true,
		]);
	});

	it('should ask for a required option', async () => {
		const [slot] = await slots({ options: { '--port <n>': { type: 'int' } } });
		expect(slot?.label).toBe('--port <n>');
		expect(slot?.spelling).toBe('--port');
		expect(slot?.required).toBe(true);
	});

	it('should not ask for an optional option', async () => {
		expect(await slots({ options: { '--port [n]': { type: 'int' } } })).toEqual([]);
		expect(await slots({ options: { '--force': {} } })).toEqual([]);
	});

	it('should not ask for a required option a default answers for', async () => {
		expect(await slots({ options: { '--port <n>': { default: 8080, type: 'int' } } })).toEqual([]);
	});

	it('should not ask for a required option the environment answers for', async () => {
		const declared = { options: { '--port <n>': { env: 'PORT', type: 'int' } } };

		expect(await slots(declared, { PORT: '8080' })).toEqual([]);
		// an empty variable is read as unset, which is `envValue()`'s own rule
		expect((await slots(declared, { PORT: '' })).map(({ label }) => label)).toEqual(['--port <n>']);
		// and with no environment to read, nothing is answered for
		expect((await slots(declared)).map(({ label }) => label)).toEqual(['--port <n>']);
	});

	it('should not ask for the flags the parser adds', async () => {
		// `--help` and `--version` are the two, and the `required` test above
		// already answers for both -- a flag is never required. Asserted anyway
		// because they are the options every schema gets whether or not it asked,
		// so a reader meets them here first; what this does *not* pin is the
		// `parserOwned` guard, which a sabotage says the whole suite cannot see
		const parsed = await parse({
			argv: [],
			env: {},
			schema: { commands: { build: { run(): void {} } } },
		});
		const root = parsed.contexts[0] as InternalCommand;
		const build = root[Internal].commands.get('build') as InternalCommand;
		expect(slotsFor([build, root])).toEqual([]);
	});

	it("should ask for an ancestor's required option", async () => {
		// `validateOptions()` flattens every context's options, so a root-level
		// required option with no default is enforced when a subcommand runs -- and
		// the first version read the command's own registry alone and asked for
		// none of it. Found by review
		const found = await slots({}, undefined, { options: { '--config <file>': {} } });
		expect(found.map(({ label }) => label)).toEqual(['--config <file>']);
	});

	it("should not ask for an ancestor's option a default answers for", async () => {
		expect(
			await slots({}, undefined, { options: { '--config <file>': { default: 'a.json' } } })
		).toEqual([]);
	});

	it("should not ask for an ancestor's option the environment answers for", async () => {
		expect(
			await slots({}, { CONFIG: 'a.json' }, { options: { '--config <file>': { env: 'CONFIG' } } })
		).toEqual([]);
	});

	it('should ask once for a destination two contexts both declare', async () => {
		// the parser resolves an option innermost first and `validateOptions()`
		// reads the *destination*, so the nearer declaration answers for both --
		// and the nearer one is what argv reaches, so it is the one to ask under
		const found = await slots({ options: { '--config <near>': {} } }, undefined, {
			options: { '--config <far>': {} },
		});
		expect(found.map(({ label }) => label)).toEqual(['--config <near>']);
	});

	it("should let a nearer default answer for an ancestor's required option", async () => {
		// whichever order the two are seen in, which is why what the parse fills
		// is read in a pass of its own
		expect(
			await slots({ options: { '--config [near]': { default: 'a.json' } } }, undefined, {
				options: { '--config <far>': {} },
			})
		).toEqual([]);
	});

	it('should not ask for a negated twin, which gives its default up', async () => {
		// `skipDefault` is how the negated flag hands the destination to its valued
		// twin, so having a `default` is not the same as the parse applying one --
		// the valued twin is still the question
		const found = await slots({
			options: { '--cheese <type>': {}, '--no-cheese': {} },
		});
		expect(found.map(({ label }) => label)).toEqual(['--cheese <type>']);
	});

	it('should let a positional argument answer for an option of its name', async () => {
		// a destination can have more than one writer, and an option and a
		// positional of the same name is one of the pairs this repository records.
		// `processArgs()` fills the destination, so `validateOptions()` sees a value
		// and the option is not a question
		const found = await slots({ args: ['<entry>'], options: { '--entry <v>': {} } });
		expect(found.map(({ label }) => label)).toEqual(['<entry>']);
	});

	it('should refuse an empty chain', () => {
		expect(() => slotsFor([])).toThrow(/command chain/);
	});

	it('should put the arguments before the options', async () => {
		const found = await slots({
			args: ['<entry>'],
			options: { '--port <n>': { type: 'int' } },
		});
		expect(found.map(({ label }) => label)).toEqual(['<entry>', '--port <n>']);
	});

	it('should spell a short-only option the way the registry answers to it', async () => {
		// an option declared `-p <n>` is *named* `p` and has no long spelling, so
		// `--p=5` resolves to nothing while `-p=5` does -- the parser splits either
		// on the first `=` and looks the name half up
		const [slot] = await slots({ options: { '-p <n>': { type: 'int' } } });
		expect(slot?.spelling).toBe('-p');
	});

	it('should prefer a spelling that is not a negation where there is one', async () => {
		// both spellings resolve, so what this decides is the label the prompt is
		// asked under: `--no-color <v>` reads as a negation it is not. A preference
		// with a fallback rather than a filter, which is the test above
		const [slot] = await slots({ options: { '--no-color, --colour <v>': {} } });
		expect(slot?.spelling).toBe('--colour');
	});

	it('should ask for a required option whose only spelling is a negation', async () => {
		// `initOption()` rewrites a `no-` name only for a *flag*, so a valued
		// `'--no-color <when>'` keeps `--no-color` as its only long spelling and
		// has no short -- which the first version of `spellingOf()` filtered away,
		// so `slotsFor()` dropped the slot and the palette emitted an argv the
		// parse refused with `Missing required options`. Found by review
		const [slot] = await slots({ options: { '--no-color <when>': {} } });
		expect(slot?.label).toBe('--no-color <when>');
		expect(slot?.spelling).toBe('--no-color');
		expect(slotTokens(slot as PaletteSlot, ['never'])).toEqual(['--no-color=never']);
	});

	it('should ignore a `choices` that is not a list, as the parser does', async () => {
		// `initArg()` does not validate an argument's `choices` and
		// `assertChoices()` ignores a non-array, so projecting one through would
		// make `checkSlotValue()` refuse every value for a declaration the parse
		// is perfectly happy with
		const found = await slots({
			args: [{ choices: 'nope' as unknown as readonly unknown[], name: '<x>' }],
		});
		expect(found[0]?.choices).toBeUndefined();
	});

	it('should answer nothing for a command that needs nothing', async () => {
		expect(await slots({})).toEqual([]);
	});
});

describe('slotTokens()', () => {
	const arg: PaletteSlot = {
		label: '<entry>',
		multiple: false,
		required: true,
		type: 'string',
	};
	const opt: PaletteSlot = {
		label: '--port <n>',
		multiple: false,
		required: true,
		spelling: '--port',
		type: 'int',
	};

	it("should pass an argument's values through positionally", () => {
		expect(slotTokens(arg, ['a', 'b'])).toEqual(['a', 'b']);
	});

	it("should attach an option's value with an `=`", () => {
		// attached rather than in the following token, because the parser takes an
		// attached value exactly as typed while a value in the next token is left
		// alone only when it does not resolve to a declared option
		expect(slotTokens(opt, ['8080'])).toEqual(['--port=8080']);
		expect(slotTokens(opt, ['--weird'])).toEqual(['--port=--weird']);
	});

	it('should repeat the spelling for a collecting option', () => {
		expect(slotTokens({ ...opt, multiple: true }, ['a', 'b'])).toEqual(['--port=a', '--port=b']);
	});

	it('should answer nothing for a slot that was skipped', () => {
		expect(slotTokens(arg, [])).toEqual([]);
		expect(slotTokens(opt, [])).toEqual([]);
	});
	describe('a command its module renamed', () => {
		const schema: Schema = {
			commands: {
				ns: { path: join(import.meta.dirname, '..', 'fixtures', 'rename', 'ns.mjs') },
			},
		};

		it('should dispatch the name argv reaches it by, not the one it calls itself', async () => {
			// a loaded module's `name` wins over the placeholder's and the registry
			// stays keyed by the placeholder's, so only `ns` routes. Built from
			// `cmd.name`, the path was `['renamed-ns', 'inner']`, which the parser
			// refuses with `Unexpected argument` -- a palette offering what it
			// cannot run, which is the failure this whole component is written
			// against
			const parsed = await state(schema, ['ns', 'inner']);
			const entry = commandCatalog(parsed).find((e) => e.label.endsWith('inner'));

			expect(parsed.contexts[1]?.name).toBe('renamed-ns');
			expect(entry?.path).toEqual(['ns', 'inner']);
		});

		it('should still show the name the command calls itself', async () => {
			// the display name and the dispatch name are two answers: what is shown
			// is what help shows, and what is run is what argv reaches
			const parsed = await state(schema, ['ns', 'inner']);
			const entry = commandCatalog(parsed).find((e) => e.path.join(' ') === 'ns inner');

			expect(entry?.label).toBe('renamed-ns inner');
		});

		it('should dispatch what it offers, through the real parser', async () => {
			// the end-to-end form, which is the only one that can say the argv
			// routes rather than merely looking right
			const parsed = await state(schema, ['ns', 'inner']);
			const entry = commandCatalog(parsed).find((e) => e.path.join(' ') === 'ns inner');
			const again = await state(schema, [...(entry?.path ?? [])]);

			expect(again.cmd?.name).toBe('inner');
		});

		it('should fall back to a command argv never named, which is a default', async () => {
			// a `default` command has no matched token, and its own name is both the
			// fallback and the right answer -- there is nothing argv said to prefer.
			//
			// It needs the default to have a CHILD to be reached at all, which a
			// sabotage had to say: a childless default emits nothing under itself,
			// so every entry comes from the root's own walk, where the prefix is
			// empty and the name comes from the child. With one, the default *is*
			// the prefix, and dropping the fallback makes that prefix an empty
			// string
			const parsed = await state({
				commands: {
					build: { run: () => undefined },
					pal: { default: true, commands: { sub: { run: () => undefined } } },
				},
			});

			expect(
				commandCatalog(parsed, { namespaces: true })
					.map((e) => e.path.join(' '))
					.sort()
			).toEqual(['build', 'pal', 'pal sub']);
		});

		it('should use the alias argv typed, which is what routes', async () => {
			// an alias resolves, so either spelling runs -- and what was typed is
			// what "the argv you would have typed" means
			const parsed = await state(
				{ commands: { 'deep, d': { commands: { x: { run: () => undefined } } } } },
				['d', 'x']
			);
			const entry = commandCatalog(parsed).find((e) => e.label.endsWith('x'));

			expect(entry?.path).toEqual(['d', 'x']);
			expect(entry?.label).toBe('deep x');
		});
	});
});
