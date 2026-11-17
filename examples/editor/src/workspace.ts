/**
 * The directory the editor is about, and the only two things it does to the
 * disk: read a file and write one.
 *
 * A context rather than `node:fs` called from the model, which is the git
 * client's `GitContext` shape: `App` takes no props, so where it reads and writes
 * comes through a context that the entry provides with the directory on the
 * command line and a test provides with a temporary one it can count the writes
 * of.
 */

import { createContext, type Context } from '@ttylabs/sigil/renderer';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the editor reads and writes through. */
export interface Workspace {
  /** The directory at the top of the file tree, absolute. */
  readonly root: string;
  /**
   * Reads a file as UTF-8.
   *
   * @throws When it cannot be read, is larger than {@link MAX_BYTES}, or holds a
   *   NUL byte -- which is what makes a file binary as far as an editor is
   *   concerned, and a text area would draw it as nothing useful.
   */
  read(path: string): string;
  /** Writes a file as UTF-8, replacing what was there. */
  write(path: string, text: string): void;
}

/**
 * The largest file the editor opens: 8 MiB, three times the 2.7 MB the text
 * area's own entry measured a join over. Past it a keystroke is spent joining and
 * highlighting rather than typing, and an editor that freezes on a log file it
 * was pointed at by mistake is worse than one that says no.
 */
export const MAX_BYTES: number = 8 * 1024 * 1024;

/**
 * A workspace over a directory on disk.
 *
 * Synchronous, because every file it reads is one the person just asked to see
 * and the next frame is about it -- an asynchronous read would only add a
 * "loading" state to draw for the few milliseconds of an 8 MiB read.
 *
 * @param root - The directory. Defaults to the working directory.
 * @returns The workspace.
 */
export function createWorkspace(root: string = process.cwd()): Workspace {
  return {
    root: resolve(root),
    read(path) {
      const size = statSync(path).size;
      if (size > MAX_BYTES) {
        throw new Error(`${path} is ${Math.round(size / 1024 / 1024)} MiB, past the 8 MiB limit`);
      }
      const text = readFileSync(path, 'utf8');
      if (text.includes('\u0000')) {
        throw new Error(`${path} is a binary file`);
      }
      return text;
    },
    write(path, text) {
      writeFileSync(path, text, 'utf8');
    },
  };
}

/** The workspace the editor is about. `provideContext()` it with another in a test. */
export const WorkspaceContext: Context<Workspace> = createContext(createWorkspace(), 'workspace');
