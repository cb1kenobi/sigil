import { pendingIsString } from '../../src/components/keys.js';
import { box, type Element, renderToString, text } from '../../src/element/index.js';
import { main } from '../../src/index.js';
import {
	type CapabilityReply,
	createInput,
	detectCapabilities,
	isCapabilityResponse,
	type KeyEvent,
	parseCapabilityResponse,
	parseReportedColor,
	queryCursor,
	queryMode,
	readCapabilities,
	refineColorLevel,
} from '../../src/input/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * Asking the terminal instead of guessing, and the two things that go wrong.
 *
 * Written with escapes rather than raw bytes throughout, unlike `keys.test.ts`
 * next door: that file is describing a terminal's own bytes, and this one is
 * describing a grammar over them, so there is nothing here that needs an entry in
 * `sources.test.ts`'s allow list.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const CSI = `${ESC}[`;

interface Harness {
	feed: (chunk: string) => void;
	/** Everything written to the terminal, which for a probe is the query. */
	out: string[];
	terminal: Terminal;
	/** Fires the stream's own `end`, which is how a probe finds out it is over. */
	end: () => void;
}

/** A terminal whose stdin is a TTY nothing is typing on. Copied from `input.test.ts`. */
function harness(): Harness {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const out: string[] = [];

	const stdin = {
		isTTY: true,
		off(event: string, fn: (...args: unknown[]) => void) {
			listeners.get(event)?.delete(fn);
			return this;
		},
		on(event: string, fn: (...args: unknown[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(fn);
			return this;
		},
		pause() {
			return this;
		},
		resume() {
			return this;
		},
		setEncoding() {
			return this;
		},
		raw: false,
		setRawMode(mode: boolean) {
			this.raw = mode;
			return this;
		},
	};

	const terminal = createTerminal({
		env: {},
		isTTY: true,
		proc: { on() {}, pid: 1, removeListener() {} } as never,
		stderr: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
		stdin: stdin as never,
		stdout: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
	});

	return {
		end() {
			for (const fn of listeners.get('end') ?? []) {
				fn();
			}
		},
		feed(chunk: string) {
			for (const fn of listeners.get('data') ?? []) {
				fn(chunk);
			}
		},
		out,
		terminal,
	};
}

describe('isCapabilityResponse', () => {
	/**
	 * The shapes no keyboard produces, which is the whole of what may be claimed.
	 */
	const REPLIES: readonly [string, string][] = [
		['DA1', `${CSI}?1;2c`],
		['DA1 with many parameters', `${CSI}?62;1;2;6;9;15;22c`],
		['DA2', `${CSI}>0;95;0c`],
		['DECRPM, a mode that is set', `${CSI}?1006;1$y`],
		['DECRPM, a mode nothing has heard of', `${CSI}?9999;0$y`],
		['DECRPM for an ANSI mode, with no prefix', `${CSI}4;2$y`],
		['a cell size reply', `${CSI}6;20;10t`],
		['a text area reply', `${CSI}4;1080;1920t`],
		['XTVersion', `${ESC}P>|Ghostty 1.0.1${ST}`],
		['an OSC reply ended with BEL', `${ESC}]11;rgb:1111/2222/3333${BEL}`],
		['an OSC reply ended with ST', `${ESC}]11;rgb:1111/2222/3333${ST}`],
		['an OSC reply ended with a C1 ST', `${ESC}]10;rgb:0000/0000/0000\u009c`],
		['an OSC 52 clipboard reply', `${ESC}]52;c;aGVsbG8=${BEL}`],
	];

	it.each(REPLIES)('should claim %s', (_name, sequence) => {
		expect(isCapabilityResponse(sequence)).toBe(true);
	});

	/**
	 * The table that is the feature.
	 *
	 * Claiming one of these loses a key the user pressed, which is the direction
	 * that costs more than a wrong colour level does -- so every shape AGENTS.md
	 * already records as having bitten is here: a CSI whose terminator has not
	 * arrived, a mouse report's `<`, a key pressed while a sequence was half
	 * arrived, and Ctrl-C above all.
	 */
	const KEYS: readonly [string, string][] = [
		['Ctrl-C', '\u0003'],
		['Ctrl-D', '\u0004'],
		['a plain character', 'a'],
		['Enter', '\r'],
		['Tab', '\t'],
		['Escape on its own', ESC],
		['Up', `${CSI}A`],
		['an SS3 arrow', `${ESC}OA`],
		['SS3 F3, which ends on the same byte CPR does', `${ESC}OR`],
		['Ctrl-Up', `${CSI}1;5A`],
		['Shift-Tab', `${CSI}Z`],
		['Delete', `${CSI}3~`],
		['PageUp', `${CSI}5~`],
		['an SGR mouse press', `${CSI}<0;10;5M`],
		['an SGR mouse release', `${CSI}<0;10;5m`],
		['a paste start marker', `${CSI}200~`],
		['a paste end marker', `${CSI}201~`],
		['focus in', `${CSI}I`],
		['focus out', `${CSI}O`],
		['a Kitty keyboard key', `${CSI}97;5u`],
		['a CSI whose terminator has not arrived', CSI],
		['a DECRPM whose intermediate has not arrived', `${CSI}?1006;2`],
		['a DECRPM missing its final byte', `${CSI}?1006;2$`],
		['a bare device attributes request, which nothing replies with', `${CSI}c`],
		['Alt-]', `${ESC}]`],
		['Alt-Shift-P', `${ESC}P`],
		['an OSC whose terminator has not arrived', `${ESC}]11;rgb:1111`],
		['a DCS whose terminator has not arrived', `${ESC}P>|Ghostty`],
		['a window-op reply one parameter short', `${CSI}6;20t`],
		['a cursor position report, which is also Shift-F3', `${CSI}1;2R`],
		['a cursor position report at a plausible cursor', `${CSI}24;80R`],
	];

	it.each(KEYS)('should leave %s alone', (_name, sequence) => {
		expect(isCapabilityResponse(sequence)).toBe(false);
	});

	// the gate and the reading are two questions, and CPR is the one that makes
	// them different: it parses, so a router that asked for one can take it, and it
	// is not claimed unconditionally because nothing about the bytes tells it from
	// Shift-F3
	it('should still read a cursor report it refuses to claim', () => {
		expect(parseCapabilityResponse(`${CSI}24;80R`)).toMatchObject({
			kind: 'cursor',
			params: [24, 80],
		});
	});
});

describe('reading a reply', () => {
	it('should read an OSC command and its payload', () => {
		expect(parseCapabilityResponse(`${ESC}]11;rgb:1111/2222/3333${BEL}`)).toMatchObject({
			kind: 'osc',
			params: [11],
			text: 'rgb:1111/2222/3333',
		});
	});

	it('should read XTVersion off the marker that says it is one', () => {
		expect(parseCapabilityResponse(`${ESC}P>|WezTerm 20240203-110809${ST}`)).toMatchObject({
			kind: 'version',
			text: 'WezTerm 20240203-110809',
		});
	});

	// a DCS that is not XTVersion is an answer to something this does not ask. It
	// is still not a key, which is the only thing the router needs from it
	it('should read an unrecognised control string as a reply all the same', () => {
		const found = parseCapabilityResponse(`${ESC}P1$r0m${ST}`);
		expect(found?.kind).to.equal('string');
		expect(isCapabilityResponse(`${ESC}P1$r0m${ST}`)).toBe(true);
	});

	// an omitted parameter is the zero a terminal means by one, rather than `NaN`
	it('should read an omitted parameter as zero', () => {
		expect(parseCapabilityResponse(`${CSI}?;2$y`)?.params).toEqual([0, 2]);
	});
});

describe('what a reply says about colour', () => {
	const VERSIONS: readonly [string, string, string | undefined][] = [
		['Ghostty 1.0.1', 'ghostty', '1.0.1'],
		['kitty 0.32.2', 'kitty', '0.32.2'],
		['foot(1.16.2)', 'foot', '1.16.2'],
		['XTerm(390)', 'xterm', '390'],
		['tmux 3.4', 'tmux', '3.4'],
		['contour', 'contour', undefined],
	];

	it.each(VERSIONS)('should read %s as a name and a version', (text, name, version) => {
		const caps = readCapabilities([reply(`${ESC}P>|${text}${ST}`)]);
		expect(caps.name).to.equal(name);
		expect(caps.version).to.equal(version);
	});

	// upwards only, and never off a floor of zero. Both halves are the same rule
	// the degrader keeps: a level of zero is what `NO_COLOR` and a pipe produce,
	// and a probe that raised it would override a choice already made
	it('should raise a level a known terminal contradicts', () => {
		expect(refineColorLevel('ghostty', 2)).to.equal(3);
	});

	it('should leave a level of zero alone, whatever the terminal is', () => {
		expect(refineColorLevel('ghostty', 0)).toBeUndefined();
	});

	it('should never lower a level', () => {
		expect(refineColorLevel('tmux', 3)).toBeUndefined();
		expect(refineColorLevel('ghostty', 3)).toBeUndefined();
	});

	// the instructive omission: xterm answers XTVersion from patch 331 and renders
	// direct colour only with the `-direct` terminfo, which `supportsColor()`
	// already reads. Claiming it would raise the level for every ordinary
	// `xterm-256color` session on the strength of a reply about something else
	it('should not read xterm as a promise of truecolour', () => {
		expect(refineColorLevel('xterm', 2)).toBeUndefined();
	});

	it('should read a cell size and a text area out of the right reply', () => {
		const caps = readCapabilities([reply(`${CSI}6;20;10t`), reply(`${CSI}4;1080;1920t`)]);
		expect(caps.cell).toEqual({ height: 20, width: 10 });
		expect(caps.pixels).toEqual({ height: 1080, width: 1920 });
	});

	it('should say when nothing answered at all', () => {
		const caps = readCapabilities([], 2);
		expect(caps.responded).toBe(false);
		expect(caps.colorLevel).toBeUndefined();
	});
});

function reply(sequence: string): CapabilityReply {
	const found = parseCapabilityResponse(sequence);
	if (!found) {
		throw new Error(`not a reply: ${JSON.stringify(sequence)}`);
	}
	return found;
}

describe('the router as a query mechanism', () => {
	it('should write the query and resolve on the reply', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });

		const promise = router.query({
			until: (it) => it.kind === 'device',
			write: `${CSI}c`,
		});
		expect(h.out.join('')).to.contain(`${CSI}c`);

		h.feed(`${CSI}?1;2c`);
		const replies = await promise;
		expect(replies.map((it) => it.kind)).toEqual(['device']);
		router.stop();
	});

	it('should keep a reply out of every handler a key would reach', async () => {
		const h = harness();
		const focused = box({ focusable: true }, text('field'));
		const root = box({}, focused);
		const router = createInput({ paste: false, root, terminal: h.terminal });
		router.focus.focus(focused);

		const bound: string[] = [];
		const onKey: string[] = [];
		router.bind((event: KeyEvent) => void bound.push(event.key.sequence));
		focused.onKey = (event: KeyEvent) => void onKey.push(event.key.sequence);

		const promise = router.query({ until: () => true, write: `${CSI}c` });
		// the reply, then a real key, in one chunk -- which is what a terminal that
		// answers while somebody is typing actually sends
		h.feed(`${CSI}?1;2c` + 'x');
		await promise;

		expect(bound, 'a reply reached a binding').toEqual(['x']);
		expect(onKey, 'a reply reached the focused element').toEqual(['x']);
		router.stop();
	});

	// the failure this whole path is for, measured on the decoder before it was
	// fixed: an OSC 11 reply came through as twenty-three keys, of which a text
	// prompt inserted twenty-one
	it('should keep an OSC reply out of the keys, whole', async () => {
		const h = harness();
		const seen: string[] = [];
		const router = createInput({ paste: false, terminal: h.terminal });
		router.bind((event: KeyEvent) => void seen.push(event.key.sequence));

		const promise = router.query({ until: () => true, write: `${ESC}]11;?${ST}` });
		h.feed(`${ESC}]11;rgb:1c1c/1c1c/1c1c${BEL}`);
		const replies = await promise;

		expect(seen).toEqual([]);
		expect(replies[0]?.text).to.equal('rgb:1c1c/1c1c/1c1c');
		router.stop();
	});

	// the split read, which is the one case the decoder's default cannot answer:
	// with `ESC ]` alone there is nothing left to go on, and only a reader that
	// asked knows it is not Alt-]
	it('should hold a reply whose read split at the introducer', async () => {
		const h = harness();
		const seen: string[] = [];
		const router = createInput({ paste: false, terminal: h.terminal });
		router.bind((event: KeyEvent) => void seen.push(event.key.sequence));

		const promise = router.query({ until: () => true, write: `${ESC}]11;?${ST}` });
		h.feed(`${ESC}]`);
		h.feed(`11;rgb:0000/0000/0000${BEL}`);
		const replies = await promise;

		expect(seen, 'the introducer was read as Alt-]').toEqual([]);
		expect(replies[0]?.params).toEqual([11]);
		router.stop();
	});

	it('should still read Alt-] as a key when nothing was asked', async () => {
		const h = harness();
		const seen: string[] = [];
		const router = createInput({ paste: false, terminal: h.terminal });
		router.bind((event: KeyEvent) => void seen.push(event.key.name));

		h.feed(`${ESC}]`);
		expect(seen).toEqual([']']);
		router.stop();
	});

	it('should resolve with nothing when the terminal says nothing', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const router = createInput({ paste: false, terminal: h.terminal });
			const promise = router.query({ timeout: 20, write: `${CSI}c` });
			await vi.advanceTimersByTimeAsync(21);
			expect(await promise).toEqual([]);
			router.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// a cursor report is claimed only while a request for one is outstanding,
	// because `CSI 1 ; 2 R` is byte for byte Shift-F3
	it('should take a cursor report only for a query that asked for one', async () => {
		const h = harness();
		const seen: string[] = [];
		const router = createInput({ paste: false, terminal: h.terminal });
		router.bind((event: KeyEvent) => void seen.push(event.key.sequence));

		h.feed(`${CSI}1;2R`);
		expect(seen, 'Shift-F3 was swallowed with nothing outstanding').toEqual([`${CSI}1;2R`]);

		const at = await Promise.all([
			queryCursor(router, { timeout: 50 }),
			Promise.resolve().then(() => h.feed(`${CSI}12;34R`)),
		]);
		expect(at[0]).toEqual({ column: 34, row: 12 });
		expect(seen, 'the report reached a binding as well').toEqual([`${CSI}1;2R`]);
		router.stop();
	});

	it('should read a mode state back, and tell "off" from "never heard of it"', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });

		const set = await Promise.all([
			queryMode(router, 2004, { timeout: 50 }),
			Promise.resolve().then(() => h.feed(`${CSI}?2004;1$y`)),
		]);
		expect(set[0]).to.equal('set');

		const unknown = await Promise.all([
			queryMode(router, 9999, { timeout: 50 }),
			Promise.resolve().then(() => h.feed(`${CSI}?9999;0$y`)),
		]);
		expect(unknown[0]).to.equal('unrecognised');

		// nothing at all is not the same answer as `unrecognised`, which is itself a
		// reply: a terminal that does not implement DECRQM answers only the sentinel.
		// The timeout here is long enough that reaching it would fail the test rather
		// than pass it slowly, which is what makes this the sentinel's own assertion
		const silent = await Promise.all([
			queryMode(router, 1006, { timeout: 10_000 }),
			Promise.resolve().then(() => h.feed(`${CSI}?1;2c`)),
		]);
		expect(silent[0]).toBeUndefined();
		router.stop();
	});

	// three things settle a query -- the reply, the deadline, and the router
	// stopping -- and a probe left outstanding is a promise nobody settles, with a
	// frame usually waiting on it
	it('should settle an outstanding query when the router stops', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });
		const promise = router.query({ timeout: 10_000, write: `${CSI}c` });
		router.stop();
		expect(await promise).toEqual([]);
	});

	it('should settle an outstanding query when the stream ends', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });
		const promise = router.query({ timeout: 10_000, write: `${CSI}c` });
		h.end();
		expect(await promise).toEqual([]);
		router.stop();
	});

	it('should write nothing for a query on a router that has stopped', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });
		router.stop();
		const before = h.out.length;
		expect(await router.query({ write: `${CSI}c` })).toEqual([]);
		expect(h.out.length).to.equal(before);
	});

	// put back what you attached: a probe arms a timer, and one left running is a
	// timer firing into a router that has gone
	it('should leave no timer behind', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const router = createInput({ paste: false, terminal: h.terminal });
			const promise = router.query({ timeout: 100, until: () => true, write: `${CSI}c` });
			h.feed(`${CSI}?1;2c`);
			await promise;
			expect(vi.getTimerCount(), 'the deadline outlived the reply').to.equal(0);

			const second = router.query({ timeout: 100, write: `${CSI}c` });
			router.stop();
			await second;
			expect(vi.getTimerCount(), 'the deadline outlived the router').to.equal(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('the batched probe', () => {
	it('should write every query it was asked for, and DA1 last', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });

		const promise = detectCapabilities(router, { background: true, geometry: true, timeout: 50 });
		const written = h.out.join('');
		expect(written).to.contain(`${CSI}>q`);
		expect(written).to.contain(`${ESC}]11;?`);
		expect(written).to.contain(`${CSI}16t`);
		expect(written).to.contain(`${CSI}14t`);
		expect(written.endsWith(`${CSI}c`), written).toBe(true);

		h.feed(`${ESC}P>|Ghostty 1.0.1${ST}${CSI}?62;c`);
		const caps = await promise;
		expect(caps.name).to.equal('ghostty');
		router.stop();
	});

	it('should ask nothing it was not asked to ask', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });
		const promise = detectCapabilities(router, { timeout: 50, version: false });
		expect(h.out.join('')).to.equal(`${CSI}c`);
		h.feed(`${CSI}?1;2c`);
		await promise;
		router.stop();
	});

	// the sentinel is what turns a deadline into a round trip: DA1 is the one query
	// every terminal answers, so its reply means everything before it is answered
	// or never will be
	it('should finish on the sentinel rather than on the timeout', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const router = createInput({ paste: false, terminal: h.terminal });
			const promise = detectCapabilities(router, { timeout: 10_000 });
			h.feed(`${CSI}?1;2c`);
			const caps = await promise;
			expect(caps.responded).toBe(true);
			expect(caps.name, 'a terminal that answered nothing was given a name').toBeUndefined();
			expect(vi.getTimerCount()).to.equal(0);
			router.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('nothing probes unless a renderer mounted', () => {
	/**
	 * The test the whole startup-cost argument rests on.
	 *
	 * A CLI must not pay a round trip to print one line, so the things a CLI does
	 * before it has decided to be an app -- parse, fail, print help, build a string
	 * -- must write no query at all. Asserted as *zero bytes on stdin's behalf*
	 * rather than as "no capability sequence", because a query is the only reason
	 * any of these would write to the input side of a terminal at all.
	 */
	const QUERIES = [`${CSI}c`, `${CSI}>q`, `${CSI}6n`, `${CSI}14t`, `${CSI}16t`, `${ESC}]11;?`];

	const probed = (written: string): string[] => QUERIES.filter((q) => written.includes(q));

	it('should write no query for a parse', async () => {
		const out: string[] = [];
		const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		});
		const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		});
		try {
			await main({
				argv: ['--verbose'],
				schema: {
					name: 'probe',
					options: { '--verbose': {} },
					commands: { real: { run() {} } },
				},
			});
			// and a parse that fails, which is the other half: an error path that
			// probed would be a round trip paid to print a message
			await main({ argv: ['nope'], schema: { name: 'probe', commands: { real: { run() {} } } } });
		} finally {
			write.mockRestore();
			err.mockRestore();
		}

		expect(probed(out.join('')), out.join('')).toEqual([]);
	});

	it('should write no query for a help screen or a string render', () => {
		const out: string[] = [];
		const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		});
		try {
			const tree: Element = box({ 'flex-direction': 'column' }, text('one'), text('two'));
			out.push(renderToString(tree, { width: 40 }));
		} finally {
			write.mockRestore();
		}

		expect(probed(out.join(''))).toEqual([]);
	});

	it('should not put the query machinery on the root entry', async () => {
		// the import-graph half of the same claim, and the one that catches somebody
		// adding a convenience re-export: `src/index.ts` must not reach the router
		const root = await import('../../src/index.js');
		expect(Object.keys(root)).not.toContain('createInput');
		expect(Object.keys(root)).not.toContain('detectCapabilities');
	});
});

