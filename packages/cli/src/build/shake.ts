/**
 * Style shaking: emitting only the utility rules an app can actually name.
 *
 * ## What this is, and what it deliberately is not
 *
 * SIG-115 asked for two things about stylesheets -- shake them, and emit them
 * **as data** rather than as source to be parsed at startup -- and said the two
 * should be one pass because they read the same sheet. They are one pass here,
 * and the pass does one of them, because the other was measured and is a loss.
 * The numbers are in AGENTS.md; the short version is that a parsed rule is
 * simply more information than the CSS that produced it. The utility sheet is
 * 13.3 kB of CSS and **103 kB** of minified JS literal, against a stylesheet
 * parser that is 9.1 kB and a parse that is 0.59 ms. Shaking moves both numbers
 * the same way; emitting data trades 90 kB for half a millisecond.
 *
 * ## Only the generated vocabulary is shaken
 *
 * That is SIG-81's own argument taken at its word. Hand-written CSS cannot be
 * shaken soundly -- "can this app ever produce `class="error"`?" is a question
 * about arbitrary JavaScript -- and a hand-written sheet has no bytes in it to
 * win back anyway. The utility sheet is the opposite on both counts: the build
 * knows the entire grammar that produced it, and it is 383 rules an app may
 * name a dozen of.
 *
 * It is also the one sheet with a seam the build can reach. `utilitySheet()` is
 * opt-in, so it is a call **in the app's own source**, which a transform can
 * rewrite -- and rewriting it is what makes `UTILITY_CSS` unreferenced, so the
 * 13.3 kB shakes out of the bundle rather than being replaced in it. The
 * framework sheet has no such seam: nothing in an app calls `frameworkSheet()`,
 * because every built-in reaches it through `themedCascade()` from inside the
 * runtime. It is left alone, and at 19 rules and 0.023 ms that is not a loss
 * worth inventing a seam for.
 *
 * ## The analysis is evidence, not proof
 *
 * A class reaches the cascade as a string, so the question is which strings an
 * app's source can produce. Every string literal and every template quasi in
 * the app's own files is tokenized, and a utility survives if some token could
 * be it. That is Tailwind's scanner, and like Tailwind's it is unsound in
 * exactly one direction: a class assembled entirely out of values that never
 * appear as literals -- read from JSON, joined out of an array that came from
 * somewhere else -- leaves no evidence and its rule is dropped.
 *
 * Two affordances make the common dynamic shapes safe, and they are the reason
 * this is not simply a regex over the source. A literal that sits next to an
 * interpolation is **open** on that side, so `` `text-${colour}` `` and
 * `'text-' + colour` both leave the token `text-` open on the right, and every
 * `text-*` utility survives it. A literal with nothing next to it is closed and
 * matches by equality, so `'Hello, '` keeps nothing. Which end is open is read
 * off the tree rather than guessed at from the text, which is the whole
 * difference between this and a scanner.
 *
 * What is left over is the escape hatch: `build.safelist` in `sigil.json` names
 * classes to keep whatever the evidence says, and `build.shake: false` turns
 * the whole thing off. The count is in the build summary either way, because a
 * build that quietly kept everything and a build that quietly dropped the wrong
 * rule look identical from outside.
 *
 * ## Why over-approximating is the safe direction, everywhere
 *
 * Keeping a rule nothing can match costs 35 bytes. Dropping one something can
 * match costs a layout that is subtly wrong in a terminal with nothing to point
 * at. So every uncertainty here resolves towards keeping: a file that does not
 * parse falls back to a raw token scan of its own text, files rolldown would
 * never have reached are scanned anyway, and a `utilitySheet` the matcher
 * cannot claim is simply left alone with the whole sheet behind it.
 */

import { quote } from '../template/emit.ts';
import { generateUtilities, utilities, VARIANT_NAMES } from '../utilities/index.ts';
import { bindingName, importBindings, reachable } from './bindings.ts';
import { choosePrefix } from './compile-templates.ts';
import { landsAt } from './discover.ts';
import { unwrapShallow } from './literals.ts';
import { MODULE_RE, parseModule } from './parse-module.ts';
import { walk } from './walk.ts';
import MagicString from 'magic-string';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CallExpression, Expression, Node } from 'oxc-parser';

/** Where `utilitySheet` comes from. */
export const STYLE_MODULE = '@ttylabs/sigil/style';

/** What it is exported as. */
export const SHEET_EXPORT = 'utilitySheet';

/**
 * The characters a class name is made of, as far as this has to care.
 *
 * Word characters and a hyphen are most of it; a slash is in because ten base
 * utilities are named `w-1/2` and its siblings, and a colon is in because that
 * is how a variant is spelled and leaving it out would silently stop working
 * the day the variants ship. Everything else -- a quote, a space, an angle
 * bracket, an equals sign -- is a boundary, which is what lets a `ui`
 * template's `class="p-2 bold"` be read out of the one literal chunk it
 * arrives in.
 */
const TOKEN_RE = /[\w\-/:]+/g;

/** What an app's source says about the classes it can name. */
export interface ClassEvidence {
  /**
   * Whether the app could name this class.
   *
   * @param name - The class name, unescaped.
   * @returns Whether some literal in the app is evidence for it.
   */
  mayName(name: string): boolean;
}

