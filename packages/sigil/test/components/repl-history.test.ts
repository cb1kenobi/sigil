import { createHistory, replHistoryFile } from '../../src/components/repl-history.js';
import { tempDir } from '../temp.js';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** A history file in a directory of its own. */
function fileIn(prefix: string): string {
  return join(tempDir(prefix), 'history');
}

/** The entries the file holds, as the file spells them. */
function onDisk(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string);
}

describe('createHistory() in memory', () => {
  it('should keep entries in order and drop a blank one', () => {
    const history = createHistory();

    expect(history.add('one')).toBe(true);
    expect(history.add('   ')).toBe(false);
    expect(history.add('')).toBe(false);
    expect(history.add('two')).toBe(true);

    expect(history.entries).toEqual(['one', 'two']);
  });

  it('should collapse consecutive duplicates and keep one that is not consecutive', () => {
    const history = createHistory();

    history.add('a');
    expect(history.add('a')).toBe(false);
    history.add('b');
    history.add('a');

    expect(history.entries).toEqual(['a', 'b', 'a']);
  });

  it('should keep only the newest max entries', () => {
    const history = createHistory({ max: 3 });

    for (const line of ['1', '2', '3', '4', '5']) {
      history.add(line);
    }

    expect(history.entries).toEqual(['3', '4', '5']);
  });

  it('should read a max that is not a positive whole number as the default', () => {
    expect(createHistory({ max: 0 }).max).toBe(1000);
    expect(createHistory({ max: Number.NaN }).max).toBe(1000);
    expect(createHistory({ max: 2.5 }).max).toBe(1000);
  });

  it('should hand back a copy, so the caller cannot rewrite the past', () => {
    const history = createHistory();
    history.add('a');

    (history.entries as string[]).push('forged');

    expect(history.entries).toEqual(['a']);
  });
});

