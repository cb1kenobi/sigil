import { decodeKeys, KEY_NAMES, type Key } from '../../src/components/keys.js';
import { box, type Element, text } from '../../src/element/index.js';
import {
	createInput,
	ESCAPE_TIMEOUT,
	formatKey,
	formatKeys,
	type InputRouter,
	KeySpecError,
	parseKeys,
	SEQUENCE_TIMEOUT,
} from '../../src/input/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * Key sequences: the grammar, the trie, and what the router does with a pending
 * one.
 *
 * The grammar and the trie are testable with a literal `Key` and no terminal at
 * all, which is what `sequence.ts` importing nothing but the decoder's name
 * table buys. The router half is driven by feeding bytes, which is how every
 * other test in this directory drives it.
 */

const ESC = '\u001b';

interface Harness {
	feed: (chunk: string) => void;
	terminal: Terminal;
}

/** A terminal whose stdin is a TTY nothing is typing on. */
function harness(): Harness {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

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
		stderr: { isTTY: true, write: () => true } as never,
		stdin: stdin as never,
		stdout: { isTTY: true, write: () => true } as never,
	});

	return {
		feed(chunk: string) {
			for (const fn of listeners.get('data') ?? []) {
				fn(chunk);
			}
		},
		terminal,
	};
}

/**
 * Presses Escape, which costs the *other* deadline.
 *
 * A chunk ending in `ESC` is held as a partial key whatever else is true: a
 * terminal sends Alt-x as `ESC` then `x` in one write, so a read that split puts
 * the `x` in the next chunk. The Escape key therefore does not exist until
 * `ESCAPE_TIMEOUT` has passed, which is the key pending state paying for itself
 * and is why every test about Escape here needs a clock. Needs fake timers.
 */
function pressEscape(h: Harness, bytes = ESC): void {
	h.feed(bytes);
	vi.advanceTimersByTime(ESCAPE_TIMEOUT);
}

/** Two focusable boxes, so that a sequence can be half-entered into one. */
function tree(): { first: Element; root: Element; second: Element } {
	const first = box({ focusable: true }, text('one'));
	const second = box({ focusable: true }, text('two'));
	return { first, root: box({}, first, second), second };
}

