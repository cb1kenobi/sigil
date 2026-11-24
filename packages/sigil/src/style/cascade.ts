/**
 * The cascade: which declaration wins, and what an element's style ends up as.
 *
 * ```js
 * import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';
 *
 * const cascade = new Cascade([parseStylesheet('.panel:focus { color: cyan }')]);
 * const style = cascade.resolve(node, { parent: parentStyle, props: { padding: '1' } });
 * ```
 *
 * The order is **layer, then origin, then specificity, then source order** --
 * the standard algorithm with the one axis a terminal UI needs added. Inventing
 * a different one buys nothing and costs everyone's intuition.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import { readSettings, resolveKeyword } from './declaration.js';
import { degradeInto } from './degrade.js';
import {
  inheritFrom,
  initialStyle,
  PROPERTY_NAMES,
  type PropertyName,
  type Style,
} from './properties.js';
import {
  compareSpecificity,
  matches,
  type Selector,
  type Specificity,
  type StyleNode,
  type StyleState,
  statesBeyondSubject,
  UNIVERSAL_KEY,
} from './selector.js';
import {
  DEFAULT_MEDIA,
  type Keyframes,
  LAYERS,
  matchesMedia,
  type MediaContext,
  ORIGINS,
  type Origin,
  type Rule,
  type RuleDeclaration,
  type Stylesheet,
} from './stylesheet.js';

/**
 * Props, as a component writes them.
 *
 * Read as source text, because that is what every other way into this system
 * takes -- `width={10}` and `width="10"` are the same declaration. A prop set to
 * `undefined` is one the template did not set, so it is skipped rather than read
 * as the word.
 */
export type PropValues = Record<string, boolean | number | string | undefined>;

/**
 * A style resolved from the sheets alone, and what a prop may not overwrite.
 *
 * This is the shape the prop fast path is built on. A sheet supplies defaults
 * and props override them per property, which is where `style=""` sits in a
 * browser -- so a prop write cannot change any *other* element's resolved style,
 * and re-applying props over a result the cascade already produced needs no
 * selector matching at all. The one thing props do not beat is an `!important`
 * declaration, which is the whole point of retaining `!important`; `locked` is
 * how that survives the fast path.
 */
export interface CascadeResult {
  /**
   * The colour depth this was resolved at.
   *
   * Carried on the result rather than passed to `applyProps()` separately: a
   * prop can name a colour, so the fast path has to degrade too, and a `level`
   * argument defaulting to truecolor is a fast path that silently disagrees
   * with `resolve()` on exactly the terminals degradation exists for.
   */
  readonly colorLevel: ColorLevel;
  /**
   * The properties an `!important` declaration won. One empty set is shared by
   * every result that has none, so it is read and never written.
   */
  readonly locked: ReadonlySet<PropertyName>;
  readonly style: Style;
}

export interface ResolveOptions {
  /** The parent element's resolved style, for inheritance. */
  readonly parent?: Style;
  readonly props?: PropValues;
}

/** A rule that matched, with the specificity of the selector that did it. */
export interface Matched {
  readonly order: number;
  readonly origin: Origin;
  readonly rule: Rule;
  readonly specificity: Specificity;
}

/** One rule filed under one of its selectors' buckets. */
interface Candidate {
  /**
   * What `match()` reports when this is the selector of its rule that matched
   * best: built once with the index rather than once per match, since nothing in
   * it depends on the element (SIG-455).
   */
  readonly matched: Matched;
  readonly selector: Selector;
}

/**
 * Which rules one `match()` has already found, and where it put each.
 *
 * Indexed by a rule's source order, which is what a rule with several selectors
 * is deduplicated on: `seen[order]` is meaningful only while `stamp[order]` is
 * the call's own generation, so a call starts by bumping the generation rather
 * than by clearing anything -- the same trick, and the same doubles, as the
 * winners table below. A `Map` per call was what this replaced (SIG-455).
 */
interface Seen {
  generation: number;
  readonly seen: Int32Array;
  readonly stamp: Float64Array;
}