describe('a probe that goes wrong', () => {
	// this runs inside the stream's own `data` listener, so a predicate that throws
	// and is let through is an uncaught exception -- with the query still
	// outstanding, its deadline still armed, and the decoder still reading an
	// `ESC ]` as an answer rather than as Alt-]
	it('should end its own probe rather than the process when until() throws', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const router = createInput({ paste: false, terminal: h.terminal });
			const promise = router.query({
				timeout: 10_000,
				until() {
					throw new Error('nope');
				},
				write: `${CSI}c`,
			});

			expect(() => h.feed(`${CSI}?1;2c`)).not.toThrow();
			const replies = await promise;
			expect(replies.map((it) => it.kind)).toEqual(['device']);
			expect(vi.getTimerCount(), 'the deadline outlived the throw').to.equal(0);

			// and the decoder is back to reading an introducer as the key it is
			const seen: string[] = [];
			router.bind((event: KeyEvent) => void seen.push(event.key.name));
			h.feed(`${ESC}]`);
			expect(seen).toEqual([']']);
			router.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// the question is asked before anything is registered, so a write that fails
	// outright cannot leave a deadline running behind it
	it('should arm nothing when the query could not be written', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });
		// the far end going away is what `terminal.write()` reports as `false`
		(h.terminal as unknown as { write(): boolean }).write = () => false;

		expect(await router.query({ timeout: 10_000, write: `${CSI}c` })).toEqual([]);
		// and the decoder never went into "an introducer is an answer" mode, which is
		// what a leaked query would have left behind
		const seen: string[] = [];
		router.bind((event: KeyEvent) => void seen.push(event.key.name));
		h.feed(`${ESC}]`);
		expect(seen).toEqual([']']);
		router.stop();
	});
});

