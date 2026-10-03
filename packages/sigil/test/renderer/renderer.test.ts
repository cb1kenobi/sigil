import { createCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import { parseCapabilityResponse } from '../../src/input/capabilities.js';
import {
	createBranch,
	createContext,
	createEffect,
	createRoot,
	For,
	getOwner,
	onCleanup,
	onMount,
	provideContext,
	render,
	runWithOwner,
	Show,
	useContext,
} from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { State } from '../../src/signals/index.js';
import { Cascade, parseStylesheet } from '../../src/style/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { Screen, screenStream } from '../canvas/screen.js';
import { setup } from '../components/helpers.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The renderer.
 *
 * Driven by `frame()` rather than by the clock: the pacing is a `setTimeout` and
 * a test that waits for one is a test that is slow and flaky in equal measure.
 * What the pacing itself promises is asserted separately, by counting frames.
 */

/** A backend over a canvas, with no terminal and a count of what it painted. */
function harness(width = 20, height = 4) {
	const canvas = createCanvas({ height, width });
	const out: string[] = [];
	let painted = 0;
	let presented = 0;

	const resizeListeners = new Set<(size: { height: number; width: number }) => void>();
	const terminal = {
		height: 24,
		onResize(fn: (size: { height: number; width: number }) => void) {
			resizeListeners.add(fn);
			return () => resizeListeners.delete(fn);
		},
		restore() {},
		width,
	} as unknown as Terminal;

	const backend = {
		active: true,
		canvas,
		done() {},
		get height() {
			return canvas.height;
		},
		isLive: true,
		present() {
			presented++;
		},
		render(draw: (painter: never) => void) {
			painted++;
			canvas.paint(draw as never);
		},
		resize(w: number, h: number) {
			canvas.resize(w, h);
		},
		stop() {},
		terminal,
		get width() {
			return canvas.width;
		},
		write(line: string) {
			out.push(line);
		},
	};

	return {
		backend: backend as never,
		get painted() {
			return painted;
		},
		picture() {
			return canvas
				.toString()
				.split('\n')
				.map((row) => row.padEnd(canvas.width, ' ').replaceAll(' ', '.'))
				.join('\n');
		},
		get presented() {
			return presented;
		},
		resize(w: number, h: number) {
			(terminal as { width: number }).width = w;
			(terminal as { height: number }).height = h;
			for (const fn of resizeListeners) {
				fn({ height: h, width: w });
			}
		},
		terminal,
	};
}

/** Each test gets its own effect scope, so one never inherits another's. */
let effects = createEffects();
beforeEach(() => {
	effects = createEffects();
});

describe('mounting', () => {
	it('should run a component body exactly once, however much it re-renders', () => {
		// the whole reason signals came first: there is no re-render, so the body is
		// not a function of state that runs again -- the effects inside it are
		const h = harness();
		const count = new State(0);
		let bodies = 0;
		let runs = 0;

		const view = render(
			() => {
				bodies++;
				const label = text('');
				createEffect(() => {
					runs++;
					label.setText(`n=${count.get()}`);
				});
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(bodies).toBe(1);
		expect(runs).toBe(1);

		count.set(1);
		view.frame();
		count.set(2);
		view.frame();

		expect(bodies).toBe(1);
		expect(runs).toBe(3);
		expect(h.picture().split('\n')[0]).toBe('n=2.................');
		view.dispose();
	});

	it('should have painted before it returns', () => {
		// a `render()` that comes back with a timer pending and nothing on screen is
		// one every caller has to follow with a wait it cannot name
		const h = harness();
		const view = render(() => box({}, text('hi')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});

		expect(h.painted).toBe(1);
		expect(h.picture().split('\n')[0]).toBe('hi..................');
		view.dispose();
	});

	it('should paint nothing for a frame with nothing to do', () => {
		// nothing dirty means no frame, and the half of that this can see is that a
		// frame which happens anyway does no work
		const h = harness();
		const view = render(() => box({}, text('hi')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});

		expect(h.painted).toBe(1);
		view.frame();
		view.frame();
		expect(h.painted).toBe(1);
		view.dispose();
	});

	it('should coalesce a burst of writes into one frame', () => {
		// which is what the pacing is for: a terminal over ssh cannot absorb a
		// repaint per signal write, and thirty of them here are one frame
		const h = harness();
		const count = new State(0);

		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					label.setText(`n=${count.get()}`);
				});
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		for (let i = 1; i <= 30; i++) {
			count.set(i);
		}
		view.frame();

		expect(h.painted).toBe(2);
		expect(h.picture().split('\n')[0]).toBe('n=30................');
		view.dispose();
	});

	it('should repaint for a mutation no signal made', () => {
		// the tree records it, and what the tree records asks for a frame -- without
		// which an imperative edit from a key handler is invisible until something
		// else happens to draw
		const h = harness();
		let label: Element | undefined;
		const view = render(
			() => {
				label = text('one');
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		label?.setText('two');
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('two.................');
		view.dispose();
	});
});

describe('the cascade', () => {
	it('should re-resolve what a state change made match', () => {
		// the join that did not exist: a restyler kept across frames re-resolves
		// only what it was told about, so without the bridge the sheet matched once
		// and the frame was never asked again
		const h = harness();
		const focused = new State(false);
		const sheet = parseStylesheet(`
			.field { color: gray }
			.field:focus { color: cyan }
		`);

		let field: Element | undefined;
		const view = render(
			() => {
				field = box({ class: 'field' }, text('x'));
				createEffect(() => {
					field?.setState('focus', focused.get());
				});
				return box({}, field);
			},
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			}
		);

		expect(field?.style.color).toBe(8);
		focused.set(true);
		view.frame();
		expect(field?.style.color).toBe(6);
		view.dispose();
	});

	it('should re-match everything when the terminal resized', () => {
		// a rule inside a width media query may now apply or may now not, and which
		// elements those are is exactly what a full re-match answers
		const h = harness(20, 4);
		const sheet = parseStylesheet(`
			box { color: gray }
			@media (min-width: 30) { box { color: cyan } }
		`);

		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			}
		);

		expect(root?.style.color).toBe(8);
		h.resize(40, 24);
		view.frame();
		expect(root?.style.color).toBe(6);
		view.dispose();
	});
});

