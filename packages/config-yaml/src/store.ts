import { lossesOf } from './fidelity.js';
import { PARSE_OPTIONS } from './options.js';
import { assertReadable, rootOf, type ReadShape } from './read.js';
import { yamlCanHold } from './represent.js';
import { candidates, reshape, shapeOf, type Shape } from './shape.js';
import { applyInto } from './write.js';
import {
  isMissing,
  isPlainObject,
  overlay,
  writeAtomic,
  writeAtomicSync,
  type ConfigDocument,
  type WritableConfigStore,
  type WriteOptions,
} from '@ttylabs/sigil/config';
import { __ } from '@ttylabs/sigil/i18n';
import { expand } from '@ttylabs/sigil/paths';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Document, LineCounter, parseDocument, type ToStringOptions } from 'yaml';

/** What `yaml()` takes besides the path. */
export interface YamlStoreOptions {
  /**
   * What to call this store's format in a diagnostic.
   *
   * `'yaml'` when omitted. The one reason to pass it is that `.yml` and `.yaml`
   * are **one store** -- which is the decision this option exists to make
   * visible rather than to work around: two registrations would be two stores
   * to keep in agreement about a schema version, a residual table and three
   * write refusals, for two spellings of one format. So the extension is not
   * read at all and the store is the same either way; an app that wants its
   * `.yml` layer to say `yml` in a message says so here.
   */
  format?: string;
}

/** A parsed document, with the bytes' own shape and the options that render it. */
interface Parsed {
  /** The document. */
  doc: Document;
  /** What a write would lose, if anything. */
  losses: readonly import('@ttylabs/sigil/config').Loss[] | undefined;
  /** The shape to put back. */
  shape: Shape;
  /** The options that render this document's own layout. */
  style: ToStringOptions;
}

/**
 * A YAML config file.
 *
 * ## It reads YAML 1.2's core schema, pinned
 *
 * Which is the one place a YAML store can silently disagree with the rest of the
 * library: YAML 1.1 reads `yes`, `no`, `on` and `off` as booleans, `017` as
 * **15** and `12:30` as **750**, where 1.2's core schema reads all five as
 * strings or as the decimal number they look like. `options.ts` has the measured
 * table and the argument for pinning rather than taking the parser's default.
 *
 * Merge keys are enabled on top of that schema, because without them a `<<`
 * reads as a literal key spelled `<<` -- a file that reads wrong rather than one
 * that errors.
 *
 * ## It writes by editing the document
 *
 * `write()` re-reads the file, parses it, diffs the target value against what
 * the document says, and calls `setIn()` or `deleteIn()` for each path that
 * differs. So a comment, an anchor, an alias, a merge key, a block scalar, a
 * quoting style and the file's own indentation all survive a `set()` -- not
 * because each is handled but because nothing rewrote the lines holding them.
 *
 * What it cannot carry it reports as `wouldLose`, per **document** rather than
 * per format: twenty-four of the thirty-five documents in `test/corpus.test.ts`
 * round-trip byte for byte, and `fidelity.ts` has the residual. Those counts are
 * asserted there rather than written down, because a figure nobody can
 * re-derive is one that goes stale -- this one read "nineteen of twenty-seven"
 * until that file existed.
 *
 * ## Scalars arrive already typed, which is the inverse of the XML store
 *
 * YAML's core schema resolves `8080` to a number and `true` to a boolean, so
 * this store hands back typed values and `Config` validates them through
 * `checkValue()` -- where `@ttylabs/config-xml` has nothing
 * but strings and goes through `transformValue()`. Which is why the two
 * additions in the runtime are not redundant: each sibling exercises one.
 *
 * Neither is the store's own call. `Config` coerces every layer whatever
 * produced it, so this store calls neither function: the saving is that it does
 * not have to ask.
 *
 * @param path - The file.
 * @param opts - What to call the format in a diagnostic.
 * @returns The store.
 */