/** One literal chunk, and which of its ends touch something unknown. */
interface Chunk {
  /** Whether something unknown is concatenated on the left. */
  readonly openLeft: boolean;
  /** Whether something unknown is concatenated on the right. */
  readonly openRight: boolean;
  readonly text: string;
}

/**
 * The evidence, collected.
 *
 * Four buckets rather than one set, because where a literal sat decides what
 * it is evidence *of*: a closed literal is the class, and an open one is a
 * piece of one, matching by prefix, by suffix, or anywhere.
 */
class Evidence implements ClassEvidence {
  readonly #exact = new Set<string>();
  readonly #infix = new Set<string>();
  readonly #prefix = new Set<string>();
  readonly #suffix = new Set<string>();
  /**
   * The open tokens that could be part of a variant-qualified name, kept apart
   * so asking about one of the ~6,000 of those never walks the ones that
   * could not be.
   */
  readonly #qualified = {
    infix: new Set<string>(),
    prefix: new Set<string>(),
    suffix: new Set<string>(),
  };

  /** Adds a name that is kept whatever the source says. */
  safelist(name: string): void {
    this.#exact.add(name);
  }

  /**
   * Reads one literal chunk.
   *
   * A token is open on an end only when it *touches* that end: in `'Hello, '`
   * followed by an interpolation, the chunk is open on the right and the token
   * `Hello` is not, because the comma sits between them. That is what keeps
   * the affordance for `` `text-${c}` `` from becoming an affordance for every
   * string in the app.
   *
   * @param chunk - The literal text and which ends are open.
   */
  read(chunk: Chunk): void {
    for (const match of chunk.text.matchAll(TOKEN_RE)) {
      const token = match[0];
      const left = chunk.openLeft && match.index === 0;
      const right = chunk.openRight && match.index + token.length === chunk.text.length;

      // an open token names a *qualified* class only if it is itself half of
      // one: it holds the `:` and something to read beside it. `${h}:${m}` is
      // a clock and leaves the token `:` open on both sides, and counting that
      // as evidence would keep every variant of every utility -- 5,745 rules --
      // for an app that formats a time
      const half = token.includes(':') && /\w/.test(token);

      if (left && right) {
        this.#infix.add(token);
        if (half) {
          this.#qualified.infix.add(token);
        }
      } else if (left) {
        this.#suffix.add(token);
        if (half) {
          this.#qualified.suffix.add(token);
        }
      } else if (right) {
        this.#prefix.add(token);
        if (half) {
          this.#qualified.prefix.add(token);
        }
      } else {
        this.#exact.add(token);
      }
    }
  }

  mayName(name: string): boolean {
    if (this.#exact.has(name)) {
      return true;
    }
    if (name.includes(':')) {
      for (const token of this.#qualified.prefix) {
        if (name.startsWith(token)) {
          return true;
        }
      }
      for (const token of this.#qualified.suffix) {
        if (name.endsWith(token)) {
          return true;
        }
      }
      for (const token of this.#qualified.infix) {
        if (name.includes(token)) {
          return true;
        }
      }
      return false;
    }
    for (const prefix of this.#prefix) {
      if (name.startsWith(prefix)) {
        return true;
      }
    }
    for (const suffix of this.#suffix) {
      if (name.endsWith(suffix)) {
        return true;
      }
    }
    for (const infix of this.#infix) {
      if (name.includes(infix)) {
        return true;
      }
    }
    return false;
  }
}

/** Directories a scan never descends into. */
const SKIPPED = new Set(['node_modules']);

/** What to scan, and what to keep regardless. */
export interface ScanOptions {
  /** Directories to leave out: the one being written and the build's own. */
  readonly exclude?: readonly string[];
  /** Class names kept whatever the source says. */
  readonly safelist?: readonly string[];
}

/**
 * Reads an app's source for the classes it could name.
 *
 * The app's own tree rather than the module graph rolldown builds. That is an
 * over-approximation in one direction and the analysis's one real boundary in
 * the other. It reads files nothing imports, which can only keep a rule that
 * was going to be kept anyway; and it does not read anything **outside the app
 * root**, which is where it can be short -- a published package that renders
 * sigil elements with sigil utility classes, and, less exotically, a sibling
 * workspace package in a monorepo. Both are `build.safelist`'s, and both are
 * the same statement the unsound case above makes: this is evidence, and what
 * leaves none needs saying by hand.
 *
 * Rolldown's own graph is the sound answer and is not available: the rewrite
 * happens in a module's `transform`, and the evidence is not complete until
 * every module has been through one. Deferring the splice to `renderChunk`
 * would close that and costs a sentinel string in the chunk, a count that has
 * to be reconciled, and a substitution over minifier-adjacent output -- which
 * is a lot of machinery to buy a case a safelist already answers.
 *
 * What it costs is measured and left alone: **0.4 ms** for a three-module app
 * and **100 ms** for a 238-module, 2.17 MB tree, of which the parse is 76 ms,
 * the walk 9 ms and reading the files 2.5 ms. The parse is the cost and the
 * obvious way to avoid it -- skip a file whose raw text holds no token any
 * utility could match -- is *not* sound, because a literal's cooked value is
 * not its source text and `'\u0070-2'` is `p-2` to the parse and nothing to a
 * substring search. That is a silent drop rather than a silent miss, which is
 * the one direction this analysis does not trade in. The laziness above is the
 * optimization that is free: an app that never calls `utilitySheet()` pays
 * none of it.
 *
 * What it must not read is a *previous build's output*, whose text is evidence
 * for rules the app never names -- the whole sheet when it was built
 * `--no-shake`, a few dozen more when it was shaken. So the caller excludes the
 * configured build directory as well as the one being written -- `bundleApp()`
 * passes its own `out` and the `outputs` both commands hand it -- which is what
 * let `sigil package`, bundling under `node_modules`, read the `dist/` a
 * `sigil build` had left (SIG-354). They are compared by physical path, and the
 * exclusion is the whole of the guard: a build empties its output only once the
 * bundle has read its graph, which is after this walk. Nothing else: a
 * directory excluded here is evidence lost if it holds source, so one that holds
 * no bundle is not worth the risk. A stale bundle nobody configured still gets
 * through, and its failure is the safe one: more is kept than the app names,
 * never less, and the summary's count says so.
 *
 * @param root - The app root.
 * @param options - What to leave out, and what to keep regardless.
 * @returns What the source says.
 */