/**
 * The bucket index, built once per change to the sheet set, and the table that
 * deduplicates against it.
 *
 * The table lives here because its size is the index's rule count, and an index
 * taken once per `match()` is what keeps a call consistent with itself even if
 * the sheet set moves under it.
 */
interface Index {
  /**
   * The buckets, by what a selector's `key` names -- an id, a class or a type,
   * each without the `#` or `.` the key spells it with, so that matching looks a
   * bucket up by the element's own name rather than by a string built per call.
   */
  readonly classes: Map<string, Candidate[]>;
  readonly ids: Map<string, Candidate[]>;
  readonly rules: number;
  readonly types: Map<string, Candidate[]>;
  readonly universal: Candidate[];
  /**
   * The table not in use, or `undefined` while a `match()` holds it. Borrowed
   * rather than shared for the reason the winners table is: matching calls into
   * the `StyleNode`, which an app may implement, and a getter on one can start
   * another match on this same cascade.
   */
  spare: Seen | undefined;
}

/**
 * Whether a declaration from `a` outranks one from `b` for the same property:
 * positive if it does, negative if it does not, zero for one rule against
 * itself.
 *
 * Compared field by field: the band, then origin, then layer, then specificity,
 * then source order. `!important` is what moves a declaration into the upper
 * band, and inside it the origin and the layer are read backwards -- an app
 * sheet's `!important` beats a component's props, and within one origin an
 * earlier layer's `!important` beats a later one's. That inversion is CSS's, and
 * it is the reason `!important` is worth keeping: a component copied in by
 * `sigil add` that bakes `color="red"` into its template would otherwise be
 * unthemeable, with no recourse.
 *
 * Specificity and source order are never inverted, which is also CSS.
 *
 * Props are the band between the two, and nothing here carries it: they are
 * applied after the sheets have been resolved and are gated by `locked`, which
 * says the same thing -- above every normal declaration, below every important
 * one -- while being the fast path rather than another pass over the rules.
 *
 * Read off the two matched rules rather than off a precedence built per
 * declaration, because it is only ever asked when two declarations want one
 * property, and most declarations have no rival (SIG-381).
 */
function outranks(a: Matched, aImportant: boolean, b: Matched, bImportant: boolean): number {
  if (aImportant !== bImportant) {
    return aImportant ? 1 : -1;
  }
  // read backwards inside the important band
  const direction = aImportant ? -1 : 1;
  return (
    direction * (ORIGINS.indexOf(a.origin) - ORIGINS.indexOf(b.origin)) ||
    direction * (LAYERS.indexOf(a.rule.layer) - LAYERS.indexOf(b.rule.layer)) ||
    compareSpecificity(a.specificity, b.specificity) ||
    a.order - b.order
  );
}

/** Each property's place in the scratch tables below. */
const SLOT = new Map<PropertyName, number>(PROPERTY_NAMES.map((name, at) => [name, at]));

/**
 * Which declaration is winning each property, for the one resolve using it.
 *
 * `winner[slot]` is the index of the matched rule, doubled, plus one if the
 * declaration was `!important`; it means something only while `stamp[slot]` is
 * the resolve's own `generation`, so a resolve starts by bumping the generation
 * rather than by clearing anything. That is what makes it reusable: a fresh
 * `Map` per resolve, and a `Set` of locked properties beside it, were the two
 * allocations every restyle paid whatever it matched (SIG-381).
 *
 * The stamps are doubles so that the generation never has to wrap: it is exact
 * to 2^53, which at a million resolves a second is 285 years. A 32-bit counter
 * needs a reset, and a reset is code no test can reach.
 */
interface Scratch {
  generation: number;
  /**
   * The rules the resolve matched, written from the front by `#collect()` and
   * emptied again once the resolve is done with them, so that a table kept
   * between resolves holds no rule a sheet taken out of the cascade had. It was
   * a fresh array per resolve (SIG-455).
   */
  readonly matched: (Matched | undefined)[];
  readonly stamp: Float64Array;
  readonly winner: Int32Array;
}