export function yaml(path: string, opts: YamlStoreOptions = {}): WritableConfigStore {
  // refused here rather than at the read, which is `json()`'s own reason:
  // `expand('')` is `'.'`, so an empty path reported a failure to read a
  // directory nobody named, and a path that is not a string threw out of
  // `expand()` itself. Not translated -- a store's path is the app's own
  if (typeof path !== 'string' || !path) {
    throw new Error('A config YAML store needs a path');
  }

  // and the options themselves, which defaulted only for `undefined` while
  // `opts.format` was read at once. Measured, `yaml(p, null)` threw
  // `Cannot read properties of null (reading 'format')` -- a raw TypeError
  // where the format check already has a message -- and `yaml(p, 'yml')`,
  // `yaml(p, ['yml'])` and `yaml(p, false)` each **succeeded** with the format
  // left at `'yaml'`, so an untyped caller could pass the format name as the
  // second argument and have it silently ignored. Parses and does nothing
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error('A config YAML store needs its options as an object');
  }

  const format = opts.format ?? 'yaml';
  if (typeof format !== 'string' || !format) {
    throw new Error('A config YAML store needs a non-empty format name');
  }

  const source = expand(path);

  /** What the file holds, or nothing where it is not there. */
  const text = async (): Promise<string | undefined> => {
    try {
      return await readFile(source, 'utf8');
    } catch (e: unknown) {
      if (!isMissing(e)) {
        throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
      }
      return undefined;
    }
  };

  /** The same, without awaiting. */
  const textSync = (): string | undefined => {
    try {
      return readFileSync(source, 'utf8');
    } catch (e: unknown) {
      if (!isMissing(e)) {
        throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
      }
      return undefined;
    }
  };

  /**
   * Parses a document, refusing one that would read as something other than
   * what it says, and settling the layout and the residual in one pass.
   *
   * The candidates are tried until one reproduces the source exactly: that one
   * is both the answer to "is anything lost" -- nothing -- and the options a
   * real write renders with. Where none does, the best of them is still the
   * layout to write in and what differs is the residual to report, which is why
   * the loop keeps the closest rather than giving up.
   */
  const parse = (raw: string, read: ReadShape): Parsed => {
    const { body, shape } = shapeOf(raw);
    const doc = parseDocument(body, { ...PARSE_OPTIONS, lineCounter: read.lines });

    assertReadable(doc, read);

    let best:
      | {
          losses: readonly import('@ttylabs/sigil/config').Loss[] | undefined;
          style: ToStringOptions;
        }
      | undefined;

    for (const style of candidates(body)) {
      const losses = lossesOf(raw, reshape(doc.toString(style), shape));
      if (!losses) {
        return { doc, losses: undefined, shape, style };
      }
      // the fewest kinds of difference, which is the closest layout available
      // -- and a **declared sabotage survivor**: `best ??= { losses, style }`
      // keeps the same candidate on every input tried, because the detected one
      // is first and is minimal wherever the detection is right about the
      // indent, which is every document measured. Measured over the four-space
      // sequence, a multi-line flow, a block scalar indented past the step and
      // a document with mixed indentation: every candidate ties, or the
      // detected one has the fewest.
      //
      // Kept because "the closest layout" is the rule and "the detected one" is
      // correct only by the detection being right -- which is the shape
      // `union()`'s own early return is kept on in the runtime. What makes it
      // unreachable is also what makes it cheap: nothing is lost where a
      // candidate is exact, and the loop returns there
      if (!best || losses.length < best.losses!.length) {
        best = { losses, style };
      }
    }

    return { doc, losses: best?.losses, shape, style: best?.style ?? {} };
  };

  /**
   * A document's value, and what a write of it would lose.
   *
   * A file that is **not there** and one holding nothing but whitespace are the
   * same answer -- an empty document -- which is the house rule `json()` keeps:
   * an absent config is the ordinary state of one, and refusing to start over
   * `touch config.yaml` is the wrong answer. YAML needs saying because it does
   * not fall out: `parseDocument('')` is a document whose value is `null`, and
   * a comment-only file is the same, so both would be refused by the
   * must-hold-an-object check below rather than read as empty.
   */
  const document = (raw: string | undefined): ConfigDocument => {
    if (raw === undefined || !raw.trim()) {
      return { value: {} };
    }

    const read: ReadShape = { lines: new LineCounter(), what: source };
    const { doc, losses } = parse(raw, read);

    // the null root and the must-hold-a-map refusal are `rootOf()`'s, which is
    // the one reader `render()` shares -- the two used to be written here only
    const value = rootOf(doc, read);

    return losses ? { value, wouldLose: losses } : { value };
  };

  /**
   * What the file should hold: whatever it holds now, with the claimed paths of
   * `value` written over it.
   *
   * `json()`'s own `claim()`, for `json()`'s own reason: a write with no claim
   * is total, which is the only thing `write(value)` can mean on its own, and a
   * write **with** one is the three-way merge `save()` exists to perform. The
   * read it staged against may be stale by the time this runs, so the paths are
   * applied to what is there now and every other key is left alone -- without
   * which a key another process changed in that window is reverted.
   *
   * `overlay()` is core's rather than this package's, which is one of the five
   * reasons the store kit is published: the null exemption, the non-object
   * refusal and the claimed-delete no-op are each a review finding, and a
   * second copy would inherit none of them.
   */
  const claim = (
    theirs: Record<string, unknown>,
    value: unknown,
    paths: readonly string[] | undefined
  ): unknown => {
    if (paths === undefined) {
      return value;
    }

    overlay(theirs, value, paths, source);
    return theirs;
  };

  /**
   * The text the file should hold, given what it holds now.
   *
   * Computed before anything is written, which is what makes a refusal cost
   * nothing: a value YAML cannot hold, a source that will not parse, or a path
   * that would touch an anchor all throw with the file untouched.
   */
  const render = (
    now: string | undefined,
    value: unknown,
    paths: readonly string[] | undefined
  ): string => {
    const read: ReadShape = { lines: new LineCounter(), what: source };
    const blank = now === undefined || !now.trim();
    const { doc, shape, style } = blank
      ? {
          doc: new Document({}, PARSE_OPTIONS),
          shape: { bom: false, crlf: false, trailing: '\n' },
          style: { lineWidth: 0 } as ToStringOptions,
        }
      : parse(now as string, read);

    // read **twice**, deliberately, and each read is a different question.
    // `claim()` mutates what it is handed, so the copy it overlays onto cannot
    // also be the `current` the diff compares against -- that one has to be
    // what the document still says. One read used for both would make every
    // claimed path look unchanged and the write a no-op
    const held = claim(blank ? {} : rootOf(doc, read), value, paths);
    const current = blank ? {} : rootOf(doc, read);

    // asked here as well as at `set()`, because this is public API and a
    // `write()` a caller made directly has had nothing checked. `set()`'s own
    // call is the *early* answer -- it names the one value and the one path at
    // the moment they were written -- and this one answers for the merged
    // document, or a part of `value` this write is not claiming would refuse a
    // write that never touches it
    const ok = yamlCanHold(held, '');
    if (ok !== true) {
      throw new Error(`Cannot write ${source}: ${ok}`);
    }

    if (!isPlainObject(held)) {
      throw new Error(__`${source} must hold an object`);
    }

    applyInto(doc, current, held, read);

    return reshape(doc.toString(style), shape);
  };

  return {
    canRepresent(value: unknown, at: string): true | string {
      return yamlCanHold(value, at);
    },
    format,
    async read(): Promise<ConfigDocument> {
      return document(await text());
    },
    readSync(): ConfigDocument {
      return document(textSync());
    },
    source,
    async write(value: unknown, opts?: WriteOptions): Promise<void> {
      // the current bytes, read here rather than kept from the last `read()`.
      // `json()` records why at length, and the short of it is that a cache
      // overwrites blindly: reading here is what makes this **the** read the
      // merge is against, so the read and the merge cannot come apart, and it
      // is what makes a `write()` reached directly work standalone
      const now = await text();
      const next = render(now, value, opts?.paths);

      // a write that changes nothing touches no file, which keeps the mtime a
      // watcher reads and makes `apply()` of a freshly read value a no-op
      // rather than a rewrite of the same bytes
      if (next !== now) {
        await writeAtomic(source, next);
      }
    },
    writeSync(value: unknown, opts?: WriteOptions): void {
      const now = textSync();
      const next = render(now, value, opts?.paths);

      if (next !== now) {
        writeAtomicSync(source, next);
      }
    },
  };
}