describe('a key spec', () => {
	it('should read a sequence as one pattern per key', () => {
		expect(parseKeys('g g')).to.deep.equal([
			{ ctrl: false, meta: false, name: 'g', shift: false },
			{ ctrl: false, meta: false, name: 'g', shift: false },
		]);
	});

	it('should read any amount of whitespace between keys', () => {
		expect(parseKeys('  ctrl+x \t ctrl+s  ').map((it) => formatKey(it))).to.deep.equal([
			'ctrl+x',
			'ctrl+s',
		]);
	});

	// a keyword, so it is read in any case -- the rule a property name and
	// `inherit` already follow
	it('should take the modifiers in any order and in any case', () => {
		expect(formatKey(parseKeys('Shift+CTRL+tab')[0] as Key)).to.equal('ctrl+shift+tab');
		expect(formatKey(parseKeys('ctrl+shift+tab')[0] as Key)).to.equal('ctrl+shift+tab');
	});

	// three names for the bit xterm reports in one place
	it('should read alt, meta and option as one modifier', () => {
		for (const spec of ['alt+a', 'meta+a', 'OPTION+a']) {
			expect(formatKey(parseKeys(spec)[0] as Key), spec).to.equal('alt+a');
		}
	});

	// `'ctrl++'.split('+')` is three pieces and two of them are blank, so a
	// splitter has to decide which blank is the key. Stripping prefixes has
	// nothing to decide
	it('should read a key that is itself a separator', () => {
		expect(parseKeys('ctrl++')[0]).to.deep.equal({
			ctrl: true,
			meta: false,
			name: '+',
			shift: false,
		});
		expect(parseKeys('+')[0]?.name).to.equal('+');
		expect(parseKeys('ctrl+-')[0]?.name).to.equal('-');
	});

	// the byte is the same one and `readOne()` names it from `code + 0x60`, which
	// is always lower case, so the two spellings are one key press
	it('should read ctrl with an upper-case letter as the same key', () => {
		expect(formatKey(parseKeys('ctrl+X')[0] as Key)).to.equal('ctrl+x');
		expect(formatKey(parseKeys('ctrl+x')[0] as Key)).to.equal('ctrl+x');
	});

	// and that normalization is only for a character: `ctrl+up` is a real
	// sequence a terminal sends, and lower-casing a name it already produced
	// would be a second answer to what the decoder said
	it('should leave a named key alone under ctrl', () => {
		expect(formatKey(parseKeys('CTRL+Up')[0] as Key)).to.equal('ctrl+up');
	});

	// the legacy encoding never reports shift for a plain character, so
	// `shift+a` is a binding that can never fire -- refused where it is written,
	// which is what `initOption()` does with a `...` hint on an option
	it('should refuse shift with a character, naming what to write instead', () => {
		expect(() => parseKeys('shift+a')).toThrow(/write "A"/);
		expect(() => parseKeys('ctrl+shift+a')).toThrow(KeySpecError);
		// and the one place a terminal really does report it is still bindable
		expect(parseKeys('shift+tab')[0]?.shift).to.equal(true);
	});

	it('should refuse a name of more than one character that is not a key', () => {
		expect(() => parseKeys('escap')).toThrow(/Unknown key name "escap"/);
		expect(() => parseKeys('g gg')).toThrow(KeySpecError);
	});

	/**
	 * What the decoder calls a sequence it has no key for, so a binding on it
	 * would fire on whatever the terminal happened to send.
	 *
	 * Refused by the name check rather than by a guard of its own: `unknown` is
	 * produced inline rather than out of either table, so it is not in
	 * `KEY_NAMES`. The property is what is asserted, so the day somebody puts it
	 * in a table this fails rather than going quiet.
	 */
	it('should refuse "unknown", which is not a key', () => {
		expect(KEY_NAMES.has('unknown')).to.equal(false);
		expect(() => parseKeys('unknown')).toThrow(KeySpecError);
		expect(() => parseKeys('alt+unknown')).toThrow(KeySpecError);
	});

	it('should refuse a repeated modifier, including under two of its names', () => {
		expect(() => parseKeys('ctrl+ctrl+a')).toThrow(/Repeated modifier/);
		expect(() => parseKeys('alt+meta+a')).toThrow(/Repeated modifier/);
	});

	/**
	 * A token with no `+` in it at all is a name, which is one `indexOf` away from
	 * being an endless loop.
	 *
	 * `indexOf` answers `-1`, and a loop that read `plus < 1` would then ask
	 * whether `slice(0, -1)` is a modifier -- which for `ctrlX` it is, so the
	 * modifier is taken, `slice(plus + 1)` strips nothing, and it goes round
	 * again. The repeated-modifier check happens to turn that into the wrong
	 * error rather than a hang, which is the masking this repository records: two
	 * guards covering each other means removing either fails nothing. So this
	 * asserts the *message*, which only the right reading produces.
	 */
	it('should read a token with no separator as a name rather than looping on it', () => {
		for (const spec of ['ctrlX', 'shifts', 'altz', 'metaa']) {
			expect(() => parseKeys(spec), spec).toThrow(/Unknown key name/);
		}
	});

	it('should refuse an empty spec and a modifier with no key after it', () => {
		expect(() => parseKeys('')).toThrow(/names no key/);
		expect(() => parseKeys('   ')).toThrow(/names no key/);
		expect(() => parseKeys('g ctrl+')).toThrow(/Missing key name/);
	});

	// on a plain object `constructor` reads back a truthy function, so this
	// would have been a spec with a modifier nobody declared
	it('should refuse an inherited property as a modifier', () => {
		expect(() => parseKeys('constructor+a')).toThrow(KeySpecError);
		expect(() => parseKeys('__proto__+a')).toThrow(KeySpecError);
		// and `toString` is a name rather than a modifier, so it fails as one
		expect(() => parseKeys('toString')).toThrow(/Unknown key name/);
	});

	// by code point rather than by code unit, which is the rule `readOne()`
	// already keeps where it reads `codePointAt` rather than `input[start]`
	it('should read an astral character as one key', () => {
		expect(parseKeys('👍')[0]?.name).to.equal('👍');
		expect(formatKey(parseKeys('alt+👍')[0] as Key)).to.equal('alt+👍');
	});

	it('should print a sequence with one space between its keys', () => {
		expect(formatKeys(parseKeys('ctrl+x ctrl+s'))).to.equal('ctrl+x ctrl+s');
		expect(formatKeys([])).to.equal('');
	});

	/**
	 * The spelling is one spelling, which is what makes the trie a `Map`.
	 *
	 * Asserted against the **decoder** rather than against literals: a spec and a
	 * live key are looked up by the same function, so what has to hold is that
	 * `formatKey()` of what the terminal sent equals `formatKey()` of what the
	 * app wrote. A pair of literals could agree while both were wrong about the
	 * bytes.
	 */
	it('should spell what the terminal sent the way a spec spells it', () => {
		const pairs: [string, string][] = [
			['g', 'g'],
			['A', 'A'],
			['\u0018', 'ctrl+x'],
			['\u0013', 'ctrl+s'],
			['\u0003', 'ctrl+c'],
			['\r', 'enter'],
			[' ', 'space'],
			['\u007f', 'backspace'],
			[ESC, 'escape'],
			[`${ESC}[A`, 'up'],
			[`${ESC}OA`, 'up'],
			[`${ESC}[Z`, 'shift+tab'],
			[`${ESC}[1;5A`, 'ctrl+up'],
			[`${ESC}[3~`, 'delete'],
			[`${ESC}f`, 'alt+f'],
			['👍', '👍'],
		];

		for (const [bytes, spec] of pairs) {
			const keys = decodeKeys(bytes);
			expect(keys.length, `${spec}: one key`).to.equal(1);
			expect(formatKey(keys[0] as Key), spec).to.equal(spec);
			expect(formatKey(parseKeys(spec)[0] as Key), `${spec}: round trip`).to.equal(spec);
		}
	});

	/**
	 * The vocabulary is derived from the decoder's own tables, so a name it
	 * produces is a name a spec can write.
	 *
	 * The sabotage this is for is a hand-written list: a name added to
	 * `SEQUENCES` without being added to a second copy is a key no spec can bind,
	 * with nothing to say so.
	 */
	it('should accept every name the decoder produces', () => {
		// written out, because asserting only that each entry parses would pass for
		// a name that has no business being in there: `parseKeys()` reads whatever
		// the set contains, so the set is what has to be checked. The content is the
		// values of `SEQUENCES` and `CONTROLS` with the one-character ones dropped,
		// plus the `escape` `readEscape()` produces inline
		expect([...KEY_NAMES].sort()).to.deep.equal([
			'backspace',
			'delete',
			'down',
			'end',
			'enter',
			'escape',
			'home',
			'left',
			'pagedown',
			'pageup',
			'right',
			'space',
			'tab',
			'up',
		]);

		for (const name of KEY_NAMES) {
			expect(parseKeys(name)[0]?.name, name).to.equal(name);
			// and nothing of one character is in there, because a one-character name
			// and a character are the same answer reached two ways
			expect([...name].length, name).to.be.greaterThan(1);
		}
	});
});

describe('a sequence binding', () => {
	it('should fire a one-key binding at once, with nothing to disambiguate', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('ctrl+s', (keys) => seen.push(formatKeys(keys)));
		h.feed('\u0013');

		expect(seen).to.deep.equal(['ctrl+s']);
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});

	it('should fire a two-key binding on the second key and not the first', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', (keys) => seen.push(formatKeys(keys)));

		h.feed('g');
		expect(seen, 'fired on the first key').to.deep.equal([]);
		expect(formatKeys(input.sequence.get())).to.equal('g');

		h.feed('g');
		expect(seen).to.deep.equal(['g g']);
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});

	it('should fire a binding whose keys arrive in one chunk', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('ctrl+x ctrl+s', () => seen.push('save'));
		h.feed('\u0018\u0013');

		expect(seen).to.deep.equal(['save']);
		input.stop();
	});

	it('should fire both bindings of one sequence', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => seen.push('one'));
		input.bind('g g', () => seen.push('two'));
		h.feed('gg');

		expect(seen).to.deep.equal(['one', 'two']);
		input.stop();
	});

	it('should refuse a spec with no handler rather than consuming the key', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });

		// the overload refuses it at the call site, which is the better half of this
		// -- and the run-time check is what answers for a JavaScript app
		expect(() => (input.bind as unknown as (k: string) => unknown)('ctrl+s')).toThrow(TypeError);
		input.stop();
	});

	it('should still take a function binding, which sees every key', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind((event) => seen.push(formatKey(event.key)));
		h.feed('ab');

		expect(seen).to.deep.equal(['a', 'b']);
		input.stop();
	});

	/**
	 * A node left behind with no handler is still a prefix, and a prefix is what
	 * holds a key back.
	 *
	 * Without the prune, unbinding `g g` leaves `g` waiting for a second key for
	 * the life of the process -- so this is asserted through the *timing*: with
	 * `g g` gone, `g` has nothing after it and fires at once rather than after a
	 * deadline.
	 */
	it('should stop being a prefix once the longer binding is unbound', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g', () => seen.push('g'));
		const off = input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		expect(seen, 'waits while the longer binding exists').to.deep.equal([]);
		expect(formatKeys(input.sequence.get())).to.equal('g');

		h.feed('g');
		expect(seen).to.deep.equal(['gg']);

		off();
		h.feed('g');
		expect(seen, 'fires at once with nothing after it').to.deep.equal(['gg', 'g']);
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});

	/**
	 * A second removal does nothing, and the fixture that shows why is the one
	 * where the path is **partly** pruned and then rebuilt.
	 *
	 * The disposer closes over the node it added to, and a prune walks from that
	 * node up through `parent`. So with `g a` and `g b` bound, removing `g a`
	 * prunes the `a` node and leaves the `g` node alive for `b` -- after which
	 * rebinding `g a` hangs a *new* `a` node off that same live `g`. A stale
	 * disposer called again then finds its old node empty and deletes `'a'` from
	 * the live parent, taking the new binding with it.
	 *
	 * The obvious fixture -- bind, off, off -- cannot see that, because there the
	 * whole path is pruned and the stale node's parent is detached from the trie.
	 */
	it('should ignore a second removal, which would otherwise prune a rebinding', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		const off = input.bind('g a', () => seen.push('first'));
		input.bind('g b', () => seen.push('b'));
		off();

		input.bind('g a', () => seen.push('second'));
		off();

		h.feed('ga');
		expect(seen, 'the stale disposer pruned the rebinding').to.deep.equal(['second']);

		h.feed('gb');
		expect(seen).to.deep.equal(['second', 'b']);
		input.stop();
	});

	it('should ignore a second removal where the whole path was pruned', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => seen.push('first'));
		const off = input.bind('g g', () => seen.push('second'));
		off();
		off();

		h.feed('gg');
		expect(seen).to.deep.equal(['first']);
		input.stop();
	});
});