describe('lifecycle', () => {
	it('should dispose every effect a component created', () => {
		// a long-running CLI that skips this leaks a watcher per mount, and nothing
		// above can see them to clean up
		const h = harness();
		const count = new State(0);
		let runs = 0;

		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					runs++;
					label.setText(String(count.get()));
				});
				return box({}, label);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(runs).toBe(1);
		view.dispose();

		count.set(1);
		effects.flush();
		expect(runs).toBe(1);
	});

	it('should run cleanups innermost first and in reverse', () => {
		// the order things were built in, undone: a child's cleanup may read what
		// the parent's is about to tear down
		const order: string[] = [];
		createRoot((dispose) => {
			onCleanup(() => order.push('outer-a'));
			onCleanup(() => order.push('outer-b'));
			createEffect(() => {
				onCleanup(() => order.push('inner'));
			});
			dispose();
		}, effects.effect);

		expect(order).toEqual(['inner', 'outer-b', 'outer-a']);
	});

	it('should run every cleanup even when one throws', () => {
		// what is left behind by a teardown that stopped half way is a subscription
		// nobody can reach to cancel
		const ran: string[] = [];
		expect(() =>
			createRoot((dispose) => {
				onCleanup(() => ran.push('first'));
				onCleanup(() => {
					throw new Error('nope');
				});
				onCleanup(() => ran.push('last'));
				dispose();
			}, effects.effect)
		).toThrow('nope');

		expect(ran).toEqual(['last', 'first']);
	});

	it('should run onMount once the element has a box', () => {
		// after a frame rather than at the end of the body, because the useful thing
		// to do here is read where the component landed, and during the body there
		// is no answer
		const h = harness();
		const seen: (number | undefined)[] = [];

		const view = render(
			() => {
				const root = box({ height: '2', width: '5' }, text('x'));
				onMount(() => seen.push(root.box?.width));
				return root;
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(seen).toEqual([5]);
		view.frame();
		expect(seen).toEqual([5]);
		view.dispose();
	});

	it('should let a detached callback borrow an owner', () => {
		// a key handler or a settling promise has no owner of its own, and creating
		// an effect from one would otherwise never be disposed
		const h = harness();
		const count = new State(0);
		let runs = 0;
		let owner: ReturnType<typeof getOwner>;

		const view = render(
			() => {
				owner = getOwner();
				return box({}, text('x'));
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		runWithOwner(owner, () => {
			createEffect(() => {
				runs++;
				count.get();
			});
		});
		expect(runs).toBe(1);

		view.dispose();
		count.set(1);
		effects.flush();
		expect(runs).toBe(1);
	});
});

describe('context', () => {
	it('should read the nearest provided value', () => {
		const theme = createContext('plain');
		let inner = '';
		let outer = '';

		createRoot((dispose) => {
			outer = useContext(theme);
			provideContext(theme, 'dark', () => {
				inner = useContext(theme);
			});
			dispose();
		}, effects.effect);

		expect(outer).toBe('plain');
		expect(inner).toBe('dark');
	});

	it('should be readable from inside an effect body', () => {
		// the body runs with the creating owner current, so `useContext()` means
		// inside it what it meant outside
		const theme = createContext('plain');
		let seen = '';

		createRoot((dispose) => {
			provideContext(theme, 'dark', () => {
				createEffect(() => {
					seen = useContext(theme);
				});
			});
			dispose();
		}, effects.effect);

		expect(seen).toBe('dark');
	});
});

describe('Show', () => {
	it('should mount and dispose a branch as the condition turns', () => {
		const h = harness();
		const on = new State(false);
		const events: string[] = [];

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							onCleanup(() => events.push('gone'));
							events.push('built');
							return text('yes');
						},
						fallback: () => text('no'),
						when: () => on.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(h.picture().split('\n')[0]).toBe('no..................');
		expect(events).toEqual([]);

		on.set(true);
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('yes.................');
		expect(events).toEqual(['built']);

		on.set(false);
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('no..................');
		expect(events).toEqual(['built', 'gone']);
		view.dispose();
	});

	it('should not rebuild a branch while presence did not change', () => {
		// a `when` that reads a counter would otherwise tear its branch down and
		// build it again on every tick, losing whatever state the branch held
		const h = harness();
		const count = new State(1);
		let builds = 0;

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							builds++;
							return text('on');
						},
						when: () => count.get() > 0,
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(builds).toBe(1);
		count.set(2);
		view.frame();
		count.set(3);
		view.frame();
		expect(builds).toBe(1);
		view.dispose();
	});
});

