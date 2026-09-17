import { ansi } from '../../src/ansi/index.js';
import { createSections, renderHelp, resolveHelp } from '../../src/help/index.js';
import { initCommand } from '../../src/parser/command/init-command.js';
import { parse } from '../../src/parser/parse.js';
import { Internal, type HelpSection, type Schema } from '../../src/types.js';
import { stringWidth } from '../../src/width/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The help screen for a parse, hooks fired, at a fixed width. */
async function help(schema: Schema, argv: string[] = [], width = 72) {
	const state = await parse({ argv, schema: { help: false, ...schema } });
	return resolveHelp(state, { width });
}

/** The headings of a screen, in order, so a test can assert the shape of it. */
function headings(text: string): string[] {
	return text
		.split('\n')
		.filter((line) => /^\S.*:$/.test(line))
		.map((line) => line.slice(0, -1));
}

/** The section under a heading, without the heading. */
function sectionOf(text: string, title: string): string[] {
	const lines = text.split('\n');
	const start = lines.indexOf(`${title}:`);
	if (start === -1) {
		return [];
	}
	const rest = lines.slice(start + 1);
	const end = rest.indexOf('');
	return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trimEnd());
}

beforeEach(() => {
	ansi.level = 0;
});

afterEach(() => {
	ansi.level = undefined;
});

describe('Option.group', () => {
	const schema: Schema = {
		name: 'mycli',
		options: {
			'--verbose': 'Say more',
			'--sdk [version]': { desc: 'Which SDK', group: 'Advanced' },
			'--trace': { desc: 'Dump the tree', group: 'Advanced' },
			'--legacy': { desc: 'The old way', group: 'Deprecated' },
		},
	};

	it('should put a grouped option under its own heading', async () => {
		const text = await help(schema);
		expect(sectionOf(text, 'Options')).toEqual(['  --verbose  Say more']);
		expect(sectionOf(text, 'Advanced options')).toEqual([
			'  --sdk [version]  Which SDK',
			'  --trace          Dump the tree',
		]);
		expect(sectionOf(text, 'Deprecated options')).toEqual(['  --legacy  The old way']);
	});

	// the name is a noun and help appends the word, which is what keeps every
	// section scannable as an options list
	it('should name the heading after the group', async () => {
		expect(headings(await help(schema))).toEqual([
			'Options',
			'Advanced options',
			'Deprecated options',
		]);
	});

	it('should order the groups by where they are first seen', async () => {
		const reversed: Schema = {
			name: 'mycli',
			options: {
				'--legacy': { desc: 'The old way', group: 'Deprecated' },
				'--sdk [version]': { desc: 'Which SDK', group: 'Advanced' },
			},
		};
		expect(headings(await help(reversed))).toEqual(['Deprecated options', 'Advanced options']);
	});

	it('should leave out a group whose every option is hidden', async () => {
		const hidden: Schema = {
			name: 'mycli',
			options: {
				'--verbose': 'Say more',
				'--secret': { desc: 'Nobody sees this', group: 'Advanced', hidden: true },
			},
		};
		expect(headings(await help(hidden))).toEqual(['Options']);
	});

	it('should still list ungrouped options under Options when every group is empty', async () => {
		const only: Schema = {
			name: 'mycli',
			options: { '--sdk [v]': { desc: 'Which SDK', group: 'Advanced' } },
		};
		// nothing ungrouped, so no plain Options heading at all
		expect(headings(await help(only))).toEqual(['Advanced options']);
	});

	// help writes "Global options" itself, so two headings of one name on a screen
	// would describe options in different scopes
	it('should refuse a group named Global', async () => {
		for (const group of ['Global', 'global', '  GLOBAL  ']) {
			await expect(
				parse({ argv: [], schema: { name: 'mycli', options: { '--a': { group } } } })
			).rejects.toThrow('Expected option "a" group not to be');
		}
	});

	// validated at init, and checked again at render because `group` stays
	// editable: no heading is better than a broken screen
	it('should ignore a group mutated into something that cannot be a heading', async () => {
		const schema: Schema = {
			help: false,
			name: 'mycli',
			options: { '--a': { desc: 'A', group: 'Extra' } },
		};
		const state = await parse({ argv: [], schema });
		state.contexts[0][Internal].options.find('--a')!.group = 'Broken\nGlobal options';
		const text = await resolveHelp(state, { width: 72 });
		expect(sectionOf(text, 'Options')).toEqual(['  --a  A']);
		expect(headings(text)).toEqual(['Options']);
	});

	// being hidden is about whether help lists it, not about whether it resolves
	it('should shadow an inherited option from behind a hidden one', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: { '--mode [name]': 'Root mode' },
			commands: {
				build: { options: { '--mode [name]': { desc: 'Build mode', hidden: true } } },
			},
		};
		const text = await help(schema, ['build']);
		expect(text).not.toContain('Build mode');
		expect(sectionOf(text, 'Global options')).toEqual([]);
	});

	// a group becomes a heading, so a bad one is rejected while the schema is being
	// built rather than when somebody asks for help
	it('should reject a group that is not a name', async () => {
		for (const group of ['', '   ', 7, null] as never[]) {
			await expect(
				parse({ argv: [], schema: { name: 'mycli', options: { '--a': { group } } } })
			).rejects.toThrow('Expected option "a" group to be a non-empty string');
		}
	});

	it('should reject a group that would not stay on its own line', async () => {
		await expect(
			parse({
				argv: [],
				schema: { name: 'mycli', options: { '--a': { group: 'Android\nGlobal options' } } },
			})
		).rejects.toThrow('Expected option "a" group to be a single line with no control characters');
	});

	it('should trim a group rather than reject it', async () => {
		const padded: Schema = { name: 'mycli', options: { '--a': { desc: 'A', group: '  Extra  ' } } };
		expect(sectionOf(await help(padded), 'Extra options')).toEqual(['  --a  A']);
	});

	// a group is still the command's own option, so it still claims the spelling
	it('should shadow an inherited option from inside a group', async () => {
		const shadowing: Schema = {
			name: 'mycli',
			options: { '--mode [name]': 'Root mode' },
			commands: {
				build: { options: { '--mode [name]': { desc: 'Build mode', group: 'Advanced' } } },
			},
		};
		const text = await help(shadowing, ['build']);
		expect(sectionOf(text, 'Advanced options')).toEqual(['  --mode [name]  Build mode']);
		expect(sectionOf(text, 'Global options')).toEqual([]);
	});
});

