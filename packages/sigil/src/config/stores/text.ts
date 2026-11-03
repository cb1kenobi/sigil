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
 * What a file holds, or nothing where it is not there.
 *
 * Only absence is nothing, which is `isMissing()`'s rule: a file that is there
 * and cannot be read is an error naming it, rather than a config that silently
 * reads as empty and is then written back over.
 *
 * @param source - The file.
 * @returns Its text, or `undefined` where it does not exist.
 * @throws If it exists and cannot be read.
 */
export async function readText(source: string): Promise<string | undefined> {
  try {
    return await readFile(source, 'utf8');
  } catch (e: unknown) {
    if (!isMissing(e)) {
      throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
    }
    return undefined;
  }
}

/**
 * `readText()`, without awaiting.
 *
 * A second function rather than one wrapping the other, because a `catch`
 * cannot be shared between an `await` and a synchronous call.
 *
 * @param source - The file.
 * @returns Its text, or `undefined` where it does not exist.
 * @throws If it exists and cannot be read.
 */
export function readTextSync(source: string): string | undefined {
  try {
    return readFileSync(source, 'utf8');
  } catch (e: unknown) {
    if (!isMissing(e)) {
      throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
    }
    return undefined;
  }
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