describe('the prefix and exact disambiguation', () => {
	it('should fire the shorter binding once the deadline passes', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			expect(seen).to.deep.equal([]);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT - 1);
			expect(seen, 'fired before its own deadline').to.deep.equal([]);
			expect(formatKeys(input.sequence.get())).to.equal('g');

			vi.advanceTimersByTime(1);
			expect(seen).to.deep.equal(['g']);
			expect(input.sequence.get()).to.deep.equal([]);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// the failure the deadline exists for: too short and a deliberate `g g`
	// fires `g` twice
	it('should fire the longer binding for a second key inside the deadline', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT - 1);
			h.feed('g');

			expect(seen).to.deep.equal(['gg']);

			// and the deadline it replaced does not go off afterwards
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'the old deadline fired as well').to.deep.equal(['gg']);
			expect(vi.getTimerCount()).to.equal(0);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * A prefix that is not also a binding waits with no deadline at all.
	 *
	 * Emacs' answer, and the right one: there is nothing to decide between, and
	 * any key that does not continue the sequence already cancels it. A deadline
	 * here would throw a half-entered sequence away while the user was still
	 * reaching for the second key.
	 */
	it('should wait indefinitely where there is nothing to disambiguate', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g g', () => seen.push('gg'));
			h.feed('g');

			expect(vi.getTimerCount(), 'armed a deadline for a pure prefix').to.equal(0);
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 100);
			expect(formatKeys(input.sequence.get())).to.equal('g');

			h.feed('g');
			expect(seen).to.deep.equal(['gg']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * A key that extends the sequence takes the old deadline off, and the fixture
	 * that shows it needs the *next* node to arm nothing.
	 *
	 * `g` bound and `g a b` bound: `g` is a binding and a prefix, so it arms;
	 * `g a` is a pure prefix, so it arms nothing -- and without the clear at the
	 * top of the step the first deadline is left running. What it then does is
	 * fire `g`, half a second into a sequence the user is still typing, and throw
	 * away the `g a` they had got to.
	 *
	 * The obvious fixture cannot see it: a sequence that *completes* clears the
	 * pending state and the timer with it, so the clear is redundant on exactly
	 * the path a two-key binding takes.
	 */
	it('should take the old deadline off when a key extends the sequence', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g a b', () => seen.push('gab'));

			h.feed('g');
			expect(vi.getTimerCount(), 'g is a binding and a prefix').to.equal(1);

			h.feed('a');
			expect(vi.getTimerCount(), 'the old deadline is still armed').to.equal(0);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'the old deadline committed g mid-sequence').to.deep.equal([]);
			expect(formatKeys(input.sequence.get()), 'and took the sequence with it').to.equal('g a');

			h.feed('b');
			expect(seen).to.deep.equal(['gab']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// and the same thing where the next node arms a deadline of its own, which is
	// where the old one would be orphaned rather than merely left running
	it('should not orphan a deadline when the next node arms one too', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g a', () => seen.push('ga'));
			input.bind('g a b', () => seen.push('gab'));

			h.feed('g');
			h.feed('a');
			expect(vi.getTimerCount(), 'two deadlines for one sequence').to.equal(1);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT);
			expect(seen, 'the orphaned deadline fired as well').to.deep.equal(['ga']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * A disposer called while the deadline is running can change what the node it
	 * was armed for *is*.
	 *
	 * The pending state moving is what clears the timer, so the two cannot part --
	 * the **trie** can, which the comment over that `setTimeout` used to deny. Take
	 * the handler off and what is left is a pure prefix, which waits with no
	 * deadline at all; firing an empty handler set there threw the sequence away
	 * for nothing, so the pending `g` was gone and `g g` needed starting again.
	 */
	it('should not throw the sequence away when the deadline lost its binding', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			const off = input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			expect(vi.getTimerCount()).to.equal(1);

			// `g` stops being a binding while its own deadline is running, so what is
			// left is the prefix of `g g` and that waits indefinitely
			off();
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen).to.deep.equal([]);
			expect(formatKeys(input.sequence.get()), 'the deadline wiped a live prefix').to.equal('g');

			h.feed('g');
			expect(seen).to.deep.equal(['gg']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * And a disposer that unbinds the whole path leaves nothing pending.
	 *
	 * The prune detaches the node the pending sequence is sitting on, and
	 * `sequence.ts` deliberately knows nothing about the router, so it cannot say
	 * so -- `reaches()` is asked on the next key instead. Without it the status
	 * line kept showing a sequence that no longer existed, and the Escape that
	 * followed was swallowed by it.
	 */
	it('should treat a pending node whose path was unbound as nothing pending', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const { first, root } = tree();
			const input = createInput({ paste: false, root, terminal: h.terminal });
			const seen: string[] = [];

			input.focus.focus(first);
			first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
			const off = input.bind('g a b', () => seen.push('gab'));

			h.feed('ga');
			off();

			pressEscape(h);
			expect(seen, 'a sequence that had been unbound ate the Escape').to.deep.equal([
				'element:escape',
			]);
			expect(input.sequence.get()).to.deep.equal([]);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// node stores a delay as a signed 32-bit integer, so anything past the ceiling
	// becomes `1` -- the trap `Infinity` is refused for, reached by a finite number
	it('should clamp a deadline past the longest one setTimeout will hold', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({
				paste: false,
				sequenceTimeout: 2_147_483_648,
				terminal: h.terminal,
			});
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 10);
			expect(seen, 'a delay past the ceiling fired at once').to.deep.equal([]);

			vi.advanceTimersByTime(2_147_483_647);
			expect(seen).to.deep.equal(['g']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should take a deadline of its own from the options', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, sequenceTimeout: 20, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			vi.advanceTimersByTime(20);
			expect(seen).to.deep.equal(['g']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// `Infinity >= 0` is true and node reads a delay past 2^31-1 as 1, so
	// honouring one asks for "never" and gets "at once"
	it('should fall back for a deadline that is not a finite number', () => {
		for (const timeout of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
			vi.useFakeTimers();
			try {
				const h = harness();
				const input = createInput({ paste: false, sequenceTimeout: timeout, terminal: h.terminal });
				const seen: string[] = [];

				input.bind('g', () => seen.push('g'));
				input.bind('g g', () => seen.push('gg'));

				h.feed('g');
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT - 1);
				expect(seen, String(timeout)).to.deep.equal([]);
				vi.advanceTimersByTime(1);
				expect(seen, String(timeout)).to.deep.equal(['g']);
				input.stop();
			} finally {
				vi.useRealTimers();
			}
		}
	});
});

describe('a pending sequence', () => {
	/**
	 * **The Ctrl-C guarantee.**
	 *
	 * A function binding sees every key, so no keystroke whatsoever can make one
	 * unreachable -- which is the sentence this module already carries about a
	 * focused input, and a half-entered sequence is the second route to the same
	 * failure. Asserted with a sequence genuinely pending, because that is the
	 * state the guarantee is about.
	 */
	it('should not eat ctrl-c, which a binding sees before any of it', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
		input.bind((event) => {
			if (event.key.ctrl && event.key.name === 'c') {
				seen.push('quit');
				event.stop();
			}
		});
		input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		expect(formatKeys(input.sequence.get()), 'nothing pending to be eaten').to.equal('g');

		h.feed('\u0003');
		expect(seen).to.deep.equal(['quit']);
		// and the sequence is gone, because the key did not continue it
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});

	// the same guarantee one spelling along: a *sequence* binding of one key is
	// reachable while another sequence is pending, because the pending one claims
	// only what the app named as a continuation
	it('should leave a one-key binding reachable while another sequence is pending', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => seen.push('gg'));
		input.bind('ctrl+c', () => seen.push('quit'));

		h.feed('g');
		h.feed('\u0003');

		expect(seen).to.deep.equal(['quit']);
		input.stop();
	});

	/**
	 * The one key a pending sequence can claim is one the app bound as a
	 * continuation, and this is that case written down rather than left to be
	 * discovered.
	 *
	 * `g ctrl+c` fires rather than quitting, because the app said so. The
	 * guarantee is not "Ctrl-C is magic" -- it is that nothing is swallowed the
	 * app did not itself name, and a function binding is ahead of all of it in
	 * any case.
	 */
	it('should claim ctrl-c only where the app bound it as a continuation', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g ctrl+c', (keys) => seen.push(formatKeys(keys)));
		h.feed('g\u0003');

		expect(seen).to.deep.equal(['g ctrl+c']);
		input.stop();
	});

	/**
	 * A key that reached the trie and did not continue the sequence **answers**
	 * the question the deadline was waiting on.
	 *
	 * `g` bound and `g g` bound, `g` then `x`, means `g` -- which is what vim does
	 * and the only reading that does not silently lose a keystroke the user
	 * deliberately made. The first version of this discarded the pending `g`, so a
	 * bound `g` fired only if nothing at all was pressed for half a second: the
	 * deadline became the *only* way to reach it rather than the fallback for when
	 * nothing follows. Found by following a review finding about unbinding mid-wait
	 * to the far commoner case underneath it.
	 */
	it('should commit the shorter binding for a key that answered the question', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const { first, root } = tree();
			const input = createInput({ paste: false, root, terminal: h.terminal });
			const seen: string[] = [];

			input.focus.focus(first);
			first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			h.feed('x');

			// the `g` the user pressed, and then the `x` they pressed after it
			expect(seen).to.deep.equal(['g', 'element:x']);
			expect(vi.getTimerCount(), 'the deadline outlived its answer').to.equal(0);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'and it fired twice').to.deep.equal(['g', 'element:x']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// at the node reached and no further: committing an ancestor would mean saying
	// what becomes of the keys after it, which is a typeahead replay rather than a
	// rule
	it('should commit nothing where the node it reached is not a binding', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
		input.bind('g', () => seen.push('g'));
		input.bind('g a b', () => seen.push('gab'));

		h.feed('ga');
		h.feed('x');

		expect(seen).to.deep.equal(['element:x']);
		input.stop();
	});

	// and Escape and Backspace are above that rule rather than below it, which is
	// the whole distinction: those are the user saying "forget it", where a key is
	// the user saying which of the two they meant
	it('should commit nothing for the Escape and Backspace that cancel', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			pressEscape(h);
			expect(seen, 'Escape committed the shorter binding').to.deep.equal([]);

			h.feed('g');
			h.feed('\u007f');
			expect(seen, 'Backspace committed the shorter binding').to.deep.equal([]);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// a key a binding *stopped* never reached the trie, so the question is still
	// open -- and something else has claimed that keystroke, so running a second
	// binding in the same breath is not what anybody asked for
	it('should commit nothing for a key a binding stopped', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind((event) => {
			if (event.key.ctrl && event.key.name === 'c') {
				seen.push('quit');
				event.stop();
			}
		});
		input.bind('g', () => seen.push('g'));
		input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		h.feed('\u0003');

		expect(seen).to.deep.equal(['quit']);
		input.stop();
	});

	it('should cancel and dispatch a key that continues nothing', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
		input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		h.feed('x');

		expect(seen, 'the key was swallowed').to.deep.equal(['element:x']);
		expect(input.sequence.get()).to.deep.equal([]);

		// and the sequence really did end: a `g` after it starts a new one
		h.feed('g');
		expect(formatKeys(input.sequence.get())).to.equal('g');
		input.stop();
	});

	// a key that ended one sequence may start another, so it is offered from the
	// root rather than being spent on the cancel
	it('should begin another sequence with the key that ended this one', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => seen.push('gg'));
		input.bind('d d', () => seen.push('dd'));

		h.feed('g');
		h.feed('d');
		expect(formatKeys(input.sequence.get()), 'the d was spent on cancelling').to.equal('d');

		h.feed('d');
		expect(seen).to.deep.equal(['dd']);
		input.stop();
	});

	it('should be cleared by Escape, which goes no further', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const { first, root } = tree();
			const input = createInput({ paste: false, root, terminal: h.terminal });
			const seen: string[] = [];

			input.focus.focus(first);
			first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			pressEscape(h);

			expect(input.sequence.get()).to.deep.equal([]);
			expect(seen, 'the cancel also reached the tree').to.deep.equal([]);

			// and with nothing pending it is an ordinary key again
			pressEscape(h);
			expect(seen).to.deep.equal(['element:escape']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// Escape-clears is a default and sits *under* the rule above rather than over
	// it, which is the same call Tab already gets: a component that wants it keeps
	// it by stopping the event
	it('should let a continuation the app bound beat the Escape default', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g escape', (keys) => seen.push(formatKeys(keys)));
			h.feed('g');
			pressEscape(h);

			expect(seen).to.deep.equal(['g escape']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// a modifier makes it a different key, so Alt-Escape is not the cancel
	it('should read a modified Escape as a key rather than as the cancel', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const { first, root } = tree();
			const input = createInput({ paste: false, root, terminal: h.terminal });
			const seen: string[] = [];

			input.focus.focus(first);
			first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			// `ESC ESC` is held whole, because the second one may still be the start
			// of an Alt-something that has not finished arriving
			pressEscape(h, `${ESC}${ESC}`);

			expect(seen).to.deep.equal(['element:alt+escape']);
			expect(input.sequence.get()).to.deep.equal([]);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should pop one key for Backspace and keep the rest', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g a b', (keys) => seen.push(formatKeys(keys)));
		h.feed('ga');
		expect(formatKeys(input.sequence.get())).to.equal('g a');

		h.feed('\u007f');
		expect(formatKeys(input.sequence.get())).to.equal('g');

		// and what is left is still the prefix it was, so the sequence completes
		h.feed('ab');
		expect(seen).to.deep.equal(['g a b']);
		input.stop();
	});

	it('should clear on a Backspace that pops the only key', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
		input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		h.feed('\u007f');

		expect(input.sequence.get()).to.deep.equal([]);
		expect(seen, 'the pop also reached the tree').to.deep.equal([]);
		input.stop();
	});

	// a modifier makes it a different key, the way it does for Escape: Alt-
	// Backspace is "delete the word" in a text field and is not the pop
	it('should read a modified Backspace as a key rather than as the pop', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
		input.bind('g a b', () => seen.push('gab'));

		h.feed('ga');
		h.feed(`${ESC}\u007f`);

		expect(seen).to.deep.equal(['element:alt+backspace']);
		expect(input.sequence.get(), 'it popped rather than cancelling').to.deep.equal([]);
		input.stop();
	});

	/**
	 * A pop of the only key leaves **nothing** pending rather than leaving the
	 * root as the node.
	 *
	 * Those look the same -- the published keys are empty either way, and the next
	 * key is looked up in the root's children by both readings -- and they differ
	 * in one place: with the root sitting there as a pending node, the Escape and
	 * Backspace defaults still apply, so an Escape after the pop is swallowed as a
	 * cancel instead of reaching the tree.
	 */
	it('should leave nothing pending after popping the only key', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const { first, root } = tree();
			const input = createInput({ paste: false, root, terminal: h.terminal });
			const seen: string[] = [];

			input.focus.focus(first);
			first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			h.feed('\u007f');
			expect(input.sequence.get()).to.deep.equal([]);

			pressEscape(h);
			expect(seen, 'the Escape was eaten by a sequence that had ended').to.deep.equal([
				'element:escape',
			]);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * Tab is claimed by a continuation the app bound on it, and the focus does not
	 * move.
	 *
	 * The trie is consulted before the tree and the Tab default is after both, so
	 * this is the answer "a component that wants Tab keeps it by stopping the
	 * event" already gives, one layer along.
	 */
	it('should let a sequence claim Tab without the focus moving', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		input.bind('g tab', (keys) => seen.push(formatKeys(keys)));

		h.feed('g\t');
		expect(seen).to.deep.equal(['g tab']);
		expect(input.focus.current.get(), 'the Tab default ran as well').to.equal(first);

		// and with nothing pending it moves the focus the way it always did
		h.feed('\t');
		expect(input.focus.current.get()).to.not.equal(first);
		input.stop();
	});

	it('should let a continuation the app bound beat the Backspace default', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g backspace', (keys) => seen.push(formatKeys(keys)));
		h.feed('g\u007f');

		expect(seen).to.deep.equal(['g backspace']);
		input.stop();
	});

	/**
	 * A pop does not re-arm the deadline, even where what is left is a binding as
	 * well as a prefix.
	 *
	 * Backspace is the user editing the sequence, and committing the shorter
	 * binding on a deadline after an explicit undo is the opposite of what they
	 * asked for. The fixture needs three levels, because the key that is popped
	 * back *to* has to be one that was waiting when it was first entered.
	 */
	it('should not commit the shorter binding on a deadline after a pop', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g a', () => seen.push('ga'));

			h.feed('g');
			expect(vi.getTimerCount(), 'g is a binding and a prefix').to.equal(1);

			h.feed('a');
			expect(seen).to.deep.equal(['ga']);

			// back to `g`, which is a binding and a prefix again
			h.feed('g');
			h.feed('\u007f');
			expect(input.sequence.get()).to.deep.equal([]);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'the pop committed the shorter binding').to.deep.equal(['ga']);
			expect(vi.getTimerCount()).to.equal(0);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should not re-arm a deadline when a deeper pop leaves a binding behind', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g a', () => seen.push('ga'));
			input.bind('g a b', () => seen.push('gab'));

			h.feed('ga');
			expect(vi.getTimerCount(), 'g a is a binding and a prefix').to.equal(1);

			h.feed('b');
			expect(seen).to.deep.equal(['gab']);

			h.feed('gab');
			seen.length = 0;
			h.feed('ga');
			h.feed('\u007f');
			expect(formatKeys(input.sequence.get())).to.equal('g');

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'the pop re-armed a deadline').to.deep.equal([]);
			expect(vi.getTimerCount()).to.equal(0);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('the pending state', () => {
	it('should hold the keys as they were pressed, and clear on completion', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });

		input.bind('ctrl+x ctrl+s', () => {});
		expect(formatKeys(input.sequence.get())).to.equal('');

		h.feed('\u0018');
		expect(formatKeys(input.sequence.get())).to.equal('ctrl+x');
		expect(input.sequence.get().length).to.equal(1);

		h.feed('\u0013');
		expect(formatKeys(input.sequence.get())).to.equal('');
		input.stop();
	});

	// `readonly` is a TypeScript fiction at run time, and one caller splicing what
	// the signal published rewrites what every reader of it sees
	it('should publish a frozen list', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });

		input.bind('g g', () => {});
		expect(Object.isFrozen(input.sequence.get()), 'the empty one').to.equal(true);

		h.feed('g');
		expect(Object.isFrozen(input.sequence.get()), 'a pending one').to.equal(true);
		input.stop();
	});

	/**
	 * Clearing one that is already clear is not a write.
	 *
	 * `State.set()` compares with `Object.is`, so a fresh `[]` each time would be
	 * a change each time -- and every focus move would ask for a frame to redraw a
	 * status line that has not moved. Asserted by identity, which is what the
	 * shared frozen constant buys and what a fresh array would break.
	 */
	it('should not write a value when there was nothing pending to clear', () => {
		const h = harness();
		const { first, root, second } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });

		input.focus.focus(first);
		const before = input.sequence.get();
		expect(before).to.deep.equal([]);

		// a focus change clears the pending sequence, so this reaches the clear
		// with nothing in it
		input.focus.focus(second);
		expect(input.sequence.get()).to.equal(before);
		input.stop();
	});

	it('should be handed to the handler as the keys that completed it', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: Key[][] = [];

		input.bind('ctrl+x ctrl+s', (keys) => seen.push([...keys]));
		h.feed('\u0018\u0013');

		expect(seen.length).to.equal(1);
		expect((seen[0] as Key[]).map((it) => it.sequence)).to.deep.equal(['\u0018', '\u0013']);
		input.stop();
	});
});