describe('the help hook', () => {
	/** The shape titanium-cli's `build` command carries as `platforms`. */
	const platforms = {
		android: {
			title: 'Android',
			args: [{ desc: 'The AVD to launch', name: '[avd]' }],
			options: { '--device-id [id]': 'Which device', '--key-store [path]': 'The keystore' },
		},
		ios: {
			title: 'iOS',
			options: { '--pp-uuid [uuid]': 'The provisioning profile' },
		},
	};

	const schema: Schema = {
		name: 'ti',
		options: { '--no-banner': 'Skip the banner' },
		commands: {
			build: {
				desc: 'Builds a project',
				options: { '-p, --platform [name]': { choices: ['android', 'ios'], desc: 'The target' } },
				hooks: {
					help: [
						async ({ sections, state }) => {
							const only = state.argv.platform;
							for (const [name, conf] of Object.entries(platforms)) {
								if (!only || only === name) {
									await sections.add(conf as HelpSection);
								}
							}
						},
					],
				},
			},
		},
	};

	it('should list a contributed section after the command own and before the inherited', async () => {
		expect(headings(await help(schema, ['build']))).toEqual([
			'Options',
			'Android arguments',
			'Android options',
			'iOS options',
			'Global options',
		]);
	});

	it('should describe a contributed option exactly as a declared one', async () => {
		const text = await help(schema, ['build']);
		expect(sectionOf(text, 'Android options')).toEqual([
			'  --device-id [id]    Which device',
			'  --key-store [path]  The keystore',
		]);
		expect(sectionOf(text, 'Android arguments')).toEqual(['  [avd]  The AVD to launch']);
	});

	it('should keep the sections in the order they were added', async () => {
		const text = await help(schema, ['build']);
		expect(text.indexOf('Android options:')).toBeLessThan(text.indexOf('iOS options:'));
	});

	// the reason the hook is a function rather than a list on the declaration
	it('should let the hook describe only what argv asked about', async () => {
		const text = await help(schema, ['build', '--platform', 'ios']);
		expect(headings(text)).toEqual(['Options', 'iOS options', 'Global options']);
	});

	it('should be fired for the help command as well as the flag', async () => {
		const state = await parse({ argv: ['help', 'build'], schema });
		expect(headings(await resolveHelp(state, { width: 72 }))).toContain('Android options');
	});

	it('should hand the hook the command and its registries', async () => {
		const seen: Record<string, unknown> = {};
		const probe: Schema = {
			name: 'mycli',
			commands: {
				build: {
					args: ['[entry]'],
					desc: 'Build',
					options: { '--watch': 'Watch' },
					commands: { targets: {} },
					hooks: {
						help: [
							({ args, cmd, commands, options, state }) => {
								seen.args = args.length;
								seen.name = cmd.name;
								seen.commands = commands.size;
								seen.options = options.size;
								seen.typed = state.$orig.join(' ');
							},
						],
					},
				},
			},
		};
		await help(probe, ['build', '--watch']);
		expect(seen).toEqual({
			args: 1,
			commands: 1,
			name: 'build',
			options: 1,
			typed: 'build --watch',
		});
	});

	// an ancestor's sections would appear under a command that has nothing to do
	// with them
	it('should only fire the hooks of the command being described', async () => {
		const fired: string[] = [];
		const nested: Schema = {
			name: 'mycli',
			hooks: { beforeParse: [] },
			commands: {
				build: {
					desc: 'Build',
					hooks: { help: [() => void fired.push('build')] },
					commands: {
						targets: { desc: 'Targets', hooks: { help: [() => void fired.push('targets')] } },
					},
				},
			},
		};
		await help(nested, ['build', 'targets']);
		expect(fired).toEqual(['targets']);
	});

	it('should honor hidden inside a contributed section', async () => {
		const hiding: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({
									options: { '--shown': 'Shown', '--gone': { desc: 'Gone', hidden: true } },
									title: 'Extra',
								});
							},
						],
					},
				},
			},
		};
		expect(sectionOf(await help(hiding, ['build']), 'Extra options')).toEqual(['  --shown  Shown']);
	});

	it('should pair a negated twin inside a contributed section', async () => {
		const paired: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({
									options: { '--cheese [type]': 'Add cheese', '--no-cheese': undefined },
									title: 'Extra',
								});
							},
						],
					},
				},
			},
		};
		expect(sectionOf(await help(paired, ['build']), 'Extra options')).toEqual([
			'  --cheese [type], --no-cheese  Add cheese',
		]);
	});

	it('should leave out a section with nothing visible in it', async () => {
		const empty: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ title: 'Nothing' });
								await sections.add({ options: {}, title: 'Also nothing' });
								await sections.add({ options: { '--x': 'X' }, title: 'Something' });
							},
						],
					},
				},
			},
		};
		// the root declares no options and the helper passes `help: false`, so there
		// is nothing inherited to follow them either
		expect(headings(await help(empty, ['build']))).toEqual(['Something options']);
	});

	// they are shown and not parsed, so they shadow nothing
	it('should not let a contributed option shadow an inherited one', async () => {
		const clashing: Schema = {
			name: 'mycli',
			options: { '--mode [name]': 'Root mode' },
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ options: { '--mode [name]': 'Extra mode' }, title: 'Extra' });
							},
						],
					},
				},
			},
		};
		const text = await help(clashing, ['build']);
		expect(sectionOf(text, 'Extra options')).toEqual(['  --mode [name]  Extra mode']);
		expect(sectionOf(text, 'Global options')).toEqual(['  --mode [name]  Root mode']);
	});

	it('should ignore a group on a contributed option, since the section is the group', async () => {
		const grouped: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({
									options: { '--x': { desc: 'X', group: 'Nested' } },
									title: 'Extra',
								});
							},
						],
					},
				},
			},
		};
		const text = await help(grouped, ['build']);
		expect(sectionOf(text, 'Extra options')).toEqual(['  --x  X']);
		expect(headings(text)).not.toContain('Nested options');
	});

	it('should say [options] in the usage line for a contributed section alone', async () => {
		const only: Schema = {
			help: false,
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ options: { '--x': 'X' }, title: 'Extra' });
							},
						],
					},
				},
			},
		};
		expect((await help(only, ['build'])).split('\n')[0]).toBe('Usage: mycli build [options]');
	});

	it('should keep every line within the width', async () => {
		for (const width of [30, 40, 72]) {
			for (const line of (await help(schema, ['build'], width)).split('\n')) {
				// columns, not code units, which is the only measurement that survives
				// a title or a description with anything wide in it
				expect(stringWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
					width
				);
			}
		}
	});

	// a title long enough to need it breaks at a space, unlike an option's label
	it('should wrap a heading too long for the width', async () => {
		const long: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({
									options: { '--x': 'X' },
									title: 'An exceptionally long platform configuration',
								});
							},
						],
					},
				},
			},
		};
		const text = await help(long, ['build'], 30);
		expect(text.split('\n')).toContain('An exceptionally long platform');
		expect(text.split('\n')).toContain('configuration options:');
		for (const line of text.split('\n')) {
			expect(stringWidth(line)).toBeLessThanOrEqual(30);
		}
	});

	// two platforms that share a title, or a hook run twice, add to what is there
	it('should merge sections that share a title', async () => {
		const merging: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ args: ['[one]'], options: { '--a': 'A' }, title: 'Extra' });
								await sections.add({ args: ['[two]'], options: { '--b': 'B' }, title: 'Extra' });
							},
						],
					},
				},
			},
		};
		const text = await help(merging, ['build']);
		expect(headings(text).filter((h) => h === 'Extra options')).toHaveLength(1);
		expect(sectionOf(text, 'Extra options')).toEqual(['  --a  A', '  --b  B']);
		expect(sectionOf(text, 'Extra arguments')).toEqual(['  [one]', '  [two]']);
	});

	it('should not promise options for a section that contributes only arguments', async () => {
		const argsOnly: Schema = {
			help: false,
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ args: ['[avd]'], title: 'Android' });
							},
						],
					},
				},
			},
		};
		const text = await help(argsOnly, ['build']);
		expect(text.split('\n')[0]).toBe('Usage: mycli build');
		expect(headings(text)).toEqual(['Android arguments']);
	});

	// the same two list-wide rules a command's arguments get
	it('should hold a section argument list to the rules a command own list follows', async () => {
		const sections = createSections();
		await expect(sections.add({ args: ['[files...]', '<out>'], title: 'Extra' })).rejects.toThrow(
			'Only the last argument can be variadic: [files...] is followed by <out> in the "Extra" help section'
		);

		// an optional argument before a required one is promoted, so the section
		// describes what would actually be required
		const promoted = createSections();
		await promoted.add({ args: ['[a]', '<b>'], title: 'Extra' });
		expect(promoted.list[0]?.args.map((arg) => arg.required)).toEqual([true, true]);
	});

	// the rules are about the list, so merging has to apply them to the whole of it
	it('should hold a merged argument list to the same rules', async () => {
		const variadic = createSections();
		await variadic.add({ args: ['[files...]'], title: 'Extra' });
		await expect(variadic.add({ args: ['<out>'], title: 'Extra' })).rejects.toThrow(
			'Only the last argument can be variadic'
		);

		const promoting = createSections();
		await promoting.add({ args: ['[a]'], title: 'Extra' });
		await promoting.add({ args: ['<b>'], title: 'Extra' });
		expect(promoting.list[0]?.args.map((arg) => arg.required)).toEqual([true, true]);
	});

	// nothing is kept until everything validated
	it('should leave a section alone when adding to it throws', async () => {
		const sections = createSections();
		await sections.add({ args: ['[a]'], options: { '--a': 'A' }, title: 'Extra' });
		await expect(
			sections.add({ args: ['[b]'], options: 'nope' as never, title: 'Extra' })
		).rejects.toThrow('Expected help section "Extra" options to be an object');

		expect(sections.list).toHaveLength(1);
		expect(sections.list[0]?.args.map((arg) => arg.name)).toEqual(['a']);
		expect(sections.list[0]?.options.size).toBe(1);
	});

	it('should pair a negated twin that arrived in a later call', async () => {
		const sections = createSections();
		await sections.add({ options: { '--cheese [type]': 'Add cheese' }, title: 'Extra' });
		await sections.add({ options: { '--no-cheese': undefined }, title: 'Extra' });
		expect(sections.list[0]?.options.find('--cheese')?.[Internal].negatedTwin).toBeTruthy();
	});

	it('should refuse a section named Global', async () => {
		const sections = createSections();
		await expect(sections.add({ title: 'Global' })).rejects.toThrow(
			'Expected help section title not to be "Global"'
		);
	});

	// a hook that adds to the list it is being read from would extend the run it
	// is already in, and would reach the caller's declaration while doing it
	it('should fire the hooks the command had when help was asked for', async () => {
		const late = vi.fn();
		const growing: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							({ cmd }) => {
								(cmd.hooks?.help as unknown[])?.push(late);
							},
						],
					},
				},
			},
		};
		await help(growing, ['build']);
		expect(late).not.toHaveBeenCalled();

		// and the caller's own declaration is not where it landed
		expect(
			(growing.commands as Record<string, { hooks: { help: unknown[] } }>).build.hooks.help
		).toHaveLength(1);
	});
});