export function scanClassEvidence(root: string, options: ScanOptions = {}): ClassEvidence {
  const evidence = new Evidence();
  // compared by physical path, because the caller's `out` and this walk's
  // `join()` are two spellings of one directory -- a trailing slash, a `./`,
  // `/tmp` for `/private/tmp`, a symlinked `--out`, `DIST` on a volume that
  // folds case -- and a miss is the one exclusion that really matters, since a
  // previous build's output holds the whole utility sheet and reading it keeps
  // every rule. Measured: built once and then built again with `--out` spelled
  // through `/tmp`, an app kept 52 of 383 rules and then 58, where it keeps 25
  const exclude = new Set((options.exclude ?? []).map((path) => landsAt(path)));

  for (const name of options.safelist ?? []) {
    evidence.safelist(name);
  }

  // every directory the walk enters, by its real path, so a symlink pointing
  // back up the tree is followed once rather than forever. Real paths rather
  // than the paths walked to, because two links to one directory are one
  // directory and a loop is exactly two of those
  const entered = new Set<string>();
  const start = landsAt(resolve(root));

  const visit = (dir: string): void => {
    const real = landsAt(dir);
    // never the root itself: `--out . --no-clean` makes the app root the
    // output directory, and excluding it skips every source file the app has,
    // which keeps too little rather than too much
    if (entered.has(real) || (real !== start && exclude.has(real))) {
      return;
    }
    entered.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // a directory that cannot be read contributes nothing, and refusing to
      // build over one would fail on a permissions problem in a corner of the
      // tree that holds no source
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);

      // a `Dirent` answers `false` to both `isDirectory()` and `isFile()` for
      // a **symlink**, because `readdir` does not follow one -- so a walk that
      // asks only those two skips a linked source file entirely while rolldown
      // follows the link and compiles it. That is evidence missed and
      // therefore a rule dropped, which is the one direction this analysis
      // does not trade in. The `stat` is paid only for a link
      const kind = entry.isSymbolicLink() ? linkKind(path) : entry.isDirectory() ? 'dir' : 'file';

      if (kind === 'dir') {
        // a dot directory is `.git`, `.turbo`, a cache -- never source. An
        // excluded directory is answered by `visit()`, which has its physical
        // path in hand already
        if (!entry.name.startsWith('.') && !SKIPPED.has(entry.name)) {
          visit(path);
        }
        continue;
      }

      if (kind === 'file' && MODULE_RE.test(entry.name)) {
        readFile(path, evidence);
      }
    }
  };

  visit(resolve(root));
  return evidence;
}

/**
 * What a symlink points at, or nothing when it points nowhere.
 *
 * @param path - The link.
 * @returns `dir`, `file`, or `undefined` for a dangling link or anything else.
 */
function linkKind(path: string): 'dir' | 'file' | undefined {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : undefined;
  } catch {
    // a dangling link is not a file, and it is not a build error either: it is
    // something in the tree that nothing can read
    return undefined;
  }
}

/**
 * Reads one file's literals into the evidence.
 *
 * A file that does not parse falls back to a raw token scan of its whole text,
 * every token closed. That is strictly more conservative than the parse -- it
 * reads identifiers and comments as though they were class names -- so a
 * syntax error somewhere in the tree costs bytes rather than correctness. The
 * alternative was to skip such a file, which loses evidence and can drop a rule
 * the app really does name; the one after that was to fail the build, which
 * would refuse an app over a file rolldown never reads.
 *
 * @param path - The file.
 * @param into - Where the evidence goes.
 */
function readFile(path: string, into: Evidence): void {
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch {
    return;
  }

  try {
    collectLiterals(parseModule(path, source).program, into);
  } catch {
    into.read({ openLeft: false, openRight: false, text: source });
  }
}

