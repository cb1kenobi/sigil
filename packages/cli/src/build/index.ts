/**
 * The build's front half: reading an app off disk.
 *
 * Six passes over a tree of source files. Four of them read source and never
 * run it; the fifth hands the app's own compiler its own config and asks.
 *
 * - `discoverApp()` finds the app's root and entry, and `readAppCommands()`
 *   reads where that entry says its commands are -- a directory the filesystem
 *   router walks, or commands the schema wrote out.
 * - `resolveCommandTree()` walks `commands/` the way the runtime would, all at
 *   once, and hands back the tree as data.
 * - `extractCommand()` reads one command module for the `desc` and `hidden`
 *   that the runtime cannot know without importing it.
 * - `findTemplates()` finds the `ui` templates in a module, which is the half
 *   `@ttylabs/cli/template` has always been handed rather than found.
 * - `generateCommands()` prints a resolved tree as the schema literal a built
 *   app carries, with a lazy `import()` per command.
 * - `typeCheck()` runs the app's own `tsc` over the app's own `tsconfig.json`,
 *   because a build that says an app is fine and then fails the app's `tsc` has
 *   been wrong about the one thing it was asked.
 *
 * What is deliberately not here yet is the bundler: everything above produces
 * source, data, or a verdict, and the bundling stage is what feeds the result
 * to rolldown. That split is the useful one -- every pass here is testable with
 * a fixture directory and no bundler at all.
 */

export { formatDiagnostic, isFatal, type Diagnostic, type Severity } from './diagnostic.js';
export {
	discoverApp,
	readAppCommands,
	readManifest,
	resolveSpecifier,
	type AppCommands,
	type AppManifest,
	type DiscoveredApp,
	type DiscoverOptions,
} from './discover.js';
export { extractCommand, factsOf, type CommandFacts, type Extracted } from './extract.js';
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
	type CommandKind,
	type ResolvedTree,
	type ResolveOptions,
} from './tree.js';
export { typeCheck, type TypeCheckOptions, type TypeCheckResult } from './typecheck.js';