describe('a focus change', () => {
	/**
	 * A sequence half-entered into one pane must not complete in another, because
	 * the second key was typed at something else.
	 */
	it('should invalidate a half-entered sequence', () => {
		const h = harness();
		const { first, root, second } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		expect(formatKeys(input.sequence.get())).to.equal('g');

		input.focus.focus(second);
		expect(input.sequence.get()).to.deep.equal([]);

		h.feed('g');
		expect(seen, 'the sequence completed across the move').to.deep.equal([]);
		expect(formatKeys(input.sequence.get()), 'and started a new one').to.equal('g');
		input.stop();
	});

	it('should invalidate it when the focused element is unmounted', () => {
		const h = harness();
		const { first, root, second } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(second);
		input.bind('g g', () => seen.push('gg'));

		h.feed('g');
		root.removeChild(second);

		// the repair happens on the way through `route()`, so the next key is what
		// finds the element gone -- and that key then starts a sequence of its own
		h.feed('g');
		expect(seen, 'completed across a repair').to.deep.equal([]);
		expect(input.focus.current.get()).to.equal(first);
		input.stop();
	});

	/**
	 * A focus change *caused by* a completing sequence costs nothing.
	 *
	 * `fire()` is handed the keys and the pending state is already clear by the
	 * time the handler can move anything, so the handler's own focus move has
	 * nothing left to invalidate. The sabotage this is for is firing before the
	 * reset: the handler's `focus()` would then clear the state the completion was
	 * reading, and the keys it was handed with it.
	 */
	it('should not break a sequence whose own handler moves the focus', () => {
		const h = harness();
		const { first, root, second } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		input.bind('g g', (keys) => {
			input.focus.focus(second);
			seen.push(formatKeys(keys));
		});

		h.feed('gg');
		expect(seen).to.deep.equal(['g g']);
		expect(input.focus.current.get()).to.equal(second);
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});

	/**
	 * A key offered from the **root** starts a trail of its own, whatever a
	 * handler did in between.
	 *
	 * The commit above it runs the caller's code, and that code can start a
	 * sequence by calling `feed()` -- so `take()` is handed its trail rather than
	 * reading one off the pending state. Measured on the ambient version: `g`
	 * committed, its handler fed a `d`, and the outer `d` was then taken with the
	 * inner one still in place, so **one keystroke left a pending `d d`** and the
	 * `d d` binding fired with three keys. Found by re-reading the commit path
	 * rather than by a review.
	 */
	it('should offer a key from the root with a trail of its own', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];
		let fed = false;

		input.bind('g', () => {
			seen.push('g');
			if (!fed) {
				fed = true;
				input.feed('d');
			}
		});
		input.bind('g g', () => seen.push('gg'));
		input.bind('d d', (keys) => seen.push(`dd:${formatKeys(keys)}`));

		// `g` pends, `d` does not continue it so `g` commits, the handler feeds a
		// `d` which begins `d d`, and then the outer `d` is offered from the root
		h.feed('gd');
		expect(seen).to.deep.equal(['g']);
		expect(formatKeys(input.sequence.get()), 'one keystroke, two keys').to.equal('d');

		h.feed('d');
		expect(seen).to.deep.equal(['g', 'dd:d d']);
		input.stop();
	});

	// and a handler that feeds more keys starts from a clean pending state rather
	// than from the one its own completion left behind
	it('should let a handler that feeds more keys start a fresh sequence', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('d d', () => seen.push('dd'));
		input.bind('g g', () => {
			seen.push('gg');
			h.feed('dd');
		});

		h.feed('gg');
		expect(seen).to.deep.equal(['gg', 'dd']);
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});
});