describe('For', () => {
	it('should keep a row that moved rather than rebuilding it', () => {
		// keyed by identity: position keying rebuilds every row after the first
		// change, which for a terminal means the focus ring moves under whoever was
		// typing
		const h = harness();
		const a = { name: 'a' };
		const b = { name: 'b' };
		const items = new State<readonly { name: string }[]>([a, b]);
		const built: string[] = [];
		const made = new Map<{ name: string }, Element>();

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item) => {
							built.push(item.name);
							const element = text(item.name);
							made.set(item, element);
							return element;
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(built).toEqual(['a', 'b']);
		const firstA = made.get(a);

		items.set([b, a]);
		view.frame();

		expect(built).toEqual(['a', 'b']);
		expect(made.get(a)).toBe(firstA);
		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'b...................',
			'a...................',
		]);
		view.dispose();
	});

	it('should dispose a row that left', () => {
		const h = harness();
		const a = { n: 1 };
		const b = { n: 2 };
		const items = new State<readonly { n: number }[]>([a, b]);
		const gone: number[] = [];

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item) => {
							onCleanup(() => gone.push(item.n));
							return text(String(item.n));
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		items.set([a]);
		view.frame();
		expect(gone).toEqual([2]);
		view.dispose();
	});

	it('should give a moved row its new index', () => {
		// an accessor rather than a number, because the row that moved is the same
		// row and rebuilding it to tell it where it sits throws away what keying
		// exists to keep
		const h = harness();
		const a = { n: 'a' };
		const b = { n: 'b' };
		const items = new State<readonly { n: string }[]>([a, b]);

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item, index) => {
							const label = text('');
							createEffect(() => {
								label.setText(`${index()}${item.n}`);
							});
							return label;
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'0a..................',
			'1b..................',
		]);

		items.set([b, a]);
		view.frame();
		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'0b..................',
			'1a..................',
		]);
		view.dispose();
	});

	it('should hold two rows for an item that appears twice', () => {
		// two equal primitives in a list are a list with two entries in it, not a
		// bug to refuse
		const h = harness();
		const items = new State<readonly string[]>(['x', 'x', 'y']);
		let builds = 0;

		const view = render(
			() =>
				box(
					{},
					For({
						props: { 'flex-direction': 'column' },
						children: (item) => {
							builds++;
							return text(item);
						},
						each: () => items.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(builds).toBe(3);
		expect(h.picture().split('\n').slice(0, 3)).toEqual([
			'x...................',
			'x...................',
			'y...................',
		]);
		view.dispose();
	});

	it('should show a fallback while the list is empty', () => {
		const h = harness();
		const items = new State<readonly string[]>([]);

		const view = render(
			() =>
				box(
					{},
					For({
						children: (item) => text(item),
						each: () => items.get(),
						fallback: () => text('empty'),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(h.picture().split('\n')[0]).toBe('empty...............');
		items.set(['a']);
		view.frame();
		expect(h.picture().split('\n')[0]).toBe('a...................');
		view.dispose();
	});
});

describe('errors', () => {
	it('should put the terminal back before reporting', () => {
		// a CLI that dies on the alternate buffer with the cursor hidden has eaten
		// the user's shell, and a message printed into a half-drawn frame is
		// unreadable anyway
		const h = harness();
		const order: string[] = [];
		const seen: unknown[] = [];
		(h.terminal as unknown as { restore: () => void }).restore = () => order.push('restored');

		const count = new State(0);
		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					if (count.get() > 0) {
						throw new Error('boom');
					}
					label.setText('ok');
				});
				return box({}, label);
			},
			{
				backend: h.backend,
				effects,
				onError(error) {
					order.push('reported');
					seen.push(error);
				},
				terminal: h.terminal,
			}
		);

		count.set(1);
		view.frame();

		expect(order).toEqual(['restored', 'reported']);
		expect((seen[0] as Error).message).toBe('boom');
		expect(view.mounted).toBe(false);
	});

	it('should stop rather than throwing the same frame away forever', () => {
		const h = harness();
		let reports = 0;
		const count = new State(0);

		const view = render(
			() => {
				const label = text('');
				createEffect(() => {
					if (count.get() > 0) {
						throw new Error('boom');
					}
					label.setText('ok');
				});
				return box({}, label);
			},
			{
				backend: h.backend,
				effects,
				onError: () => void reports++,
				terminal: h.terminal,
			}
		);

		count.set(1);
		view.frame();
		view.frame();
		view.frame();
		expect(reports).toBe(1);
	});
});

describe('a frame that failed part way', () => {
	it('should stop the frame it failed in rather than finishing it', () => {
		// an effect that throws is *reported* by the scope's handler rather than
		// thrown through it, so the flush returns normally -- and the rest of the
		// frame would then paint onto a terminal the failure had already given back
		// and drain mount callbacks against an owner whose cleanups had all run
		const h = harness();
		const count = new State(0);
		const mounted: string[] = [];

		const view = render(
			() => {
				const first = text('');
				const second = text('');
				// the first effect gives the frame something to paint, so that a frame
				// which carried on past the failure would be visible as a paint after
				// the screen was handed back
				createEffect(() => {
					first.setText(`n=${count.get()}`);
				});
				createEffect(() => {
					if (count.get() > 0) {
						throw new Error('boom');
					}
					second.setText('ok');
				});
				onMount(() => mounted.push('one'));
				return box({ 'flex-direction': 'column' }, first, second);
			},
			{ backend: h.backend, effects, onError: () => {}, terminal: h.terminal }
		);

		const paintedBefore = h.painted;
		expect(mounted).toEqual(['one']);

		count.set(1);
		view.frame();

		// nothing was drawn after the screen was given back, though the tree had
		// changed and the frame had every reason to draw
		expect(h.painted).toBe(paintedBefore);
		expect(view.mounted).toBe(false);
	});

	it('should hand a throw from the body to its caller rather than reporting it', () => {
		// `render()` is still on the stack, so there is somebody to hand it to, and
		// reporting it as well is the same failure said twice
		const h = harness();
		const reports: unknown[] = [];

		expect(() =>
			render(
				() => {
					throw new Error('during mount');
				},
				{ backend: h.backend, effects, onError: (e) => void reports.push(e), terminal: h.terminal }
			)
		).toThrow('during mount');

		expect(reports).toEqual([]);
	});
});

describe('independence', () => {
	it("should not install its frame loop over another renderer's", () => {
		// a scope holds one scheduler and one error handler, so sharing the module's
		// meant a second `render()` stopped the first painting, and an effect that
		// threw in either tore down whichever had installed last
		const a = harness();
		const b = harness();
		const one = new State(0);
		const two = new State(0);

		const first = render(
			() => {
				const label = text('');
				createEffect(() => {
					label.setText(`a=${one.get()}`);
				});
				return box({}, label);
			},
			{ backend: a.backend, terminal: a.terminal }
		);
		const second = render(
			() => {
				const label = text('');
				createEffect(() => {
					label.setText(`b=${two.get()}`);
				});
				return box({}, label);
			},
			{ backend: b.backend, terminal: b.terminal }
		);

		one.set(1);
		two.set(1);
		first.frame();
		second.frame();

		expect(a.picture().split('\n')[0]).toBe('a=1.................');
		expect(b.picture().split('\n')[0]).toBe('b=1.................');

		// and disposing one leaves the other painting
		first.dispose();
		two.set(2);
		second.frame();
		expect(b.picture().split('\n')[0]).toBe('b=2.................');
		second.dispose();
	});

	it('should fail the renderer whose effect threw, and only that one', () => {
		// a shared scope holds one error handler, so a throw in either tore down
		// whichever had installed last -- restoring the terminal out from under the
		// one that was still running
		const a = harness();
		const b = harness();
		const boom = new State(0);
		const restored: string[] = [];
		(a.terminal as unknown as { restore: () => void }).restore = () => restored.push('a');
		(b.terminal as unknown as { restore: () => void }).restore = () => restored.push('b');

		const first = render(
			() => {
				const label = text('');
				createEffect(() => {
					if (boom.get() > 0) {
						throw new Error('boom');
					}
					label.setText('a');
				});
				return box({}, label);
			},
			{ backend: a.backend, onError: () => {}, terminal: a.terminal }
		);
		const second = render(() => box({}, text('b')), {
			backend: b.backend,
			onError: () => {},
			terminal: b.terminal,
		});

		boom.set(1);
		first.frame();

		expect(first.mounted).toBe(false);
		expect(second.mounted).toBe(true);
		expect(restored).toEqual(['a']);
		second.dispose();
	});
});

describe('a builder that throws', () => {
	it('should leave Show able to try again', () => {
		// presence is committed after the branch exists. Committed first, an effect
		// caches what it threw and goes clean -- so the next truthy `when()` matched
		// the recorded presence, returned early, and the host stayed empty for good
		const which = new State(0);
		let explode = true;
		const thrown: unknown[] = [];
		effects.setErrorHandler((error) => void thrown.push(error));

		let host: Element | undefined;
		createRoot(() => {
			host = Show({
				children: (n) => {
					if (explode) {
						throw new Error('nope');
					}
					return text(`v${n}`);
				},
				when: () => which.get() || false,
			});
		}, effects.effect);

		which.set(1);
		effects.flush();
		expect((thrown[0] as Error).message).toBe('nope');
		expect(host?.children.length).toBe(0);

		// a different truthy value: presence did not change, so only a `showing`
		// that was never committed lets this build
		explode = false;
		which.set(2);
		effects.flush();
		expect(host?.children[0]?.text).toBe('v2');
	});

	it('should leave For describing what is still on screen', () => {
		// the rows built before the throw were owned by nothing -- `rows` never took
		// them, and an effect caches what it threw, so the next reconcile started
		// from the stale list and those branches ran for the life of the `For`
		const a = { n: 'a' };
		const bad = { n: 'bad' };
		const items = new State<readonly { n: string }[]>([a]);
		let live = 0;
		const thrown: unknown[] = [];
		effects.setErrorHandler((error) => void thrown.push(error));

		createRoot(() => {
			For({
				children: (item) => {
					if (item === bad) {
						throw new Error('nope');
					}
					live++;
					onCleanup(() => live--);
					return text(item.n);
				},
				each: () => items.get(),
			});
		}, effects.effect);

		expect(live).toBe(1);

		// `bad` is second, so the row before it is built and then has to be undone
		items.set([{ n: 'c' }, bad]);
		effects.flush();
		expect((thrown[0] as Error).message).toBe('nope');
		expect(live).toBe(1);

		// and the next reconcile starts from what is still there rather than from a
		// list holding a row nothing owns
		items.set([a]);
		effects.flush();
		expect(live).toBe(1);
	});
});

describe('unmounting', () => {
	it('should let the restyler forget a subtree that left', () => {
		// `Restyler` keys its caches by element identity, so a panel shown and
		// hidden for an hour leaves an entry per node per mount with nothing to
		// point at
		const h = harness();
		const on = new State(true);
		let gone: Element | undefined;

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							gone = box({ class: 'x' }, text('here'));
							return gone;
						},
						when: () => on.get(),
					})
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		expect(gone?.tree).toBeDefined();
		expect(view.restyler.styleOf(gone as Element)).toBeDefined();

		on.set(false);
		view.frame();

		// detached, and the frame that saw it leave is what told the restyler --
		// which keys by element identity and would otherwise hold every node of
		// every branch ever shown, for the life of the renderer
		expect(gone?.tree).toBeUndefined();
		expect(view.restyler.styleOf(gone as Element)).toBeUndefined();
		expect(view.restyler.styleOf(gone?.children[0] as Element)).toBeUndefined();
		view.dispose();
	});

	it('should keep the style of a row that only moved', () => {
		// a move is a removal and an insertion, so forgetting everything that was
		// removed would throw away the style of every row a `For` reordered
		const h = harness();
		const a = { n: 'a' };
		const b = { n: 'b' };
		const items = new State<readonly { n: string }[]>([a, b]);
		const sheet = parseStylesheet(`.row { color: cyan }`);
		const made = new Map<{ n: string }, Element>();

		const view = render(
			() =>
				box(
					{},
					For({
						children: (item) => {
							const element = box({ class: 'row' }, text(item.n));
							made.set(item, element);
							return element;
						},
						each: () => items.get(),
						props: { 'flex-direction': 'column' },
					})
				),
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			}
		);

		expect(made.get(a)?.style.color).toBe(6);
		items.set([b, a]);
		view.frame();
		expect(made.get(a)?.style.color).toBe(6);
		expect(made.get(a)?.tree).toBeDefined();
		view.dispose();
	});

	it('should refuse to start anything new under a disposed owner', () => {
		// a key handler or a promise landing after unmount is exactly what
		// `runWithOwner()` is for, and exactly where the answer is to do nothing:
		// there is no component left to keep up to date and nothing that would
		// ever dispose the effect
		const h = harness();
		const count = new State(0);
		let runs = 0;
		let owner: ReturnType<typeof getOwner>;

		const view = render(
			() => {
				owner = getOwner();
				return box({}, text('x'));
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		view.dispose();
		runWithOwner(owner, () => {
			createEffect(() => {
				runs++;
				count.get();
			});
		});

		expect(runs).toBe(0);
		count.set(1);
		effects.flush();
		expect(runs).toBe(0);
	});

	it('should run a cleanup registered after disposal rather than keeping it', () => {
		const ran: string[] = [];
		let owner: ReturnType<typeof getOwner>;
		createRoot((dispose) => {
			owner = getOwner();
			dispose();
		}, effects.effect);

		runWithOwner(owner, () => onCleanup(() => ran.push('now')));
		expect(ran).toEqual(['now']);
	});

	it('should report what a branch cleanup threw rather than dropping it', () => {
		// `Show` and `For` are not in a position to do anything with a cleanup's
		// throw, and dropping it is how an unmount that failed to unsubscribe
		// something becomes silent
		const h = harness();
		const on = new State(true);
		const reports: unknown[] = [];

		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							onCleanup(() => {
								throw new Error('unsubscribe failed');
							});
							return text('here');
						},
						when: () => on.get(),
					})
				),
			{
				backend: h.backend,
				effects,
				onError: (error) => void reports.push(error),
				terminal: h.terminal,
			}
		);

		on.set(false);
		view.frame();

		expect((reports[0] as Error).message).toBe('unsubscribe failed');
		expect(view.mounted).toBe(true);
		view.dispose();
	});

	it('should report an onMount throw and stay mounted', () => {
		// a mount callback is not the frame: it runs after one, its throw says
		// nothing about whether the screen is right, and tearing the app down over
		// it would be a worse answer than saying so
		const h = harness();
		const reports: unknown[] = [];

		const view = render(
			() => {
				onMount(() => {
					throw new Error('mount hook');
				});
				return box({}, text('x'));
			},
			{
				backend: h.backend,
				effects,
				onError: (error) => void reports.push(error),
				terminal: h.terminal,
			}
		);

		expect((reports[0] as Error).message).toBe('mount hook');
		expect(view.mounted).toBe(true);
		view.dispose();
	});
});

