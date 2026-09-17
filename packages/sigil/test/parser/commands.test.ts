import { parse } from '../../src/parser/parse.js';
import { Internal } from '../../src/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('commands', () => {
	describe('Error Handling', () => {
		it('should error if commands definition is invalid', async () => {
			await expect(
				parse({
					schema: {
						commands: 123 as any,
					},
				})
			).rejects.toThrow(new TypeError('Expected commands to be one or more paths or an object'));

			await expect(
				parse({
					schema: {
						commands: null as any,
					},
				})
			).rejects.toThrow(new TypeError('Expected commands to be one or more paths or an object'));
		});

		it('should error if command has an invalid name', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: {
								name: 123 as any,
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected command name to be a non-empty string'));

			await expect(
				parse({
					schema: {
						commands: {
							'<foo>': {},
						},
					},
				})
			).rejects.toThrow(new Error('Unable to determine command name from "<foo>"'));
		});

		it('should error if run function is invalid', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: {
								run: 'foo' as any,
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Invalid run function in "foo" command'));
		});

		it('should error if hidden is not a boolean', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: {
								hidden: 'false' as any,
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected hidden to be a boolean in "foo" command'));
		});
	});

	describe('string', () => {
		it('should error if path is an empty string', async () => {
			await expect(
				parse({
					schema: {
						commands: '',
					},
				})
			).rejects.toThrow(new TypeError('Expected commands to be one or more paths or an object'));
		});

		it('should error if path is unsupported file type', async () => {
			await expect(
				parse({
					schema: {
						commands: 'unsupported.txt',
					},
				})
			).rejects.toThrow('Unsupported command module "unsupported.txt"');
		});

		it('should load a command by file path', async () => {
			await parse({
				schema: {
					commands: path.join(__dirname, 'fixtures/simple/foo.js'),
				},
			});
		});

		it('should load commands by directory path', async () => {
			await parse({
				schema: {
					commands: path.join(__dirname, 'fixtures/simple'),
				},
			});
		});
	});

	describe('array', () => {
		it('should not error if array is empty', async () => {
			await parse({
				schema: {
					commands: [],
				},
			});
		});

		it('should error if path is an empty string', async () => {
			await expect(
				parse({
					schema: {
						commands: ['', 'foo'],
					},
				})
			).rejects.toThrow(new TypeError('Expected commands to be one or more paths or an object'));
		});

		it('should error if path is unsupported file type', async () => {
			await expect(
				parse({
					schema: {
						commands: ['unsupported.txt'],
					},
				})
			).rejects.toThrow('Unsupported command module "unsupported.txt"');
		});

		it('should load a command by file path', async () => {
			await parse({
				schema: {
					commands: [
						path.join(__dirname, 'fixtures/simple/bar.js'),
						path.join(__dirname, 'fixtures/simple/foo.js'),
					],
				},
			});
		});

		it('should load commands by directory path', async () => {
			await parse({
				schema: {
					commands: [path.join(__dirname, 'fixtures/simple')],
				},
			});
		});

		it('should handle array of objects', async () => {
			const result = await parse({
				argv: ['foo'],
				schema: {
					commands: [{ name: 'foo' }, { name: 'bar' }],
				},
			});

			expect(result.contexts[0].name).to.equal('foo');
		});

		it('should error if name is invalid', async () => {
			await expect(
				parse({
					argv: ['foo'],
					schema: {
						commands: [{ name: undefined as any }],
					},
				})
			).rejects.toThrow(new TypeError('Expected command name to be a non-empty string'));

			await expect(
				parse({
					argv: ['foo'],
					schema: {
						commands: [{ name: 123 as any }],
					},
				})
			).rejects.toThrow(new TypeError('Expected command name to be a non-empty string'));
		});
	});

	describe('object', () => {
		it('should load multiple commands with file paths and objects', async () => {
			await parse({
				schema: {
					commands: {
						bar: path.join(__dirname, 'fixtures/simple/bar.js'),
						foo: path.join(__dirname, 'fixtures/simple/foo.js'),
						baz: {},
					},
				},
			});
		});

		it('should detect a command', async () => {
			const result = await parse({
				argv: ['baz'],
				schema: {
					commands: {
						bar: path.join(__dirname, 'fixtures/simple/bar.js'),
						foo: path.join(__dirname, 'fixtures/simple/foo.js'),
						baz: {},
					},
				},
			});

			expect(result.contexts[0].name).to.equal('baz');
		});

		it('should detect a nested command', async () => {
			const result = await parse({
				argv: ['foo', 'bar'],
				schema: {
					commands: {
						foo: {
							commands: {
								bar: {
									//
								},
							},
						},
					},
				},
			});

			expect(result.contexts[0].name).to.equal('bar');
			expect(result.contexts[1].name).to.equal('foo');
		});

		it('should lazy load command module as .js file path', async () => {
			const result = await parse({
				argv: ['foo'],
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/simple/foo.js'),
					},
				},
			});

			expect(result.cmd).to.be.ok;
			if (result.cmd !== undefined) {
				expect(result.cmd.name).to.equal('foo');
				expect(result.cmd.desc).to.equal('foo!');
			}
		});

		it('should lazy load command module as .mjs file path', async () => {
			const result = await parse({
				argv: ['foo'],
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/esm/foo.mjs'),
					},
				},
			});

			expect(result.cmd).to.be.ok;
			if (result.cmd !== undefined) {
				expect(result.cmd.name).to.equal('foo');
				expect(result.cmd.desc).to.equal('foo!');
			}
		});

		it('should lazy load command module as .cjs file path', async () => {
			const result = await parse({
				argv: ['foo'],
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/esm/foo.cjs'),
					},
				},
			});

			expect(result.cmd).to.be.ok;
			if (result.cmd !== undefined) {
				expect(result.cmd.name).to.equal('foo');
				expect(result.cmd.desc).to.equal('foo!');
			}
		});

		it('should lazy load a command module as object', async () => {
			const result = await parse({
				argv: ['foo'],
				schema: {
					commands: {
						foo: {
							desc: 'this should be overwritten',
							path: path.join(__dirname, 'fixtures/simple/foo.js'),
						},
					},
				},
			});

			expect(result.cmd).to.be.ok;
			if (result.cmd !== undefined) {
				expect(result.cmd.name).to.equal('foo');
				expect(result.cmd.desc).to.equal('foo!');
			}
		});

		it('should register command as hidden', async () => {
			const { contexts } = await parse({
				argv: ['foo'],
				schema: {
					commands: {
						'!foo': {},
					},
				},
			});
			expect(contexts[0].name).to.equal('foo');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should handle inline args', async () => {
			const schema = {
				commands: {
					'get <key>': {},
					'set <key> <value>': {},
					'build [path]': {},
					'compile <mode> [path]': {},
				},
			};

			let result = await parse({
				argv: ['get', 'foo'],
				schema,
			});
			expect(result._).to.deep.equal(['foo']);
			expect(result.argv.key).to.equal('foo');
			await expect(
				parse({
					argv: ['get'],
					schema,
				})
			).rejects.toThrow('Missing required arguments: <key>');

			result = await parse({
				argv: ['set', 'foo', 'bar'],
				schema,
			});
			expect(result._).to.deep.equal(['foo', 'bar']);
			expect(result.argv.key).to.equal('foo');
			expect(result.argv.value).to.equal('bar');
			await expect(
				parse({
					argv: ['set'],
					schema,
				})
			).rejects.toThrow('Missing required arguments: <key>');
			await expect(
				parse({
					argv: ['set', 'foo'],
					schema,
				})
			).rejects.toThrow('Missing required arguments: <value>');

			result = await parse({
				argv: ['build', 'foo'],
				schema,
			});
			expect(result._).to.deep.equal(['foo']);
			expect(result.argv.path).to.equal('foo');
			result = await parse({
				argv: ['build'],
				schema,
			});
			expect(result._).to.deep.equal([]);
			expect(result.argv.path).to.equal(undefined);

			result = await parse({
				argv: ['compile', 'foo', 'bar'],
				schema,
			});
			expect(result._).to.deep.equal(['foo', 'bar']);
			expect(result.argv.mode).to.equal('foo');
			expect(result.argv.path).to.equal('bar');
			result = await parse({
				argv: ['compile', 'foo'],
				schema,
			});
			expect(result._).to.deep.equal(['foo']);
			expect(result.argv.mode).to.equal('foo');
			expect(result.argv.path).to.equal(undefined);
			await expect(
				parse({
					argv: ['compile'],
					schema,
				})
			).rejects.toThrow('Missing required arguments: <mode>');
		});

		it('should error if both args and inline args', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							'get <key>': {
								args: ['<name>'],
							},
						},
					},
				})
			).rejects.toThrow('Cannot combine command arguments with inline arguments "get <key>"');
		});

		it('should error if command module does not exist', async () => {
			await expect(
				parse({
					argv: ['foo'],
					schema: {
						commands: {
							foo: 'does_not_exist.js',
						},
					},
				})
			).rejects.toThrow('Command module not found: does_not_exist.js');
		});

		it('should error if command module has invalid syntax', async () => {
			await expect(
				parse({
					argv: ['foo'],
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-syntax.js'),
						},
					},
				})
			).rejects.toThrow('Failed to load command module:');
		});

		it('should error if command module does not export default', async () => {
			await expect(
				parse({
					argv: ['foo'],
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/no-default.js'),
						},
					},
				})
			).rejects.toThrow('Command module default export is not a valid command object');
		});

		it('should error if command module exports invalid definition', async () => {
			await expect(
				parse({
					argv: ['foo'],
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/invalid.js'),
						},
					},
				})
			).rejects.toThrow('Command module default export is not a valid command object:');
		});

		it('should error if commands definition is invalid', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: '',
						},
					},
				})
			).rejects.toThrow('Expected commands to be one or more paths or an object');
		});
	});

	describe('packages', () => {
		it('should load a good package', async () => {
			const results = await parse({
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/good-pkg'),
					},
				},
			});
			expect(results.contexts[0][Internal].commands.get('foo')?.desc).to.equal('Foo command');
		});

		it('should load a good package with dot export', async () => {
			const results = await parse({
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/good-pkg-export-dot'),
					},
				},
			});
			expect(results.contexts[0][Internal].commands.get('foo')?.desc).to.equal('Foo command');
		});

		it('should load a good package with default export', async () => {
			const results = await parse({
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/good-pkg-export-default'),
					},
				},
			});
			expect(results.contexts[0][Internal].commands.get('foo')?.desc).to.equal('Foo command');
		});

		it('should load a good package with index', async () => {
			const results = await parse({
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/good-pkg-index'),
					},
				},
			});
			expect(results.contexts[0][Internal].commands.get('foo')?.desc).to.equal('Foo command');
		});

		it('should lazy load a good package', async () => {
			let results = await parse({
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/good-pkg-lazy'),
					},
				},
			});
			expect(results.contexts[0][Internal].commands.get('lazy')?.desc).to.equal(
				'Command not loaded yet'
			);

			results = await parse({
				argv: ['lazy'],
				schema: {
					commands: {
						foo: path.join(__dirname, 'fixtures/good-pkg-lazy'),
					},
				},
			});
			expect(results.contexts[0].desc).to.equal('Command lazy loaded');
		});

		it('should error if directory is empty', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/empty'),
						},
					},
				})
			).rejects.toThrow('Unsupported command module');
		});

		it('should error if package has malformed package.json', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-pkg-json'),
						},
					},
				})
			).rejects.toThrow('Failed to JSON parse');
		});

		it('should error if no entry file', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-pkg-no-export'),
						},
					},
				})
			).rejects.toThrow('Unsupported command module');
		});

		it('should error if entry file has syntax error', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-pkg-syntax'),
						},
					},
				})
			).rejects.toThrow('Failed to parse'); // Node.js import() error
		});

		it('should error if export does not exist', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-pkg-export-missing'),
						},
					},
				})
			).rejects.toThrow('Command package does not have a valid export:');
		});

		it('should error if main does not exist', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-pkg-main-missing'),
						},
					},
				})
			).rejects.toThrow('Command package does not have a valid main:');
		});

		it('should error if export is not an object', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: path.join(__dirname, 'fixtures/bad-pkg-no-object'),
						},
					},
				})
			).rejects.toThrow('Expected command package to default export an object:');
		});
	});

	describe('aliases', () => {
		it('should detect a command with single alias', async () => {
			const result = await parse({
				argv: ['bar'],
				schema: {
					commands: {
						foo: {
							alias: 'bar',
						},
					},
				},
			});

			expect(result.contexts[0].name).to.equal('foo');
		});

		it('should detect a command with multiple aliases', async () => {
			const result = await parse({
				argv: ['baz'],
				schema: {
					commands: {
						foo: {
							alias: ['bar', 'baz', ''],
						},
					},
				},
			});

			expect(result.contexts[0].name).to.equal('foo');
		});

		it('should handle inline aliases', async () => {
			const schema = {
				commands: {
					'@ls, list, !report': {},
					'@foo': {},
					'!bar': {},
				},
			};

			let result = await parse({
				argv: ['ls'],
				schema,
			});
			expect(result.contexts[0].name).to.equal('list');
			expect(result.contexts[0][Internal].label).to.equal('ls, list');

			result = await parse({
				argv: ['list'],
				schema,
			});
			expect(result.contexts[0].name).to.equal('list');

			result = await parse({
				argv: ['report'],
				schema,
			});
			expect(result.contexts[0].name).to.equal('list');

			result = await parse({
				argv: ['foo'],
				schema,
			});
			expect(result.contexts[0].name).to.equal('foo');

			result = await parse({
				argv: ['bar'],
				schema,
			});
			expect(result.contexts[0].name).to.equal('bar');
		});

		it('should error if alias is invalid', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							foo: {
								alias: 123 as any,
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected command alias to be a string or list of strings'));

			await expect(
				parse({
					schema: {
						commands: {
							foo: {
								alias: [123 as any],
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected command alias to be a string or list of strings'));
		});
	});

	describe('hooks', () => {
		it('should fire command hooks', async () => {
			await parse({
				argv: ['foo', '--color', 'red', '--shape', 'triangle'],
				schema: {
					commands: {
						foo: {
							hooks: {
								init: [
									async ({ options }) => {
										const color = options.get('color');
										if (color) {
											color.choices = ['red', 'green', 'blue'];
										}
									},
								],
								parse: [
									async ({ options }) => {
										options.add({
											name: 'shape',
											choices: ['circle', 'square', 'triangle'],
										});
									},
								],
							},
							options: {
								'--color [value]': {
									choices: [],
								},
							},
						},
					},
				},
			});
		});
	});
});
