/**
 * What the host prop types accept and refuse, asserted by the type checker.
 *
 * Nothing here runs. It is checked by `tsconfig.jsx.json`, which the package's
 * `type-check` script runs after the ordinary pass -- so `pnpm check` fails if
 * any of it stops holding.
 *
 * It exists because `test/template/props.test.ts` cannot do this job. That test
 * pins the one hand-written list in `props.ts` and nothing else, so restoring
 * the defect these assertions were written for -- `Authored<>` keyed on the
 * value type, where `Color` is `number` and swallowed every numeric property --
 * would leave `pnpm test` green with `<box paddingTop={1} />` rejected and
 * `<box color={39} />` accepted, which is both answers backwards.
 *
 * A separate tsconfig rather than the package's own, for one reason: JSX needs
 * `jsxImportSource`, and pointing that at `@ttylabs/sigil` would make this
 * package's type-check depend on its own `dist/`. The `paths` mapping there
 * sends it to `src/` instead, so a source edit is checked without a build.
 *
 * Every `@ts-expect-error` must stay an error and everything without one must
 * keep compiling; TypeScript reports an unused directive, so both directions
 * fail loudly.
 */

import { For, Show } from '../../src/renderer/index.js';
import type { HostProps } from '../../src/template/runtime.js';

// --- the host element vocabulary ---

// @ts-expect-error -- not one of the three host types
const unknownElement = <txet>nope</txet>;

// @ts-expect-error -- a longhand that does not exist
const misspelledLonghand = <box padddding="1" />;

// @ts-expect-error -- a shorthand that does not exist
const misspelledShorthand = <box bordr="round" />;

// @ts-expect-error -- a keyword union stays itself
const badKeyword = <box display="grid" />;

// @ts-expect-error -- and in the kebab spelling, which is the same property
const badKeywordKebab = <box flex-direction="sideways" />;

// --- the reactivity rule, which is the thing a tagged template cannot check ---

// @ts-expect-error -- `when` is a thunk; a value is not reactive and never fires
const notAThunk = <Show when={'not a thunk'}>{() => <text>x</text>}</Show>;

const thunk = <Show when={() => true}>{() => <text>x</text>}</Show>;
const list = <For each={() => ['a']}>{(item: string) => <text>{item}</text>}</For>;

// --- a colour is spelled, never counted ---

// @ts-expect-error -- parseColor refuses "39"; it wants red, #ff8800, palette(39)
const numericColor = <box color={39} />;

// @ts-expect-error -- the same rule through the props type rather than through JSX
const numericColorProp: HostProps['color'] = 39;

const namedColor = <box color="red" backgroundColor="#ff8800" borderColor="palette(39)" />;

// --- and a count is counted, which is what the colour branch used to break ---

const numericLonghands = <box paddingTop={1} flex-grow={1} order={0} z-index={2} />;
const numericProp: HostProps['paddingTop'] = 1;
const lengths = <box width={10} max-width="50%" />;

// --- a shorthand is written in either spelling, because the runtime takes both ---

const shorthandsKebab = <box flex-flow="column" font-weight="bold" text-decoration="underline" />;
const shorthandsCamel = <box flexFlow="column" fontWeight="bold" textDecoration="underline" />;

export type Checked = typeof unknownElement &
	typeof misspelledLonghand &
	typeof misspelledShorthand &
	typeof badKeyword &
	typeof badKeywordKebab &
	typeof notAThunk &
	typeof thunk &
	typeof list &
	typeof numericColor &
	typeof numericColorProp &
	typeof namedColor &
	typeof numericLonghands &
	typeof numericProp &
	typeof lengths &
	typeof shorthandsKebab &
	typeof shorthandsCamel;