describe('a builder that throws, going back the way it came', () => {
	it('should leave Show able to return to the presence it had', () => {
		// the inverse of committing presence too early, and just as permanent:
		// tearing the old branch down first left `showing` claiming a branch that
		// was gone, so the presence that came back matched the recorded one and
		// returned early
		const on = new State(false);
		let explode = false;
		const thrown: unknown[] = [];
		effects.setErrorHandler((error) => void thrown.push(error));

		let host: Element | undefined;
		createRoot(() => {
			host = Show({
				children: () => {
					if (explode) {
						throw new Error('nope');
					}
					return text('yes');
				},
				fallback: () => text('no'),
				when: () => on.get(),
			});
		}, effects.effect);

		expect(host?.children[0]?.text).toBe('no');

		explode = true;
		on.set(true);
		effects.flush();
		expect((thrown[0] as Error).message).toBe('nope');
		// the fallback that was on screen is still on screen: nothing was torn down
		// for a branch that never got built
		expect(host?.children[0]?.text).toBe('no');

		// and going back to where it came from is not a no-op
		on.set(false);
		effects.flush();
		expect(host?.children[0]?.text).toBe('no');

		explode = false;
		on.set(true);
		effects.flush();
		expect(host?.children[0]?.text).toBe('yes');
	});

	it('should dispose the row it was part way through building', () => {
		// the branch for the item that threw is created before its builder runs, so
		// tracking finished rows leaves exactly that one alive -- the leak the
		// rollback was written to close, one item along
		const ok = { n: 'ok' };
		const bad = { n: 'bad' };
		const items = new State<readonly { n: string }[]>([ok]);
		let live = 0;
		effects.setErrorHandler(() => {});

		createRoot(() => {
			For({
				children: (item) => {
					live++;
					onCleanup(() => live--);
					if (item === bad) {
						throw new Error('nope');
					}
					return text(item.n);
				},
				each: () => items.get(),
			});
		}, effects.effect);

		expect(live).toBe(1);

		items.set([ok, bad]);
		effects.flush();
		// `bad`'s builder ran, registered a cleanup, and threw: the branch holding
		// that cleanup is disposed with everything else this pass made
		expect(live).toBe(1);
	});

	it('should put back the indexes it had already moved', () => {
		// a row left reading a position the failed pass never placed it at paints
		// the wrong number at the old spot
		const a = { n: 'a' };
		const b = { n: 'b' };
		const bad = { n: 'bad' };
		const items = new State<readonly { n: string }[]>([a, b]);
		const labels = new Map<{ n: string }, Element>();
		effects.setErrorHandler(() => {});

		createRoot(() => {
			For({
				children: (item, index) => {
					if (item === bad) {
						throw new Error('nope');
					}
					const label = text('');
					labels.set(item, label);
					createEffect(() => {
						label.setText(`${index()}${item.n}`);
					});
					return label;
				},
				each: () => items.get(),
			});
		}, effects.effect);

		expect([labels.get(a)?.text, labels.get(b)?.text]).toEqual(['0a', '1b']);

		// `b` is moved to 0 before `bad` throws
		items.set([b, bad, a]);
		effects.flush();

		// and moved back, so no row paints a position it was never placed at. The
		// effect does re-run -- a signal written and written back still re-runs its
		// effects once, with the value it settled on -- and what it paints is right
		expect([labels.get(a)?.text, labels.get(b)?.text]).toEqual(['0a', '1b']);
	});

	it('should not leak a fallback that threw', () => {
		// the fallback is built after `rows` is committed, so it sat outside the
		// rollback: the branch leaked and the list was already empty, which means
		// `each()` never changes again and the effect never retries
		const items = new State<readonly string[]>(['a']);
		let live = 0;
		effects.setErrorHandler(() => {});

		createRoot(() => {
			For({
				children: (item) => text(item),
				each: () => items.get(),
				fallback: () => {
					live++;
					onCleanup(() => live--);
					throw new Error('nope');
				},
			});
		}, effects.effect);

		items.set([]);
		effects.flush();
		expect(live).toBe(0);
	});
});