describe('a handler that changes the bindings', () => {
	/**
	 * A handler registered while an event is being dispatched does not receive
	 * that event, and one removed during it is not called.
	 *
	 * The rule every handler set in this module follows, which needs a copy for
	 * the first half and a membership check for the second -- and the reason it is
	 * worth asserting here is that a sequence completing and rebinding itself is
	 * exactly that case.
	 */
	it('should not hand the completion to a binding it added', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => {
			seen.push('first');
			input.bind('g g', () => seen.push('added'));
		});

		h.feed('gg');
		expect(seen, 'the new binding saw the very completion that added it').to.deep.equal(['first']);

		// and it is live for the next one
		h.feed('gg');
		expect(seen).to.deep.equal(['first', 'first', 'added']);
		input.stop();
	});

	it('should not call a binding the handler before it removed', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		let off = (): void => {};
		input.bind('g g', () => {
			seen.push('first');
			off();
		});
		off = input.bind('g g', () => seen.push('second'));

		h.feed('gg');
		expect(seen).to.deep.equal(['first']);
		input.stop();
	});

	// the fourth place `stopped` is asked, and the ordinary way to reach it is a
	// sequence bound twice whose first handler quits
	it('should stop calling handlers once one of them stops the router', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => {
			seen.push('quit');
			input.stop();
		});
		input.bind('g g', () => seen.push('after'));

		h.feed('gg');
		expect(seen).to.deep.equal(['quit']);
	});

	// and a key that stops the router stops the chunk it was in, which is the rule
	// `keys()` already keeps between keys
	it('should stop reading the chunk a completing sequence stopped it in', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind((event) => seen.push(formatKey(event.key)));
		input.bind('g g', () => input.stop());

		h.feed('ggxyz');
		expect(seen).to.deep.equal(['g', 'g']);
	});
});

