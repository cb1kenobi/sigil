/**
 * The build's front half: reading an app off disk.
 *
 * Four passes over a tree of source files, none of which runs any of it.
 *
 * - `resolveCommandTree()` walks `commands/` the way the runtime would, all at
 *   once, and hands back the tree as data.
 * - `extractCommand()` reads one command module for the `desc` and `hidden`
 *   that the runtime cannot know without importing it.
 * - `findTemplates()` finds the `ui` templates in a module, which is the half
 *   `@ttylabs/cli/template` has always been handed rather than found.
 * - `generateCommands()` prints a resolved tree as the schema literal a built
 *   app carries, with a lazy `import()` per command.
 *
 * What is deliberately not here yet is the bundler: everything above produces
 * source and data, and stage five is what feeds it to rolldown. That split is
 * the useful one -- these four are testable with a fixture directory and no
 * bundler at all.
 */

export {
	extractCommand,
	factsOf,
	type CommandFacts,
	type Diagnostic,
	type Extracted,
	type Severity,
} from './extract.js';
export { generateCommands, specifier, type GenerateOptions } from './generate.js';
export {
	formatPosition,
	parseModule,
	position,
	type ParsedModule,
	type Position,
} from './parse-module.js';
export {
	findTemplates,
	templatesIn,
	type FoundTemplate,
	type TemplatesOptions,
} from './templates.js';
export {
	resolveCommandTree,
	walkTree,
	type ResolvedCommand,
	type ResolvedTree,
	type ResolveOptions,
} from './tree.js';