describe('cleanups inside an effect body', () => {
	it('should report a throw rather than swallowing it', () => {
		// where an unsubscribe belongs, and the one place it failed in silence: the
		// wrapper handed the errors back as an array instead of raising them, so
		// the signals layer had nothing to report
		const thrown: unknown[] = [];
		effects.setErrorHandler((error) => void thrown.push(error));
		const count = new State(0);

		createRoot(() => {
			createEffect(() => {
				count.get();
				onCleanup(() => {
					throw new Error('unsubscribe failed');
				});
			});
		}, effects.effect);

		count.set(1);
		effects.flush();

		expect(thrown.map((e) => (e as Error).message)).toContain('unsubscribe failed');
	});
});

describe('re-entrancy', () => {
	it('should not let a frame start from inside one', () => {
		// the inner flush is a no-op while one is draining, so what an inner frame
		// really does is take the outer frame's marks and paint a half-settled
		// graph -- here, one label updated and the next one not yet
		const h = harness();
		const count = new State(0);
		let view: ReturnType<typeof render> | undefined;

		view = render(
			() => {
				const first = text('');
				const second = text('');
				createEffect(() => {
					first.setText(`a=${count.get()}`);
					view?.frame();
				});
				createEffect(() => {
					second.setText(`b=${count.get()}`);
				});
				return box({ 'flex-direction': 'column' }, first, second);
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		const before = h.painted;
		count.set(7);
		view.frame();

		// one frame, not two, and the one that happened has both labels in it
		expect(h.painted).toBe(before + 1);
		expect(h.picture().split('\n').slice(0, 2)).toEqual([
			'a=7.................',
			'b=7.................',
		]);
		view.dispose();
	});

	it('should hand back a dead branch under a disposed owner', () => {
		// asked of `createBranch()` rather than through `Show`, whose own effect
		// never runs there: a live branch parented onto a disposed owner is one
		// nothing will ever walk again, so what runs under it has to start nothing
		const count = new State(0);
		let runs = 0;
		let owner: ReturnType<typeof getOwner>;
		createRoot((dispose) => {
			owner = getOwner();
			dispose();
		}, effects.effect);

		runWithOwner(owner, () => {
			const branch = createBranch();
			runWithOwner(branch.owner, () => {
				createEffect(() => {
					runs++;
					count.get();
				});
			});
		});

		expect(runs).toBe(0);
		count.set(1);
		effects.flush();
		expect(runs).toBe(0);
	});
});

describe('giving the screen back', () => {
	/** A real inline canvas over a modelled screen, which is where this lives. */
	function screened(width = 20, height = 8) {
		const screen = new Screen(width, height);
		const stream = screenStream(screen);
		const terminal = createTerminal({
			env: {},
			isTTY: true,
			proc: { on() {}, pid: 1, removeListener() {} } as never,
			stderr: stream as never,
			stdin: undefined,
			stdout: stream as never,
		});
		return { screen, terminal };
	}

	it('should leave the frame in the log with the cursor below it', () => {
		// an inline backend holds its rows until it is told otherwise, and with the
		// anchor goes the arithmetic that says where the frame's top is relative to
		// the cursor. A `console.log()` after `dispose()` moved the real cursor and
		// left that arithmetic describing somewhere else, so the erase the region
		// does on its way out started two rows *inside* the frame and cleared
		// downwards -- eating the log line and leaving the top of the frame behind
		const { screen, terminal } = screened();
		const view = render(
			() => box({ 'flex-direction': 'column' }, text('one'), text('two'), text('three')),
			{ effects, terminal }
		);

		view.dispose();
		terminal.write('after\r\n');

		expect(screen.written).toEqual(['one', 'two', 'three', 'after']);
	});

	it('should leave nothing behind when the backend is stopped first', () => {
		// order matters and the doc says so: finishing the region is what hands the
		// rows back, so an erase on the other side of `dispose()` has no anchor to
		// be relative to and quietly does nothing
		const { screen, terminal } = screened();
		const view = render(() => box({ 'flex-direction': 'column' }, text('one'), text('two')), {
			effects,
			terminal,
		});

		view.backend.stop();
		view.dispose();
		terminal.write('after\r\n');

		expect(screen.written).toEqual(['after']);
	});
});

describe('refining what the terminal is', () => {
	/**
	 * A router that answers with whatever it was told to, and nothing else.
	 *
	 * `detect()` only ever calls `query()`, and the router's own half -- a reply
	 * taken out of the key stream, the CPR gate, the deadline -- is asserted in
	 * `test/input/capabilities.test.ts` over the real one. What is asserted here is
	 * the renderer's half: that a late reply *restyles* rather than being dropped.
	 */
	function answering(replies: readonly string[]) {
		const written: string[] = [];
		return {
			written,
			router: {
				query(opts: { write: string }) {
					written.push(opts.write);
					return Promise.resolve(
						replies.map((it) => parseCapabilityResponse(it)).filter((it) => it !== undefined)
					);
				},
			} as never,
		};
	}

	const SHEET = `
		box { color: gray }
		@media (color-level: 3) { box { color: cyan } }
	`;

	it('should publish a late reply as a media change and restyle', async () => {
		const h = harness(20, 4);
		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade: new Cascade([parseStylesheet(SHEET)]),
				colorLevel: 2,
				effects,
				frameMs: 0,
				terminal: h.terminal,
			}
		);

		// the first frame did not wait for anything: it painted at the level that was
		// inferred, which is what `probing refines it and never gates it` means
		expect(root?.style.color).toBe(8);
		const painted = h.painted;

		const { router } = answering([`\u001bP>|Ghostty 1.0.1\u001b\\`, `\u001b[?62;c`]);
		const caps = await view.detect(router);
		expect(caps.colorLevel).toBe(3);

		// and the frame the reply asked for arrives on its own, which is the half
		// that silently does nothing when it is not wired up
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(root?.style.color, 'the reply was read and then dropped').toBe(6);
		expect(h.painted, 'nothing repainted').toBeGreaterThan(painted);
		view.dispose();
	});

	it('should let a resize keep the refinement rather than undo it', async () => {
		const h = harness(20, 4);
		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade: new Cascade([parseStylesheet(SHEET)]),
				colorLevel: 1,
				effects,
				frameMs: 0,
				terminal: h.terminal,
			}
		);

		const { router } = answering([`\u001bP>|kitty 0.32.2\u001b\\`, `\u001b[?62;c`]);
		await view.detect(router);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(root?.style.color).toBe(6);

		// `readMedia()` rebuilds the whole context from scratch, so a level the
		// terminal told us about has to survive that or the refinement lasts exactly
		// until the window changes by a column
		h.resize(40, 24);
		view.frame();
		expect(root?.style.color, 'a resize undid what the terminal said').toBe(6);
		view.dispose();
	});

	it('should never raise a level of zero, whatever the terminal says', async () => {
		const h = harness(20, 4);
		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade: new Cascade([parseStylesheet(SHEET)]),
				// zero is what `NO_COLOR` and a pipe produce, and a probe that raised it
				// would override a choice the user or the destination already made --
				// the same rule the degrader keeps for a declared palette colour
				colorLevel: 0,
				effects,
				frameMs: 0,
				terminal: h.terminal,
			}
		);

		const { router } = answering([`\u001bP>|Ghostty 1.0.1\u001b\\`, `\u001b[?62;c`]);
		const caps = await view.detect(router);
		expect(caps.colorLevel).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(root?.style.color, 'a level of zero was raised').toBe(-1);
		view.dispose();
	});

	it('should write no query from a renderer that has gone', async () => {
		const h = harness(20, 4);
		const view = render(() => box({}, text('x')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});
		view.dispose();

		const { router, written } = answering([`\u001b[?1;2c`]);
		const caps = await view.detect(router);
		expect(written).toEqual([]);
		expect(caps.responded).toBe(false);
	});
});

