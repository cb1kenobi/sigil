import { createTerminal, type OutputStream, type ProcessLike } from '../../src/terminal/index.js';
import { HIDE_CURSOR, SHOW_CURSOR } from '../../src/terminal/sequences.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * A stream that records what was written and can be told to fail the way a pipe
 * whose reader has gone does -- synchronously, or through an `error` event,
 * which is the shape that actually kills a CLI.
 */
function createStream(opts: { columns?: number; isTTY?: boolean; rows?: number } = {}) {
	const listeners = new Map<string, Set<(...args: never[]) => void>>();
	let throws: NodeJS.ErrnoException | undefined;

	return {
		columns: opts.columns,
		isTTY: opts.isTTY ?? false,
		rows: opts.rows,
		written: [] as string[],

		get output() {
			return this.written.join('');
		},

		on(event: string, listener: (...args: never[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				listeners.set(event, (set = new Set()));
			}
			set.add(listener);
			return this;
		},

		removeListener(event: string, listener: (...args: never[]) => void) {
			listeners.get(event)?.delete(listener);
			return this;
		},

		listenerCount(event: string) {
			return listeners.get(event)?.size ?? 0;
		},

		emit(event: string, ...args: unknown[]) {
			// a copy, matching what the real emitters do: a listener that removes
			// another must not change who hears this event
			// eslint-disable-next-line unicorn/no-useless-spread
			for (const listener of [...(listeners.get(event) ?? [])]) {
				(listener as (...a: unknown[]) => void)(...args);
			}
		},

		failWith(code: string) {
			throws = Object.assign(new Error(code), { code });
		},

		write(chunk: string) {
			if (throws) {
				throw throws;
			}
			this.written.push(chunk);
			return true;
		},
	};
}

/** A process that records handlers instead of installing them. */
function createProc() {
	const listeners = new Map<string, Set<(...args: never[]) => void>>();

	return {
		killed: [] as string[],
		pid: 1234,

		on(event: string, listener: (...args: never[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				listeners.set(event, (set = new Set()));
			}
			set.add(listener);
			return this;
		},

		removeListener(event: string, listener: (...args: never[]) => void) {
			listeners.get(event)?.delete(listener);
			return this;
		},

		listenerCount(event: string) {
			return listeners.get(event)?.size ?? 0;
		},

		kill(_pid: number, signal: string) {
			this.killed.push(signal);
			return true;
		},

		emit(event: string) {
			// as above: the restore handler removes its own siblings as it runs
			// eslint-disable-next-line unicorn/no-useless-spread
			for (const listener of [...(listeners.get(event) ?? [])]) {
				(listener as () => void)();
			}
		},
	};
}

function setup(streamOpts: Parameters<typeof createStream>[0] = {}) {
	const stdout = createStream({ isTTY: true, ...streamOpts });
	const stderr = createStream({ isTTY: true });
	const proc = createProc();
	const stdin = { isTTY: true, setRawMode: vi.fn() };
	const term = createTerminal({
		env: {},
		proc: proc as unknown as ProcessLike,
		stderr: stderr as unknown as OutputStream,
		stdin,
		stdout: stdout as unknown as OutputStream,
	});
	return { proc, stderr, stdin, stdout, term };
}

describe('createTerminal()', () => {
	describe('installing nothing up front', () => {
		// a CLI that only prints lines must not acquire signal handling by
		// importing a module
		it('should not touch the process until there is something to restore', () => {
			const { proc, term } = setup();

			expect(proc.listenerCount('exit')).to.equal(0);
			expect(proc.listenerCount('SIGINT')).to.equal(0);

			term.write('hello');
			expect(proc.listenerCount('exit')).to.equal(0);

			term.hideCursor();
			expect(proc.listenerCount('exit')).to.equal(1);
			expect(proc.listenerCount('SIGINT')).to.equal(1);
		});

		it('should stand down once there is nothing left to restore', () => {
			const { proc, term } = setup();

			term.hideCursor();
			expect(proc.listenerCount('SIGINT')).to.equal(1);

			term.showCursor();
			expect(proc.listenerCount('SIGINT')).to.equal(0);
			expect(proc.listenerCount('exit')).to.equal(0);
		});

		it('should not subscribe to resize until somebody is listening', () => {
			const { stdout, term } = setup();

			expect(stdout.listenerCount('resize')).to.equal(0);

			const off = term.onResize(() => {});
			expect(stdout.listenerCount('resize')).to.equal(1);

			off();
			expect(stdout.listenerCount('resize')).to.equal(0);
		});
	});

	describe('size', () => {
		it('should report the stream size', () => {
			const { term } = setup({ columns: 120, rows: 40 });
			expect(term.width).to.equal(120);
			expect(term.height).to.equal(40);
		});

		// `terminalWidth()` caps at MAX_WIDTH because a line of prose is hard to
		// read past it. That is about generated text; this is the real screen, and
		// a progress bar told 100 when it is 200 erases the wrong amount
		it('should not cap the width the way terminalWidth() does', () => {
			const { term } = setup({ columns: 200 });
			expect(term.width).to.equal(200);
		});

		it('should fall back when there is nothing to ask', () => {
			const { term } = setup({ columns: undefined, rows: undefined });
			expect(term.width).to.equal(80);
			expect(term.height).to.equal(24);
		});

		it('should re-read the size rather than answer from a snapshot', () => {
			const { stdout, term } = setup({ columns: 80 });
			expect(term.width).to.equal(80);

			stdout.columns = 132;
			expect(term.width).to.equal(132);
		});

		it('should tell subscribers the new size on a resize', () => {
			const { stdout, term } = setup({ columns: 80, rows: 24 });
			const seen: { height: number; width: number }[] = [];

			term.onResize((size) => seen.push(size));
			stdout.columns = 132;
			stdout.rows = 50;
			stdout.emit('resize');

			expect(seen).to.deep.equal([{ height: 50, width: 132 }]);
		});

		it('should stop telling a subscriber that unsubscribed', () => {
			const { stdout, term } = setup();
			const fn = vi.fn();

			const off = term.onResize(fn);
			stdout.emit('resize');
			expect(fn).toHaveBeenCalledTimes(1);

			off();
			stdout.emit('resize');
			expect(fn).toHaveBeenCalledTimes(1);
		});
	});

	describe('the far end going away', () => {
		// `mycli --help | head -1` kills a CLI that did nothing wrong, because an
		// `error` event with no listener is an uncaught exception
		it('should swallow EPIPE from an error event and go quiet', () => {
			const { stdout, term } = setup();

			term.write('first');
			expect(term.closed).to.equal(false);

			stdout.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));

			expect(term.closed).to.equal(true);
			expect(term.write('second')).to.equal(false);
			expect(stdout.output).to.equal('first');
		});

		it('should swallow a synchronous EPIPE', () => {
			const { stdout, term } = setup();

			stdout.failWith('EPIPE');

			expect(term.write('anything')).to.equal(false);
			expect(term.closed).to.equal(true);
		});

		it.each(['ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])(
			'should treat %s as the far end going away too',
			(code) => {
				const { stdout, term } = setup();
				stdout.failWith(code);
				expect(term.write('x')).to.equal(false);
				expect(term.closed).to.equal(true);
			}
		);

		// only the pipe going away is this module's to swallow; a real fault is
		// still a fault
		it('should rethrow anything that is not the far end going away', () => {
			const { stdout, term } = setup();

			stdout.failWith('ENOSPC');

			expect(() => term.write('x')).toThrow('ENOSPC');
			expect(term.closed).to.equal(false);
		});

		it('should not install an error guard on a stream nothing writes to', () => {
			const { stdout, term } = setup();

			expect(stdout.listenerCount('error')).to.equal(0);
			term.write('x');
			expect(stdout.listenerCount('error')).to.equal(1);
		});
	});

	describe('the cursor', () => {
		it('should hide and show the cursor', () => {
			const { stdout, term } = setup();

			term.hideCursor();
			expect(stdout.output).to.equal(HIDE_CURSOR);

			term.showCursor();
			expect(stdout.output).to.equal(HIDE_CURSOR + SHOW_CURSOR);
		});

		it('should hide the cursor once', () => {
			const { stdout, term } = setup();

			term.hideCursor();
			term.hideCursor();

			expect(stdout.output).to.equal(HIDE_CURSOR);
		});

		// nothing is watching, and a hidden cursor is invisible in a pipe anyway
		it('should not hide the cursor when this is not a terminal', () => {
			const { stdout, term } = setup({ isTTY: false });

			term.hideCursor();

			expect(stdout.output).to.equal('');
		});
	});

	describe('raw mode', () => {
		it('should enter and leave raw mode', () => {
			const { stdin, term } = setup();

			term.setRawMode(true);
			expect(stdin.setRawMode).toHaveBeenCalledWith(true);

			term.setRawMode(false);
			expect(stdin.setRawMode).toHaveBeenCalledWith(false);
		});

		it('should not ask twice for the mode it is already in', () => {
			const { stdin, term } = setup();

			term.setRawMode(true);
			term.setRawMode(true);

			expect(stdin.setRawMode).toHaveBeenCalledTimes(1);
		});

		it('should do nothing when the input is not a terminal', () => {
			const stdin = { isTTY: false, setRawMode: vi.fn() };
			const term = createTerminal({ env: {}, stdin, stdout: createStream() as never });

			term.setRawMode(true);

			expect(stdin.setRawMode).not.toHaveBeenCalled();
		});
	});

	describe('the live region', () => {
		// a spinner still ticking underneath a prompt writes over it on its next
		// frame, so the region is a lock rather than a convention
		it('should evict the previous holder', () => {
			const { term } = setup();
			const first = vi.fn();

			const a = term.claimLive(first);
			expect(a.active).to.equal(true);

			const b = term.claimLive();

			expect(first).toHaveBeenCalledTimes(1);
			expect(a.active).to.equal(false);
			expect(b.active).to.equal(true);
		});

		it('should not evict a holder that released first', () => {
			const { term } = setup();
			const onEvict = vi.fn();

			const a = term.claimLive(onEvict);
			a.release();
			expect(a.active).to.equal(false);

			term.claimLive();

			expect(onEvict).not.toHaveBeenCalled();
		});

		it('should be idempotent to release', () => {
			const { term } = setup();
			const a = term.claimLive();

			a.release();
			a.release();

			expect(a.active).to.equal(false);
		});

		// the region belongs to whoever holds it now, and an evicted claim
		// releasing itself afterwards would hand it to nobody
		it('should not let an evicted claim release the new holder', () => {
			const { proc, term } = setup();

			const a = term.claimLive();
			const b = term.claimLive();
			a.release();

			expect(b.active).to.equal(true);
			expect(proc.listenerCount('exit')).to.equal(1);
		});

		it('should hold the restore handlers while a claim is live', () => {
			const { proc, term } = setup();

			const a = term.claimLive();
			expect(proc.listenerCount('exit')).to.equal(1);

			a.release();
			expect(proc.listenerCount('exit')).to.equal(0);
		});
	});

	describe('restoring', () => {
		it('should put everything back', () => {
			const { proc, stdin, stdout, term } = setup();
			const onEvict = vi.fn();

			term.hideCursor();
			term.setRawMode(true);
			term.claimLive(onEvict);

			term.restore();

			expect(stdout.output).to.equal(HIDE_CURSOR + SHOW_CURSOR);
			expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
			expect(onEvict).toHaveBeenCalledTimes(1);
			expect(proc.listenerCount('exit')).to.equal(0);
		});

		it('should be idempotent', () => {
			const { stdout, term } = setup();

			term.hideCursor();
			term.restore();
			term.restore();

			expect(stdout.output).to.equal(HIDE_CURSOR + SHOW_CURSOR);
		});

		it('should restore on exit', () => {
			const { proc, stdout, term } = setup();

			term.hideCursor();
			proc.emit('exit');

			expect(stdout.output).to.equal(HIDE_CURSOR + SHOW_CURSOR);
		});

		it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('should restore on %s', (signal) => {
			const { proc, stdout, term } = setup();

			term.hideCursor();
			proc.emit(signal);

			expect(stdout.output).to.equal(HIDE_CURSOR + SHOW_CURSOR);
		});

		// a listener on a signal replaces the default action, so a CLI that hid its
		// cursor would stop dying on Ctrl-C -- worse than the bug being fixed
		it('should re-raise a signal nothing else is listening for', () => {
			const { proc, term } = setup();

			term.hideCursor();
			proc.emit('SIGINT');

			expect(proc.killed).to.deep.equal(['SIGINT']);
			expect(proc.listenerCount('SIGINT')).to.equal(0);
		});

		it('should leave a signal alone when the app is listening for it too', () => {
			const { proc, term } = setup();

			proc.on('SIGINT', () => {});
			term.hideCursor();
			proc.emit('SIGINT');

			expect(proc.killed).to.deep.equal([]);
		});
	});
});
