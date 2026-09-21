/**
 * Templates: one IR, two frontends.
 *
 * `@ttylabs/sigil/template` is the zero-build frontend --
 * the `ui` tag -- plus the IR both frontends build and the emitter both hand it
 * to. The JSX frontend is the sibling entry `@ttylabs/sigil/jsx-runtime`, which
 * is a module name rather than a choice: it is what `jsxImportSource` resolves.
 *
 * What is deliberately not here yet is the third thing SIG-69 asks for: the
 * analysis pass and the build emitter in `@ttylabs/cli`. The seam for both is
 * `IRNode` -- an analyzer rewrites it and a build emitter prints it as source
 * instead of calling `emit()`.
 */

export {
	type ComponentRef,
	emit,
	type IRElement,
	type IRNode,
	type IRProp,
	type IRSlot,
	type IRText,
	isHost,
	type SourceLocation,
	templateError,
} from './ir.js';
export { ui } from './tag.js';
