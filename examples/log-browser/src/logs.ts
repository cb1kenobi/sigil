/**
 * Log lines: what one is, how a level is read off one, which ones a view shows,
 * and where a search lands.
 *
 * Pure functions over arrays, so the rules are tested without a screen. A query
 * is read by `searchPattern()` -- the pager's own reading, literal and smart case
 * -- so `/` in the log view and `/` in the describe pager find the same things.
 */

import { searchPattern } from '@ttylabs/sigil/components';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

/** The four levels, least urgent first. */
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type Level = (typeof LEVELS)[number];

/** One line of a log, as the view holds it. */
export interface LogLine {
  /** Unique and increasing: the list's key, and the order lines arrived in. */
  readonly id: number;
  readonly level: Level;
  /** The pod that wrote it, or `''` for a line read from a file. */
  readonly source: string;
  /** The whole line, as it is shown and searched. */
  readonly text: string;
}

/** What the view shows: a least level, a pod, and a filter query. */
export interface LogFilter {
  /** Only lines that match, read as `searchPattern()` reads a query. Empty is every line. */
  readonly filter: string;
  /** The least urgent level shown. */
  readonly level: Level;
  /** One pod's lines, or every pod's. */
  readonly source: string | undefined;
}

/**
 * The level a line was written at, read from the first word that names one --
 * `ERROR`, `[warn]`, `level=debug`, `W1110` is not one. A line that names none is
 * `info`, which is what an unlabelled line in a log almost always is.
 */
export function levelOf(text: string): Level {
  const word =
    /\b(fatal|panic|crit(?:ical)?|err(?:or)?|warn(?:ing)?|info|notice|debug|trace)\b/i.exec(
      text
    )?.[1];
  switch (word?.toLowerCase().slice(0, 4)) {
    case 'fata':
    case 'pani':
    case 'crit':
    case 'err':
    case 'erro': {
      return 'error';
    }
    case 'warn': {
      return 'warn';
    }
    case 'debu':
    case 'trac': {
      return 'debug';
    }
    default: {
      return 'info';
    }
  }
}

/**
 * The lines with a batch added at the end, and the oldest dropped past `max`.
 *
 * A new array, because a `State` hears a new value and not a changed one.
 */
export function appendLines(
  lines: readonly LogLine[],
  batch: readonly LogLine[],
  max: number
): readonly LogLine[] {
  if (batch.length === 0) {
    return lines;
  }
  const next = lines.concat(batch);
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * A test for one line against a filter, or `undefined` where the filter's query
 * does not compile -- which a literal query never fails to.
 */
export function lineTest(by: LogFilter): ((line: LogLine) => boolean) | undefined {
  const least = LEVELS.indexOf(by.level);
  let pattern: RegExp | undefined;
  if (by.filter !== '') {
    try {
      pattern = searchPattern(by.filter);
    } catch {
      return undefined;
    }
  }
  return (line) =>
    LEVELS.indexOf(line.level) >= least &&
    (by.source === undefined || line.source === by.source) &&
    (pattern === undefined || line.text.search(pattern) >= 0);
}

/** The lines a filter keeps, in order. */
export function filterLines(lines: readonly LogLine[], by: LogFilter): readonly LogLine[] {
  const test = lineTest(by);
  return test === undefined ? [] : lines.filter(test);
}

/**
 * Where a search goes next: the first line after `from` that matches, wrapping
 * at the end, or before it with `direction` -1. `-1` where nothing matches.
 *
 * @param lines - The lines on show.
 * @param query - What was typed after `/`.
 * @param from - Where the cursor is, or `-1` for nowhere.
 * @param direction - `1` for `n`, `-1` for `N`.
 */
export function nextMatch(
  lines: readonly LogLine[],
  query: string,
  from: number,
  direction: 1 | -1
): number {
  if (query === '' || lines.length === 0) {
    return -1;
  }
  const pattern = searchPattern(query);
  const count = lines.length;
  const start = from < 0 ? (direction === 1 ? -1 : count) : from;
  for (let n = 1; n <= count; n++) {
    const i = (((start + n * direction) % count) + count) % count;
    if ((lines[i] as LogLine).text.search(pattern) >= 0) {
      return i;
    }
  }
  return -1;
}

/** How many of the lines match a query. */
export function countMatches(lines: readonly LogLine[], query: string): number {
  if (query === '') {
    return 0;
  }
  const pattern = searchPattern(query);
  let n = 0;
  for (const line of lines) {
    if (line.text.search(pattern) >= 0) {
      n++;
    }
  }
  return n;
}

/** A piece of a line, and whether a search matched it. */
export interface Run {
  readonly match: boolean;
  readonly text: string;
}

/**
 * A line cut into the runs a search did and did not match, for drawing the
 * matches reversed. One run, unmatched, where the query is empty or finds nothing.
 */
export function matchRuns(text: string, query: string): Run[] {
  if (query === '') {
    return [{ match: false, text }];
  }
  const runs: Run[] = [];
  let at = 0;
  for (const found of text.matchAll(searchPattern(query))) {
    const end = found.index + found[0].length;
    if (end === found.index) {
      continue;
    }
    if (found.index > at) {
      runs.push({ match: false, text: text.slice(at, found.index) });
    }
    runs.push({ match: true, text: found[0] });
    at = end;
  }
  if (at < text.length || runs.length === 0) {
    runs.push({ match: false, text: text.slice(at) });
  }
  return runs;
}

/** Where log lines come from: whatever arrived since the last read. */
export interface LogFeed {
  /** What the log's title calls it: the file's own name. */
  readonly name: string;
  /** Where it is read from, for the header. */
  readonly path: string;
  /** The lines that arrived since the last call, oldest first. */
  read(): LogLine[];
}

/**
 * A feed over a file on disk: everything in it on the first read, and whatever
 * was appended on each read after, which is `tail -f`.
 *
 * A line is handed over once its newline has arrived, so a writer caught half
 * way through a line is read whole on the next call. A file that got shorter was
 * truncated or replaced, and is read again from the top -- which is what a
 * rotated log looks like from here. Bytes are decoded as a stream, so a
 * character cut between two reads arrives whole.
 *
 * @param path - The file.
 * @param nextId - Hands out the lines' ids.
 */
export function fileFeed(path: string, nextId: () => number): LogFeed {
  let offset = 0;
  let held = '';
  let decoder = new TextDecoder();
  const chunk = Buffer.alloc(64 * 1024);

  return {
    name: basename(path),
    path,
    read() {
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size < offset) {
          offset = 0;
          held = '';
          decoder = new TextDecoder();
        }
        let text = held;
        while (offset < size) {
          const n = readSync(fd, chunk, 0, chunk.length, offset);
          if (n === 0) {
            break;
          }
          offset += n;
          text += decoder.decode(chunk.subarray(0, n), { stream: true });
        }
        const parts = text.split(/\r?\n/);
        held = parts.pop() ?? '';
        return parts.map((line) => ({
          id: nextId(),
          level: levelOf(line),
          source: '',
          text: line,
        }));
      } finally {
        closeSync(fd);
      }
    },
  };
}
