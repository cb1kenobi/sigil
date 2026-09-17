import { type Ansi, createAnsi } from '../../src/ansi/index.js';
import {
	createTerminal,
	type InputStream,
	type OutputStream,
	type Terminal,
} from '../../src/terminal/index.js';
import { createLiveRegion, type LiveRegion } from '../../src/terminal/live.js';
import { PassThrough } from 'node:stream';

/**
 * What is left of a string once the escape sequences are gone.
 *
 * The carriage return goes too: a repaint leads with `CURSOR_HOME`, which moves
 * the cursor without being an escape sequence, so what is left is what shows.
 *
 * @param text - The written output.
 * @returns The text a person would see.
 */
function strip(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\[[\d;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

export interface FakeStream {
	columns: number | undefined;
	emit(event: string): void;
	/** Only the most recent frame, stripped. */
	readonly frame: string;
	isTTY: boolean;
	on(event: string, listener: (...args: unknown[]) => void): FakeStream;
	/** Everything written, exactly as it was written. */
	readonly output: string;
	removeListener(event: string, listener: (...args: unknown[]) => void): FakeStream;
	/** Everything written, stripped. */
	readonly text: string;
	write(chunk: string): boolean;
	written: string[];
}

/** A stream that records what was written, standing in for stdout. */
export function createStream(opts: { columns?: number; isTTY?: boolean } = {}): FakeStream {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	const stream: FakeStream = {
		columns: opts.columns ?? 80,
		isTTY: opts.isTTY ?? true,
		written: [],

		get output(): string {
			return stream.written.join('');
		},

		get text(): string {
			return strip(stream.output);
		},

		/**
		 * Frames are separated by the sequences that erase the last one rather than
		 * by newlines -- a repaint is `\r ESC[0J <frame>` -- so splitting the output
		 * on a newline finds the lines of one frame, not the frames themselves.
		 */
		get frame(): string {
			return strip(stream.written.at(-1) ?? '');
		},

		on(event: string, listener: (...args: unknown[]) => void): FakeStream {
			let set = listeners.get(event);
			if (!set) {
				listeners.set(event, (set = new Set()));
			}
			set.add(listener);
			return stream;
		},

		removeListener(event: string, listener: (...args: unknown[]) => void): FakeStream {
			listeners.get(event)?.delete(listener);
			return stream;
		},

		emit(event: string): void {
			// eslint-disable-next-line unicorn/no-useless-spread
			for (const listener of [...(listeners.get(event) ?? [])]) {
				listener();
			}
		},

		write(chunk: string): boolean {
			stream.written.push(chunk);
			return true;
		},
	};

	return stream;
}

/**
 * Stdin, as a real `PassThrough` rather than something shaped like one.
 *
 * It has to be real. A hand-written async iterable has no `return()`, and that
 * is exactly the method Node's stream iterator implements by *destroying* the
 * stream -- so a fake one cannot show the bug where finishing a prompt left
 * `process.stdin` destroyed and the next prompt with nothing to read.
 */
export interface FakeInput extends PassThrough {
	isTTY: boolean;
	rawMode: boolean;
	/** Sends a chunk to whatever is reading. */
	send(chunk: string): void;
	setRawMode(mode: boolean): FakeInput;
}

/**
 * Builds the stdin a prompt reads.
 *
 * @param opts - Whether it is a terminal.
 * @returns The input.
 */
export function createInput(opts: { isTTY?: boolean } = {}): FakeInput {
	const input = new PassThrough() as FakeInput;

	input.isTTY = opts.isTTY ?? true;
	input.rawMode = false;

	input.setRawMode = (mode: boolean): FakeInput => {
		input.rawMode = mode;
		return input;
	};

	input.send = (chunk: string): void => {
		input.write(chunk);
	};

	return input;
}

export interface Harness {
	ansi: Ansi;
	region: LiveRegion;
	stdin: FakeInput;
	stdout: FakeStream;
	terminal: Terminal;
}

/**
 * A terminal, a region, and a recording stream, wired together.
 *
 * @param opts - The size, and whether either end is a terminal.
 * @returns The harness.
 */
export function setup(
	opts: { columns?: number; inputTTY?: boolean; isTTY?: boolean } = {}
): Harness {
	const stdout = createStream(opts);
	const stdin = createInput({ isTTY: opts.inputTTY ?? opts.isTTY ?? true });
	const proc = {
		listenerCount: (): number => 0,
		on: (): void => {},
		removeListener: (): void => {},
	};

	const terminal = createTerminal({
		env: {},
		isTTY: opts.isTTY ?? true,
		proc,
		stdin: stdin as unknown as InputStream,
		stdout: stdout as unknown as OutputStream,
	});

	return {
		// level 0, so what a test reads is the text rather than the styling. The
		// styling has tests of its own
		ansi: createAnsi({ level: 0 }),
		region: createLiveRegion({ terminal }),
		stdin,
		stdout,
		terminal,
	};
}

/**
 * Lets pending promises settle, so a prompt can act on what was sent.
 *
 * @param times - How many turns of the microtask queue.
 * @returns Settled.
 */
export async function tick(times = 2): Promise<void> {
	// `setImmediate` and not a chain of resolved promises: a real stream delivers
	// `data` on the macrotask queue, so draining microtasks alone would look at
	// the prompt before it had seen the keys
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}