/**
 * Every constant piece of a string in a tree, with its open ends.
 *
 * A string an app builds is a **sequence of parts**, some known and some not,
 * and the two grammars that build one -- a template literal and a `+` chain --
 * are the same sequence written differently. So both are read the same way: a
 * run of consecutive *known* parts is one chunk, open on an end where an
 * unknown part sits beside it and closed at the ends of the expression itself.
 *
 * That model is what a per-node reading gets wrong, and a review round found
 * five shapes of it, each of which **dropped** a rule the app can match.
 * `` `text-` + colour `` and `` colour + `-red` `` put a *template* where a
 * string literal was expected, so the concatenation saw no known operand and
 * the template was later read on its own as closed. `` c += `-red` `` is the
 * same one again. And `` `${'text-'}${colour}` `` put the literal inside an
 * interpolation, where nothing was looking at all -- the walk found it and read
 * it closed, with no idea it sat next to an unknown.
 *
 * Reading runs rather than parts is also *tighter* where it differs, and
 * correctly so: `'a' + 'b' + c` is `ab` followed by something unknown, so the
 * chunk is the prefix `ab` where a per-operand reading gave a prefix `a` and a
 * both-ends-open `b`. Both are safe; only one of them is the string.
 *
 * ## Known is a string and nothing else
 *
 * `partsOf()` knows a string literal, a template, and a `+` chain or an untagged
 * template of those, spliced in whole, and nothing else -- not a number, though `'p-' + 2` is
 * `p-2` and folding it would be tighter still. Tighter is where a mistake
 * *drops* a rule, so the conversions are left alone: an unknown part simply
 * ends the run and opens its neighbours, which is the safe answer for every
 * operand there is.
 *
 * Two more shapes are known, because each is certain and each only keeps more
 * (SIG-578). A `?:` whose branches are all literals is a **choice**, read as one
 * run per branch. A `||` or `??` whose left side is a literal is that literal,
 * since the right side can never be the value. A literal on the *right* of one
 * is a choice too, between the literal and the unknown left side (SIG-595):
 * `(x || 'text-') + colour` is `text-` followed by something, or something
 * followed by something. Every other shape of the kind -- a `?:` with a branch
 * that is not a literal, `.concat()`, `.join()` -- is an unknown part and the
 * safelist's, and the list an author can read without this file is in
 * `packages/cli/README.md`.
 *
 * ## A tagged template is not a concatenation
 *
 * Its value is whatever the tag returns, so folding an interpolation into the
 * run would be asserting something about a function this has never seen. Its
 * quasis are read as before -- each one a chunk, open where an interpolation
 * sits beside it -- which is both the conservative reading and the one that
 * makes a `ui` template's `class="p-2"` visible. Reading `` ui`p-${x}` `` as a
 * run would turn the prefix `p-` into whatever `x` happens to be.
 *
 * A template with no interpolations has one quasi and no unknown parts, so it
 * is one closed chunk whether it is tagged or not.
 *
 * A quasi is read **cooked**, and reading the raw text beside it was written
 * and deleted. `String.raw` is the one tag whose value is the raw text, and
 * cooked and raw differ only where a backslash is -- so the string such a
 * template produces contains one, and no class name does.
 *
 * @param program - The tree.
 * @param into - Where the evidence goes.
 */
function collectLiterals(program: Node, into: Evidence): void {
  // the quasi of a tagged template, so that the `TemplateLiteral` branch can
  // tell one from an ordinary template. Filled on the way past the tag, which
  // the walk reaches first
  const tagged = new Set<Node>();
  // the `+` chains and untagged templates `partsOf()` has already spliced into
  // a run. The walk still descends into one -- a call in an operand holds
  // literals of its own -- but does not read it as a run again, which is what
  // made a chain of n terms cost n reads of up to n parts each
  const spliced = new Set<Node>();

  walk(program, (node) => {
    if (node.type === 'TaggedTemplateExpression') {
      tagged.add(node.quasi as Node);
      return true;
    }

    if (spliced.has(node)) {
      return true;
    }

    if (node.type === 'BinaryExpression' && node.operator === '+') {
      readRuns(partsOf(node, spliced), into);
      return true;
    }

    // `c += 'text-'` is the same concatenation with the accumulator on the
    // left, so the literal is open on that side. What this does *not* reach
    // is the other half of it -- `let c = 'text-'; c += colour`, where the
    // literal is in a declaration and only a dataflow could say it was ever
    // appended to. That is the documented unsound case rather than a shape to
    // add: this reads where a literal *sits*, and that one sits somewhere
    // that says nothing. The right side is read as the sequence it is, so
    // `c += '-red' + x` and `` c += `-red${x}` `` open on both ends rather than
    // being a closed `-red` after an unknown accumulator
    if (node.type === 'AssignmentExpression' && node.operator === '+=') {
      readRuns([undefined, ...partsOf(node.right as Node, spliced)], into);
      return true;
    }

    if (node.type === 'TemplateLiteral') {
      readRuns(templateParts(node, tagged.has(node), spliced), into);
      return true;
    }

    // everything else a literal can be: an argument, a property value, a
    // `case`, a JSX attribute. It stands alone, so it is closed. A literal
    // that a branch above already read as part of a run is read again here,
    // which changes no answer -- a closed reading matches by equality and the
    // open one it duplicates matches a superset of it
    if (isStringLiteral(node)) {
      into.read({ openLeft: false, openRight: false, text: String(node.value) });
    }

    return true;
  });
}

