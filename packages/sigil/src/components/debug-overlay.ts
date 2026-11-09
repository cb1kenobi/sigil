/**
 * A debug overlay: captured console output and frame stats, inside the app.
 *
 * Debugging a full-screen app means not being able to print anything. The
 * full-screen backend holds what is written to it and flushes on the way out,
 * which is right -- there is no "above the region" on a screen with no
 * scrollback, and a log line the app thought it had written is worse than one
 * that arrives late -- and *after the app exits* is not when you need to read
 * it. A `console.log` in an effect that fires thirty times a second is invisible
 * until the process ends and then arrives as a wall.
 *
 * ```js
 * import { runApp } from '@ttylabs/sigil/app';
 * import { enableDebugOverlay } from '@ttylabs/sigil/components/debug-overlay';
 *
 * const app = runApp(App, { gatherStats: true });
 * enableDebugOverlay(app.view, {
 *   input: app.input,
 *   key: (key) => key.ctrl && key.name === 'g',
 *   log: app.logs,
 * });
 * process.exitCode = await app.exited;
 * ```
 *
 * `runApp()` captures the console into `app.logs` by default (SIG-310), so the
 * overlay is handed the ring the runner already fills. It never installs a capture
 * of its own: the patch is global and only one can be live, so the app owns the
 * pairing. An app that assembles its own renderer, as `demos/renderer/03-debug.js`
 * does, calls `captureConsole()` itself and passes the ring it gave it.
 *
 * ## The three loops this is written around
 *
 * The overlay is part of the tree it reports on, so every obvious shape of it is
 * a loop or a lie. Each of the three is answered structurally rather than by a
 * comment, and each has a test named after it.
 *
 * **A console write marks nothing.** The ring is plain data with a version
 * counter and is deliberately **not** a signal: a signal write notifies its
 * watchers, which reaches the renderer's scheduler, which asks for a frame -- so
 * a `console.log` inside an effect would ask for the frame that runs the effect
 * that logs. The ring is therefore inert, and what reads it is the frame
 * callback below.
 *
 * **The pane reads on frames that were already happening.** `Renderer.onFrame()`
 * fires at the *top* of a frame, before the effects run, so what the pane writes
 * there is settled, laid out and painted by that same frame. The consequence is
 * the honest one and is worth knowing: in an app with nothing else going on, a
 * line logged after the last frame does not appear until something else asks for
 * one -- a keystroke, a resize, a signal write. There is no loop-free
 * alternative, because showing a line means changing the tree and changing the
 * tree means a frame.
 *
 * **The pane's own writes are not what asks for the next frame.** The rows
 * terminate by themselves, because a sync that finds the ring unmoved writes
 * nothing. The *stats* line does not: it holds the frame number and the frame's
 * duration, which differ every frame, so `setText()` would mark layout, ask for
 * a frame, and the frame after would differ again -- a thirty-a-second spin for
 * the life of the process, with every number in it measuring the instrument. So
 * the stats line skips exactly the frame its own last write asked for.
 *
 * ## Full screen only, and why the inline backend does not get this
 *
 * The inline backend has `write()`, which puts a line *above* the region and
 * re-anchors -- so an inline app can already print, and an overlay there would
 * be a second answer to a question that has one. This is written for the backend
 * where there is nowhere for a line to go. Nothing stops it being mounted over
 * an inline canvas and nothing about it would break; it simply is not what it is
 * for.
 */

import {
  box,
  type Element,
  type ElementProps,
  scrollIntoView,
  text as textElement,
} from '../element/index.js';
import type { InputRouter, KeyEvent } from '../input/index.js';
import type { FrameStats, Renderer } from '../renderer/index.js';
import {
  captureConsole,
  type CaptureOptions,
  type ConsoleCapture,
  createLogRing,
  type LogEntry,
  type LogLevel,
  type LogRing,
  type LogRingOptions,
} from './console-capture.js';
import type { Key } from './keys.js';
import { ScrollBox } from './scroll-box.js';

// the ring and the console patch live in `console-capture.ts` so that `runApp()` can
// own them without loading a pane (SIG-310); they are this module's exports still
export { captureConsole, createLogRing };
export type { CaptureOptions, ConsoleCapture, LogEntry, LogLevel, LogRing, LogRingOptions };

