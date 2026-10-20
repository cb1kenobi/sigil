import { lossesOf } from './fidelity.js';
import { readDocument, type ReadShape } from './read.js';
import { nameable, xmlCanHold } from './represent.js';
import { FRESH, reshape, type Shape, shapeOf } from './shape.js';
import { applyInto, writeShape, type XmlEl } from './write.js';
import {
  isMissing,
  isPlainObject,
  overlay,
  segments,
  writeAtomic,
  writeAtomicSync,
  type ConfigDocument,
  type ConfigSchema,
  type WritableConfigStore,
  type WriteOptions,
} from '@ttylabs/sigil/config';
import { __ } from '@ttylabs/sigil/i18n';
import { expand } from '@ttylabs/sigil/paths';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** Enough of a DOM document for this store: a root, and something to serialize. */
interface XmlDocument {
  readonly documentElement: XmlEl;
}

/**
 * What `xml()` takes besides the path.
 *
 * Both are **constructor options** rather than anything on `ConfigStore`, which
 * is what keeps the claim that this package needs no change to that interface
 * true: they are app wiring, and the published surface is unchanged.
 */
export interface XmlStoreOptions {
  /**
   * The root element a file written from nothing gets.
   *
   * `config` when omitted. Only a *write* needs one -- a missing or blank file
   * reads as an empty document, which needs no root at all -- and it is the one
   * decision a from-scratch JSON file does not have to make, because `{}` is a
   * whole document and there is no XML equivalent.
   */
  root?: string;
  /**
   * The app's config schema, read for one field.
   *
   * Only `multiple` is read, and leaving it out costs an app that declares one
   * its **startup**: an XML list with a single occurrence is a scalar, so a
   * `multiple: true` setting meets `'a'` where it wants `['a']` and
   * `coerceSetting()` throws on the first load. The same document in JSON
   * throws identically, so core is right and this is the format leaking through
   * a store whose job is to hide it.
   *
   * It is the **same object** an app passes to `createConfig()`, so there is
   * one schema with two readers rather than an XML-shaped restatement of it --
   * and this one reads one field, which is why it is a `ConfigSchema` rather
   * than a list of paths.
   */
  schema?: ConfigSchema;
}

/** The dotted paths a schema declared `multiple`. */
function multiplePaths(schema: ConfigSchema | undefined): ReadonlySet<string> {
  const out = new Set<string>();

  for (const [path, setting] of Object.entries(schema ?? {})) {
    if (!setting || typeof setting !== 'object' || !setting.multiple) {
      continue;
    }
    // through `segments()` rather than trusted, which is the prototype guard
    // asked where a path enters: a schema is the app's own, and the app's own
    // is where `readSchema()` asks it too. A path this refuses is one
    // `createConfig()` is about to refuse with a better message, so it is
    // skipped rather than thrown over -- the store is not the right place to
    // report a schema somebody got wrong
    try {
      segments(path);
    } catch {
      continue;
    }
    out.add(path);
  }

  return out;
}

/**
 * An XML config file.
 *
 * ## Attributes and child elements share one path space
 *
 * ```xml
 * <config mode="dev">
 *   <server port="8080">
 *     <host>example.com</host>
 *   </server>
 * </config>
 * ```
 *
 * ```
 * mode        -> 'dev'
 * server.port -> '8080'
 * server.host -> 'example.com'
 * ```
 *
 * `read.ts` has the argument, and it is the whole of why this package exists in
 * the shape it does: a sentinel key would put one setting at two paths
 * depending on the *format* of the layer it came from, which breaks the one
 * thing a layered config provides.
 *
 * ## It writes through the DOM
 *
 * `write()` re-reads the file, parses it, diffs the target value against what
 * the document says, and touches only what differs. So a comment, the XML
 * declaration, a DOCTYPE, a CDATA section, attribute order and the user's
 * indentation all survive a `set()` -- measured, and the acceptance test is the
 * JSON store's own one format along: a comment-rich document with one key set,
 * every other byte identical.
 *
 * What it cannot carry it reports as `wouldLose`, per **document** rather than
 * per format, which is what makes a write to a file with no trivia in it
 * lossless rather than refused.
 *
 * ## Everything is a string, which is a saving rather than a cost
 *
 * XML has no scalar kind, so every value arrives as text -- exactly what
 * `transformValue()` already coerces, and exactly how an environment variable
 * already reaches an option. So this store calls no `checkValue()` of its own.
 * What that does **not** mean is that XML values skip the schema: `Config`
 * coerces every layer whatever produced it, so `'8080'` on an `int` setting is
 * the number every reader after the coercion sees. The saving is that the store
 * does not have to ask.
 *
 * @param path - The file.
 * @param opts - The root element to write from scratch, and the app's schema.
 * @returns The store.
 */