/**
 * A template's parts, in order: quasi, expression, quasi, and so on.
 *
 * An expression of an untagged template is read through `partsOf()`, so a
 * concatenation or a template inside an interpolation is spliced into the run
 * rather than read as one unknown part.
 *
 * @param node - The template.
 * @param isTagged - Whether a tag decides what it comes to.
 * @param spliced - Collects every node spliced in on the way.
 * @returns One entry per part, `undefined` where the text is not known.
 */
function templateParts(node: Node, isTagged: boolean, spliced: Set<Node>): Part[] {
  const parts: Part[] = [];
  addTemplateParts(node, isTagged, spliced, parts);
  return parts;
}

/** `templateParts()`, appending to a list instead of making one. */
function addTemplateParts(node: Node, isTagged: boolean, spliced: Set<Node>, parts: Part[]): void {
  const template = node as unknown as {
    expressions: Node[];
    quasis: { value: { cooked?: string | null; raw: string } }[];
  };

  for (const [at, quasi] of template.quasis.entries()) {
    parts.push(quasi.value.cooked ?? quasi.value.raw);

    const expression = template.expressions[at];
    if (expression) {
      if (isTagged) {
        parts.push(undefined);
      } else {
        addParts(expression, spliced, parts);
      }
    }
  }
}

/**
 * One part of a string an app builds: the text it is, a choice between two or
 * more texts it is one of, or `undefined` where it is not known at all. A choice
 * may itself hold an `undefined`, which is the one that says "or something this
 * cannot read" -- `x || 'text-'` is `'text-'` or whatever `x` is (SIG-595).
 */
type Part = string | readonly (string | undefined)[] | undefined;

/**
 * The most texts one run may stand for at once.
 *
 * A choice multiplies the run around it -- `(a ? 'x' : 'y') + (b ? 'p' : 'q')`
 * is four strings -- so a chain of n of them is 2^n unless something says
 * stop. Past this, a choice is read as an unknown part with each of its texts
 * read on its own, open on both ends, which keeps every base class the product
 * would have and costs a handful of reads rather than a doubling. It is not a
 * superset for a *variant* assembled across the choice -- `'md' + (w ? ':' : '-')
 * + 'flex-row'` is `md:flex-row` under the cap and not past it -- which is the
 * safelist's, as the same pieces joined by a call always were.
 */
const MAX_RUN_TEXTS = 16;

/**
 * Reads a sequence of parts, joining the runs of known ones.
 *
 * A choice is part of a run like any other known part, and what it does is make
 * the run more than one text: `(dark ? 'text-' : 'bg-') + colour` is the two
 * runs `text-` and `bg-`, each open on the right, and is read as both.
 *
 * @param parts - The parts, `undefined` where the text is not known.
 * @param into - Where the evidence goes.
 */
function readRuns(parts: readonly Part[], into: Evidence): void {
  // the texts the run so far can be, each with what it is open towards: one,
  // until a choice multiplies it. A choice holding an unknown alternative makes
  // a text that is open on the left where the rest are not, which is why the
  // openness belongs to the text rather than to the run
  let states: RunState[] = [{ openLeft: false, text: '', touched: false }];
  // consecutive known text, joined once rather than appended to every text
  let pending: string[] = [];

  const settle = (): void => {
    if (pending.length) {
      const text = pending.join('');
      states = states.map((s) => ({ openLeft: s.openLeft, text: s.text + text, touched: true }));
      pending = [];
    }
  };

  const read = (state: RunState, openRight: boolean): void => {
    if (state.touched) {
      into.read({ openLeft: state.openLeft, openRight, text: state.text });
    }
  };

  // the first run starts at the start of the expression, where there is
  // nothing to be open towards; every one after an unknown is open on the left
  const reset = (): RunState => ({ openLeft: true, text: '', touched: false });

  const flush = (openRight: boolean): void => {
    settle();
    for (const state of states) {
      read(state, openRight);
    }
    states = [reset()];
  };

  for (const part of parts) {
    if (part === undefined) {
      flush(true);
      continue;
    }

    if (typeof part === 'string') {
      pending.push(part);
      continue;
    }

    const known = part.filter((text): text is string => text !== undefined);
    const unknown = known.length < part.length;
    if (states.length * known.length + (unknown ? 1 : 0) > MAX_RUN_TEXTS) {
      flush(true);
      for (const text of known) {
        into.read({ openLeft: true, openRight: true, text });
      }
      continue;
    }

    settle();
    const next = states.flatMap((s) =>
      known.map((text) => ({ openLeft: s.openLeft, text: s.text + text, touched: true }))
    );
    if (unknown) {
      // the alternative nothing is known about ends what was read so far, as an
      // unknown part does, and what follows starts open on the left
      for (const state of states) {
        read(state, true);
      }
      next.push(reset());
    }
    states = next;
  }

  flush(false);
}

/** One text a run can be so far, and what is known of how it is open. */
interface RunState {
  readonly openLeft: boolean;
  readonly text: string;
  /** Whether any known text went into it, so an empty one is not read. */
  readonly touched: boolean;
}