describe('bad sections', () => {
	it('should reject a list of hooks that is not functions', async () => {
		await expect(initCommand({ hooks: { help: 'nope' as never }, name: 'x' })).rejects.toThrow(
			'Expected command help hooks to be an array of functions'
		);
		await expect(initCommand({ hooks: { help: [1 as never] }, name: 'x' })).rejects.toThrow(
			/help hooks to be an array of functions/
		);
	});

	it('should reject a section with no title', async () => {
		const sections = createSections();
		await expect(sections.add({ title: '' })).rejects.toThrow(
			'Expected help section title to be a non-empty string'
		);
		await expect(sections.add({} as HelpSection)).rejects.toThrow(/section title/);
		await expect(sections.add(null as never)).rejects.toThrow('Expected a help section object');
		await expect(sections.add({ title: 'Android\nGlobal options' })).rejects.toThrow(
			'Expected help section title to be a single line with no control characters'
		);
	});

	it('should reject arguments that are not a list and options that are not an object', async () => {
		const sections = createSections();
		await expect(sections.add({ args: 'nope' as never, title: 'Extra' })).rejects.toThrow(
			'Expected help section "Extra" arguments to be an array'
		);
		await expect(sections.add({ options: 'nope' as never, title: 'Extra' })).rejects.toThrow(
			'Expected help section "Extra" options to be an object'
		);
	});

	// a command that writes its own help should not be able to fail on the way to
	// not using the generated one
	it('should not fire a hook for a command whose help is a string', async () => {
		const fired = vi.fn();
		const schema: Schema = {
			name: 'mycli',
			commands: {
				notes: { desc: 'Notes', help: 'Read the manual.', hooks: { help: [fired] } },
			},
		};
		const state = await parse({ argv: ['notes', '--help'], schema });
		expect(await resolveHelp(state)).toBe('Read the manual.');
		expect(fired).not.toHaveBeenCalled();
	});

	it('should still fire a hook for a command whose help is a function', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				notes: {
					desc: 'Notes',
					help: ({ generated }) => generated,
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ options: { '--x': 'X' }, title: 'Extra' });
							},
						],
					},
				},
			},
		};
		const state = await parse({ argv: ['notes', '--help'], schema });
		expect(await resolveHelp(state, { width: 72 })).toContain('Extra options:');
	});

	// a stack overflow is a poor way to find out, and what a hook wanting the
	// generated screen is looking for is `Command.help`
	it('should refuse a hook that asks for the help it is contributing to', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: { help: [({ state }) => resolveHelp(state) as unknown as void] },
				},
			},
		};
		const state = await parse({ argv: ['build', '--help'], schema });
		await expect(resolveHelp(state)).rejects.toThrow(
			'A help hook for "build" asked for the help it is contributing to'
		);
	});

	// and the guard lifts, so the next screen still renders
	it('should let help render again after a hook was refused', async () => {
		let recurse = true;
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections, state }) => {
								if (recurse) {
									recurse = false;
									await resolveHelp(state);
								}
								await sections.add({ options: { '--x': 'X' }, title: 'Extra' });
							},
						],
					},
				},
			},
		};
		const state = await parse({ argv: ['build', '--help'], schema });
		await expect(resolveHelp(state)).rejects.toThrow(/asked for the help/);
		expect(await resolveHelp(state, { width: 72 })).toContain('Extra options:');
	});

	// it leaves through the one error path like anything else a command does
	it('should let a hook that throws become the error', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							() => {
								throw new Error('the hook is broken');
							},
						],
					},
				},
			},
		};
		const state = await parse({ argv: ['build', '--help'], schema });
		await expect(resolveHelp(state)).rejects.toThrow('the hook is broken');
	});
});