/**
 * The role each level draws in.
 *
 * A **role** rather than a colour, which is the framework sheet's own rule read
 * from the consumer's side: a line's level is de-emphasis, a warning or an error,
 * and those already have one site each in that vocabulary. The consequence is
 * that this component adds no colour declaration of its *own* to the sheet -- a
 * theme restyling `.sigil-error` restyles an error here along with everything
 * else. The one declaration it does add is the pane's **background**, which no
 * role is; the sheet says why where it sits.
 *
 * `log` draws in no role, because the ordinary case is the default foreground --
 * so an ordinary log line is **not** reachable by a role rule, which is the
 * honest half of this and is what `should draw every line in the role a theme
 * reaches it by` pins from both sides.
 * Keyed by the union so that a level added without a role is a type error rather
 * than a class no sheet defines, which is the rule `SEVERITY_ROLE` already keeps
 * in the toolchain.
 */
const LEVEL_ROLE: Record<LogLevel, string> = {
  debug: 'sigil-muted',
  error: 'sigil-error',
  info: 'sigil-info',
  log: '',
  warn: 'sigil-warn',
};

export interface DebugOverlayOptions {
  /**
   * Whether the pane follows the newest line. Defaults to `true`.
   *
   * `tail -f`, which is what a pane you toggled on to watch something wants: a
   * line arriving while you are reading history pulls you back, and reading
   * history is what pausing the app is for. It is `scrollIntoView()` on the last
   * row rather than arithmetic of the pane's own, so the offset is computed by
   * the one function that already knows where a row is -- and it runs on the
   * frame **after** a row was appended, because a row the layout has not placed
   * yet has no box to scroll to.
   */
  follow?: boolean;
  /** How many cells tall the pane is. Defaults to 12. A floor of three. */
  height?: number;
  /** Where the key binding goes. Without one there is no key and `toggle()` is it. */
  input?: InputRouter;
  /**
   * Which key toggles the pane, as a predicate over the decoded key.
   *
   * A function rather than a name, and that is a correction rather than a
   * preference: the first version took a `Key.name` and its own documentation
   * recommended `f12`, which is a name **this decoder never produces** -- the
   * named sequences are the arrows, the paging keys and the editing keys, and
   * everything else comes through as a key whose name is its own escape
   * sequence. So a string would have been an option whose documented value
   * silently matched nothing, found by driving the demo.
   *
   * A predicate also has no chord grammar to invent, which is the other half of
   * it: a key name and a modifier set are two things, and a third spelling of a
   * chord beside `Key`'s own fields would be a grammar with one caller. What an
   * app writes is `(key) => key.ctrl && key.name === 'g'`.
   *
   * Note what a binding is: it sees **every** key before the focused element
   * does, so a bare letter is a letter a text field can no longer type. A chord,
   * or one of the keys nothing types, is what to reach for -- and the handle's
   * `toggle()` is there for an app that wants a guard of its own, which is what
   * `03-focus.js` does with its `q`.
   */
  key?: (key: Key) => boolean;
  /**
   * The ring the pane shows. Defaults to one of its own.
   *
   * One of its own is a ring nothing fills. Under `runApp()` pass `app.logs`: the
   * runner owns the capture. An `undefined` there means nothing was captured
   * (`console: false`, or a capture the app installed itself), so pass that ring.
   */
  log?: LogRing;
  /**
   * Whether to draw the stats line. Defaults to `true`.
   *
   * It says nothing useful unless the renderer was built with `gatherStats`,
   * because `Renderer.stats` is `undefined` without it -- so the line reads
   * `stats off` rather than being left blank, which is a question answered
   * rather than a pane that looks broken.
   */
  stats?: boolean;
  /** Whether it starts visible. Defaults to `false`. */
  visible?: boolean;
}

export interface DebugOverlayHandle {
  /**
   * Takes the pane out of the tree, unbinds the key, and stops reading frames.
   *
   * Put back what you attached, in the order it was attached in reverse: the
   * frame handler first, so that nothing reads a pane being dismantled, then the
   * key, then the stats exclusion, then the element. Idempotent, and called for
   * you when the renderer is disposed.
   */
  dispose(): void;
  /** The pane. Already in the tree -- there is nothing for a caller to mount. */
  readonly element: Element;
  hide(): void;
  /** The ring it is showing: `app.logs` under `runApp()`, or the one passed to `captureConsole()`. */
  readonly log: LogRing;
  show(): void;
  toggle(): void;
  readonly visible: boolean;
}