describe('createHistory() over a file', () => {
  it('should survive the process: a second history reads what the first wrote', () => {
    const file = fileIn('sigil-history-survive-');
    createHistory({ file }).add('deploy prod');

    expect(createHistory({ file }).entries).toEqual(['deploy prod']);
  });

  it('should write a multiline entry as one line, so it is read back as one', () => {
    const file = fileIn('sigil-history-multiline-');
    createHistory({ file }).add('if (x) {\n  go()\n}');

    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(createHistory({ file }).entries).toEqual(['if (x) {\n  go()\n}']);
  });

  it('should skip a line that is not an entry rather than losing the rest', () => {
    const file = fileIn('sigil-history-garbage-');
    writeFileSync(file, `"one"\nnot json\n42\n"two"\n{"x":1}\n"th`);

    // the last line has no newline, so it is a writer caught half way and not an entry
    expect(createHistory({ file }).entries).toEqual(['one', 'two']);
  });

  it('should not run an entry on to the last line of a file whose end was cut short', () => {
    const file = fileIn('sigil-history-cut-');
    writeFileSync(file, '"one"\n"two"');

    const history = createHistory({ file });
    expect(history.entries).toEqual(['one']);
    history.add('three');

    // the cut line ends where it was cut, and the new one is its own
    expect(readFileSync(file, 'utf8')).toBe('"one"\n"two"\n"three"\n');
    expect(createHistory({ file }).entries).toEqual(['one', 'two', 'three']);
  });

  it('should create the directory it lives in', () => {
    const file = join(tempDir('sigil-history-mkdir-'), 'a', 'b', 'history');

    createHistory({ file }).add('x');

    expect(existsSync(file)).toBe(true);
  });

  it('should keep the file readable by its owner alone, since a line may be a secret', () => {
    const file = fileIn('sigil-history-mode-');
    createHistory({ file }).add('login --token abc');

    // POSIX permission bits mean nothing on Windows
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  });

  it('should answer where an app keeps its history: its name under the state directory', () => {
    const where = replHistoryFile('mycli');
    if (where !== undefined) {
      expect(where.endsWith(join('mycli', 'history'))).toBe(true);
    }
  });

  describe('trimmed on load', () => {
    it('should read the newest max of a file that holds more, and cut the file back', () => {
      const file = fileIn('sigil-history-trim-');
      const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify(`cmd ${i}`));
      writeFileSync(file, `${lines.join('\n')}\n`);

      const history = createHistory({ file, max: 10 });

      expect(history.entries).toEqual(Array.from({ length: 10 }, (_, i) => `cmd ${i + 30}`));
      expect(onDisk(file)).toEqual(history.entries);
    });

    it('should leave a file alone that is within a quarter of the cap, so a session at the cap is not a rewrite', () => {
      const file = fileIn('sigil-history-slack-');
      const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify(`cmd ${i}`));
      writeFileSync(file, `${lines.join('\n')}\n`);
      const before = statSync(file).ino;

      const history = createHistory({ file, max: 10 });

      // the memory is capped and the file is not touched
      expect(history.entries).toHaveLength(10);
      expect(onDisk(file)).toHaveLength(12);
      expect(statSync(file).ino).toBe(before);
    });

    it('should cut the file back when asked, to the newest max', () => {
      const file = fileIn('sigil-history-explicit-');
      const history = createHistory({ file, max: 10 });
      for (let i = 0; i < 12; i++) {
        history.add(`cmd ${i}`);
      }
      // within a quarter of the cap, so loading would have left it alone
      expect(onDisk(file)).toHaveLength(12);

      history.trim();

      expect(onDisk(file)).toEqual(Array.from({ length: 10 }, (_, i) => `cmd ${i + 2}`));
      expect(history.entries).toEqual(onDisk(file));
    });

    it('should not trim while another process holds the lock, and still read the entries', () => {
      const file = fileIn('sigil-history-locked-');
      const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify(`cmd ${i}`));
      writeFileSync(file, `${lines.join('\n')}\n`);
      // a fresh lock: somebody is trimming
      writeFileSync(`${file}.lock`, '');

      const history = createHistory({ file, max: 10 });

      expect(history.entries).toHaveLength(10);
      expect(onDisk(file)).toHaveLength(40);
    });

    it('should take over a lock that is older than a live process could have held it', () => {
      const file = fileIn('sigil-history-stale-');
      const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify(`cmd ${i}`));
      writeFileSync(file, `${lines.join('\n')}\n`);
      writeFileSync(`${file}.lock`, '');
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${file}.lock`, old, old);

      createHistory({ file, max: 10 });

      expect(onDisk(file)).toHaveLength(10);
      expect(existsSync(`${file}.lock`)).toBe(false);
    });
  });

  describe('two writers at once', () => {
    it('should keep every entry of both, in the order the file has them', () => {
      const file = fileIn('sigil-history-two-');
      const a = createHistory({ file });
      const b = createHistory({ file });

      a.add('a1');
      b.add('b1');
      a.add('a2');
      b.add('b2');

      expect(onDisk(file)).toEqual(['a1', 'b1', 'a2', 'b2']);
      // and each hears of the other's, in the file's order, the next time it looks
      a.sync();
      expect(a.entries).toEqual(['a1', 'b1', 'a2', 'b2']);
      expect(b.entries).toEqual(['a1', 'b1', 'a2', 'b2']);
    });

    it("should collapse a repeat against the other writer's entry and not only its own", () => {
      const file = fileIn('sigil-history-dup-');
      const a = createHistory({ file });
      const b = createHistory({ file });

      a.add('deploy');

      expect(b.add('deploy')).toBe(false);
      expect(onDisk(file)).toEqual(['deploy']);
    });

    it('should hear of an entry written since it last looked, when told to sync', () => {
      const file = fileIn('sigil-history-sync-');
      const a = createHistory({ file });
      const b = createHistory({ file });

      b.add('from b');
      expect(a.entries).toEqual([]);
      a.sync();

      expect(a.entries).toEqual(['from b']);
    });

    it('should read a whole file again after the other writer trimmed it from under it', () => {
      const file = fileIn('sigil-history-replaced-');
      const a = createHistory({ file, max: 4 });
      for (const line of ['1', '2', '3', '4']) {
        a.add(line);
      }
      // the other process trims: a new file under the same name
      const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify(`n${i}`));
      writeFileSync(file, `${lines.join('\n')}\n`);
      const b = createHistory({ file, max: 4 });
      expect(onDisk(file)).toEqual(['n26', 'n27', 'n28', 'n29']);

      a.sync();

      expect(a.entries).toEqual(['n26', 'n27', 'n28', 'n29']);
      expect(b.entries).toEqual(a.entries);
    });

    it('should lose nothing when one writer trims while the other appends', () => {
      const file = fileIn('sigil-history-race-');
      const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify(`old ${i}`));
      writeFileSync(file, `${lines.join('\n')}\n`);
      const a = createHistory({ file, max: 10 });
      const b = createHistory({ file, max: 10 });

      // whichever order the processes would have run in, what b appended is in the
      // file once a has trimmed, because the trim re-read the file inside the lock
      b.add('late');
      a.sync();

      expect(onDisk(file).at(-1)).toBe('late');
      expect(a.entries.at(-1)).toBe('late');
    });
  });

  describe('a file that cannot be used', () => {
    it('should keep the history in memory and say so once', () => {
      // a directory where the file should be: every read and write fails
      const dir = tempDir('sigil-history-dir-');
      const errors: unknown[] = [];

      const history = createHistory({ file: dir, onError: (error) => errors.push(error) });
      history.add('one');
      history.add('two');

      expect(history.entries).toEqual(['one', 'two']);
      expect(errors.length).toBeGreaterThan(0);
      // once per kind of failure, not once per line
      expect(errors.length).toBeLessThanOrEqual(3);
    });

    it('should never throw for want of an onError', () => {
      const dir = tempDir('sigil-history-silent-');

      expect(() => {
        const history = createHistory({ file: dir });
        history.add('x');
        history.sync();
      }).not.toThrow();
    });
  });
});