describe('renderHelp() with sections', () => {
	it('should take built sections without firing any hook', async () => {
		const fired = vi.fn();
		const schema: Schema = {
			help: false,
			name: 'mycli',
			commands: { build: { desc: 'Build', hooks: { help: [fired] } } },
		};
		const state = await parse({ argv: ['build'], schema });
		const sections = createSections();
		await sections.add({ options: { '--x': 'X' }, title: 'Given' });

		const text = renderHelp(
			{ contexts: state.contexts, schema },
			{ sections: sections.list, width: 72 }
		);

		expect(fired).not.toHaveBeenCalled();
		expect(sectionOf(text, 'Given options')).toEqual(['  --x  X']);
	});

	it('should let a caller override what the hooks would have contributed', async () => {
		const schema: Schema = {
			help: false,
			name: 'mycli',
			commands: {
				build: {
					desc: 'Build',
					hooks: {
						help: [
							async ({ sections }) => {
								await sections.add({ options: { '--from-hook': 'Hook' }, title: 'Hook' });
							},
						],
					},
				},
			},
		};
		const state = await parse({ argv: ['build'], schema });
		const sections = createSections();
		await sections.add({ options: { '--given': 'Given' }, title: 'Given' });

		const text = await resolveHelp(state, { sections: sections.list, width: 72 });
		expect(headings(text)).toContain('Given options');
		expect(headings(text)).not.toContain('Hook options');
	});

	it('should change nothing for a command with no hooks', async () => {
		const schema: Schema = { help: false, name: 'mycli', options: { '--x': 'X' } };
		const state = await parse({ argv: [], schema });
		expect(await resolveHelp(state, { width: 72 })).toBe(renderHelp(state, { width: 72 }));
	});
});

describe('createSections()', () => {
	it('should read an option declaration the way a schema does', async () => {
		const sections = createSections();
		await sections.add({
			options: {
				'--from-string': 'A description',
				'--from-null': null,
				'--from-object': { desc: 'An object' },
				ignored: { desc: 'Named by format', format: '--from-format' },
			},
			title: 'Extra',
		});

		const [built] = sections.list;
		expect(built?.title).toBe('Extra');
		expect(built?.options.find('--from-string')?.desc).toBe('A description');
		expect(built?.options.find('--from-null')?.desc).toBeUndefined();
		expect(built?.options.find('--from-object')?.desc).toBe('An object');
		expect(built?.options.find('--from-format')?.desc).toBe('Named by format');
	});

	it('should build arguments from strings and objects alike', async () => {
		const sections = createSections();
		await sections.add({ args: ['<entry>', { desc: 'Where to', name: '[out]' }], title: 'Extra' });

		const args = sections.list[0]?.args ?? [];
		expect(args.map((arg) => arg.name)).toEqual(['entry', 'out']);
		expect(args[0]?.required).toBe(true);
		expect(args[1]?.[Internal].dest).toBe('out');
	});
});
