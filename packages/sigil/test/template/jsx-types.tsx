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

import { type Element, HANDLER_PROPS, type HandlerProp } from '../../src/element/index.js';
import { For, Show } from '../../src/renderer/index.js';
import { State } from '../../src/signals/index.js';
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

// --- the seven hooks are props, typed by the fields they set ---

// every hook has a prop, and its type is the field's: a hook `Element` gains and
// `ReservedProps` does not fails here as a missing key. `HANDLER_PROPS` is read
// so that the list this checks is the list the runtime branches on
type EveryHookIsAProp = { [K in HandlerProp]: HostProps[K] };
const hookNames: readonly HandlerProp[] = HANDLER_PROPS;

const keyed = <box onKey={(event) => event.stop()} focusable />;
const hooked = (
  <box
    onMouse={(event) => event.stop()}
    onPaste={(event) => void event.text}
    onFocusChange={(element, focused) => void (element.type + String(focused))}
    onScroll={(viewport) => void viewport.type}
    onResize={(element) => element.box === undefined}
    onLayout={() => false}
  />
);
const clearedHook = <box onKey={undefined} />;

// @ts-expect-error -- a wrong signature is a type error rather than a silent no-op
const wrongKeySignature = <box onKey={(count: number) => count} />;

// @ts-expect-error -- onResize answers whether it changed the tree
const wrongResizeReturn = <box onResize={() => 'changed'} />;

// @ts-expect-error -- a static value could only ever be a mistake
const staticHandler = <box onKey="x" />;

// --- a ref is a callback and nothing else ---

const held = new State<Element | undefined>(undefined);
const refCallback = <box ref={(el) => el.addClass('row')} />;
const refToState = <text ref={(el) => held.set(el)}>x</text>;

// @ts-expect-error -- a State is `ref={(el) => node.set(el)}`, not the State itself
const refState = <box ref={held} />;

// @ts-expect-error -- a value is not a callback
const refValue = <box ref="x" />;

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
  typeof shorthandsCamel &
  typeof keyed &
  typeof hooked &
  typeof clearedHook &
  typeof wrongKeySignature &
  typeof wrongResizeReturn &
  typeof staticHandler &
  typeof refCallback &
  typeof refToState &
  typeof refState &
  typeof refValue &
  EveryHookIsAProp &
  typeof hookNames;
