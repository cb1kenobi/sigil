/**
 * A slider: a value on a track, moved by the keys and by the pointer.
 *
 * A settings screen's volume, a media player's seek bar. The value is a number
 * between `min` and `max` in whole `step`s, drawn as a track with a thumb on it,
 * and optionally followed by a readout of the value.
 *
 * ```js
 * import { Slider } from '@ttylabs/sigil/components/slider';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const volume = new State(40);
 * const slider = Slider({ value: volume, format: (v) => `${v}%` });
 * ```
 *
 * The slider is focusable. Left and Right move it a step, Page Up and Page Down a
 * page -- a tenth of the range unless `page` says otherwise -- and Home and End to
 * the ends. A press on the track puts the thumb under the pointer, and holding the
 * button drags it, past either end of the track and off the canvas, until the
 * release. A disabled slider is out of the focus ring and takes neither.
 *
 * Horizontal only, and the label is the app's. `AGENTS.md` has the reasons under
 * "A slider".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { stringWidth } from '../width/index.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';

export interface SliderProps {
  /**
   * Draw the track with ASCII only. Defaults to what `unicodeSupported()` says,
   * which is the rule `Tabs` and `Collapsible` keep.
   */
  ascii?: boolean;
  /**
   * Whether the slider refuses input.
   *
   * A disabled slider is out of the focus ring, takes no key and no press, and is
   * drawn in the muted role. A `State<boolean>` is read live, so an app can switch
   * it. Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /**
   * Draws a readout of the value after the track, as this returns it: `${v}%`, a
   * time, a unit.
   *
   * The readout is as wide as the widest thing this returns over the range, so
   * the track does not move as the value does. Absent, there is no readout.
   */
  format?: (value: number) => string;
  /** The top of the range. Defaults to 100. */
  max?: number;
  /** The bottom of the range. Defaults to 0. */
  min?: number;
  /** Called with the value after a key or the pointer moved it. Not called for a write the app made. */
  onChange?: (value: number) => void;
  /**
   * How far Page Up and Page Down move, in the value's own units, rounded to whole
   * steps and never less than one. Defaults to a tenth of the range.
   */
  page?: number;
  /** The host box's own props: a class, a margin, a width. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey'>;
  /**
   * The size of one step. The value is always `min` plus a whole number of them,
   * so the top of the range is the last step at or under `max`. Defaults to 1, and
   * must be no larger than `max` minus `min`, the default included.
   */
  step?: number;
  /**
   * The value.
   *
   * A number is where it starts. A `State<number>` is the value itself: the keys
   * and the pointer write it, and an app that writes it moves the thumb. A value
   * outside the range, or between two steps, is drawn at the nearest step rather
   * than refused, since an app writes it. Defaults to `min`.
   */
  value?: number | State<number>;
  /**
   * How many columns the track takes. Defaults to what the layout gives it: the
   * rest of the width in a column, and twenty columns in a row with no width of
   * its own, shrinking to its share where the row is short.
   */
  width?: number;
}

/** Where a slider's keys are described, which is the whole of what is asked of a router. */
export interface SliderDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/**
 * What the track is drawn with.
 *
 * The thumb's glyph is what says the slider has the focus at colour level 0, where
 * the focus role's `inverse` is dropped: it fills in, in a cell the thumb already
 * holds, so the focus moves nothing.
 */
const MARKS = {
  ascii: { fill: '=', focused: 'O', rest: '-', thumb: 'o' },
  unicode: { fill: '━', focused: '●', rest: '─', thumb: '○' },
} as const;

/** The track's columns where neither the app nor the layout said. */
const TRACK = 20;

/** Past this many steps the readout is measured at the ends rather than at every step. */
const MEASURED = 1000;

/** Each slider's host, which is the focusable element the keys are described on. */
const SLIDERS = new WeakSet<Element>();

/**
 * How many digits follow the point when a number is written out, so that a sum
 * of steps can be rounded back to what the steps could add up to.
 *
 * Read off `String(value)`, which is how JavaScript writes a number, and the
 * exponent form counts: `1e-7` is seven places and `1.5e-7` eight, while
 * `1e+21` is none. A value with no digits to count -- `NaN` and either
 * infinity -- is none too.
 *
 * `number()` and the slider both asked this, one with a regex and one by
 * splitting, and the two agreed on every input tried (SIG-366), so this is the
 * one of them. It is the slider's rather than the number prompt's so that the
 * smaller of the two imports nothing for it: `number()` loads the prompt stack
 * anyway, and the slider is a few kilobytes beside that.
 *
 * @param value - The number.
 * @returns How many decimal places it is written with.
 */