/**
 * The scratch not in use, or `undefined` while a resolve holds it.
 *
 * Borrowed rather than shared, so that a resolve which somehow started inside
 * another one gets a table of its own instead of overwriting the winners, or the
 * matched rules, of the one it interrupted. Nothing in the library does that, but
 * there are two ways in: matching calls into the `StyleNode`, which an app may
 * implement with getters, and a `Stylesheet` is a plain object an app can build
 * by hand, so a getter on one of its declarations is the other. Everything else a
 * resolve calls is a pure function of the declarations, the parent style and the
 * colour level. A resolve that throws while it holds the table never hands it
 * back, and the next one makes another; one that throws after, from
 * `degradeInto()`, has already handed it back with its generation spent and its
 * rules let go, which is all a later resolve needs of it.
 */
let spare: Scratch | undefined;

/**
 * What a result with nothing `!important` locks, shared by every such result.
 *
 * Most elements match no important declaration, and a `Set` built per resolve
 * to say so was the other allocation every restyle paid. It is a `ReadonlySet`
 * in `CascadeResult` already, which is what makes sharing it safe to promise.
 */
const UNLOCKED: ReadonlySet<PropertyName> = new Set();

/** What `node.classes` is read as when an element has none. */
const NO_CLASSES: readonly string[] = [];

/**
 * Tests one bucket's candidates against an element, for `#collect()`: writes
 * each rule that matches into `out` after the `count` already there, or over the
 * entry it already has when a more specific selector of the same rule matches,
 * and returns the new count.
 */
function collectFrom(
  bucket: readonly Candidate[] | undefined,
  node: StyleNode,
  media: MediaContext,
  table: Seen,
  out: (Matched | undefined)[],
  count: number
): number {
  if (bucket === undefined) {
    return count;
  }
  const { generation, seen, stamp } = table;
  for (const candidate of bucket) {
    const matched = candidate.matched;
    const order = matched.order;
    const at = stamp[order] === generation ? (seen[order] as number) : -1;
    if (at >= 0 && compareSpecificity((out[at] as Matched).specificity, matched.specificity) >= 0) {
      continue;
    }
    if (!matchesMedia(matched.rule.media, media)) {
      continue;
    }
    if (!matches(candidate.selector, node)) {
      continue;
    }
    if (at >= 0) {
      // a more specific selector of a rule already found: it keeps its place,
      // which is what the map this replaced did on a second `set()`
      out[at] = matched;
    } else {
      stamp[order] = generation;
      seen[order] = count;
      out[count++] = matched;
    }
  }
  return count;
}

/**
 * The cascade: a set of stylesheets, and the answer for any one element.
 *
 * Matching is right-to-left and rules are bucketed by their rightmost simple
 * selector, so an element only tests rules that could possibly match it. Worth
 * keeping in proportion: browsers optimize this hard because they have ten
 * thousand elements and ten thousand rules, and a terminal UI has a couple of
 * hundred of each. Naive may simply be the permanent answer.
 */
export class Cascade {
  /** What the media queries are asked about. A renderer sets it on resize. */
  media: MediaContext;

  #buckets: Index | undefined;
  #keyframes: Map<string, Keyframes> | undefined;
  #reaching: Set<StyleState> | undefined;
  #importants: Set<PropertyName> | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #sheets: Stylesheet[] = [];

  constructor(sheets: Iterable<Stylesheet> = [], media: MediaContext = DEFAULT_MEDIA) {
    this.media = media;
    for (const sheet of sheets) {
      this.add(sheet);
    }
  }

  get sheets(): readonly Stylesheet[] {
    return this.#sheets;
  }

  /**
   * Adds a stylesheet. Sheets are in source order, so a sheet added later
   * breaks ties against one added earlier -- within one origin and layer.
   *
   * @param sheet - The sheet.
   * @returns This cascade, for chaining.
   */
  add(sheet: Stylesheet): this {
    this.#sheets.push(sheet);
    this.#changed();
    return this;
  }

