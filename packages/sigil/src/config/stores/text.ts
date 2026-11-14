import { __ } from '../../i18n/index.js';
import { isMissing, writeAtomic, writeAtomicSync } from '../atomic.js';
import { overlay } from '../merge.js';
import type { WriteOptions } from '../types.js';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * The text half of a file store: reading what a file holds, the claim a write
 * makes over it, and writing it back only where it changed.
 *
 * `json()`, `@ttylabs/config-xml` and `@ttylabs/config-yaml` each wrote all five
 * of these out, byte for byte, around a parse and a render that really are
 * theirs. They are the store kit's other half: `isMissing()`, `overlay()` and
 * `writeAtomic()` are what each line here is made of, and a store that wrote
 * them out again would be a fourth copy of the same three decisions -- which
 * error is absence, which keys a claimed write may touch, and that a write
 * which changes nothing touches no file.
 */

/**
 * The one decoder every config file is read through.
 *
 * `fatal`, because the `'utf8'` a `readFile()` takes is the lossy one: it reads
 * every invalid sequence as U+FFFD, and a store splices its edits into what it
 * decoded and writes the whole text back -- so `set()` of one unrelated key
 * rewrote a Latin-1 `é` in a comment as `ef bf bd`, permanently, in a file the
 * span writer exists to leave alone. A file that is not UTF-8 is refused at the
 * read instead, which is before anything can be written over it.
 *
 * `ignoreBOM`, because without it a `TextDecoder` **strips** a leading UTF-8
 * BOM, where `readFile(source, 'utf8')` kept it as U+FEFF -- and every store
 * writes back text made from what it decoded, so dropping it here would make
 * every save of a BOM-prefixed file remove it.
 *
 * One instance is enough: a call without `stream` is a whole decode, and a
 * fatal one that throws leaves nothing behind for the next.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Where the first byte that cannot begin or continue a UTF-8 sequence is.
 *
 * Only asked once the decoder has refused, so that the message can point at
 * the byte -- a `TextDecoder` says the data was invalid and not where. The
 * ranges are the well-formed table in the Unicode standard, which is the one
 * the WHATWG decoder implements, so the two agree about which bytes are valid:
 * an overlong form, a surrogate and anything past U+10FFFF are all ill-formed,
 * and so is a sequence cut short by the end of the file. The offset is where
 * the first ill-formed sequence **starts**, which is its lead byte.
 *
 * @param bytes - What the file holds.
 * @returns The offset, or `-1` where every sequence is valid.
 */
export function invalidUtf8At(bytes: Uint8Array): number {
  let i = 0;

  while (i < bytes.length) {
    const lead = bytes[i] as number;
    if (lead < 0x80) {
      i += 1;
      continue;
    }

    // how many continuation bytes the lead asks for, and the range the first
    // of them has to fall in -- the only one that is ever narrower than 80..bf
    let need: number;
    let low = 0x80;
    let high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      need = 1;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      low = lead === 0xe0 ? 0xa0 : 0x80;
      high = lead === 0xed ? 0x9f : 0xbf;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      low = lead === 0xf0 ? 0x90 : 0x80;
      high = lead === 0xf4 ? 0x8f : 0xbf;
    } else {
      return i;
    }

    for (let k = 1; k <= need; k += 1) {
      const next = bytes[i + k];
      if (next === undefined || next < (k === 1 ? low : 0x80) || next > (k === 1 ? high : 0xbf)) {
        return i;
      }
    }

    i += need + 1;
  }

  return -1;
}

/**
 * A file's bytes as text, refusing any that are not UTF-8.
 *
 * A UTF-16 byte order mark is named rather than reported as an offset of `0`,
 * because it is the one non-UTF-8 file with a recognizable cause: Windows
 * PowerShell 5's `Out-File` and `>` write one by default, and "the first
 * invalid byte is at offset 0" sends somebody looking at a byte they cannot
 * see. Neither `ff fe` nor `fe ff` is ever valid UTF-8, so this is a better
 * message for a file the decoder refuses anyway and never a second rule.
 *
 * @param bytes - What the file holds.
 * @param source - The file, for the message.
 * @returns Its text, with a UTF-8 BOM kept as U+FEFF.
 * @throws If the bytes are not UTF-8.
 */
function decode(bytes: Uint8Array, source: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    const [a, b] = bytes;
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) {
      throw new Error(
        __`Failed to read ${source}: it is not UTF-8, it starts with a UTF-16 byte order mark`
      );
    }
    throw new Error(
      __`Failed to read ${source}: it is not UTF-8, the first invalid byte is at offset ${invalidUtf8At(bytes)}`
    );
  }
}