describe('a paste', () => {
	/**
	 * A pasted key neither advances a sequence nor cancels one.
	 *
	 * What is between the paste markers is content by definition -- the rule a
	 * capability reply inside a paste already follows -- so content cannot drive a
	 * binding in either direction.
	 */
	it('should not fire a sequence binding', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		input.bind('g g', () => seen.push('gg'));
		input.onPaste((event) => {
			seen.push(`paste:${event.text}`);
			event.stop();
		});

		h.feed('\u001b[200~gg\u001b[201~');
		expect(seen).to.deep.equal(['paste:gg']);
		expect(input.sequence.get()).to.deep.equal([]);
		input.stop();
	});

	// the other half, which is the one a `!paste` guard on the advance alone would
	// get wrong: a paste must not be able to cancel a sequence either
	it('should not cancel a pending sequence, even typed in', () => {
		const h = harness();
		const input = createInput({ terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', (keys) => seen.push(formatKeys(keys)));

		h.feed('g');
		// nobody wants it whole, so it is typed in -- which is where a pasted key
		// reaches `dispatch()` and could have touched the sequence
		h.feed('\u001b[200~xy\u001b[201~');
		expect(formatKeys(input.sequence.get()), 'the paste cancelled it').to.equal('g');

		h.feed('g');
		expect(seen).to.deep.equal(['g g']);
		input.stop();
	});
});

/**
 * Two pending states, two deadlines, and which owns a byte.
 *
 * `held` holds **bytes that have not become a key yet** and is owned by
 * `ESCAPE_TIMEOUT`; the pending sequence holds **keys that have already been
 * decoded** and is owned by `SEQUENCE_TIMEOUT`. A byte is in exactly one of the
 * two and it moves from the first to the second by being decoded, so there is
 * no byte both could claim -- which is structural rather than careful.
 */
describe('the two pending states', () => {
	it('should leave a sequence alone while bytes are still a partial key', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });

		input.bind('g g', () => {});
		h.feed('g');

		// `ESC [` could still become Up, so it is held as a partial key and is not
		// a key the sequence could be offered
		h.feed(`${ESC}[`);
		expect(formatKeys(input.sequence.get())).to.equal('g');
		input.stop();
	});

	it('should offer the key a held partial becomes to the pending sequence', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g up', (keys) => seen.push(formatKeys(keys)));

		h.feed('g');
		h.feed(`${ESC}[`);
		expect(seen, 'fired on half an arrow key').to.deep.equal([]);

		h.feed('A');
		expect(seen).to.deep.equal(['g up']);
		input.stop();
	});

	it('should hand the key timeout flushing a lone Escape to the sequence', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g escape', (keys) => seen.push(formatKeys(keys)));

			h.feed('g');
			h.feed(ESC);
			// a trailing ESC is held, because a read that split puts the Alt-x in the
			// next chunk -- so nothing has happened yet
			expect(seen).to.deep.equal([]);

			vi.advanceTimersByTime(ESCAPE_TIMEOUT);
			expect(seen).to.deep.equal(['g escape']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * A handler that feeds bytes mid-chunk does not leave a second key deadline
	 * behind.
	 *
	 * `keys()` is re-entered by that `feed()`, and the inner call leaves **its
	 * own** remainder in `held` while the outer call goes on to arm from its own
	 * `joined`. Measured before it was guarded: two timers where one is correct.
	 * Reachable from an ordinary `bind()` handler with no sequence involved, which
	 * is why the first of these uses one -- the second is the same defect reached
	 * by this ticket's own new code.
	 *
	 * The wasted timer is the lesser half. The half that matters is that where the
	 * inner remainder is a control string and the outer chunk's was not, the second
	 * timer is the key deadline over a held reply, which is the one thing
	 * `armExpiry()` exists to refuse.
	 */
	it('should not arm a second key deadline for a handler that fed mid-chunk', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];
			let fed = false;

			input.bind((event) => {
				seen.push(event.key.name);
				if (event.key.name === 'a' && !fed) {
					fed = true;
					// a trailing ESC, which is held and arms the key deadline
					input.feed(ESC);
				}
			});

			h.feed('ab');
			expect(vi.getTimerCount(), 'two deadlines for one held tail').to.equal(1);

			vi.advanceTimersByTime(ESCAPE_TIMEOUT);
			expect(seen).to.deep.equal(['a', 'b', 'escape']);
			expect(vi.getTimerCount()).to.equal(0);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should not arm one for a sequence handler that fed mid-chunk either', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind((event) => seen.push(event.key.name));
			input.bind('g g', () => void input.feed(ESC));

			h.feed('ggz');
			expect(vi.getTimerCount()).to.equal(1);

			vi.advanceTimersByTime(ESCAPE_TIMEOUT);
			expect(seen).to.deep.equal(['g', 'g', 'z', 'escape']);
			expect(vi.getTimerCount()).to.equal(0);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * Both deadlines can be armed at once, and the shorter one is the key's.
	 *
	 * Fifty milliseconds against five hundred, so a held partial always becomes a
	 * key before a sequence commits -- and the key it becomes is then offered to
	 * the sequence like any other, which here cancels it. That ordering is a
	 * consequence of the two numbers rather than of anything written down, and it
	 * is the right way round: the sequence's own deadline exists to guess what the
	 * user meant, and a key that has actually arrived is not a guess.
	 */
	it('should let the shorter key deadline decide before the sequence commits', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			expect(vi.getTimerCount(), 'the sequence deadline').to.equal(1);

			h.feed(`${ESC}[`);
			expect(vi.getTimerCount(), 'and the key deadline beside it').to.equal(2);
			expect(formatKeys(input.sequence.get()), 'held bytes are not yet a key').to.equal('g');

			// the key deadline is the shorter, so what it flushes arrives as a real
			// key -- and a key that reached the trie and did not continue the
			// sequence answers the question the sequence deadline was waiting on, so
			// `g` commits now rather than waiting out its own deadline
			vi.advanceTimersByTime(ESCAPE_TIMEOUT);
			expect(seen).to.deep.equal(['g']);
			expect(input.sequence.get()).to.deep.equal([]);
			expect(vi.getTimerCount(), 'the sequence deadline outlived its answer').to.equal(0);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'it fired twice').to.deep.equal(['g']);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	// and the other order: a sequence deadline shorter than the key's commits
	// first, and the bytes stay held because a key that has not arrived cannot
	// have been part of what committed
	it('should commit a sequence whose deadline is the shorter of the two', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, sequenceTimeout: 10, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			h.feed(`${ESC}[`);
			expect(vi.getTimerCount()).to.equal(2);

			vi.advanceTimersByTime(10);
			expect(seen).to.deep.equal(['g']);
			expect(vi.getTimerCount(), 'the key deadline went with it').to.equal(1);
			input.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('a leader key', () => {
	it('should bind sequences under one leading key', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		const leader = input.leader('space');
		leader.bind('f', (keys) => seen.push(formatKeys(keys)));
		leader.bind('w q', () => seen.push('quit'));

		h.feed(' f');
		expect(seen).to.deep.equal(['space f']);

		h.feed(' wq');
		expect(seen).to.deep.equal(['space f', 'quit']);
		input.stop();
	});

	// the canonical spelling, so that the leader a status line prints and the one
	// the trie is keyed by are one string
	it('should report the leader as the one spelling', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });

		expect(input.leader('SPACE').key).to.equal('space');
		expect(input.leader('CTRL+Shift+tab').key).to.equal('ctrl+shift+tab');
		input.stop();
	});

	it('should hold the key back while it is a leader rather than dispatching it', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);

		const leader = input.leader(',');
		leader.bind('f', () => seen.push('find'));

		h.feed(',');
		expect(seen, 'the leader reached the tree').to.deep.equal([]);
		expect(formatKeys(input.sequence.get())).to.equal(',');

		h.feed('f');
		expect(seen).to.deep.equal(['find']);
		input.stop();
	});

	// "put back what you attached", which is worth having here because the point
	// of a leader is that one object holds many bindings
	it('should take every binding off at once', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);

		const leader = input.leader(',');
		leader.bind('f', () => seen.push('find'));
		leader.bind('g', () => seen.push('go'));
		leader.dispose();

		h.feed(',f');
		expect(seen, 'a disposed leader still claimed the keys').to.deep.equal([
			'element:,',
			'element:f',
		]);

		// and a second dispose is not an error
		leader.dispose();
		input.stop();
	});

	it('should take one binding off without the others', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		const leader = input.leader(',');
		const off = leader.bind('f', () => seen.push('find'));
		leader.bind('g', () => seen.push('go'));
		off();
		off();

		h.feed(',g');
		expect(seen).to.deep.equal(['go']);

		// and disposing afterwards still removes what is left
		leader.dispose();
		h.feed(',g');
		expect(seen).to.deep.equal(['go']);
		input.stop();
	});

	it('should refuse a leader that is more than one key', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });

		expect(() => input.leader('g g')).toThrow(/A leader is one key/);
		expect(() => input.leader('')).toThrow(KeySpecError);
		expect(() => input.leader('nope')).toThrow(KeySpecError);
		input.stop();
	});

	/**
	 * An empty continuation is refused rather than binding the leader by itself.
	 *
	 * The patterns are joined rather than the strings, which is what makes that
	 * true: a spec built by interpolation is `"space "`, whose blank token
	 * `parseKeys()` drops -- so one key is left and the "names no key" error that
	 * `parseKeys('')` raises never happens. What shipped for a round was a leader
	 * that fired its own binding the moment Space was pressed.
	 */
	it('should refuse an empty continuation rather than binding the leader alone', () => {
		const h = harness();
		const { first, root } = tree();
		const input = createInput({ paste: false, root, terminal: h.terminal });
		const seen: string[] = [];

		input.focus.focus(first);
		first.onKey = (event) => seen.push(`element:${formatKey(event.key)}`);

		const leader = input.leader('space');
		expect(() => leader.bind('', () => seen.push('leader itself'))).toThrow(KeySpecError);
		expect(() => leader.bind('   ', () => seen.push('leader itself'))).toThrow(KeySpecError);

		h.feed(' ');
		expect(seen).to.deep.equal(['element:space']);
		input.stop();
	});

	it('should refuse a continuation with no handler', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const leader = input.leader(',');

		expect(() => (leader.bind as unknown as (k: string) => unknown)('f')).toThrow(TypeError);
		input.stop();
	});
});