export function xml(path: string, opts: XmlStoreOptions = {}): WritableConfigStore {
  // refused here rather than at the read, which is `json()`'s own reason:
  // `expand('')` is `'.'`, so an empty path reported a failure to read a
  // directory nobody named, and a path that is not a string threw out of
  // `expand()` itself. Not translated -- a store's path is the app's own
  if (typeof path !== 'string' || !path) {
    throw new Error('A config XML store needs a path');
  }

  const root = opts.root ?? 'config';
  // through `nameable()` rather than a pattern of its own, which is one reader
  // of what an element may be called: a hand-written pattern accepted `xmlns`,
  // and a `root` of that writes a document that will not parse -- the DOM
  // refuses it as `NAMESPACE_ERR` and the store then reports its own output as
  // unparseable. Found by review round 1
  if (typeof root !== 'string' || !nameable(root)) {
    throw new Error(`"${String(root)}" is not a usable XML root element name`);
  }

  const source = expand(path);
  const read: ReadShape = { multiple: multiplePaths(opts.schema), what: source };
  const serializer = new XMLSerializer();

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
   * Parses a document, refusing one the parser had something to say about.
   *
   * `onError` is consulted rather than ignored, and the `error` level is what
   * makes a BOM-prefixed file work at all: measured, `U+FEFF <a/>` *parses* and
   * reports "Unexpected content outside root element", with the mark surviving
   * into the output as a text node outside the root. `shapeOf()` takes the mark
   * off before this is reached, so what is left reporting an error is content
   * outside the root that somebody really wrote -- which has no config path and
   * would be silently kept or silently dropped either way.
   */
  const parse = (xmlText: string): XmlDocument => {
    const errors: string[] = [];
    const onError = (level: string, message: unknown): void => {
      if (level === 'error' || level === 'fatalError') {
        errors.push(String(message).split('\n')[0] as string);
      }
    };

    // the parse is bracketed as well as handled, because `@xmldom/xmldom`
    // reports a `fatalError` through `onError` **and then throws** -- measured
    // over ten malformed documents, of which seven do both and three only
    // report. So without the bracket a `ParseError` escapes with its own
    // message, which names neither the file nor anything a user can act on:
    // `Opening and ending tag mismatch: "a" != "config"` is the whole of what
    // reached a caller, untranslated, with the path nowhere in it
    let doc: { documentElement?: XmlEl | null };
    try {
      doc = new DOMParser({ onError }).parseFromString(xmlText, 'text/xml') as unknown as {
        documentElement?: XmlEl | null;
      };
    } catch (e: unknown) {
      // the collected message in preference to the thrown one: they are the
      // same sentence, and a parser that reported before it threw has already
      // said the thing closest to the first offending byte
      throw new Error(
        __`Failed to parse ${source}: ${errors[0] ?? ((e as Error).message.split('\n')[0] as string)}`
      );
    }

    if (errors.length > 0) {
      throw new Error(__`Failed to parse ${source}: ${errors[0] as string}`);
    }

    // a document with no root is only reachable where the parser neither threw
    // nor reported, which it does not today -- `missing root element` is a
    // `fatalError`. Kept as a tripwire rather than deleted, because what it
    // stands against is a `documentElement` of `null` reaching the mapping,
    // where every read of it would be a `TypeError` three frames in
    if (!doc.documentElement) {
      throw new Error(__`Failed to parse ${source}: it has no root element`);
    }

    // the **document** rather than its root element, which is what carries the
    // declaration, a DOCTYPE and any comment or processing instruction outside
    // the root. Serializing the root element alone silently drops all four --
    // so the acceptance test, a comment-rich file with one key set, came back
    // without its declaration or its leading comment and the fidelity check
    // then reported a loss the store had caused itself
    return doc as unknown as XmlDocument;
  };

  /**
   * A document's value, and what a write of it would lose.
   *
   * A file that is **not there** and one holding nothing but whitespace are the
   * same answer -- an empty document -- which is the house rule `json()`
   * already keeps: an absent config is the ordinary state of one, and refusing
   * to start over `touch config.xml` is the wrong answer. XML needs saying
   * because it does not fall out: measured, both an empty string and a
   * whitespace-only one throw `missing root element`, where `JSON.parse('')` is
   * the only thing in the JSON store's way.
   */
  const document = (raw: string | undefined): ConfigDocument => {
    if (raw === undefined || !raw.trim()) {
      return { value: {} };
    }

    const { shape, xml: body } = shapeOf(raw);
    const doc = parse(body);
    const value = readDocument(doc.documentElement, read);

    // asked by round-tripping the source against itself, **after** the shape is
    // put back: a check on the raw serialize reports every CRLF document as
    // lossy, which is a guard firing on correct code and is the contradiction a
    // review round found between the residual table and the reapply
    const losses = lossesOf(raw, reshape(serializer.serializeToString(doc as never), shape));

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

  /** A document and the shape its bytes carry. */
  const parseShaped = (raw: string): { doc: XmlDocument; shape: Shape } => {
    const { shape, xml: body } = shapeOf(raw);
    return { doc: parse(body), shape };
  };

  /** A document with nothing in it but a declaration and the root. */
  const fresh = (): { doc: XmlDocument; shape: Shape } => ({
    // the declaration is what makes a from-scratch file unambiguous about its
    // encoding, which is what every XML tool writes and every editor expects
    doc: parse(`<?xml version="1.0" encoding="UTF-8"?>\n<${root}/>`),
    shape: FRESH,
  });

  /**
   * The text the file should hold, given what it holds now.
   *
   * Computed before anything is written, which is what makes a refusal cost
   * nothing: a value XML cannot hold, or a source that will not parse, throws
   * with the file untouched.
   */
  const render = (
    now: string | undefined,
    value: unknown,
    paths: readonly string[] | undefined
  ): string => {
    const blank = now === undefined || !now.trim();
    const { doc, shape } = blank ? fresh() : parseShaped(now as string);
    const el = doc.documentElement;

    // read **twice**, deliberately, and each read is a different question.
    // `claim()` mutates what it is handed, so the copy it overlays onto cannot
    // also be the `current` the diff compares against -- that one has to be
    // what the DOM still says. One read used for both would make every claimed
    // path look unchanged and the write a no-op
    const held = claim(blank ? {} : readDocument(el, read), value, paths);
    const current = blank ? {} : readDocument(el, read);

    // asked here as well as at `set()`, because this is public API and a
    // `write()` a caller made directly has had nothing checked. `set()`'s own
    // call is the *early* answer -- it names the one value and the one path at
    // the moment they were written -- and this one answers for the merged
    // document, or a part of `value` this write is not claiming would refuse a
    // write that never touches it
    const ok = xmlCanHold(held, '', read.multiple);
    if (ok !== true) {
      throw new Error(`Cannot write ${source}: ${ok}`);
    }

    // and the document's root has to be something a layer can merge, which is
    // what `readDocument()` already refuses on the way in. Without it
    // `write('x')` or `write([1, 2])` reached `applyInto()` as a scalar root
    // and wrote `<config>x</config>` or `<config>1,2</config>` -- the second
    // being the `String(array)` corruption, at the one path the walk's own
    // list check skips because the root is where a document may legitimately
    // be `{}`
    if (!isPlainObject(held)) {
      throw new Error(__`${source} must hold an object`);
    }

    applyInto(el, current, held, '', writeShape(el, read, blank));

    return reshape(serializer.serializeToString(doc as never), shape);
  };

  return {
    canRepresent(value: unknown, at: string): true | string {
      return xmlCanHold(value, at, read.multiple);
    },
    format: 'xml',
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

      // a write that changes nothing touches no file, which is not tidiness:
      // **no event fires at all**, so a watcher is not woken to read back a
      // document it would have found identical anyway -- and it is what makes
      // `apply()` of a freshly read value a no-op rather than a rewrite of the
      // same bytes. Said as "it keeps the mtime, which is what the watcher
      // reads" for a while, which names a mechanism `fs.watch` does not have:
      // only `watchFile` under `poll` reads one. Found by review
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