/**
 * The parts an expression is a sequence of, with the nested ones spliced in.
 *
 * A `+` chain is its operands' parts one after another, an untagged template
 * is its quasis and the parts of its interpolations, and a string literal is
 * one known part. Anything else is one unknown part. So a chain or a template
 * **inside** another opens and closes against what surrounds it exactly as it
 * would have if it were written flat: `colour + ('-red' + x)` is
 * `colour + '-red' + x`, and `` `${a}${`-red${x}`}` `` is `` `${a}-red${x}` ``.
 * Read one operand at a time, the inner `-red` was a closed chunk with an
 * unknown sitting beside it, and every rule the string could open at run time
 * was shaken out -- the direction this analysis never errs in.
 *
 * Every operand is read through `unwrapShallow()`, which is the one list of the
 * wrappers that change nothing -- parentheses, `as`, `satisfies`, `<T>x` and
 * `!`. Read straight off the node an operand like `('text-' as string)` is not
 * a literal, the openness is never applied, and the walk later reads the string
 * as a closed token: a **dropped** rule rather than a kept one. A second list
 * here is how `<T>x` came to be missing from it while `literals.ts` had it.
 *
 * A tagged template is a `TaggedTemplateExpression` and so is one unknown
 * part: its value is whatever the tag returns.
 *
 * A `?:` of literals is one part holding every text it can be, and a `||` or
 * `??` over a literal is that literal, for the reason `knownParts()` gives.
 *
 * `+` is read as concatenation whatever its operands are. Where they are
 * numbers it is not, and the parts it yields are unknown ones, which only ever
 * open a neighbour.
 *
 * @param node - The expression, wrappers and all.
 * @param spliced - Collects every `+` and template that was read into, so a walk
 *   that has read the whole of one as a run does not read the nodes inside it
 *   as runs of their own.
 * @returns Its parts, in source order, `undefined` where the text is not known.
 */
function partsOf(node: Node, spliced: Set<Node>): Part[] {
  const parts: Part[] = [];
  addParts(node, spliced, parts);
  return parts;
}

/**
 * `partsOf()`, appending to a list instead of making one, so that a chain of n
 * terms is n pushes rather than a copy of every prefix of it. Every `+` and
 * untagged template it reads into is recorded in `spliced`.
 */
function addParts(node: Node, spliced: Set<Node>, parts: Part[]): void {
  const inner = unwrapShallow(node as Expression);

  if (isStringLiteral(inner)) {
    parts.push(String(inner.value));
    return;
  }

  // a `?:` of literals is a choice between them, and a `||` or `??` over a
  // literal is that literal. Neither is spliced: its operands are not part of
  // the sequence, so the walk reads them as it always has
  const known = knownParts(inner);
  if (known !== undefined) {
    parts.push(known);
    return;
  }

  if (inner.type === 'BinaryExpression') {
    const binary = inner as unknown as { left: Node; operator: string; right: Node };
    if (binary.operator === '+') {
      spliced.add(inner);
      addParts(binary.left, spliced, parts);
      addParts(binary.right, spliced, parts);
      return;
    }
  }

  // a template is a string written the other way, and missing that is what
  // made `` `text-` + colour `` drop every `text-*` rule. A tagged one is a
  // `TaggedTemplateExpression` and never gets here
  if (inner.type === 'TemplateLiteral') {
    spliced.add(inner);
    addTemplateParts(inner, false, spliced, parts);
    return;
  }

  parts.push(undefined);
}

/**
 * The text an expression is when it is one string written out: a string
 * literal, or a template with nothing interpolated.
 *
 * @param node - The expression, wrappers already taken off.
 * @returns The text, or `undefined` when it is anything else.
 */
function literalText(node: Node): string | undefined {
  if (isStringLiteral(node)) {
    return String(node.value);
  }

  if (node.type === 'TemplateLiteral') {
    const template = node as unknown as {
      expressions: Node[];
      quasis: { value: { cooked?: string | null; raw: string } }[];
    };
    const [quasi] = template.quasis;
    if (template.expressions.length === 0 && quasi) {
      return quasi.value.cooked ?? quasi.value.raw;
    }
  }

  return undefined;
}

/**
 * Every text a `?:` can be, when each of its branches is a literal -- or itself
 * a `?:` of them, which is how `a ? 'x' : b ? 'y' : 'z'` is written.
 *
 * @param node - The expression, wrappers already taken off.
 * @returns The texts without repeats, or `undefined` when a branch is not one.
 */
function choiceTexts(node: Node): string[] | undefined {
  const texts = new Set<string>();
  return addChoiceTexts(node, texts) ? [...texts] : undefined;
}

/** `choiceTexts()`, adding to one set rather than copying a tail per level. */
function addChoiceTexts(node: Node, into: Set<string>): boolean {
  const inner = unwrapShallow(node as Expression);
  const text = literalText(inner);
  if (text !== undefined) {
    into.add(text);
    return true;
  }

  return (
    inner.type === 'ConditionalExpression' &&
    addChoiceTexts(inner.consequent, into) &&
    addChoiceTexts(inner.alternate, into)
  );
}

/**
 * The part a `?:`, `||` or `??` is, when what it needs to be one is a literal.
 *
 * `a ? 'x' : 'y'` is a choice between two known texts. `'x' || y` is `'x'`,
 * since a literal that is not empty is always truthy, and `'x' ?? y` is `'x'`
 * whatever it is, since a string is never nullish -- so the right side is never
 * the value and only the left is read. An empty literal on the left of `||` is
 * falsy and the right side *is* the value, which is not known, so it is left
 * alone. The right-hand literal of `y || 'x'` is `'x'` **or whatever `y` is**
 * (SIG-595), so it is a choice with an unknown alternative: the run around it is
 * read once with the literal in it and once ended by an unknown part, and what
 * follows an unknown part is open on the left as it always is.
 *
 * @param node - The expression, wrappers already taken off.
 * @returns The part, or `undefined` when this is not a shape that is read.
 */
