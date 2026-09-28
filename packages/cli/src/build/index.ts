/**
 * The build's front half: reading an app off disk.
 *
 * The passes over a tree of source files, and the bundle they feed. Four of them read source and never
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
 *   `src/template/` has always been handed rather than found.
 * - `generateCommands()` prints a resolved tree as the schema literal a built
 *   app carries, with a lazy `import()` per command.
 * - `typeCheck()` runs the app's own `tsc` over the app's own `tsconfig.json`,
 *   because a build that says an app is fine and then fails the app's `tsc` has
 *   been wrong about the one thing it was asked.
 * - `bundleApp()` feeds all of that to rolldown and writes the executable.
 *
 * The split between the read passes and that last one is the useful one, and it
 * is why this doc comment said for a while that the bundler was "deliberately
 * not here yet": everything above `bundleApp()` produces source, data or a
 * verdict, so every one of those passes is testable with a fixture directory and
 * no bundler at all. The bundler arrived and the sentence stayed, which is the
 * same defect `route-info.ts` was deleted for one file along -- a comment naming
 * what is not there, in a repository where nothing in a build reads a comment.
 */

export {
	displayPath,
	diagnosticLocation,
	formatDiagnostic,
	isFatal,
	type Diagnostic,
	type Severity,
} from './diagnostic.ts';
export {
	bundleApp,
	MODULE_RE,
	type BuiltChunk,
	type BundleOptions,
	type BundleResult,
} from './bundle.ts';
export {
	discoverApp,
	readAppCommands,
	readManifest,
	resolveSpecifier,
	type AppCommands,
	type AppManifest,
	type DiscoveredApp,
	type DiscoverOptions,
} from './discover.ts';
export { extractCommand, factsOf, type CommandFacts, type Extracted } from './extract.ts';
export {
	generateBin,
	generateCommands,
	specifier,
	type GenerateBinOptions,
	type GenerateOptions,
} from './generate.ts';
export {
	formatPosition,
	parseModule,
	position,
	type ParsedModule,
	type Position,
} from './parse-module.ts';
export {
	findTemplates,
	templatesIn,
	type FoundTemplate,
	type TemplatesOptions,
} from './templates.ts';
export {
	resolveCommandTree,
	walkTree,
	type ResolvedCommand,
	type CommandKind,
	type ResolvedTree,
	type ResolveOptions,
} from './tree.ts';
export { typeCheck, type TypeCheckOptions, type TypeCheckResult } from './typecheck.ts';