describe('stopping the router', () => {
	/**
	 * The pending sequence goes the way the hover states do, and for its reason:
	 * nothing will ever clear it otherwise, so the `g` in the corner of a status
	 * line would outlive the router that put it there.
	 */
	it('should clear the pending sequence and leave no deadline armed', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const input = createInput({ paste: false, terminal: h.terminal });
			const seen: string[] = [];

			input.bind('g', () => seen.push('g'));
			input.bind('g g', () => seen.push('gg'));

			h.feed('g');
			expect(vi.getTimerCount()).to.equal(1);

			input.stop();
			expect(input.sequence.get()).to.deep.equal([]);
			expect(vi.getTimerCount(), 'a deadline survived stop()').to.equal(0);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT * 2);
			expect(seen, 'it fired into a stopped router').to.deep.equal([]);
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * Nothing is read afterwards, by either door.
	 *
	 * Named for what it can check rather than for the rule it comes from: the
	 * bindings themselves are deliberately **kept**, which is what `stop()`
	 * already does with a function binding -- and that half is not observable
	 * through the public API, because the only way to ask is to feed a key and
	 * `consume()` returns at once. An earlier name claimed both.
	 */
	it('should read nothing after it, fed either way', () => {
		const h = harness();
		const input = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		input.bind('g g', () => seen.push('gg'));
		input.stop();

		h.feed('gg');
		input.feed('gg');
		expect(seen).to.deep.equal([]);
	});
});

describe('the router surface', () => {
	/**
	 * Both spellings are on the one method, and each one's disposer removes its
	 * own.
	 *
	 * Half of this is a *type* assertion -- the `InputRouter` annotation is what
	 * makes `tsc` check the overload, and nothing at run time can see that -- so
	 * the other half asserts what is observable, because a test that only called
	 * the two would pass with either of them doing nothing at all.
	 */
	it('should offer both spellings of bind on the one interface', () => {
		const h = harness();
		const input: InputRouter = createInput({ paste: false, terminal: h.terminal });
		const seen: string[] = [];

		const offFunction = input.bind((event) => seen.push(`fn:${formatKey(event.key)}`));
		const offSequence = input.bind('g g', () => seen.push('gg'));

		h.feed('gg');
		expect(seen).to.deep.equal(['fn:g', 'fn:g', 'gg']);

		offFunction();
		h.feed('gg');
		expect(seen).to.deep.equal(['fn:g', 'fn:g', 'gg', 'gg']);

		offSequence();
		h.feed('gg');
		expect(seen, 'a disposer left its own binding in place').to.deep.equal([
			'fn:g',
			'fn:g',
			'gg',
			'gg',
		]);
		input.stop();
	});
});
