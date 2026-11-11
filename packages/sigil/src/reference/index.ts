/**
 * `@ttylabs/sigil/reference`: an app's command surface, as data.
 *
 * One function and the shapes it answers with. What a *reference* is -- markdown
 * for a reader, sorted JSON for a diff -- is `@ttylabs/cli`'s, for the reason the
 * utility generator records: reading the registries is something only the runtime
 * can do, and printing is toolchain work. So this publishes the walk and nothing
 * about a format, which is also what keeps it off every app's path -- a subpath
 * costs nothing unless something imports it, and nothing in the runtime does.
 */

export {
  commandSurface,
  type CommandSurface,
  type SurfaceArgument,
  type SurfaceCommand,
  type SurfaceExample,
  type SurfaceOption,
} from './surface.js';

// the order the surface is written in, published so that the toolchain sorts
// the reference it prints, and everything else it lists, with this function
// rather than a copy of it -- a copy is how two orders come to disagree
export { byCodeUnit } from '../util/by-code-unit.js';

// a description as one line, which the completion spec and the toolchain's
// reference both print a surface's descriptions with
export { descriptionLine } from '../util/description-line.js';

// a string as a pattern matching exactly it, which `sigil build`'s rolldown
// filters and the pager's literal search both need and which `RegExp.escape()`
// cannot answer yet at the Node floor -- published here for `byCodeUnit()`'s
// reason, so the toolchain imports it rather than keeping a copy
export { escapeRegExp } from '../util/escape-regexp.js';