  /**
   * Takes a stylesheet out, so that a theme can be swapped for another or for
   * nothing.
   *
   * Every occurrence goes: `add()` does not refuse a sheet it already holds, and
   * a cascade that still held the sheet after being told to forget it would be
   * the one answer to "is it in there" nobody could act on.
   *
   * @param sheet - The sheet, by identity.
   * @returns Whether it was there.
   */
  remove(sheet: Stylesheet): boolean {
    let found = false;
    for (let at = this.#sheets.length - 1; at >= 0; at--) {
      if (this.#sheets[at] === sheet) {
        this.#sheets.splice(at, 1);
        found = true;
      }
    }
    if (found) {
      this.#changed();
    }
    return found;
  }

  /**
   * Puts a stylesheet where another one was.
   *
   * In place rather than a `remove()` and an `add()`, because the order sheets
   * were added in is what breaks a tie within one origin and layer: a sheet that
   * swapped itself in by being added last would beat an earlier sibling the old
   * one lost to. The new sheet takes the old one's turn, in every position the
   * old one held.
   *
   * It is the *origin* that places a sheet between the framework's and the app's,
   * not where it was added, so a theme replaced by a theme stays where a theme
   * is -- and a sheet parsed at another origin is placed by that one.
   *
   * @param old - The sheet to replace, by identity.
   * @param next - The sheet that takes its place.
   * @returns This cascade, for chaining.
   * @throws If `old` is not in this cascade. Quietly adding `next` instead would
   *   hide a caller that has lost track of which sheet it put in.
   */
  replace(old: Stylesheet, next: Stylesheet): this {
    let found = false;
    for (let at = 0; at < this.#sheets.length; at++) {
      if (this.#sheets[at] === old) {
        this.#sheets[at] = next;
        found = true;
      }
    }
    if (!found) {
      throw new Error('Cannot replace a stylesheet that is not in the cascade');
    }
    this.#changed();
    return this;
  }