function knownParts(node: Node): Part {
  if (node.type === 'ConditionalExpression') {
    const texts = choiceTexts(node);
    return texts?.length === 1 ? texts[0] : texts;
  }

  if (node.type === 'LogicalExpression') {
    const operator = (node as unknown as { operator: string }).operator;
    if (operator === '||' || operator === '??') {
      const alternatives = new Set<string | undefined>();
      addAlternatives(node, alternatives);
      const texts = [...alternatives];
      if (!texts.some((text) => text !== undefined)) {
        return undefined;
      }

      return texts.length === 1 ? texts[0] : texts;
    }
  }

  return undefined;
}

/**
 * Every text an expression can be, with `undefined` among them where it can be
 * something this does not read -- the alternatives `knownParts()` makes a part
 * of for a `||` or a `??`.
 *
 * A literal on the left decides the whole of it where it cannot be skipped, so
 * only it is added; a side that is anything else is the unknown alternative, and
 * a `||` or `??` nested on either side is read the same way, so that
 * `x || 'a' || 'b'` is `a`, `b` or `x`. `&&` is one of the shapes that is not
 * read, and is the unknown alternative here too.
 */
function addAlternatives(node: Node, into: Set<string | undefined>): void {
  const inner = unwrapShallow(node as Expression);

  const text = literalText(inner);
  if (text !== undefined) {
    into.add(text);
    return;
  }

  if (inner.type === 'ConditionalExpression') {
    const texts = choiceTexts(inner);
    if (texts) {
      for (const choice of texts) {
        into.add(choice);
      }
    } else {
      into.add(undefined);
    }
    return;
  }

  if (inner.type === 'LogicalExpression') {
    const logical = inner as unknown as { left: Node; operator: string; right: Node };
    if (logical.operator === '||' || logical.operator === '??') {
      const left = literalText(unwrapShallow(logical.left as Expression));
      if (left !== undefined && (logical.operator === '??' || left !== '')) {
        into.add(left);
      } else if (left === '') {
        // falsy, so the right side is the value and the left never is
        addAlternatives(logical.right, into);
      } else {
        addAlternatives(logical.left, into);
        addAlternatives(logical.right, into);
      }
      return;
    }
  }

  into.add(undefined);
}

/** Whether a node is a string literal, which oxc spells as a `Literal`. */
function isStringLiteral(node: Node): node is Node & { value: string } {
  return node.type === 'Literal' && typeof (node as { value?: unknown }).value === 'string';
}

/** What the utility sheet came to once the evidence had been applied. */
export interface ShakenSheet {
  /** The sheet source, with only the surviving rules in it. */
  readonly css: string;
  /** How many utilities survived. */
  readonly kept: number;
  /** How many there were. */
  readonly total: number;
  /** How many variant-qualified rules the evidence asked for, on top of those. */
  readonly variants: number;
}

/**
 * The utility sheet, with only the rules the evidence allows.
 *
 * Regenerated rather than printed back out of a parsed sheet, which is the
 * decision worth knowing: `generateUtilities()` is what produced the committed
 * sheet, so asking it for a subset gives text that is byte for byte the subset
 * of that sheet, and there is no stylesheet printer anywhere to drift from the
 * parser. A printer would be a second spelling of the grammar, which is the
 * thing this repository writes down over and over as how two halves of one
 * library come to disagree.
 *
 * @param evidence - What the app's source says.
 * @returns The shaken sheet and what it cost.
 */
export function shakeUtilities(evidence: ClassEvidence): ShakenSheet {
  // the base set is the committed sheet's, so what is asked of it is a subset
  // of that sheet; the variants are not in it at all and are added below
  const all = utilities({ variants: false });
  const keep = all.filter((utility) => evidence.mayName(utility.name));

  // the variants are the other half of it, and are asked about by the name the
  // app would write -- `focus:border-green` -- because that is the only thing
  // its source can say. Only the ones named are generated, so the committed
  // sheet keeps its size and an app pays for exactly the variant rules it uses
  // (SIG-526). A variant rule stands on its own: `focus:border-green` is kept
  // without `border-green`, since a token is whole
  const qualified = VARIANT_NAMES.flatMap((variant) =>
    all.map((utility) => `${variant}:${utility.name}`)
  ).filter((name) => evidence.mayName(name));

  return {
    css: generateUtilities({ only: keep.map((utility) => utility.name), variants: qualified }),
    kept: keep.length,
    total: all.length,
    variants: qualified.length,
  };
}

/** What shaking a module's sheets produced. */
export interface ShakenModule {
  /** The rewritten source. */
  readonly code: string;
  /** The source map, as rolldown wants it. */
  readonly map: ReturnType<MagicString['generateMap']>;
  /** How many `utilitySheet()` calls were rewritten. */
  readonly sites: number;
}

