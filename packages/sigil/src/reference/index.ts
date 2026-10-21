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