  /**
   * Calls `listener` whenever the set of sheets changes.
   *
   * What lets a change to the cascade restyle on its own: a renderer subscribes
   * when it mounts, so a caller that swaps a theme never reaches into the
   * restyler to say that every rule is stale. Told *that* it changed and not
   * what, because the answer to what is a full re-match either way.
   *
   * Not told about `media`, which is a field a renderer writes on a resize and
   * which it follows with a restyle of its own.
   *
   * Called over a copy and with a membership check, as every listener set in the
   * renderer is: one that unsubscribes another, or itself, mid-dispatch is not
   * called afterwards, and one that subscribes another is not called for the
   * change that added it.
   *
   * @param listener - What to call.
   * @returns Unsubscribes it.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The sheet set moved: drop what was built from it, then say so. */
  #changed(): void {
    this.#buckets = undefined;
    this.#keyframes = undefined;
    this.#reaching = undefined;
    this.#importants = undefined;
    // a copy, so that one subscribing or leaving mid-dispatch cannot change who is called
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      if (this.#listeners.has(listener)) {
        listener();
      }
    }
  }

  /**
   * The animation a name refers to, or `undefined` if nothing declares one.
   *
   * Resolved by origin and then by the order sheets were added, with the last
   * one winning -- which is the cascade's own ordering with the two axes it has
   * nothing to say about left out. Layers do not apply: a `@keyframes` is not a
   * declaration and has no property for a layer to break a tie over, so
   * `@layer utilities { @keyframes spin { ... } }` is the same animation as one
   * written outside. Specificity has nothing to apply to either, since a name
   * is matched rather than selected.
   *
   * Built on the first ask and thrown away when a sheet is added, removed or
   * replaced, the way the bucket index is -- a theme swapped at runtime is one of
   * the three, and a keyframes map kept across that would answer for a sheet
   * nobody has.
   *
   * @param name - What `animation-name` said.
   * @returns The stops, or `undefined`.
   */
  keyframes(name: string): Keyframes | undefined {
    if (!this.#keyframes) {
      const found = new Map<string, Keyframes>();
      // origin first, then the order they were added, so that the last writer
      // in cascade order is the one still in the map
      for (const origin of ORIGINS) {
        for (const sheet of this.#sheets) {
          if (sheet.origin !== origin) {
            continue;
          }
          for (const [key, frames] of sheet.keyframes) {
            found.set(key, frames);
          }
        }
      }
      this.#keyframes = found;
    }
    return this.#keyframes.get(name);
  }

  /**
   * Whether any rule asks about `state` on an element other than the one it
   * styles -- left of a combinator, as in `.panel:focus-within .title`.
   *
   * What a restyler reads to decide how far a change to that state reaches. When
   * no rule does, the state is only ever a question about the element it is on,
   * and a change to it restyles that element alone; when one does, it restyles
   * what a class change would. Every sheet is read, a rule inside a media query
   * that does not apply included, so the answer cannot go stale on a resize.
   * Built on the first ask and thrown away with the bucket index.
   *
   * @param state - The state.
   * @returns Whether a combinator can carry a change to it to another element.
   */
  reaches(state: StyleState): boolean {
    if (!this.#reaching) {
      const found = new Set<StyleState>();
      for (const sheet of this.#sheets) {
        for (const rule of sheet.rules) {
          for (const selector of rule.selectors) {
            for (const name of statesBeyondSubject(selector)) {
              found.add(name);
            }
          }
        }
      }
      this.#reaching = found;
    }
    return this.#reaching.has(state);
  }

  /**
   * What an `!important` declaration says a property is on an element, if one
   * wins it: the one property's answer, with no style resolved (SIG-384).
   *
   * Props sit below `!important` and above everything else, so this is the one
   * thing that can outrank a prop, and it is what a reader that has to know
   * whether a prop's value is the value -- before a frame has resolved it --
   * asks. The element is matched now, against the classes and states it has now,
   * which is the point: the answer a resolve would give, for one property and
   * without the rest. Where no sheet declares the property `!important` at all
   * it answers `undefined` without matching anything, which is nearly always.
   *
   * Which declaration wins is the cascade's own order inside the important band
   * (`outranks()`, read backwards), and a wide keyword is read against `parent`
   * as `resolve()` reads it.
   *
   * @param node - The element.
   * @param property - The property.
   * @param parent - The parent's resolved style, for `inherit`.
   * @returns The value, or `undefined` where nothing important declares it.
   */
  important(node: StyleNode, property: PropertyName, parent?: Style): unknown {
    if (!this.#importants) {
      const found = new Set<PropertyName>();
      for (const sheet of this.#sheets) {
        for (const rule of sheet.rules) {
          for (const declaration of rule.declarations) {
            if (declaration.important) {
              found.add(declaration.property);
            }
          }
        }
      }
      this.#importants = found;
    }
    if (!this.#importants.has(property)) {
      return undefined;
    }

    let best: Matched | undefined;
    let winner: RuleDeclaration | undefined;
    // collected rather than asked of `match()`, which a subclass may override and
    // `resolveSheets()` does not call: this answers for what a resolve would
    const found: (Matched | undefined)[] = [];
    const count = this.#collect(node, found);
    for (let at = 0; at < count; at++) {
      const matched = found[at] as Matched;
      for (const declaration of matched.rule.declarations) {
        if (
          declaration.property !== property ||
          !declaration.important ||
          (best !== undefined && outranks(matched, true, best, true) < 0)
        ) {
          continue;
        }
        best = matched;
        winner = declaration;
      }
    }
    if (winner === undefined) {
      return undefined;
    }
    return winner.keyword ? resolveKeyword(winner.keyword, property, parent) : winner.value;
  }

  /**
   * Every rule that matches an element, once per rule however many of its
   * selectors matched.
   *
   * A rule's selector list behaves as though the rule were written once per
   * selector, so the specificity reported is the highest among the selectors
   * that actually matched.
   *
   * The array is the caller's; the objects in it are the cascade's, the same
   * ones on every call until the sheet set changes, and frozen.
   *
   * `resolveSheets()` does not call this -- it matches into an array it reuses --
   * so a subclass that overrides it changes what `match()` answers and not what
   * an element resolves to.
   *
   * @param node - The element.
   * @returns The matched rules, in no particular order.
   */
  match(node: StyleNode): Matched[] {
    const out: Matched[] = [];
    this.#collect(node, out);
    return out;
  }

  /**
   * Writes the rules that match an element into `out` from the front, and says
   * how many there were.
   *
   * What `match()` and `resolveSheets()` share. It allocates nothing in the
   * common case: the matched rule is the candidate's own, the deduplication is a
   * borrowed table, and `out` is whatever array the caller hands over -- which
   * for a resolve is one it reuses (SIG-455).
   */
  #collect(node: StyleNode, out: (Matched | undefined)[]): number {
    // taken once, so that a sheet added from inside a match -- by a getter on a
    // node -- cannot leave this call reading orders from two different indexes
    const index = this.#index();
    const table = index.spare ?? {
      generation: 0,
      seen: new Int32Array(index.rules),
      stamp: new Float64Array(index.rules),
    };
    index.spare = undefined;
    table.generation++;

    // the buckets `keysFor()` names, in its order, looked up by the name itself:
    // building its keys was an array and a string per class on every call
    const { type, id, classes } = node;
    const media = this.media;
    let count = collectFrom(index.universal, node, media, table, out, 0);
    count = collectFrom(index.types.get(type), node, media, table, out, count);
    if (id !== undefined) {
      count = collectFrom(index.ids.get(id), node, media, table, out, count);
    }
    for (const name of classes ?? NO_CLASSES) {
      count = collectFrom(index.classes.get(name), node, media, table, out, count);
    }

    index.spare = table;
    return count;
  }

  /**
   * Resolves an element's style from the stylesheets alone.
   *
   * @param node - The element.
   * @param parent - The parent's resolved style, for inheritance.
   * @returns The style, and the properties props may not overwrite.
   */
  resolveSheets(node: StyleNode, parent?: Style): CascadeResult {
    const style = (parent ? inheritFrom(parent) : initialStyle()) as Record<PropertyName, unknown>;

    // borrowed before matching, because the matched rules are written into it:
    // matching calls into the `StyleNode`, so a resolve started from there finds
    // the table out and makes its own
    const scratch = spare ?? {
      generation: 0,
      matched: [],
      stamp: new Float64Array(PROPERTY_NAMES.length),
      winner: new Int32Array(PROPERTY_NAMES.length),
    };
    spare = undefined;
    const { matched, stamp, winner } = scratch;
    const count = this.#collect(node, matched);
    const generation = ++scratch.generation;
    let locked: Set<PropertyName> | undefined;
    // a name the table has no slot for, which only a hand-built sheet can carry:
    // kept by name, as every property was before, so two of them never compete
    let strays: Map<string, number> | undefined;

    for (let at = 0; at < count; at++) {
      const rule = matched[at] as Matched;
      // indexed rather than `for...of`, which V8 was measured not optimizing
      // away here: an iterator and its results, about 120 bytes a resolve on a
      // sheet of one rule, where the loops in `collectFrom()` cost nothing (SIG-455)
      const declarations = rule.rule.declarations;
      for (let d = 0; d < declarations.length; d++) {
        const declaration = declarations[d] as RuleDeclaration;
        const property = declaration.property;
        const important = declaration.important;
        const slot = SLOT.get(property);

        const held =
          slot === undefined
            ? strays?.get(property)
            : stamp[slot] === generation
              ? winner[slot]
              : undefined;
        if (
          held !== undefined &&
          outranks(rule, important, matched[held >> 1] as Matched, (held & 1) === 1) < 0
        ) {
          continue;
        }

        const code = (at << 1) | (important ? 1 : 0);
        if (slot === undefined) {
          (strays ??= new Map()).set(property, code);
        } else {
          stamp[slot] = generation;
          winner[slot] = code;
        }
        style[property] = declaration.keyword
          ? resolveKeyword(declaration.keyword, property, parent)
          : declaration.value;
        if (important) {
          // nothing outside the important band can take it back, so this only
          // ever grows
          (locked ??= new Set()).add(property);
        }
      }
    }

    // let go of the rules, so the table kept for the next resolve holds none
    matched.fill(undefined, 0, count);
    spare = scratch;

    // the last pass over a resolved style, so nothing downstream ever holds a
    // colour the terminal cannot emit and the diff never compares a colour
    // against its own approximation
    const level = this.media.colorLevel as ColorLevel;
    return {
      colorLevel: level,
      locked: locked ?? UNLOCKED,
      style: degradeInto(style as Style, level),
    };
  }

  /**
   * Resolves an element's style: the sheets, then its props over the top.
   *
   * @param node - The element.
   * @param opts - The parent's style, and the element's props.
   * @returns The resolved style.
   */
  resolve(node: StyleNode, opts: ResolveOptions = {}): Style {
    const result = this.resolveSheets(node, opts.parent);
    // written into in place: the result is freshly built and nothing else holds
    // it, so there is nothing to protect by copying it first
    return opts.props
      ? applyPropsInto(result, opts.props, opts.parent, result.style)
      : result.style;
  }

  /** Builds the bucket index, once per change to the sheet set. */
  #index(): Index {
    if (this.#buckets) {
      return this.#buckets;
    }

    const classes = new Map<string, Candidate[]>();
    const ids = new Map<string, Candidate[]>();
    const types = new Map<string, Candidate[]>();
    const universal: Candidate[] = [];
    let order = 0;

    for (const sheet of this.#sheets) {
      for (const rule of sheet.rules) {
        const at = order++;
        for (const selector of rule.selectors) {
          const candidate: Candidate = {
            // frozen, since every match until the sheet set changes hands out
            // this one object: a caller that wrote to it would move every later
            // answer, where a fresh one per call could only move its own
            matched: Object.freeze({
              order: at,
              origin: sheet.origin,
              rule,
              specificity: selector.specificity,
            }),
            selector,
          };
          const key = selector.key;
          if (key === UNIVERSAL_KEY) {
            universal.push(candidate);
            continue;
          }
          // the key's first character says which kind of name follows, as
          // `keyOf()` spells it: `#` an id, `.` a class, and a type has neither
          const map = key[0] === '#' ? ids : key[0] === '.' ? classes : types;
          const name = map === types ? key : key.slice(1);
          const bucket = map.get(name);
          if (bucket) {
            bucket.push(candidate);
          } else {
            map.set(name, [candidate]);
          }
        }
      }
    }

    this.#buckets = { classes, ids, rules: order, spare: undefined, types, universal };
    return this.#buckets;
  }
}