describe('a reply that came back to a different screen', () => {
	// `refineColorLevel()` is asked before the await and only ever sees the level
	// that was on screen then. A resize re-reads the environment, so a level that was
	// 2 when the query went out can be 0 -- `NO_COLOR` exported in between -- by the
	// time the reply lands, and a publish that only compared the two would put
	// colour back on a screen that had just been told not to have any
	it('should not raise a level that has since gone to zero', async () => {
		const h = harness(20, 4);
		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade: new Cascade([parseStylesheet(`box { color: gray }`)]),
				colorLevel: 0,
				effects,
				frameMs: 0,
				terminal: h.terminal,
			}
		);

		const written: string[] = [];
		const router = {
			query(opts: { write: string }) {
				written.push(opts.write);
				return Promise.resolve(
					[`\u001bP>|Ghostty 1.0.1\u001b\\`, `\u001b[?62;c`]
						.map((it) => parseCapabilityResponse(it))
						.filter((it) => it !== undefined)
				);
			},
		} as never;

		// the floor the probe refines from, as it was before the level moved
		await view.detect(router, { colorLevel: 2 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(root?.style.color, 'colour came back on a screen at level zero').toBe(-1);
		view.dispose();
	});
});

describe('learning the background', () => {
	const SHEET = `
		box { color: gray }
		@media (prefers-color-scheme: light) { box { color: blue } }
	`;

	/** Gray for dark, blue for light: the colour that says which half applied. */
	const COLOR = { dark: 8, light: 4 } as const;

	function answering(replies: readonly string[]) {
		return {
			query() {
				return Promise.resolve(
					replies.map((it) => parseCapabilityResponse(it)).filter((it) => it !== undefined)
				);
			},
		} as never;
	}

	/**
	 * Mounts and reports which scheme it came up at.
	 *
	 * Read back rather than assumed, and then answered with the *opposite*: a
	 * developer whose `COLORFGBG` says light would otherwise be testing a transition
	 * that never happened, which is this repository's own rule about a fixture that
	 * depends on the machine it runs on.
	 */
	function mount(colorScheme?: 'dark' | 'light') {
		const h = harness(20, 4);
		const cascade = new Cascade([parseStylesheet(SHEET)]);
		let root: Element | undefined;
		const view = render(
			() => {
				root = box({}, text('x'));
				return root;
			},
			{
				backend: h.backend,
				cascade,
				colorLevel: 2,
				...(colorScheme ? { colorScheme } : {}),
				effects,
				frameMs: 0,
				terminal: h.terminal,
			}
		);
		return {
			at: cascade.media.colorScheme,
			h,
			root: () => root,
			view,
			/** A background whose luminance is on the other side of the midpoint. */
			opposite: cascade.media.colorScheme === 'dark' ? 'rgb:fdfd/f6f6/e3e3' : 'rgb:1c1c/1c1c/1c1c',
			other: cascade.media.colorScheme === 'dark' ? ('light' as const) : ('dark' as const),
		};
	}

	// the half the ticket was written for: env first as the synchronous answer, OSC 11
	// refining it a frame or two later as a media-context change. Sabotage-proofed by
	// asserting that the frame the reply asked for arrives on its own
	it('should restyle when the terminal turns out to be the other way', async () => {
		const m = mount();
		expect(m.root()?.style.color).toBe(COLOR[m.at]);
		const painted = m.h.painted;

		const caps = await m.view.detect(answering([`\u001b]11;${m.opposite}\u0007`, `\u001b[?62;c`]), {
			background: true,
		});
		expect(caps.colorScheme).to.equal(m.other);

		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(m.root()?.style.color, 'the reply was read and then dropped').toBe(COLOR[m.other]);
		expect(m.h.painted, 'nothing repainted').toBeGreaterThan(painted);
		m.view.dispose();
	});

	// unlike the colour level, a named scheme is not overruled by a reply: nothing
	// fills it in on a caller's behalf, so naming one is a statement about what the
	// output is drawn against rather than a guess at the terminal
	it('should let a caller who named a scheme keep it, and not repaint over it', async () => {
		const m = mount('dark');
		const painted = m.h.painted;
		await m.view.detect(answering([`\u001b]11;rgb:ffff/ffff/ffff\u0007`, `\u001b[?62;c`]), {
			background: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(m.root()?.style.color).toBe(COLOR.dark);
		// and no frame was asked for at all: a caller who named one is not asking, so a
		// reply that disagrees is not a change -- publishing anyway is a full re-match
		// and a repaint that change nothing, on every probe, for such an app
		expect(m.h.painted, 'the reply asked for a frame that could change nothing').to.equal(painted);
		m.view.dispose();
	});

	// `readMedia()` rebuilds the context from scratch, so a scheme the terminal told
	// us about has to survive a resize or it lasts until the window moves a column
	it('should keep a learned scheme across a resize', async () => {
		const m = mount();
		await m.view.detect(answering([`\u001b]11;${m.opposite}\u0007`, `\u001b[?62;c`]), {
			background: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(m.root()?.style.color).toBe(COLOR[m.other]);

		m.h.resize(40, 24);
		m.view.frame();
		expect(m.root()?.style.color, 'a resize undid what the terminal said').toBe(COLOR[m.other]);
		m.view.dispose();
	});

	it('should change nothing when the terminal is silent', async () => {
		const m = mount();
		const caps = await m.view.detect(answering([]), { background: true });
		expect(caps.colorScheme).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(m.root()?.style.color).toBe(COLOR[m.at]);
		m.view.dispose();
	});
});

describe('where the scheme comes from', () => {
	/**
	 * Four sources, and the order is the whole of the decision.
	 *
	 * `render()`'s option, then `SIGIL_COLOR_SCHEME`, then an OSC 11 reply, then
	 * `COLORFGBG`, then dark. Reading the two variables through one function put the
	 * reply *above* the user's override for a commit, because the override was inside
	 * the call that sat under the refinement -- which is why the two halves are
	 * separate functions and why this test exists.
	 */
	const SHEET = `
		box { color: gray }
		@media (prefers-color-scheme: light) { box { color: blue } }
	`;
	const COLOR = { dark: 8, light: 4 } as const;

	function answering(background: string) {
		return {
			query() {
				return Promise.resolve(
					[`\u001b]11;${background}\u0007`, `\u001b[?62;c`]
						.map((it) => parseCapabilityResponse(it))
						.filter((it) => it !== undefined)
				);
			},
		} as never;
	}

	async function schemeOf(
		env: Record<string, string | undefined>,
		opts: { background?: string; colorScheme?: 'dark' | 'light' } = {}
	) {
		const before = { ...process.env };
		for (const key of ['COLORFGBG', 'SIGIL_COLOR_SCHEME']) {
			delete process.env[key];
		}
		Object.assign(process.env, env);
		try {
			const h = harness(20, 4);
			let root: Element | undefined;
			const view = render(
				() => {
					root = box({}, text('x'));
					return root;
				},
				{
					backend: h.backend,
					cascade: new Cascade([parseStylesheet(SHEET)]),
					colorLevel: 2,
					...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
					effects,
					frameMs: 0,
					terminal: h.terminal,
				}
			);
			if (opts.background) {
				await view.detect(answering(opts.background), { background: true });
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const found = root?.style.color === COLOR.light ? 'light' : 'dark';
			view.dispose();
			return found;
		} finally {
			for (const key of ['COLORFGBG', 'SIGIL_COLOR_SCHEME']) {
				delete process.env[key];
			}
			Object.assign(process.env, before);
		}
	}

	const WHITE = 'rgb:ffff/ffff/ffff';
	const BLACK = 'rgb:0000/0000/0000';

	it('should fall back to dark when nothing said', async () => {
		expect(await schemeOf({})).to.equal('dark');
	});

	it('should read COLORFGBG when that is all there is', async () => {
		expect(await schemeOf({ COLORFGBG: '0;15' })).to.equal('light');
	});

	it('should let a reply beat COLORFGBG', async () => {
		expect(await schemeOf({ COLORFGBG: '0;15' }, { background: BLACK })).to.equal('dark');
	});

	// the bug round one found: the reply was above the override rather than below it
	it('should not let a reply beat the user', async () => {
		expect(
			await schemeOf({ COLORFGBG: '0;15', SIGIL_COLOR_SCHEME: 'light' }, { background: BLACK })
		).to.equal('light');
	});

	it('should let the user beat COLORFGBG', async () => {
		expect(await schemeOf({ COLORFGBG: '15;0', SIGIL_COLOR_SCHEME: 'light' })).to.equal('light');
	});

	// an app that names one may be painting its own background, so it is stating a
	// fact about its output rather than guessing at the terminal
	it('should let the app beat the user and the reply', async () => {
		expect(
			await schemeOf({ SIGIL_COLOR_SCHEME: 'light' }, { background: WHITE, colorScheme: 'dark' })
		).to.equal('dark');
	});

	/**
	 * A reply that *agrees* with what is on screen is still the terminal's answer.
	 *
	 * Found by review. A reply was recorded only where it differed, so a terminal
	 * answering light while `COLORFGBG` already said light left nothing behind -- and
	 * the next resize, after that variable had gone, fell through to dark over a
	 * terminal that had told us. Which is the shape of the whole ticket: the reply is
	 * the truthful source and the variable is the stale one.
	 */
	it('should record a reply that agrees, so a lower source cannot replace it', async () => {
		const before = { ...process.env };
		delete process.env.SIGIL_COLOR_SCHEME;
		process.env.COLORFGBG = '0;15';
		try {
			const h = harness(20, 4);
			let root: Element | undefined;
			const view = render(
				() => {
					root = box({}, text('x'));
					return root;
				},
				{
					backend: h.backend,
					cascade: new Cascade([parseStylesheet(SHEET)]),
					colorLevel: 2,
					effects,
					frameMs: 0,
					terminal: h.terminal,
				}
			);
			expect(root?.style.color).toBe(COLOR.light);

			// the terminal agrees with the variable, so nothing on screen moves
			const painted = h.painted;
			await view.detect(answering(WHITE), { background: true });
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(h.painted, 'a reply that changed nothing asked for a frame').to.equal(painted);

			// and then the variable goes, which is what tmux reattaching looks like
			delete process.env.COLORFGBG;
			h.resize(40, 24);
			view.frame();
			expect(root?.style.color, 'the terminal was overruled by its own absence').toBe(COLOR.light);
			view.dispose();
		} finally {
			delete process.env.COLORFGBG;
			delete process.env.SIGIL_COLOR_SCHEME;
			Object.assign(process.env, before);
		}
	});
});

describe('a canvas that follows what it draws', () => {
	// SIG-130, through the other reader of the same walk. `mountLive()` asks for
	// `width: 'auto'` and names no height, so every spinner, bar, prompt and
	// table reserves the rows `arrangedExtent()` reports -- and a clipped pane
	// used to report the rows nobody can see, so the canvas held three blank rows
	// of the user's scrollback open for the life of the frame
	it('should not reserve rows a clip hides', () => {
		const { terminal } = setup({ columns: 40 });
		const view = render(
			() =>
				box(
					{ 'flex-direction': 'column' },
					box(
						{ height: 1, overflow: 'hidden', width: 6 },
						box(
							{ 'flex-direction': 'column', 'flex-shrink': 0 },
							text('r1'),
							text('r2'),
							text('r3'),
							text('r4')
						)
					)
				),
			{ frameMs: 0, terminal, width: 'auto' }
		);

		expect(view.backend.height).to.equal(1);
		view.dispose();
	});

	// and the second pass still grows it where nothing clips, which is the rule
	// this must not have broken: a row whose description wraps further than it
	// measured is why that pass exists at all
	it('should still reserve rows for overflow nothing clips', () => {
		const { terminal } = setup({ columns: 40 });
		const view = render(
			() =>
				box(
					{ 'flex-direction': 'column' },
					box(
						{ height: 1, width: 6 },
						box(
							{ 'flex-direction': 'column', 'flex-shrink': 0 },
							text('r1'),
							text('r2'),
							text('r3'),
							text('r4')
						)
					)
				),
			{ frameMs: 0, terminal, width: 'auto' }
		);

		expect(view.backend.height).to.equal(4);
		view.dispose();
	});
});