describe('a reply whose read split at the introducer', () => {
	/**
	 * The one route the framing does not close on its own, found by review.
	 *
	 * `ESC ]` alone is Alt-] to anything that has not asked a question, so the
	 * router holds it while a query is open -- and the key timeout used to flush it
	 * fifty milliseconds later, after which the payload arrived as a chunk with no
	 * introducer in front of it and went into the answer a character at a time. The
	 * introducer itself was never the damage: it decodes as `unknown`, and a prompt
	 * inserts only a key whose name is its own sequence.
	 */
	it('should wait for the payload on the query deadline rather than the key one', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const seen: string[] = [];
			const router = createInput({ paste: false, terminal: h.terminal });
			router.bind((event: KeyEvent) => void seen.push(event.key.sequence));

			const promise = router.query({ timeout: 250, until: () => true, write: `${ESC}]11;?${ST}` });
			h.feed(`${ESC}]`);

			// four times the key timeout and inside the query's, which is the window a
			// laggy link opens and in which the payload used to be lost
			await vi.advanceTimersByTimeAsync(200);
			h.feed(`11;rgb:1c1c/1c1c/1c1c${BEL}`);

			const replies = await promise;
			expect(seen, 'the payload was typed in').toEqual([]);
			expect(replies[0]?.text).to.equal('rgb:1c1c/1c1c/1c1c');
			router.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// and the held introducer goes back to being a key once nothing is waiting for a
	// reply, rather than sitting there until the next chunk arrives
	it('should give a held introducer back as Alt-] when the last query goes', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const seen: string[] = [];
			const router = createInput({ paste: false, terminal: h.terminal });
			router.bind((event: KeyEvent) => void seen.push(event.key.name));

			const promise = router.query({ timeout: 250, write: `${ESC}]11;?${ST}` });
			h.feed(`${ESC}]`);
			expect(seen).toEqual([]);

			await vi.advanceTimersByTimeAsync(250);
			await promise;
			await vi.advanceTimersByTimeAsync(60);

			expect(seen, 'the introducer was swallowed for good').toEqual([']']);
			expect(vi.getTimerCount()).to.equal(0);
			router.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// a half-arrived *key* keeps the fifty milliseconds, whatever is outstanding:
	// what follows an `ESC [` may be the Ctrl-C somebody is pressing to get out
	it('should not make a half-arrived key wait on a probe', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const seen: string[] = [];
			const router = createInput({ paste: false, terminal: h.terminal });
			router.bind((event: KeyEvent) => void seen.push(event.key.name));

			const promise = router.query({ timeout: 10_000, write: `${CSI}c` });
			h.feed(`${CSI}`);
			await vi.advanceTimersByTimeAsync(60);
			expect(seen, 'a held key waited on the probe').toHaveLength(1);

			router.stop();
			await promise;
		} finally {
			vi.useRealTimers();
		}
	});

	// `stop()` clears the held tail and the escape timer, and `consume()` then
	// carried on through the rest of the chunk it was part way through and armed a
	// new one -- a timer firing into a router with no listeners, dispatching to the
	// bindings `stop()` does not remove. A Ctrl-C binding that stops the router is
	// the ordinary way to reach it
	it('should read nothing more once it has stopped', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const seen: string[] = [];
			const router = createInput({ paste: false, terminal: h.terminal });
			router.bind((event: KeyEvent) => {
				seen.push(event.key.name);
				if (event.key.ctrl && event.key.name === 'c') {
					router.stop();
				}
			});

			h.feed(`\u0003${CSI}200~${CSI}201~${ESC}`);
			await vi.advanceTimersByTimeAsync(60);

			expect(seen, 'bytes after the stop were still routed').toEqual(['c']);
			expect(vi.getTimerCount(), 'a timer outlived the router').to.equal(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// the same thing one iteration in, which is why the loop asks as well as the
	// entry: a paste bracketed later in the very chunk that stopped the router was
	// still flushed to the handlers `stop()` does not remove
	it('should not flush a paste that arrived in the chunk that stopped it', () => {
		const h = harness();
		const seen: string[] = [];
		const router = createInput({ terminal: h.terminal });
		router.bind((event: KeyEvent) => {
			seen.push(event.key.name);
			if (event.key.ctrl && event.key.name === 'c') {
				router.stop();
			}
		});

		h.feed(`\u0003${CSI}200~abc${CSI}201~`);
		expect(seen).toEqual(['c']);
	});
});

describe('what round two found', () => {
	// the sentinel is written last, so its reply normally arrives last -- but a
	// multiplexer that answers for itself can put the DA1 in front of a reply in the
	// *same chunk*, and a probe that settled on the spot had stopped collecting by
	// the time the next key was routed. `takeReply()` claims it either way, so the
	// reply was dropped rather than read
	it('should collect a reply that arrives after the sentinel in one chunk', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });
		const promise = detectCapabilities(router, { timeout: 50 });

		h.feed(`${CSI}?62;1;2c${ESC}P>|Ghostty 1.0.1${ST}`);
		const caps = await promise;
		expect(caps.name, 'the version was dropped rather than read').to.equal('ghostty');
		router.stop();
	});

	// `keys()` clears the timer on the way in, and then a query settling *during* the
	// routing arms one of its own -- so assigning over it dropped the handle to a
	// timer that was still queued, which then fired into a hold it was never about
	it('should leave exactly one expiry armed when a chunk both settles and holds', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const router = createInput({ paste: false, terminal: h.terminal });
			const promise = router.query({
				timeout: 10_000,
				until: (it) => it.kind === 'device',
				write: `${CSI}c`,
			});

			// the reply and a lone Escape in one chunk: the query settles and the `ESC`
			// is held, so both paths want to arm a timer
			h.feed(`${CSI}?1;2c${ESC}`);
			await promise;
			expect(vi.getTimerCount(), 'two timers were armed for one hold').to.equal(1);

			await vi.advanceTimersByTimeAsync(60);
			expect(vi.getTimerCount()).to.equal(0);
			router.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// Alt held over a reply still arriving used to report itself as a half-arrived
	// key, and a caller reading that picks the key deadline for a reply
	it('should carry the control-string flag through an Alt wrapper', () => {
		expect(pendingIsString(`${ESC}${ESC}]11;rgb:1111`, { strings: true })).toBe(true);
		expect(pendingIsString(`${ESC}${CSI}1;`, { strings: true })).toBe(false);
	});

	// tmux answers XTVersion itself and can pass the outer terminal's answer through
	// as well. Since a refinement only ever raises, the permissive reading is the
	// safe one: taking the first would let a `tmux 3.4` hide the terminal behind it
	it('should refine off any version reply, not only the first', () => {
		const caps = readCapabilities(
			[reply(`${ESC}P>|tmux 3.4${ST}`), reply(`${ESC}P>|Ghostty 1.1.0${ST}`)],
			2
		);
		expect(caps.name, 'the first is what the terminal in front of us said').to.equal('tmux');
		expect(caps.colorLevel).toBe(3);
	});

	// `name` is already the first token with any `(version)` off, so a prefix test
	// buys nothing and reads a terminal called `footer` as `foot`
	it('should match a terminal name whole rather than by prefix', () => {
		expect(refineColorLevel('footer', 2)).toBeUndefined();
		expect(refineColorLevel('foot', 2)).toBe(3);
	});

	// one of the keys in a chunk may be the Ctrl-C that stops the router
	it('should route nothing after a key stopped it mid-chunk', () => {
		const h = harness();
		const seen: string[] = [];
		const router = createInput({ paste: false, terminal: h.terminal });
		router.bind((event: KeyEvent) => {
			seen.push(event.key.name);
			if (event.key.ctrl && event.key.name === 'c') {
				router.stop();
			}
		});

		h.feed('\u0003hello');
		expect(seen).toEqual(['c']);
	});
});

