import { createTerminal, type OutputStream } from '../../src/terminal/index.js';
import { createLiveRegion, frameHeight } from '../../src/terminal/live.js';
import {
	CURSOR_HOME,
	cursorUp,
	ERASE_DOWN,
	HIDE_CURSOR,
	SHOW_CURSOR,
} from '../../src/terminal/sequences.js';
import { describe, expect, it } from 'vitest';

function createStream(opts: { columns?: number; isTTY?: boolean } = {}) {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	return {
		columns: opts.columns ?? 20,
		isTTY: opts.isTTY ?? true,
		written: [] as string[],

		get output() {
			return this.written.join('');
		},

		on(event: string, listener: (...args: unknown[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				listeners.set(event, (set = new Set()));
			}
			set.add(listener);
			return this;
		},

		removeListener(event: string, listener: (...args: unknown[]) => void) {
			listeners.get(event)?.delete(listener);
			return this;
		},

		emit(event: string) {
			// eslint-disable-next-line unicorn/no-useless-spread
			for (const listener of [...(listeners.get(event) ?? [])]) {
				listener();
			}
		},

		write(chunk: string) {
			this.written.push(chunk);
			return true;
		},
	};
}

function setup(opts: { columns?: number; isTTY?: boolean } = {}) {
	const stdout = createStream(opts);
	const proc = { on() {}, removeListener() {}, listenerCount: () => 0 };
	const terminal = createTerminal({
		env: {},
		isTTY: opts.isTTY ?? true,
		proc,
		stdin: undefined,
		stdout: stdout as unknown as OutputStream,
	});
	const region = createLiveRegion({ terminal });
	return { region, stdout, terminal };
}

/** What a repaint of a region `rows` tall looks like. */
function repaint(rows: number) {
	return cursorUp(rows - 1) + CURSOR_HOME + ERASE_DOWN;
}

describe('frameHeight()', () => {
	it('should count a short line as one row', () => {
		expect(frameHeight('hello', 20)).to.equal(1);
	});

	it('should count the rows a line wraps to', () => {
		expect(frameHeight('x'.repeat(45), 20)).to.equal(3);
	});

	it('should count an empty line as a row', () => {
		expect(frameHeight('', 20)).to.equal(1);
		expect(frameHeight('a\n\nb', 20)).to.equal(3);
	});

	// counting characters rather than columns wraps a CJK label at twice the
	// width it really does, and the repaint then walks up too few rows
	it('should measure columns rather than characters', () => {
		expect(frameHeight('日'.repeat(10), 20)).to.equal(1);
		expect(frameHeight('日'.repeat(11), 20)).to.equal(2);
	});

	it('should not count a combining mark as a column', () => {
		expect(frameHeight('á'.repeat(20), 20)).to.equal(1);
	});

	it('should survive a width of zero', () => {
		expect(frameHeight('hi', 0)).to.equal(2);
	});
});

describe('createLiveRegion()', () => {
	describe('drawing', () => {
		it('should write the first frame with nothing to erase', () => {
			const { region, stdout } = setup();

			region.render('one');

			expect(stdout.output).to.equal(HIDE_CURSOR + 'one');
		});

		it('should erase the previous frame before the next', () => {
			const { region, stdout } = setup();

			region.render('one');
			stdout.written.length = 0;
			region.render('two');

			expect(stdout.output).to.equal(repaint(1) + 'two');
		});

		// the cursor walks up by the rows the frame occupies, not by its newlines
		it('should walk up the rows a wrapped frame occupied', () => {
			const { region, stdout } = setup({ columns: 10 });

			region.render('x'.repeat(25)); // three rows at ten columns
			stdout.written.length = 0;
			region.render('short');

			expect(stdout.output).to.equal(repaint(3) + 'short');
		});

		it('should count the lines of a multi-line frame', () => {
			const { region, stdout } = setup();

			region.render('a\nb\nc');
			stdout.written.length = 0;
			region.render('d');

			expect(stdout.output).to.equal(repaint(3) + 'd');
		});

		it('should not repaint a frame that did not change', () => {
			const { region, stdout } = setup();

			region.render('same');
			stdout.written.length = 0;
			region.render('same');

			expect(stdout.output).to.equal('');
		});

		it('should hide the cursor while drawing and show it after', () => {
			const { region, stdout } = setup();

			region.render('one');
			expect(stdout.output).to.contain(HIDE_CURSOR);

			region.stop();
			expect(stdout.output).to.contain(SHOW_CURSOR);
		});
	});

	describe('clearing and finishing', () => {
		it('should erase the region on clear', () => {
			const { region, stdout } = setup();

			region.render('one');
			stdout.written.length = 0;
			region.clear();

			expect(stdout.output).to.equal(repaint(1));
		});

		it('should leave nothing behind on stop', () => {
			const { region, stdout } = setup();

			region.render('one');
			stdout.written.length = 0;
			region.stop();

			expect(stdout.output).to.equal(repaint(1) + SHOW_CURSOR);
			expect(region.active).to.equal(false);
		});

		// the frame stays, so the cursor has to come off the end of it or the next
		// thing written lands on its last row
		it('should leave the last frame and move below it on done', () => {
			const { region, stdout } = setup();

			region.render('working');
			stdout.written.length = 0;
			region.done('done!');

			expect(stdout.output).to.equal(repaint(1) + 'done!' + '\n' + SHOW_CURSOR);
			expect(region.active).to.equal(false);
		});

		it('should keep what is on screen when done is given nothing', () => {
			const { region, stdout } = setup();

			region.render('working');
			stdout.written.length = 0;
			region.done();

			expect(stdout.output).to.equal('\n' + SHOW_CURSOR);
		});

		it('should be safe to stop twice', () => {
			const { region, stdout } = setup();

			region.render('one');
			region.stop();
			stdout.written.length = 0;
			region.stop();

			expect(stdout.output).to.equal('');
		});
	});

	describe('output that stays', () => {
		// a console.log() while a spinner runs lands inside the spinner's own line
		it('should write above the region and redraw underneath', () => {
			const { region, stdout } = setup();

			region.render('spinner');
			stdout.written.length = 0;
			region.write('a log line');

			expect(stdout.output).to.equal(repaint(1) + 'a log line\n' + 'spinner');
		});

		it('should add the newline the caller left off', () => {
			const { region, stdout } = setup();

			region.write('no newline');

			expect(stdout.output).to.equal('no newline\n');
		});

		it('should not add a second newline', () => {
			const { region, stdout } = setup();

			region.write('has one\n');

			expect(stdout.output).to.equal('has one\n');
		});

		it('should write straight through when nothing is drawn', () => {
			const { region, stdout } = setup();

			region.write('plain');

			expect(stdout.output).to.equal('plain\n');
		});
	});

	describe('resize', () => {
		// the rows the last frame occupies is not the number it occupied when it
		// was drawn, and there is no way to recover the real one
		it('should clean from where it is rather than walk up a stale count', () => {
			const { region, stdout, terminal } = setup({ columns: 10 });

			region.render('x'.repeat(25));
			stdout.written.length = 0;

			stdout.columns = 40;
			stdout.emit('resize');
			region.render('after');

			expect(terminal.width).to.equal(40);
			expect(stdout.output).to.equal(CURSOR_HOME + ERASE_DOWN + 'after');
		});

		it('should repaint even when the frame is unchanged', () => {
			const { region, stdout } = setup();

			region.render('same');
			stdout.written.length = 0;

			stdout.emit('resize');
			region.render('same');

			expect(stdout.output).to.equal(CURSOR_HOME + ERASE_DOWN + 'same');
		});

		it('should go back to normal repaints afterwards', () => {
			const { region, stdout } = setup();

			region.render('one');
			stdout.emit('resize');
			region.render('two');
			stdout.written.length = 0;
			region.render('three');

			expect(stdout.output).to.equal(repaint(1) + 'three');
		});
	});

	describe('when there is no terminal', () => {
		it('should not move the cursor at all', () => {
			const { region, stdout } = setup({ isTTY: false });

			region.render('one');
			region.render('two');

			expect(stdout.output).to.equal('one\ntwo\n');
			expect(region.isLive).to.equal(false);
		});

		it('should not hide the cursor', () => {
			const { region, stdout } = setup({ isTTY: false });

			region.render('one');

			expect(stdout.output).to.not.contain(HIDE_CURSOR);
		});

		// an animating frame would be a line per tick, which is what `plain` is for
		it('should write one line per change, not one per frame', () => {
			const { region, stdout } = setup({ isTTY: false });

			for (const spin of ['|', '/', '-', '\\']) {
				region.render(`${spin} Building`, 'Building');
			}
			region.render('- Linking', 'Linking');

			expect(stdout.output).to.equal('Building\nLinking\n');
		});

		it('should still write permanent output', () => {
			const { region, stdout } = setup({ isTTY: false });

			region.render('frame', 'plain');
			region.write('a log line');

			expect(stdout.output).to.equal('plain\na log line\n');
		});

		it('should leave the final line on done', () => {
			const { region, stdout } = setup({ isTTY: false });

			region.render('working', 'Building');
			region.done('Built');

			expect(stdout.output).to.equal('Building\nBuilt\n');
		});
	});

	describe('sharing the terminal', () => {
		// a spinner still ticking underneath a prompt draws over it on its next
		// frame, so the second region takes the screen and the first stands down
		it('should clear and stand down when something else claims the region', () => {
			const { region, stdout, terminal } = setup();

			region.render('spinner');
			stdout.written.length = 0;

			const other = createLiveRegion({ terminal });
			other.render('prompt');

			expect(region.active).to.equal(false);
			expect(stdout.output).to.equal(repaint(1) + SHOW_CURSOR + HIDE_CURSOR + 'prompt');
		});

		it('should not draw again once it has been evicted', () => {
			const { region, stdout, terminal } = setup();

			region.render('spinner');
			createLiveRegion({ terminal }).render('prompt');
			stdout.written.length = 0;

			region.render('spinner again');

			expect(stdout.output).to.equal('');
		});
	});
});
