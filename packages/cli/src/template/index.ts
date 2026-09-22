/**
 * The template toolchain: `@ttylabs/cli/template`.
 *
 * Two functions and the type between them. `analyze()` folds the constants out
 * of an IR and hands back an IR; `compile()` prints one as JavaScript. Both
 * take what `parse()` in `@ttylabs/sigil/template` produced, which is the whole
 * seam: there is one parser and one definition of what a template means, and
 * this is the second thing that reads it.
 *
 * ```js
 * import { parse, Expr } from '@ttylabs/sigil/template';
 * import { analyze, compile, renderImports } from '@ttylabs/cli/template';
 *
 * const found = findTemplates(file, source); // '@ttylabs/cli/build'
 * const irs = found.map(({ quasis, expressions }) =>
 *   analyze(parse(quasis, expressions.map((source) => new Expr(source))))
 * );
 * const { hoisted, imports, sources } = compile(irs, { prefix: '$sigil_' });
 * ```
 *
 * `quasis` and `expressions` are the two halves a tagged template already has,
 * so whatever reads the module -- `findTemplates()` in `@ttylabs/cli/build` --
 * hands over what it found and writes each of `sources` back where its template
 * was, `hoisted` at module scope, and `renderImports(imports)` at the top. A
 * module at a time, because all three of those are the module's rather than one
 * template's. Each `FoundTemplate` carries the span it came from, which is what
 * a caller splices the matching `sources` entry into.
 */

export { analyze } from './analyze.ts';
export {
	compile,
	type Compiled,
	type CompiledImport,
	type CompileOptions,
	renderImports,
} from './emit.ts';