/**
 * Rewrites a module's `utilitySheet()` calls to the shaken sheet.
 *
 * The replacement is a memoized function per module rather than one parse per
 * call site, because `utilitySheet()` memoizes and a rewrite that parsed per
 * call would be slower than what it replaced. It is not the same *object*
 * across modules the way the memo is -- two modules that both call it get two
 * sheets -- which nothing can observe: a `Stylesheet` is frozen and a `Cascade`
 * only reads it.
 *
 * A `utilitySheet` reached in any other way -- passed as a value, destructured
 * off a namespace, re-exported through a barrel -- is left alone, and the app
 * then gets the whole sheet there. That is correct output: the shaken sheet is
 * a subset, so the two disagree only about rules the evidence says nothing can
 * match.
 *
 * @param file - The module's path; its extension decides TypeScript.
 * @param source - The module's source.
 * @param shaken - The shaken sheet, asked for only once a call has been found:
 *   importing from `@ttylabs/sigil/style` is ordinary and calling
 *   `utilitySheet()` is not, so most modules that reach here have nothing to
 *   rewrite and must not pay for the scan.
 * @returns The rewritten module, or `undefined` when it calls nothing.
 */
export function shakeStyles(
  file: string,
  source: string,
  shaken: () => ShakenSheet
): ShakenModule | undefined {
  // a module that does not mention the module the export comes from cannot be
  // calling it. This is the function's own fast path rather than the build's,
  // which narrows natively before it ever calls here -- the same split
  // `compileTemplates()` records
  if (!source.includes(STYLE_MODULE)) {
    return undefined;
  }

  const parsed = parseModule(file, source);
  const bindings = importBindings(parsed, STYLE_MODULE, SHEET_EXPORT);

  // a fast path rather than a correctness one, and worth having because it is
  // the common case for this filter: a module that imports `Cascade` or
  // `declare` from the same place reaches here and imports no `utilitySheet`.
  // Without it the walk runs and finds nothing, which is the same answer --
  // `templatesIn()` states its own the same way
  if (!reachable(bindings)) {
    return undefined;
  }

  const calls: CallExpression[] = [];

  walk(parsed.program, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.arguments.length === 0 &&
      bindingName(unwrapShallow(node.callee as Expression), bindings) !== undefined
    ) {
      calls.push(node);
    }
    return true;
  });

  if (!calls.length) {
    return undefined;
  }

  const sheet = shaken();
  const prefix = choosePrefix(source, '$css');
  const read = `${prefix}s`;
  const memo = `${prefix}v`;
  const edited = new MagicString(source);

  for (const call of calls) {
    edited.overwrite(call.start, call.end, `${read}()`);
  }

  // a hoisted function over a `var`, which is what `utilitySheet()` itself is:
  // memoized, so a second call site costs nothing, and lazy, so a module that
  // imports the sheet down a branch it never takes does not parse it. A
  // `const` was the first shape and is wrong in both directions -- it parses
  // at module evaluation whether or not the call is reached, and it sits in a
  // temporal dead zone, so a module reached through an import cycle before its
  // own body has run would throw a `ReferenceError` where `utilitySheet()`
  // answered. `var` and a function declaration hoist, so neither can
  //
  // Both strings go through `quote()`, the one helper for a string printed as
  // source, rather than a bare `JSON.stringify` that leaves a U+2028 in the CSS
  // raw -- which V8 counts as a line break, moving every line number after it
  const head =
    `import { parseStylesheet as ${prefix}p } from ${quote(STYLE_MODULE)};\n` +
    `var ${memo};\n` +
    `function ${read}() { return ${memo} ??= ${prefix}p(${quote(sheet.css)}); }\n`;

  // the head is an `import`, and prepending one can only ever reach a module
  // that already has one: the matcher reads oxc's record of the module's
  // **static imports**, which a CommonJS file cannot have -- a `.cjs` calling
  // `require('@ttylabs/sigil/style')` passes the filter, finds no binding, and
  // is declined before anything is written. A `'use strict'` that stops being
  // the first statement is no loss either, since a module is strict anyway.
  //
  // After a shebang rather than before it, for the reason `compileTemplates()`
  // records: `#!` is only a shebang on the first line
  const shebang = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;

  if (shebang > 0) {
    edited.appendLeft(shebang, head);
  } else {
    edited.prepend(head);
  }

  return {
    code: edited.toString(),
    map: edited.generateMap({ hires: true, includeContent: true, source: file }),
    sites: calls.length,
  };
}

/**
 * What a build needs to shake, worked out once and only when something asks.
 *
 * Lazy because the scan is a walk of the app's source tree and the sheet is a
 * regeneration of 383 rules, and an app that never calls `utilitySheet()` --
 * which is most of them, since it is opt-in -- should pay for neither. The
 * plugin asks on the first module that turns out to hold a call, and there is
 * at most one such first module.
 */
export interface Shaker {
  /** The shaken sheet, computed on the first ask. */
  sheet(): ShakenSheet;
  /** What it came to, or `undefined` if nothing ever asked. */
  result(): ShakenSheet | undefined;
}

/**
 * Builds the shaker for one app.
 *
 * @param root - The app root.
 * @param options - What to leave out of the scan, and what to keep regardless.
 * @returns The shaker.
 */
export function createShaker(root: string, options: ScanOptions = {}): Shaker {
  let computed: ShakenSheet | undefined;

  return {
    result: () => computed,
    sheet: () => {
      computed ??= shakeUtilities(scanClassEvidence(root, options));
      return computed;
    },
  };
}
