import { tempDir } from './temp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file in a directory of its own, so that two tests in one worker cannot
 * meet each other's bytes.
 *
 * A directory per file rather than per suite, which is what lets a test write
 * `config.xml` by that name -- the store's own diagnostics name the path, and a
 * path with a counter in it reads as a fixture rather than as a config.
 */
export function file(text: string, name = 'config.xml'): string {
  const path = join(tempDir('sigil-xml-'), name);
  writeFileSync(path, text);
  return path;
}

/** A path in a directory of its own with nothing at it. */
export function absent(name = 'config.xml'): string {
  return join(tempDir('sigil-xml-'), name);
}

/** What a file holds now. */
export function read(path: string): string {
  return readFileSync(path, 'utf8');
}