describe('the background the terminal reports', () => {
	/**
	 * The components come back **sixteen bits per channel** in the common reply
	 * form, and they are *scaled* rather than truncated. Truncating reads
	 * `rgb:1c1c/1c1c/1c1c` as 0x1c only by luck: a terminal answering `rgb:1/2/3`,
	 * which is legal and means full scale over one hex digit, would come out almost
	 * black.
	 */
	const COLORS: readonly [string, number, number, number][] = [
		['rgb:ffff/ffff/ffff', 255, 255, 255],
		['rgb:0000/0000/0000', 0, 0, 0],
		['rgb:1c1c/1c1c/1c1c', 28, 28, 28],
		['rgb:fdfd/f6f6/e3e3', 253, 246, 227],
		// one digit per channel, where `f` is full scale rather than 15/255
		['rgb:f/f/f', 255, 255, 255],
		['rgb:0/8/f', 0, 136, 255],
		// two digits, which is also full scale at `ff`
		['rgb:ff/80/00', 255, 128, 0],
		['rgba:ffff/0000/0000/ffff', 255, 0, 0],
		['#ff8800', 255, 136, 0],
	];

	it.each(COLORS)('should read %s', (text, r, g, b) => {
		expect(parseReportedColor(text)).toEqual({ b, g, r });
	});

	// a terminal may legally answer with an X11 colour name, and resolving one needs
	// a database this does not have -- so it is no answer rather than a guess
	it('should read nothing out of a shape it does not know', () => {
		expect(parseReportedColor('white')).toBeUndefined();
		expect(parseReportedColor('')).toBeUndefined();
		expect(parseReportedColor('rgb:1/2')).toBeUndefined();
		expect(parseReportedColor('rgb:ggggg/0/0')).toBeUndefined();
	});

	it('should turn an OSC 11 reply into a scheme', () => {
		const dark = readCapabilities([reply(`${ESC}]11;rgb:1c1c/1c1c/1c1c${BEL}`)]);
		expect(dark.background).toEqual({ b: 28, g: 28, r: 28 });
		expect(dark.colorScheme).to.equal('dark');

		const light = readCapabilities([reply(`${ESC}]11;rgb:fdfd/f6f6/e3e3${ST}`)]);
		expect(light.colorScheme).to.equal('light');
	});

	// the first, because a terminal answers a question once and anything after it is
	// somebody else's answer to the same one -- tmux again
	it('should take the first background and ignore a second', () => {
		const caps = readCapabilities([
			reply(`${ESC}]11;rgb:0000/0000/0000${BEL}`),
			reply(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`),
		]);
		expect(caps.colorScheme).to.equal('dark');
	});

	it('should say nothing about a scheme when nothing answered', () => {
		expect(readCapabilities([reply(`${CSI}?1;2c`)]).colorScheme).toBeUndefined();
	});

	// an OSC 10 reply is the foreground and answers a different question
	it('should not read a foreground reply as a background', () => {
		expect(
			readCapabilities([reply(`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`)]).colorScheme
		).toBeUndefined();
	});

	it('should ask for the background only when asked to', async () => {
		const h = harness();
		const router = createInput({ paste: false, terminal: h.terminal });

		const without = detectCapabilities(router, { timeout: 50 });
		expect(h.out.join('')).not.to.contain(`${ESC}]11;?`);
		h.feed(`${CSI}?1;2c`);
		await without;

		h.out.length = 0;
		const withIt = detectCapabilities(router, { background: true, timeout: 50 });
		expect(h.out.join('')).to.contain(`${ESC}]11;?`);
		h.feed(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}${CSI}?1;2c`);
		expect((await withIt).colorScheme).to.equal('light');
		router.stop();
	});
});