export function decimalPlaces(value: number): number {
  const [mantissa = '', exponent] = String(value).split('e');
  const places = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, places - Number(exponent ?? 0));
}

/** Throws unless a prop is absent or a finite number. */
function finite(value: unknown, message: string): void {
  if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError(message);
  }
}

/**
 * Builds a slider.
 *
 * @param props - The range, the value, the callbacks, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function Slider(props: SliderProps = {}): Element {
  refuseOwnedHooks('Slider', props.props, ['onKey', 'onFocusChange']);
  if (
    props.value !== undefined &&
    typeof props.value !== 'number' &&
    !(props.value instanceof State)
  ) {
    throw new TypeError(__`Expected a slider value to be a number or a State`);
  }
  if (
    props.disabled !== undefined &&
    typeof props.disabled !== 'boolean' &&
    !(props.disabled instanceof State)
  ) {
    throw new TypeError(__`Expected slider disabled to be a boolean or a State`);
  }
  finite(props.min, __`Expected a slider min and max to be finite numbers, min below max`);
  finite(props.max, __`Expected a slider min and max to be finite numbers, min below max`);
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  if (!(min < max)) {
    throw new TypeError(__`Expected a slider min and max to be finite numbers, min below max`);
  }
  if (props.step !== undefined && !(Number.isFinite(props.step) && props.step > 0)) {
    throw new TypeError(__`Expected a slider step to be a positive number`);
  }
  if (props.page !== undefined && !(Number.isFinite(props.page) && props.page > 0)) {
    throw new TypeError(__`Expected a slider page to be a positive number`);
  }
  if (props.format !== undefined && typeof props.format !== 'function') {
    throw new TypeError(__`Expected a slider format to be a function`);
  }
  if (props.width !== undefined && !(Number.isInteger(props.width) && props.width > 0)) {
    throw new TypeError(__`Expected a slider width to be a positive whole number`);
  }

  const step = props.step ?? 1;
  /** How many steps the range holds, so the top is `min + last * step`. */
  const last = Math.floor((max - min) / step + 1e-9);
  // the default step counts too, so `{ max: 0.5 }` is refused rather than one step
  // of 1 putting the value at 1; asked of `last`, with its tolerance, rather than
  // as `step > max - min`, so 0.1 to 0.3 in 0.2s is not refused over a float
  if (last < 1) {
    throw new TypeError(__`Expected a slider step no larger than max minus min`);
  }
  const pageSteps = Math.max(1, Math.round((props.page ?? (max - min) / 10) / step));
  const places = Math.max(decimalPlaces(min), decimalPlaces(step));
  const value = props.value instanceof State ? props.value : new State(props.value ?? min);
  const disabled =
    props.disabled instanceof State ? props.disabled : new State(props.disabled ?? false);
  const { format, onChange } = props;
  const marks = (props.ascii ?? !unicodeSupported()) ? MARKS.ascii : MARKS.unicode;

  /** The value at a step, rounded back to the places the range is written in. */
  const at = (index: number): number => Number((min + index * step).toFixed(places));

  /** The step nearest a value, inside the range whatever was written. */
  const indexOf = (raw: number): number => {
    if (Number.isNaN(raw)) {
      return 0;
    }
    return Math.min(Math.max(Math.round((raw - min) / step), 0), last);
  };

  const fill = textNode('', {
    class: 'sigil-slider-fill sigil-accent',
    'flex-shrink': 0,
    'white-space': 'pre',
  });
  const thumb = textNode('', {
    class: 'sigil-slider-thumb sigil-accent',
    'flex-shrink': 0,
    width: 1,
    'white-space': 'pre',
  });
  const rest = textNode('', {
    class: 'sigil-slider-rest sigil-muted',
    'flex-shrink': 0,
    'white-space': 'pre',
  });
  // the track's size is its basis and the layout's, never its drawing: what it
  // draws is cut to the room it was given, so a track sized by its own content
  // could only ever stay the size it last was -- the text field's SIG-318, and
  // `min-width: 0` is what lets it take less than it drew last
  const track = box(
    {
      class: 'sigil-slider-track',
      'flex-direction': 'row',
      'min-width': 0,
      ...(props.width === undefined
        ? { 'flex-basis': TRACK, 'flex-grow': 1, 'flex-shrink': 1 }
        : { 'flex-shrink': 0, width: props.width }),
    },
    fill,
    thumb,
    rest
  );

  /**
   * The readout's columns: the widest the range formats to, so the track never
   * moves as the value does -- the trap the layout's `AGENTS.md` records a
   * hand-drawn slider walking into, where `100%` took a column from its
   * neighbours that `99%` had not.
   */
  let readoutWidth = 0;
  const measure = (raw: number): number => stringWidth(format?.(raw) ?? '');
  if (format !== undefined) {
    if (last <= MEASURED) {
      for (let i = 0; i <= last; i++) {
        readoutWidth = Math.max(readoutWidth, measure(at(i)));
      }
    } else {
      readoutWidth = Math.max(measure(at(0)), measure(at(last)));
    }
  }
  const readout =
    format === undefined
      ? undefined
      : textNode('', {
          class: 'sigil-slider-value',
          'flex-shrink': 0,
          'margin-left': 1,
          'text-align': 'right',
          'white-space': 'pre',
          width: readoutWidth,
        });

  const host = box({
    ...props.props,
    // after the caller's: the track and the readout are placed against these, and
    // `focusable` is `disabled`'s
    'flex-direction': 'row',
    focusable: !disabled.get(),
  });
  // added rather than written into the props, so an app's own `class` is kept,
  // which is the rule `ScrollBox` keeps
  host.addClass('sigil-slider');
  host.append(track, ...(readout ? [readout] : []));
  SLIDERS.add(host);

  /** The columns the layout gave the track, once it has. */
  let room = props.width ?? TRACK;
  /** Whether the slider has the focus, which the thumb shows. */
  let focused = false;
  /** Whether a press on the track is being held. */
  let dragging = false;
  /** What was drawn last, to say whether a draw changed the tree. */
  let drawn = '';

  /** Writes a part's text, and the width it takes, which is its length in cells. */
  const put = (part: Element, glyph: string, width: number): void => {
    part.setText(glyph.repeat(width));
    part.setProp('width', width);
  };

  /**
   * Draws the track, the thumb and the readout for the value as it stands.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  function draw(): boolean {
    const index = indexOf(value.get());
    const off = disabled.get();
    // the thumb's cell, out of every cell the track has: the left end is the
    // bottom of the range and the right end the top
    const cells = Math.max(1, room);
    const position = Math.round((index / last) * (cells - 1));
    const glyph = focused && !off ? marks.focused : marks.thumb;
    const shown = format?.(at(index)) ?? '';

    const signature = `${cells}|${position}|${glyph}|${off}|${shown}`;
    if (signature === drawn) {
      return false;
    }
    drawn = signature;

    put(fill, marks.fill, position);
    put(thumb, glyph, 1);
    put(rest, marks.rest, cells - 1 - position);
    if (readout) {
      // a format that returns something wider than it did over the range -- one
      // that reads the clock, say -- widens the readout rather than being cut
      if (stringWidth(shown) > readoutWidth) {
        readoutWidth = stringWidth(shown);
        readout.setProp('width', readoutWidth);
      }
      readout.setText(shown);
    }
    return true;
  }

  /** Moves to a step, telling the app if the value moved. */
  function moveTo(index: number): void {
    const next = at(Math.min(Math.max(index, 0), last));
    if (next !== value.get()) {
      value.set(next);
      onChange?.(next);
    }
    draw();
  }

  /** The step under a column, read off where the layout put the track. */
  function stepAt(x: number): number | undefined {
    const placed = track.box;
    if (placed === undefined) {
      return undefined;
    }
    // a captured drag reports columns past either end of the track, and off the
    // canvas, which is where the ends are
    const span = Math.max(1, placed.width - 1);
    const fraction = Math.min(Math.max((x - placed.x) / span, 0), 1);
    return Math.round(fraction * last);
  }

  track.onResize = (element): boolean => {
    const size = element.content ?? element.box;
    room = size?.width ?? props.width ?? TRACK;
    return draw();
  };

  // the focus role on the thumb, which is the one part the keys move; and the
  // thumb's glyph, which is what says so at colour level 0
  host.onFocusChange = (_, now): void => {
    focused = now;
    thumb.toggleClass('sigil-focus', now && !disabled.get());
    draw();
  };

  host.onKey = (event): void => {
    if (disabled.get()) {
      return;
    }
    const k = event.key;
    // a paste is not a keystroke, and a modifier makes it another key
    if (event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }

    const now = indexOf(value.get());
    switch (k.name) {
      case 'left': {
        moveTo(now - 1);
        break;
      }
      case 'right': {
        moveTo(now + 1);
        break;
      }
      case 'pagedown': {
        moveTo(now - pageSteps);
        break;
      }
      case 'pageup': {
        moveTo(now + pageSteps);
        break;
      }
      case 'home': {
        moveTo(0);
        break;
      }
      case 'end': {
        moveTo(last);
        break;
      }
      // Up and Down are not the slider's, so a form of rows around it can have them
      default: {
        return;
      }
    }
    // claimed at the ends too, which is the text field's rule and not the tab
    // row's: a held key overshoots, and every repeat past the end would otherwise
    // reach whatever is around the slider
    event.stop();
  };

  // on the track rather than the host, so a press on the readout moves nothing.
  // The press lands on one of the track's three parts and bubbles here, and a
  // press captures the pointer, so every move and the release after it arrive
  // here too wherever the pointer has got to -- which is why none of the three
  // parts is ever taken out of the tree, only drawn zero wide
  track.onMouse = (event): void => {
    switch (event.kind) {
      case 'mousedown': {
        if (event.button !== 'left' || disabled.get()) {
          return;
        }
        const index = stepAt(event.x);
        if (index === undefined) {
          return;
        }
        dragging = true;
        moveTo(index);
        // not stopped: a press focuses the slider, which is what puts the keys on it
        return;
      }
      case 'mousemove': {
        if (!dragging) {
          return;
        }
        if (!disabled.get()) {
          const index = stepAt(event.x);
          if (index !== undefined) {
            moveTo(index);
          }
        }
        event.stop();
        return;
      }
      case 'mouseup': {
        // any release ends a drag, so a report that lost its button cannot leave
        // the thumb stuck to the pointer
        if (!dragging) {
          return;
        }
        dragging = false;
        event.stop();
        return;
      }
      case 'click': {
        // the press already moved the thumb; the click is the slider's so a row
        // around it does not act on it as well. The wheel is left to bubble to
        // whatever scrolls
        if (event.button === 'left' && !disabled.get()) {
          event.stop();
        }
        return;
      }
      default: {
        return;
      }
    }
  };

  // `draw()` reads the value and `disabled`, so a write the app makes to either
  // redraws the track
  createEffect(() => {
    draw();
  });

  createEffect(() => {
    const off = disabled.get();
    host.setProp('focusable', !off);
    host.toggleClass('is-disabled', off);
    // the accent says the value; a disabled slider says nothing is to be done with it
    for (const part of [fill, thumb]) {
      part.toggleClass('sigil-accent', !off);
      part.toggleClass('sigil-muted', off);
    }
    readout?.toggleClass('sigil-muted', off);
    thumb.toggleClass('sigil-focus', focused && !off);
    if (off) {
      dragging = false;
    }
  });

  return host;
}

/**
 * Describes a slider's keys to a router, for a key-help footer.
 *
 * Scoped to the slider, which is the one element whose focus makes the keys
 * apply. Page Up, Page Down, Home and End are below the arrows, so a narrow footer
 * drops them first.
 *
 * @param router - What to describe the keys to.
 * @param sliders - Hosts that `Slider()` returned.
 * @returns Takes every description back off.
 */
export function describeSlider(
  router: SliderDescriber,
  ...sliders: readonly Element[]
): () => void {
  for (const host of sliders) {
    if (!SLIDERS.has(host)) {
      throw new TypeError(__`Expected an element that Slider() returned`);
    }
  }

  const off: Array<() => void> = [];
  for (const scope of sliders) {
    off.push(
      router.describe('left', { description: __`less`, priority: 1, scope }),
      router.describe('right', { description: __`more`, priority: 1, scope }),
      router.describe('pagedown', { description: __`much less`, scope }),
      router.describe('pageup', { description: __`much more`, scope }),
      router.describe('home', { description: __`minimum`, scope }),
      router.describe('end', { description: __`maximum`, scope })
    );
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