/**
 * Applies an element's props over a style the cascade already resolved.
 *
 * This is the fast path: a prop write affects nothing but the element it was
 * written on, so re-running this over a kept `CascadeResult` is the whole of the
 * work, with no selector matched and no other element touched.
 *
 * @param result - What the sheets resolved to. It is not modified, so one kept
 * result answers for any number of prop writes.
 * @param props - The element's props.
 * @param parent - The parent's style, which `inherit` in a prop reads.
 * @returns The style, props applied.
 */
export function applyProps(result: CascadeResult, props: PropValues, parent?: Style): Style {
  return applyPropsInto(result, props, parent, { ...result.style });
}

/**
 * Writes props into a style, taking it over.
 *
 * `into` is the caller's to give away: `resolve()` hands over the style it has
 * just built, which nothing else holds, and `applyProps()` hands over a copy so
 * that a kept result answers again.
 */
function applyPropsInto(
  result: CascadeResult,
  props: PropValues,
  parent: Style | undefined,
  into: Style
): Style {
  const { colorLevel: level, locked } = result;
  const target = into;
  const style = target as Record<PropertyName, unknown>;

  for (const [name, raw] of Object.entries(props)) {
    if (raw === undefined) {
      continue;
    }
    for (const setting of readSettings(name, String(raw))) {
      // an `!important` declaration outranks every prop, which is what makes a
      // component that bakes a value into its template themeable at all
      if (locked.has(setting.property)) {
        continue;
      }
      style[setting.property] = setting.keyword
        ? resolveKeyword(setting.keyword, setting.property, parent)
        : setting.value;
    }
  }

  // a prop can name a colour too, so the fast path degrades as well -- three
  // memoized lookups, which is what keeps it a fast path
  return degradeInto(style as Style, level);
}