describe('what round one of SIG-109 found', () => {
	// the first one that can be *read*, which is not the first: a terminal may
	// legally answer `white`, and giving up there throws away a second reply that
	// does say something
	it('should fall through a reply it cannot read to one it can', () => {
		const caps = readCapabilities([
			reply(`${ESC}]11;white${BEL}`),
			reply(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`),
		]);
		expect(caps.colorScheme).to.equal('light');
	});

	// and a readable one still closes the question
	it('should not let a later reply replace one it already read', () => {
		const caps = readCapabilities([
			reply(`${ESC}]11;rgb:0000/0000/0000${BEL}`),
			reply(`${ESC}]11;white${BEL}`),
			reply(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`),
		]);
		expect(caps.colorScheme).to.equal('dark');
	});

	/**
	 * X11 defines the `#` form at four widths, and each digit group is a fraction of
	 * its *own* full scale -- so `#fff` is white rather than `#0f0f0f`. The same rule
	 * `rgb:` follows, through the same function.
	 */
	const HASHES: readonly [string, number][] = [
		['#fff', 255],
		['#ffffff', 255],
		['#fffffffff', 255],
		['#ffffffffffff', 255],
		['#000', 0],
		['#888', 136],
		['#888888', 136],
	];

	it.each(HASHES)('should read %s as a grey of %i', (text, v) => {
		expect(parseReportedColor(text)).toEqual({ b: v, g: v, r: v });
	});

	it('should refuse a hash of a width X11 does not define', () => {
		// the widths are 3, 6, 9 and 12 digits -- one to four per channel -- so
		// anything that is not a multiple of three is not one of them
		expect(parseReportedColor('#ffff')).toBeUndefined();
		expect(parseReportedColor('#ff')).toBeUndefined();
		expect(parseReportedColor('#ffffffff')).toBeUndefined();
		expect(parseReportedColor('#fffffffffffffff')).toBeUndefined();
	});

	// one digit per channel is a fraction of 15, so `rgb:8/8/8` and `rgb:08/08/08`
	// are different colours -- which is the X11 rule and is surprising enough to pin
	it('should read a digit width as its own full scale', () => {
		expect(parseReportedColor('rgb:8/8/8')).toEqual({ b: 136, g: 136, r: 136 });
		expect(parseReportedColor('rgb:08/08/08')).toEqual({ b: 8, g: 8, r: 8 });
	});
});