/** How tall the pane is when nobody says, and the least it may be. */
const HEIGHT = 12;
const MIN_HEIGHT = 3;

/**
 * How high above everything else the pane is painted.
 *
 * Document order would already put it on top, since it is appended last -- this
 * is for the app that appends something after it. Paint order is `z-index` then
 * document order and a non-zero one keeps its subtree together, so one number on
 * the host is the whole of it.
 */
const Z_INDEX = 1000;

/**
 * Mounts a debug pane over a running renderer.
 *
 * The pane is **appended to the root**, which is sound rather than a liberty: it
 * is `position: fixed`, so it is taken out of flow, takes no space, and does not
 * size the parent it was added to -- `measureUncached()` filters out-of-flow
 * children out of what a box measures, so an auto-height canvas does not grow
 * for it either. The app's layout is what it was.
 *
 * Appended rather than built inside the component for the same reason
 * `enableSelection()` takes a mounted renderer: the stats, the exclusion and the
 * frame callback are all the renderer's, and the renderer does not exist while
 * the component body is running.
 *
 * @param view - The renderer. Pass `gatherStats: true` for the numbers.
 * @param opts - The ring, the key, the height.
 * @returns The handle.
 */
export function enableDebugOverlay(
  view: Renderer,
  opts: DebugOverlayOptions = {}
): DebugOverlayHandle {
  const log = opts.log ?? createLogRing();
  const follow = opts.follow !== false;
  const height = Math.max(MIN_HEIGHT, Math.floor(opts.height ?? HEIGHT));
  const showStats = opts.stats !== false;
  let visible = opts.visible === true;

  /** The rows, which the pane appends to and drops from the front of. */
  const list = box({
    class: 'sigil-debug-list',
    'flex-direction': 'column',
    'flex-shrink': 0,
  });

  const statsText = textElement('', {
    class: 'sigil-debug-stats sigil-muted',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  });

  const head = box(
    {
      class: 'sigil-debug-head',
      'column-gap': 1,
      'flex-direction': 'row',
      'flex-shrink': 0,
    },
    textElement('debug', { class: 'sigil-debug-title sigil-heading', 'white-space': 'nowrap' }),
    statsText
  );

  /**
   * The log, taking whatever the head left.
   *
   * `min-height: 0` is the one declaration here that is not obvious and is
   * load bearing: a box's automatic minimum is content-based, and the content of
   * a scroll box holding five hundred rows is five hundred rows tall -- so
   * without it the host cannot shrink below its own content and the pane comes
   * out forty rows tall inside a box drawn for six, with the rows painted over
   * whatever is under it. It is what `flex-basis: 0` already says said once more
   * for the axis the automatic minimum is about, and it is CSS's own idiom for a
   * scrolling pane inside a flex column.
   */
  const scroll = ScrollBox({
    children: () => list,
    props: {
      class: 'sigil-debug-log',
      'flex-basis': 0,
      'flex-grow': 1,
      'min-height': 0,
    },
  });

  /**
   * The host.
   *
   * `bottom` with a declared height rather than `top` and `bottom` together,
   * because the pane's height is the caller's and the engine's rule is "two
   * insets, else a declaration": `left` and `right` say how wide it is, and
   * `bottom` plus `height` say where the bottom edge sits. `display` is what
   * hides it -- a hidden subtree is not laid out at all, where
   * `visibility: hidden` would lay out every row to draw none of them.
   *
   * The **background is not here**, and it was for a commit. A prop beats a
   * sheet per property, so `background-color: black` written in as a prop beats
   * the light half of `.sigil-debug` and beats a theme rule on the same class --
   * which is the rule this repo records as "no built-in carries a colour in its
   * props", with the failure invisible on a dark terminal because the prop and
   * the sheet agreed there. Everything left is geometry, which is what props are
   * for.
   */
  const element = box(
    {
      'border-style': 'single',
      bottom: 0,
      class: 'sigil-debug',
      display: visible ? 'flex' : 'none',
      'flex-direction': 'column',
      height,
      left: 0,
      position: 'fixed',
      right: 0,
      'z-index': Z_INDEX,
    } satisfies ElementProps,
    ...(showStats ? [head] : []),
    scroll
  );

  /** One row per line, with the sequence number that put it there. */
  interface Row {
    element: Element;
    seq: number;
  }
  const rows: Row[] = [];

  /** What the ring's version was the last time the rows were rebuilt. */
  let seen = -1;

  /**
   * Brings the rows into agreement with the ring, and says whether it had to.
   *
   * Incremental rather than rebuilt, which is `For`'s own reason: a row that is
   * still in the ring is the same row, so keeping its element keeps its resolved
   * style and its text measurement -- both of which are keyed on the style
   * object and are worth nothing to a fresh element. A ring that wrapped once per
   * frame would otherwise rebuild five hundred rows a frame to move one.
   *
   * @returns Whether anything moved, which is what the follow is gated on.
   */
  function sync(): boolean {
    // a **declared fast path** rather than a claim, and the sabotage pass says
    // so: without it the two loops below run and find nothing to do, because
    // the drop loop's condition is false for every row and the append loop
    // skips every entry it has already shown -- so no answer changes and
    // nothing can be written that fails when it goes. What it buys is not
    // walking the whole ring on every frame of an app whose log is quiet,
    // which for five hundred rows is five hundred comparisons thirty times a
    // second to move nothing
    if (log.version === seen) {
      return false;
    }
    seen = log.version;

    // whatever fell off the front of the ring, which for a `clear()` is all of
    // it: `size` is zero, so there is no oldest entry and nothing survives
    const oldest = log.at(0)?.seq;
    while (rows.length > 0 && (oldest === undefined || rows[0].seq < oldest)) {
      const row = rows.shift();
      if (row !== undefined) {
        list.removeChild(row.element);
      }
    }

    // and whatever is newer than the last row shown. Compared by sequence rather
    // than by counting, so a `clear()` followed by a push cannot be mistaken for
    // the same lines arriving again
    const last = rows.length > 0 ? rows[rows.length - 1].seq : -1;
    for (let i = 0; i < log.size; i++) {
      const entry = log.at(i);
      if (entry === undefined || entry.seq <= last) {
        continue;
      }
      const row = entryRow(entry);
      rows.push({ element: row, seq: entry.seq });
      list.append(row);
    }

    return true;
  }

  /**
   * What the stats line says, or why it says nothing.
   *
   * @param stats - The last frame's, if there is one.
   * @returns The line.
   */
  function statsLine(stats: FrameStats | undefined): string {
    if (stats === undefined) {
      return `${log.size} lines  stats off`;
    }
    const work = `${stats.laidOut ? 'L' : '-'}${stats.painted ? 'P' : '-'}`;
    return [
      `${log.size} lines`,
      `f${stats.frame}`,
      `${stats.duration}ms`,
      work,
      `${stats.changed}/${stats.elements} el`,
      `${stats.resolved} re`,
      `${stats.cells}c ${stats.bytes}b`,
      `${stats.styles}s/${stats.sweeps}w`,
    ].join('  ');
  }

  /**
   * Whether the frame about to run is the one this pane's own last write asked
   * for.
   *
   * The third loop hazard, and the only one that does not terminate by itself.
   * The stats line holds the frame number and the frame's duration, so it differs
   * on every frame -- and `setText()` marks layout and asks for a frame, so
   * writing it unconditionally is a thirty-a-second loop for the life of the
   * process in which every number shown is a measurement of the instrument. The
   * frame the write asked for is skipped, which is what makes it stop: that frame
   * finds nothing to do and sets no other timer.
   *
   * What it costs is that a steadily animating app updates the line every other
   * frame rather than every frame, which is the right trade -- the alternative is
   * an app that cannot stop because something is watching it.
   */
  let selfCaused = false;
  /** What the stats line last said, so an unchanged line marks nothing. */
  let shown = '';
  /** Whether a row was appended and not yet scrolled to. */
  let pendingFollow = false;
  /**
   * Whether a frame has already been asked for on this pending follow's behalf.
   *
   * One, and it bounds the retry: a visible pane's next layout gives every row a
   * box, so one frame is enough -- and a tree where it somehow never does leaves
   * the pane unscrolled rather than asking for a frame per frame for ever.
   */
  let followAsked = false;

  /** Sets the follow pending, which is where its one retry is armed. */
  function wantFollow(): void {
    pendingFollow = true;
    followAsked = false;
  }

  const offFrame = view.onFrame((stats) => {
    const mine = selfCaused;
    selfCaused = false;

    // the follow first, against the boxes the *previous* frame left, and gated
    // on the last row **having** one rather than on a frame having passed. A row
    // has no box until a layout has placed it -- a row appended by the sync
    // below, or any row appended while the pane was hidden, since a hidden
    // subtree is not laid out at all -- and `scrollIntoView()` returns without
    // doing anything for a target with no box, which is indistinguishable from
    // one that was already visible. So a frame-counting version consumed the
    // flag on exactly the frame it could not act, and opening a pane that had
    // filled up while it was closed showed the *oldest* lines. Asking about the
    // box is what makes the wait as long as it has to be.
    //
    // `scrollIntoView()` writes only where it moved something, so a pane already
    // at the bottom asks for nothing.
    if (pendingFollow && visible) {
      const last = rows.at(-1)?.element;
      if (last === undefined) {
        pendingFollow = false;
      } else if (last.box !== undefined) {
        pendingFollow = false;
        scrollIntoView(last);
      } else if (!followAsked) {
        // nothing else is going to ask: `show()` marked the tree, and the frame
        // that mark produced is this one, so the layout that gives the row a box
        // happens below and the next frame has to be asked for here
        followAsked = true;
        view.invalidate();
      }
    }

    if (sync() && follow) {
      wantFollow();
    }

    if (!showStats || mine) {
      return;
    }
    const line = statsLine(stats);
    if (line !== shown) {
      shown = line;
      statsText.setText(line);
      selfCaused = true;
    }
  });

  const unexclude = view.excludeFromStats(element);
  view.root.append(element);

  let offKey: (() => void) | undefined;
  let offDispose: (() => void) | undefined;
  let disposed = false;

  const handle: DebugOverlayHandle = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      offDispose?.();
      offFrame();
      offKey?.();
      unexclude();
      element.parent?.removeChild(element);
    },

    element,

    hide(): void {
      if (!visible) {
        return;
      }
      visible = false;
      element.setProp('display', 'none');
    },

    log,

    show(): void {
      if (visible) {
        return;
      }
      visible = true;
      element.setProp('display', 'flex');
      // a hidden subtree is not laid out, so nothing in it has a box to scroll
      // to and whatever arrived while it was hidden was never followed
      if (follow) {
        wantFollow();
      }
    },

    toggle(): void {
      if (visible) {
        handle.hide();
      } else {
        handle.show();
      }
    },

    get visible() {
      return visible;
    },
  };

  // after the handle, because the binding calls it: a `const` read from a
  // closure declared above it is in its temporal dead zone for as long as
  // nothing has called the closure, and a key pressed in that window would be a
  // `ReferenceError` out of the router's dispatch
  if (opts.input !== undefined && opts.key !== undefined) {
    const wanted = opts.key;
    offKey = opts.input.bind((event: KeyEvent) => {
      if (!wanted(event.key)) {
        return;
      }
      // stopped, because a binding sees every key first and the one that
      // toggles a debug pane is not also a key for the focused element
      event.stop();
      handle.toggle();
    });
  }

  // and all of it goes with the renderer, which is `view.dispose()` without
  // `overlay.dispose()`. Toggling a pane nothing will paint is harmless;
  // **stopping the key** is not -- a binding sees every key first, so a dead
  // overlay would go on swallowing it on a router the app still owns. Last,
  // because a renderer that has already gone calls this at once
  offDispose = view.onDispose(() => handle.dispose());

  return handle;
}

/**
 * One line, as an element.
 *
 * `nowrap` so that one entry is one row whatever width the pane came out as --
 * which is what makes the list's own arithmetic a count of entries rather than a
 * measurement -- with `text-overflow` cutting what does not fit, because a line
 * that ran off the edge would be a line the pane silently lost the end of.
 *
 * @param entry - The line.
 * @returns The element.
 */
function entryRow(entry: LogEntry): Element {
  const role = LEVEL_ROLE[entry.level];
  return textElement(entry.text, {
    class: role === '' ? 'sigil-debug-entry' : `sigil-debug-entry ${role}`,
    'flex-shrink': 0,
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  });
}