/**
 * What a file holds, or nothing where it is not there.
 *
 * Only absence is nothing, which is `isMissing()`'s rule: a file that is there
 * and cannot be read is an error naming it, rather than a config that silently
 * reads as empty and is then written back over.
 *
 * And only UTF-8 is text. A file holding anything else is refused naming it,
 * rather than decoded lossily and then written back with every byte that was
 * not UTF-8 replaced -- see `UTF8` above. That is why the bytes are read and
 * decoded here rather than by `readFile()`: every store reads through this
 * pair, the watcher's reload and a `rewrite()` included, so this is the one
 * place the refusal has to be.
 *
 * @param source - The file.
 * @returns Its text, or `undefined` where it does not exist.
 * @throws If it exists and cannot be read, or is not UTF-8.
 */
export async function readText(source: string): Promise<string | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(source);
  } catch (e: unknown) {
    if (!isMissing(e)) {
      throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
    }
    return undefined;
  }

  return decode(bytes, source);
}

/**
 * `readText()`, without awaiting.
 *
 * A second function rather than one wrapping the other, because a `catch`
 * cannot be shared between an `await` and a synchronous call.
 *
 * @param source - The file.
 * @returns Its text, or `undefined` where it does not exist.
 * @throws If it exists and cannot be read, or is not UTF-8.
 */
export function readTextSync(source: string): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(source);
  } catch (e: unknown) {
    if (!isMissing(e)) {
      throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
    }
    return undefined;
  }

  return decode(bytes, source);
}

/**
 * What a file should hold: whatever it holds now, with the claimed paths of
 * `value` written over it.
 *
 * A write with no claim is total, which is the only thing `write(value)` can
 * mean on its own and is what a caller reaching a store directly means. A
 * write **with** one is the three-way merge `save()` exists to perform: the
 * read it staged against may be stale by the time this runs, so the paths are
 * applied to what is there now and every other key is left alone. Without it
 * a key another process changed in that window is reverted -- any key, not
 * only one this process touched -- which is the defect `WriteOptions.paths`
 * is written for.
 *
 * @param theirs - What the file holds, which is modified.
 * @param value - What the caller is writing.
 * @param paths - The caller's own paths, or nothing for all of them.
 * @param source - The file, for a message.
 * @returns The document to write.
 */
export function claim(
  theirs: Record<string, unknown>,
  value: unknown,
  paths: readonly string[] | undefined,
  source: string
): unknown {
  if (paths === undefined) {
    return value;
  }

  overlay(theirs, value, paths, source);
  return theirs;
}

/**
 * The text a file should hold, given what it holds now. A store's own
 * serializer, which is the part of a write that is about the format.
 */
export type RenderText = (
  now: string | undefined,
  value: unknown,
  paths: readonly string[] | undefined
) => string;

/**
 * Writes a store's file, reading what is there first.
 *
 * The current bytes are read here rather than kept from the last `read()`. A
 * cache would be the faster shape and this is the correct one, and the first
 * reason written down for it was wrong: a stale cache does not splice at the
 * wrong offsets, because the edits are computed against the same text they are
 * applied to and the result is written whole. What it does is overwrite
 * blindly. Reading here is what makes this **the** read the merge is against --
 * `claim()` applies the caller's paths to what is there now, so the read and
 * the merge cannot come apart -- and it is what makes a `write()` reached
 * directly work standalone, which is what public API should do.
 *
 * A write that changes nothing touches no file, which is not tidiness: **no
 * event fires at all**, so a watcher is not woken to read back a document it
 * would have found identical anyway -- and it is what makes `apply()` of a
 * freshly read value a no-op rather than a rewrite of the same bytes. Said as
 * "it keeps the mtime, which is what the watcher reads" for a while, which names
 * a mechanism `fs.watch` does not have: only `watchFile` under `poll` reads one.
 * Found by review.
 *
 * @param source - The file.
 * @param render - The store's serializer.
 * @param value - What the caller is writing.
 * @param opts - The caller's claim, if any.
 */
export async function rewrite(
  source: string,
  render: RenderText,
  value: unknown,
  opts?: WriteOptions
): Promise<void> {
  const now = await readText(source);
  const next = render(now, value, opts?.paths);

  if (next !== now) {
    await writeAtomic(source, next);
  }
}

/**
 * `rewrite()`, without awaiting.
 *
 * @param source - The file.
 * @param render - The store's serializer.
 * @param value - What the caller is writing.
 * @param opts - The caller's claim, if any.
 */
export function rewriteSync(
  source: string,
  render: RenderText,
  value: unknown,
  opts?: WriteOptions
): void {
  const now = readTextSync(source);
  const next = render(now, value, opts?.paths);

  if (next !== now) {
    writeAtomicSync(source, next);
  }
}
