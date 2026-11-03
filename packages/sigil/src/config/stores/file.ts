import { __ } from '../../i18n/index.js';
import { expand } from '../../paths.js';
import { DEFAULT_STEP, editJsonc } from '../jsonc-write.js';
import { parseJsonc } from '../jsonc.js';
import { jsonCanHold } from '../represent.js';
import type { ConfigDocument, WritableConfigStore, WriteOptions } from '../types.js';
import { claim, readText, readTextSync, type RenderText, rewrite, rewriteSync } from './text.js';

/**
 * A store over a JSON file, read as JSONC whatever it is called.
 *
 * `read()` and `readSync()` are two real implementations over one shared parse
 * rather than one wrapping the other, which is what the interface asks for and
 * is why there is no optionality anywhere in it:
 *
 * ```ts
 * async read() { return parse(await readFile(path, 'utf8')); }
 * readSync()   { return parse(readFileSync(path, 'utf8')); }
 * ```
 *
 * That is the shape rather than the lines: each half really does its own I/O
 * call and both go through one `parse()`, and what `readText()` and
 * `readTextSync()` add around it is the `ENOENT` reading -- which is the same
 * reading twice because a `catch` cannot be shared between an `await` and a
 * synchronous call. Those two, the claim and the write are the store kit's text
 * half, in `./text.ts`, which the XML and YAML stores read as well.
 *
 * The path is expanded through `paths.expand()` rather than taken literally. A
 * `~` is the single most likely thing an app writes by hand, and `readFileSync`
 * of one is an `ENOENT` naming a path with a `~` still in it -- which reads as
 * "the file is missing" rather than "the `~` was not expanded". One
 * implementation of that rule, which is the one `paths.ts` already holds; on
 * Windows it expands `%VAR%` too, for the same reason.
 *
 * @param path - The file.
 * @returns The store.
 */
function fileStore(path: string): WritableConfigStore {
  // refused here rather than at the read, because what the read says about it
  // names the wrong thing: `expand('')` is `'.'`, so an empty path reported
  // `Failed to read .: EISDIR` -- a message about a directory nobody named --
  // and a path that is not a string threw out of `expand()` itself. Not
  // translated: a store's path is the app's own
  if (typeof path !== 'string' || !path) {
    throw new Error('A config file store needs a path');
  }

  const source = expand(path);

  const parse = (text: string | undefined): ConfigDocument => {
    // a file that is there and holds nothing but whitespace is a file somebody
    // created and has not written yet, which is the same state as one that is
    // not there -- `JSON.parse('')` is a syntax error, and reporting one over
    // `touch config.json` would be refusing to start over an empty file
    if (text === undefined || !text.trim()) {
      return { value: {} };
    }

    const { value } = parseJsonc(text, source);

    // a document's root has to be something a layer can merge, which is an
    // object. A file holding `42` or `[1, 2]` is not a config, and merging it
    // would make every key of every layer below it vanish -- so it is refused
    // where it was read rather than discovered as a missing setting later
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(__`${source} must hold an object`);
    }

    // `wouldLose` is **absent** even over a comment-rich file -- the field is
    // optional, so nothing lost is no field rather than `[]`, which is what
    // `layer.wouldLose?.length` is the way to read. That is the contract rather
    // than an omission: this store edits spans rather than reprinting, so a
    // comment survives a write because the bytes holding it are never rewritten.
    // A store that reprints -- YAML, XML -- reports what it would drop, and the
    // field is published for those
    return { value };
  };

  /**
   * The text the file should hold, given what it holds now.
   *
   * The edit is computed before anything is written, which is what makes a
   * refusal cost nothing: a value JSON cannot hold, or a source that will not
   * parse, throws with the file untouched.
   */
  const render: RenderText = (now, value, paths) => {
    // nothing to edit against, so there is nothing to preserve: a file that is
    // not there, or one somebody created and has not written yet, is serialized
    // from scratch with a final newline, which is what every other tool leaves
    // behind and what a POSIX text file is. A claimed set of paths over no file
    // is those paths and nothing else, which falls out of overlaying onto an
    // empty document rather than needing a case of its own
    const fresh = now === undefined || !now.trim();
    const held = claim(
      fresh ? {} : (parse(now as string).value as Record<string, unknown>),
      value,
      paths,
      source
    );

    // asked here as well as at `set()`, because this is public API and a
    // `write()` a caller made directly has had nothing checked. `set()`'s own
    // call is the *early* answer -- it names the one value and the one path at
    // the moment they were written -- and this one answers for the document.
    // Asked of the **merged** document rather than of `value`, or a part of
    // `value` this write is not claiming would refuse a write that never
    // touches it
    const ok = jsonCanHold(held, '');
    if (ok !== true) {
      throw new Error(`Cannot write ${source}: ${ok}`);
    }

    if (fresh) {
      return `${JSON.stringify(held, null, DEFAULT_STEP)}\n`;
    }

    return editJsonc(now as string, held, { what: source });
  };

  return {
    canRepresent(value: unknown, at: string): true | string {
      return jsonCanHold(value, at);
    },
    format: 'jsonc',
    async read(): Promise<ConfigDocument> {
      return parse(await readText(source));
    },
    readSync(): ConfigDocument {
      return parse(readTextSync(source));
    },
    source,
    async write(value: unknown, opts?: WriteOptions): Promise<void> {
      await rewrite(source, render, value, opts);
    },
    writeSync(value: unknown, opts?: WriteOptions): void {
      rewriteSync(source, render, value, opts);
    },
  };
}

/**
 * A JSON config file, read as JSONC whatever it is called.
 *
 * Comments and trailing commas are accepted in a `.json` as readily as in a
 * `.jsonc`, which is **one** reader rather than one per extension. The argument
 * for two was that an extension should mean what it says, and the counterexample
 * is the one this file already cited for the other direction: `tsconfig.json` is
 * JSONC under a `.json` name, and so are VS Code's own settings. An extension is
 * not a declaration about the bytes -- it is a file name, and a config file is
 * the file people most want to annotate. So a comment in a `.json` is read
 * rather than reported, and nobody has to rename a file to write one.
 *
 * What that gives up is the `Comments are not allowed in ...` message, which
 * named the line where `JSON.parse`'s `Unexpected token /` does not. It bought
 * strictness nobody asked for: this store never *writes* a comment, so reading
 * one strictly could only refuse a file every other tool in the ecosystem
 * accepts. An app that needs a file to stay strict JSON has a tool that says so
 * -- its own validator, or whatever consumes it -- and that tool is not this.
 *
 * It writes by **editing spans** rather than reprinting, so a comment, a
 * trailing comma, the user's indentation, their key order, their line endings
 * and a missing final newline all survive a `set()` -- not because each is
 * handled but because the bytes holding them are never rewritten.
 *
 * @param path - The file.
 * @returns The store.
 */
export function json(path: string): WritableConfigStore {
  return fileStore(path);
}
