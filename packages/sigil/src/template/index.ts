/**
 * Templates: one IR, two frontends, two emitters.
 *
 * `@ttylabs/sigil/template` is the zero-build frontend --
 * the `ui` tag -- plus the IR both frontends build and the emitter both hand it
 * to. The JSX frontend is the sibling entry `@ttylabs/sigil/jsx-runtime`, which
 * is a module name rather than a choice: it is what `jsxImportSource` resolves.
 *
 * What is also here, and reads oddly until you know why, is the handful of
 * functions `emit()` uses for its leaves: `applyProp()`, `applyProps()`,
 * `applyText()`, `appendValue()`, `rawElement()` and `rootElement()`. They are
 * exported because the *build* emitter in `@ttylabs/cli` calls exactly those --
 * generated code is a call to each of them wherever the compiler could not
 * settle the answer at build time. So the two emitters share every leaf
 * decision rather than agreeing about it, which is what makes SIG-72's
 * differential test an invariant instead of a hope.
 *
 * `parse()` and `Expr` are the other half of that seam: a compiler reads a
 * template out of a file with this parser, putting an `Expr` where a value
 * would be at runtime. Nothing at runtime ever makes one, and every helper
 * above refuses one by name.
 */

export {
	appendValue,
	applyProp,
	applyProps,
	applyText,
	type ComponentRef,
	componentChildren,
	emit,
	Expr,
	type IRElement,
	type IRNode,
	type IRProp,
	type IRSlot,
	type IRText,
	isHost,
	rawElement,
	rootElement,
	type SourceLocation,
	templateError,
	textValue,
} from './ir.js';
export { parse, ui } from './tag.js';
