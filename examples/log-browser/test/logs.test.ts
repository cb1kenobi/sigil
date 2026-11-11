import {
  appendLines,
  countMatches,
  fileFeed,
  filterLines,
  type Level,
  levelOf,
  type LogLine,
  matchRuns,
  nextMatch,
} from '../src/logs.ts';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let n = 0;
const line = (text: string, level: Level = levelOf(text), source = ''): LogLine => ({
  id: n++,
  level,
  source,
  text,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('levelOf()', () => {
  it('should read the first word that names a level, in any case', () => {
    expect(levelOf('2026-11-10T09:00:00Z ERROR could not')).toBe('error');
    expect(levelOf('[warn] disk at 81%')).toBe('warn');
    expect(levelOf('level=debug msg=hi')).toBe('debug');
    expect(levelOf('W1110 09:00 something')).toBe('info');
    expect(levelOf('FATAL out of memory')).toBe('error');
    expect(levelOf('Warning: deprecated')).toBe('warn');
    expect(levelOf('trace enter fn')).toBe('debug');
    expect(levelOf('ERR_SOCKET_CLOSED')).toBe('info');
    expect(levelOf('just a line')).toBe('info');
  });

  it('should take the first one, so a message quoting a level keeps its own', () => {
    expect(levelOf('INFO retrying after error')).toBe('info');
  });
});

describe('appendLines()', () => {
  it('should add at the end, and drop the oldest past the cap', () => {
    const a = [line('a'), line('b')];
    const next = appendLines(a, [line('c'), line('d')], 3);
    expect(next.map((l) => l.text)).toStrictEqual(['b', 'c', 'd']);
    expect(a).toHaveLength(2);
  });

  it('should hand back the same array for an empty batch, so nothing is woken', () => {
    const a = [line('a')];
    expect(appendLines(a, [], 10)).toBe(a);
  });
});

describe('filterLines()', () => {
  const all = [
    line('DEBUG cache hit', 'debug', 'api'),
    line('INFO GET /', 'info', 'web'),
    line('WARN slow Query', 'warn', 'api'),
    line('ERROR query failed', 'error', 'db'),
  ];

  it('should keep a level and the ones worse than it', () => {
    expect(filterLines(all, { filter: '', level: 'warn', source: undefined })).toHaveLength(2);
  });

  it('should keep one source', () => {
    expect(filterLines(all, { filter: '', level: 'debug', source: 'api' })).toHaveLength(2);
  });

  it('should read the filter as the pager reads a query: literal, and smart case', () => {
    const by = (filter: string) =>
      filterLines(all, { filter, level: 'debug', source: undefined }).map((l) => l.text);
    expect(by('query')).toStrictEqual(['WARN slow Query', 'ERROR query failed']);
    expect(by('Query')).toStrictEqual(['WARN slow Query']);
    expect(by('/')).toStrictEqual(['INFO GET /']);
    expect(by('.')).toStrictEqual([]);
  });
});

describe('nextMatch()', () => {
  const all = ['a', 'xa', 'b', 'xb', 'xc'].map((t) => line(t));

  it('should find the next match after the cursor, and wrap at the end', () => {
    expect(nextMatch(all, 'x', 1, 1)).toBe(3);
    expect(nextMatch(all, 'x', 4, 1)).toBe(1);
    expect(nextMatch(all, 'x', -1, 1)).toBe(1);
  });

  it('should go backwards with -1, and wrap at the top', () => {
    expect(nextMatch(all, 'x', 3, -1)).toBe(1);
    expect(nextMatch(all, 'x', 1, -1)).toBe(4);
    expect(nextMatch(all, 'x', -1, -1)).toBe(4);
  });

  it('should come back to the cursor itself when it is the only match', () => {
    expect(nextMatch(all, 'xc', 4, 1)).toBe(4);
  });

  it('should answer -1 for no match, and for no query', () => {
    expect(nextMatch(all, 'zz', 0, 1)).toBe(-1);
    expect(nextMatch(all, '', 0, 1)).toBe(-1);
    expect(countMatches(all, 'x')).toBe(3);
    expect(countMatches(all, '')).toBe(0);
  });
});

describe('matchRuns()', () => {
  it('should cut a line into what matched and what did not', () => {
    expect(matchRuns('GET /a GET /b', 'get')).toStrictEqual([
      { match: true, text: 'GET' },
      { match: false, text: ' /a ' },
      { match: true, text: 'GET' },
      { match: false, text: ' /b' },
    ]);
  });

  it('should be one run where there is no query or no match', () => {
    expect(matchRuns('abc', '')).toStrictEqual([{ match: false, text: 'abc' }]);
    expect(matchRuns('abc', 'z')).toStrictEqual([{ match: false, text: 'abc' }]);
  });
});

describe('fileFeed()', () => {
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'log-browser-feed-'));
    dirs.push(dir);
    return join(dir, 'app.log');
  };
  const texts = (lines: readonly LogLine[]) => lines.map((l) => l.text);

  it('should read the whole file, then what was appended', () => {
    const file = temp();
    writeFileSync(file, 'one\ntwo\n');
    let id = 0;
    const feed = fileFeed(file, () => id++);
    expect(feed.name).toBe('app.log');
    const first = feed.read();
    expect(texts(first)).toStrictEqual(['one', 'two']);
    expect(first.map((l) => l.id)).toStrictEqual([0, 1]);
    expect(feed.read()).toStrictEqual([]);
    appendFileSync(file, 'three\r\n');
    expect(texts(feed.read())).toStrictEqual(['three']);
  });

  it('should hold half a line until its newline arrives', () => {
    const file = temp();
    writeFileSync(file, 'one\ntw');
    const feed = fileFeed(file, () => 0);
    expect(texts(feed.read())).toStrictEqual(['one']);
    appendFileSync(file, 'o\n');
    expect(texts(feed.read())).toStrictEqual(['two']);
  });

  it('should read a file that got shorter from the top, as a rotated log is', () => {
    const file = temp();
    writeFileSync(file, 'one\ntwo\nthree\n');
    const feed = fileFeed(file, () => 0);
    feed.read();
    writeFileSync(file, 'new\n');
    expect(texts(feed.read())).toStrictEqual(['new']);
  });

  it('should keep a character whole when a read ends inside it', () => {
    const file = temp();
    const euro = Buffer.from('€');
    writeFileSync(file, Buffer.concat([Buffer.from('cost '), euro.subarray(0, 1)]));
    const feed = fileFeed(file, () => 0);
    expect(feed.read()).toStrictEqual([]);
    appendFileSync(file, Buffer.concat([euro.subarray(1), Buffer.from('5\n')]));
    expect(texts(feed.read())).toStrictEqual(['cost €5']);
  });

  it("should read each line's level", () => {
    const file = temp();
    writeFileSync(file, 'INFO a\nWARN b\nERROR c\n');
    const feed = fileFeed(file, () => 0);
    expect(feed.read().map((l) => l.level)).toStrictEqual(['info', 'warn', 'error']);
  });
});
