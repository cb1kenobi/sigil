import { guardOutput, isStreamGone, writeFully, writeOut, writeTo } from '../src/output.js';
import { EventEmitter } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * What `main()` writes through, and the listener it puts on the streams (SIG-538,
 * SIG-542).
 *
 * `main()` itself is in `output-main.test.ts`; this is the module under it.
 */

/** What a write failing for `code` throws or emits. */
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('isStreamGone()', () => {
  it('should say yes for the reader leaving, however it is spelled', () => {
    for (const code of ['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
      expect(isStreamGone(failure(code))).toBe(true);
    }
  });

  it('should say no for a real fault, and for what is not an error at all', () => {
    for (const value of [failure('ENOSPC'), failure('EFBIG'), new Error('x'), undefined, null]) {
      expect(isStreamGone(value)).toBe(false);
    }
  });
});

describe('guardOutput()', () => {
  it('should leave only the reader leaving quiet', () => {
    const stream = new EventEmitter();
    guardOutput([stream]);

    for (const code of ['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED']) {
      expect(() => stream.emit('error', failure(code))).not.toThrow();
    }
    // a guard that swallowed every error would make `mycli > file` on a full
    // disk exit 0 over a cut-off file, which is the terminal's listener and the
    // wrong one to copy
    expect(() => stream.emit('error', failure('ENOSPC'))).toThrow('ENOSPC');
    expect(() => stream.emit('error', failure('EFBIG'))).toThrow('EFBIG');
  });

  it('should put one listener on a stream however many times it is asked', () => {
    const stream = new EventEmitter();

    guardOutput([stream]);
    guardOutput([stream]);
    guardOutput([stream]);

    expect(stream.listenerCount('error')).toBe(1);
  });

  it('should put one listener on a stream however many copies of the module ask', async () => {
    // a built app carries its own copy of the runtime, so a module-level set would
    // answer "guarded" for one copy and "not yet" for the other
    const stream = new EventEmitter();
    guardOutput([stream]);

    vi.resetModules();
    const other = await import('../src/output.js');
    expect(other.guardOutput).not.toBe(guardOutput);
    other.guardOutput([stream]);

    expect(stream.listenerCount('error')).toBe(1);
  });

  it('should guard again a stream whose listener something took off', () => {
    const stream = new EventEmitter();
    guardOutput([stream]);
    stream.removeAllListeners('error');

    guardOutput([stream]);

    expect(stream.listenerCount('error')).toBe(1);
  });

  it('should leave a listener of the program’s own beside it', () => {
    const stream = new EventEmitter();
    const own = vi.fn();
    stream.on('error', own);

    guardOutput([stream]);

    expect(stream.listenerCount('error')).toBe(2);
  });

  it('should skip a stream that cannot take a listener', () => {
    expect(() => guardOutput([{}, undefined as never])).not.toThrow();
  });
});

describe('writeFully()', () => {
  /** A sink that takes at most `room` bytes in all, the way a file at its limit does. */
  function limited(room: number, seen: Buffer[] = []) {
    let left = room;
    return {
      seen,
      write(bytes: Uint8Array, offset: number): number {
        if (left <= 0) {
          throw Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG' });
        }
        const taken = Math.min(left, bytes.length - offset, 4);
        seen.push(Buffer.from(bytes.subarray(offset, offset + taken)));
        left -= taken;
        return taken;
      },
    };
  }

  it('should write the whole of a document the sink takes in pieces', () => {
    const sink = limited(100);

    writeFully('a document of several pieces', sink.write);

    expect(Buffer.concat(sink.seen).toString()).toBe('a document of several pieces');
  });

  it('should throw, saying how much landed, when the sink stops taking bytes', () => {
    const sink = limited(10);

    expect(() => writeFully('a document of several pieces', sink.write)).toThrow(
      'The output was cut off: 10 of 28 bytes were written (EFBIG).'
    );
  });

  it('should count bytes rather than characters', () => {
    // 3 + 4 bytes, which a character count would call 2
    const sink = limited(100);

    writeFully('€\u{1f600}', sink.write);

    expect(Buffer.concat(sink.seen).toString()).toBe('€\u{1f600}');
  });

  it('should refuse a sink that takes nothing rather than loop on it', () => {
    expect(() => writeFully('abc', () => 0)).toThrow(
      'The output was cut off: 0 of 3 bytes were written, and the destination took no more.'
    );
  });

  it('should write nothing for an empty document', () => {
    const write = vi.fn(() => 0);

    writeFully('', write);

    expect(write).not.toHaveBeenCalled();
  });
});

describe('writeOut()', () => {
  it('should go through process.stdout.write when something has replaced it', () => {
    // a capture -- a test, or an app embedding a command -- is the stream's to
    // see, and writing to the descriptor underneath it would bypass the capture
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      writeOut('captured\n');
      expect(spy).toHaveBeenCalledWith('captured\n');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('writeTo()', () => {
  // a worker's own `process.stdout` has no descriptor, so these are the in-process
  // cover for both branches of the stream-or-descriptor choice, on every platform
  let file: string;
  let fd: number;

  beforeAll(() => {
    file = join(mkdtempSync(join(tmpdir(), 'sigil-writeto-')), 'out.txt');
  });
  afterAll(() => {
    rmSync(dirname(file), { force: true, recursive: true });
  });

  it('should write a regular file through its descriptor, whole', () => {
    class FileStream {
      constructor(readonly fd: number) {}
      write(): boolean {
        throw new Error('went through the stream');
      }
    }
    fd = openSync(file, 'w');
    try {
      writeTo(new FileStream(fd), 'one\n');
      writeTo(new FileStream(fd), 'two\n');
    } finally {
      closeSync(fd);
    }

    expect(readFileSync(file, 'utf-8')).toBe('one\ntwo\n');
  });

  it('should leave a stream whose write was replaced to its replacement', () => {
    // an own `write` is a capture, and writing to the descriptor under it would
    // bypass what it captures
    fd = openSync(file, 'w');
    try {
      const write = vi.fn(() => true);
      writeTo({ fd, write }, 'captured\n');

      expect(write).toHaveBeenCalledWith('captured\n');
      expect(readFileSync(file, 'utf-8')).toBe('');
    } finally {
      closeSync(fd);
    }
  });

  it('should leave a stream that is not a file to the stream', () => {
    const write = vi.fn(() => true);

    // no descriptor at all, and a descriptor that is not open
    writeTo({ write }, 'a');
    writeTo({ fd: 1 << 20, write }, 'b');

    expect(write.mock.calls).toEqual([['a'], ['b']]);
  });
});
