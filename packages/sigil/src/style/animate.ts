/**
 * Transitions and keyframe animations: what is on screen between two styles.
 *
 * A terminal is a frame loop, so CSS animation works here -- and it turns a
 * category of thing that was hand-written imperative code into declarative
 * style. Two mechanisms, both CSS's: a `transition` animates a style change
 * caused by anything at all, and `@keyframes` plus `animation` runs a named
 * sequence.
 *
 * ```js
 * const animator = new Animator(cascade);
 *
 * animator.observe(button, baseStyle, now);  // starts whatever the change implies
 * const { styles, layout, paint } = animator.tick(now);
 * for (const [el, style] of styles) el.style = style;
 * ```
 *
 * **It writes through to paint rather than marking style dirty**, which is the
 * architecture SIG-62 decided in advance and this keeps: nothing here calls into
 * the `Restyler`, so the cascade is not re-run per frame. What the animator holds
 * is a *presented* style per animating element, built over the base style the
 * cascade resolved -- so `restyler.styleOf()` stays the cascade's answer and
 * `element.style` is what is drawn. The one refinement the architecture needed is
 * that an animated **geometry** property is in `LAYOUT_PROPERTIES` and therefore
 * genuinely does have to re-lay-out; `tick()` reports that separately, and the
 * frame skipping below is what makes it affordable.
 *
 * **An animated value is presented, not inherited.** A `color` transition on a
 * container does not drag its text with it, because inheriting a presented value
 * means re-resolving the subtree every frame -- the one thing the architecture
 * rules out. The base value still inherits, so a selector covering both the
 * container and its text gives every element its own transition, all starting at
 * the same moment with the same duration, which is the spelling to reach for.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import type { Cascade } from './cascade.js';
import { ease, type Easing } from './easing.js';
import { interpolate } from './interpolate.js';
import { difference } from './invalidate.js';
import {
	ANIMATABLE_PROPERTIES,
	type AnimationDirection,
	type AnimationFillMode,
	INTERPOLATION,
	LAYOUT_PROPERTIES,
	type PropertyName,
	type Style,
} from './properties.js';
import type { Keyframes } from './stylesheet.js';

/**
 * How many frame-lengths ahead `nextChange()` will look.
 *
 * Bounded rather than open-ended: the search is linear in the number of probes
 * and the point of it is to not wake up, so a slow animation that changes
 * nothing for ten seconds wakes a handful of times rather than being solved
 * exactly. Sixty-four at thirty frames a second is about two seconds.
 */
const HORIZON = 64;

/** What one `tick()` decided. */
export interface AnimationFrame<T> {
	/** Elements whose presented box may have moved. */
	readonly layout: ReadonlySet<T>;
	/** Elements whose presented cells may have changed. */
	readonly paint: ReadonlySet<T>;
	/**
	 * The style to present, for every element the animator is overriding.
	 *
	 * **The same object as last frame where nothing quantized differently**, which
	 * is what makes a text's measurement cache survive an animation: that cache is
	 * keyed on the resolved style *object*, so a new one per frame would re-wrap
	 * every string in an animating subtree thirty times a second.
	 */
	readonly styles: ReadonlyMap<T, Style>;
}

/** One property on its way from one value to another. */
interface Transition {
	readonly duration: number;
	readonly easing: Easing;
	readonly from: unknown;
	/** When the clock started, which is the delay already added in. */
	readonly start: number;
	readonly to: unknown;
}

/** A running `@keyframes`, with its stops indexed by property. */
interface Running {
	readonly delay: number;
	readonly direction: AnimationDirection;
	readonly duration: number;
	readonly easing: Easing;
	readonly fill: AnimationFillMode;
	readonly iterations: number;
	readonly name: string;
	/** When it was applied, before the delay. */
	readonly start: number;
	/**
	 * Per property, the stops that mention it, in offset order.
	 *
	 * Built once when the animation starts rather than searched per frame, and it
	 * is also what collapses two blocks at one offset: the later one wins per
	 * property, which is what writing them in order comes to.
	 */
	readonly stops: ReadonlyMap<PropertyName, readonly (readonly [number, unknown])[]>;
}

/** What the animator holds per element. */
interface Entry {
	animation: Running | undefined;
	/** The cascade's answer, which is what everything is animated *from* and *to*. */
	base: Style;
	/**
	 * Which base object `presented` was built over.
	 *
	 * Identity rather than a comparison, for the reason `Element`'s measurement
	 * cache is keyed that way: the cascade hands back a new `Style` when anything
	 * about it changed and the same one when nothing did, so this answers "is the
	 * presented style still built over the current base" exactly and for free.
	 */
	builtFrom: Style | undefined;
	/**
	 * The values a `forwards` fill is holding after its animation finished.
	 *
	 * Lazily created, because the common entry has none: a transition leaves
	 * nothing behind and the default fill mode is `none`.
	 */
	fill?: Map<PropertyName, unknown>;
	/** The property values currently overriding the base, kept to compare against. */
	overrides: Map<PropertyName, unknown>;
	/** What was last handed back, kept so that an unchanged frame hands back the same object. */
	presented: Style | undefined;
	readonly transitions: Map<PropertyName, Transition>;
}

/**
 * Holds what is animating, and says what to present.
 *
 * Generic over the element type for the reason `invalidate.ts` takes a
 * `StyleTarget`: this layer is testable with no terminal, no renderer and no
 * element tree, and it keeps that only by not knowing what an element is.
 */
/**
 * Holds what is animating, and says what to present.
 *
 * Generic over the element type for the reason `invalidate.ts` takes a
 * `StyleTarget`: this layer is testable with no terminal, no renderer and no
 * element tree, and it keeps that only by not knowing what an element is.
 *
 * **Two maps, and the split is the whole of what makes a transition start.** A
 * transition animates from the value an element had *before* the change, so the
 * last base style has to be kept for every element the animator has been shown
 * -- and keeping that on the same entry as the running state made the entry get
 * dropped the moment nothing was running, which is exactly when there is nothing
 * to animate yet. The first version did precisely that and no transition ever
 * started: every change looked like an element's first style. So `#base` is a
 * record per element, the size of the tree and cleaned by `forget()` the way the
 * restyler's caches are, and `#entries` holds only what is actually in flight --
 * which is what `tick()` and `active` walk, so the per-frame cost is
 * proportional to the animation rather than to the tree.
 */
export class Animator<T extends object> {
	readonly #cascade: Cascade;
	/** What the cascade last resolved per element, which is what a change is *from*. */
	readonly #base = new Map<T, Style>();
	/** Only the elements with something running or something filled. */
	readonly #entries = new Map<T, Entry>();

	constructor(cascade: Cascade) {
		this.#cascade = cascade;
	}

	/** Whether anything will change without a style change to provoke it. */
	get active(): boolean {
		for (const entry of this.#entries.values()) {
			if (entry.transitions.size > 0 || entry.animation) {
				return true;
			}
		}
		return false;
	}

	/** How many elements have something in flight or something filled. */
	get size(): number {
		return this.#entries.size;
	}

	/**
	 * Records an element's base style and starts whatever the change implies.
	 *
	 * The diff is the animator's own rather than the restyler's, because what a
	 * transition needs is the properties that changed *on this element* and the
	 * `Update` a settle hands back names elements rather than properties. It is
	 * only asked about elements the restyler reported as changed, so the cost is a
	 * `difference()` per element that actually moved.
	 *
	 * **Nothing transitions on an element's first style.** There is no
	 * before-change value to animate from, which is CSS, and without the rule
	 * every element in a tree would animate from its initial style on the first
	 * frame. An *animation* does start there, because applying one is what starts
	 * it.
	 *
	 * @param target - The element.
	 * @param base - What the cascade resolved for it.
	 * @param now - The clock.
	 */
	observe(target: T, base: Style, now: number): void {
		const before = this.#base.get(target);
		this.#base.set(target, base);

		// a live entry presents its style *over* the base, so it has to follow
		const live = this.#entries.get(target);
		if (live) {
			live.base = base;
		}

		if (before !== undefined) {
			if (this.#reduced) {
				live?.transitions.clear();
			} else {
				for (const property of difference(before, base)) {
					this.#startTransition(target, property, now, before);
				}
				// and a transition whose *declaration* has gone is cancelled, which the
				// diff above cannot see: removing `transition: width 100ms` changes the
				// transition longhands and leaves `width` exactly where it was, so
				// nothing in the loop is ever asked about the property that is running.
				// CSS cancels there, and so does this -- a transition still easing on a
				// rule nobody declares any more is one with no live writer
				const running = this.#entries.get(target);
				if (running) {
					// deleting the current entry while iterating a Map is defined and
					// safe, which is what `#retire()` already relies on
					for (const property of running.transitions.keys()) {
						if (!watches(base.transitionProperty, property) || base.transitionDuration <= 0) {
							running.transitions.delete(property);
						}
					}
				}
			}
		}

		this.#syncAnimation(target, base, now);
	}

	/**
	 * Advances everything to `now`.
	 *
	 * @param now - The clock.
	 * @returns What to present, and what that disturbed.
	 */
	tick(now: number): AnimationFrame<T> {
		const layout = new Set<T>();
		const paint = new Set<T>();
		const styles = new Map<T, Style>();
		const level = this.#level;

		for (const [target, entry] of this.#entries) {
			this.#retire(entry, now);
			const overrides = this.#overridesAt(entry, now, level);

			if (!same(overrides, entry.overrides)) {
				const moved = changedProperties(overrides, entry.overrides);
				paint.add(target);
				if (moved.some((property) => LAYOUT_PROPERTIES.has(property))) {
					layout.add(target);
				}
				entry.overrides = overrides;
				entry.presented = overrides.size === 0 ? undefined : apply(entry.base, overrides);
				entry.builtFrom = entry.presented ? entry.base : undefined;
			} else if (overrides.size > 0 && entry.builtFrom !== entry.base) {
				// the overrides did not move and the *base* did: a style change the
				// animation does not cover -- a colour while a width eases -- has to
				// reach the screen, and the presented style is built over the base. The
				// restyler marked that paint itself, so this rebuilds without claiming
				// it, which is what keeps the object identity stable for every frame
				// that really did change nothing
				entry.presented = apply(entry.base, overrides);
				entry.builtFrom = entry.base;
			}

			if (entry.presented) {
				styles.set(target, entry.presented);
			}

			// an entry with nothing left to say is dropped, so that `size` is the
			// animation's footprint rather than the tree's. The element's base stays
			// in `#base`, because that is what the *next* change animates from
			if (
				entry.transitions.size === 0 &&
				entry.animation === undefined &&
				entry.overrides.size === 0
			) {
				this.#entries.delete(target);
			}
		}

		return { layout, paint, styles };
	}

	/**
	 * How long until something would quantize differently, in milliseconds.
	 *
	 * **The frame skip, done by not setting a timer rather than by waking up and
	 * returning early.** Geometry interpolates in whole cells and a colour
	 * quantizes to what the terminal can emit, so a 300ms animation over ten
	 * columns has ten visible states however many frames go past -- and a frame
	 * that would paint exactly what is already on screen is one nobody should pay
	 * for. The alternative, waking at `frameMs` and comparing, pays the wakeup and
	 * the diff every time; this pays a few dozen evaluations of a pure function
	 * once and then sleeps through the frames that would have been identical.
	 *
	 * It is a floor rather than a promise: a signal write or a tree mutation asks
	 * for a frame on its own, and an earlier request wins.
	 *
	 * @param now - The clock.
	 * @param step - The frame length to probe at.
	 * @returns The delay, or `undefined` where nothing is animating.
	 */
	nextChange(now: number, step: number): number | undefined {
		if (!this.active) {
			return undefined;
		}

		const level = this.#level;
		const grain = Math.max(1, step);
		// an animation that ends inside the horizon is woken for, even where its
		// last frames are identical: the entry has to be retired for `active` to go
		// false, and `active` going false is what stops the timer
		let limit = HORIZON * grain;
		for (const entry of this.#entries.values()) {
			for (const transition of entry.transitions.values()) {
				limit = Math.min(limit, Math.max(0, transition.start + transition.duration - now));
			}
			const end = entry.animation ? endOf(entry.animation) - now : undefined;
			if (end !== undefined && end >= 0) {
				limit = Math.min(limit, end);
			}
		}

		const current = new Map<T, Map<PropertyName, unknown>>();
		for (const [target, entry] of this.#entries) {
			current.set(target, this.#overridesAt(entry, now, level));
		}

		for (let at = grain; at <= limit; at += grain) {
			for (const [target, entry] of this.#entries) {
				const was = current.get(target) as Map<PropertyName, unknown>;
				if (!same(this.#overridesAt(entry, now + at, level), was)) {
					return at;
				}
			}
		}

		return limit;
	}

	/**
	 * Drops everything the animator knows about an element.
	 *
	 * Called when an element is unmounted, for the reason `Restyler.forget()` is:
	 * both maps are keyed by element identity, so a subtree that was shown and
	 * hidden would stay reachable for the life of the animator.
	 *
	 * @param target - The element that went.
	 */
	forget(target: T): void {
		this.#base.delete(target);
		this.#entries.delete(target);
	}

	/** The style an element is presenting, if the animator is overriding one. */
	styleOf(target: T): Style | undefined {
		return this.#entries.get(target)?.presented;
	}

	/** Whether animations are collapsed rather than run. */
	get #reduced(): boolean {
		return this.#cascade.media.reducedMotion === 'reduce';
	}

	/** The depth a mixed colour has to be degraded to. */
	get #level(): ColorLevel {
		return this.#cascade.media.colorLevel as ColorLevel;
	}

	/** The in-flight entry for an element, created on demand. */
	#entryFor(target: T, base: Style): Entry {
		let entry = this.#entries.get(target);
		if (!entry) {
			entry = {
				animation: undefined,
				base,
				builtFrom: undefined,
				overrides: new Map(),
				presented: undefined,
				transitions: new Map(),
			};
			this.#entries.set(target, entry);
		}
		return entry;
	}

	/**
	 * Starts, replaces or cancels one property's transition.
	 *
	 * **Interruptible, from the value currently on screen**, which is CSS and is
	 * the only answer that does not look broken: a focus ring half way through
	 * easing in and then unfocused has to ease back from where it is, not jump to
	 * the full value and ease from there. The alternative -- restart from the
	 * declared value -- is no cheaper and is visibly wrong on exactly the input
	 * this feature exists for, a state that toggles faster than the duration.
	 *
	 * What is *not* implemented is CSS's reversing-shortening factor, which makes
	 * a reverse of a half-done transition take half the time rather than the full
	 * duration. At whole-cell quantization it changes which of a handful of states
	 * you see rather than whether the result looks right, and it is a second
	 * timing rule to hold; noted and skipped.
	 */
	#startTransition(target: T, property: PropertyName, now: number, before: Style): void {
		const style = this.#base.get(target) as Style;
		const live = this.#entries.get(target);

		if (INTERPOLATION.get(property) === 'none' || !watches(style.transitionProperty, property)) {
			return;
		}
		if (style.transitionDuration <= 0) {
			// a transition with no duration is not one. Any running transition for
			// the property is cancelled rather than left to finish, because the
			// declaration that would have kept it running has gone
			live?.transitions.delete(property);
			return;
		}

		const to = style[property] as unknown;
		// the value on *screen*, which is the override where one is running and the
		// style the cascade had before this change where none is
		const from =
			live && live.overrides.has(property)
				? live.overrides.get(property)
				: (live?.presented ?? before)[property];

		if (sameValue(from, to)) {
			live?.transitions.delete(property);
			return;
		}

		this.#entryFor(target, style).transitions.set(property, {
			duration: style.transitionDuration,
			easing: style.transitionTimingFunction,
			from,
			start: now + style.transitionDelay,
			to,
		});
	}

	/**
	 * Starts, keeps or stops the element's animation to match its style.
	 *
	 * A change to `animation-name` restarts; a change to the timing is taken up in
	 * place without a restart, which is CSS -- a theme that lengthens a duration
	 * should not jolt every animation on screen back to its first frame.
	 *
	 * **A name nothing declares runs nothing, silently.** That looks like the rule
	 * this repo keeps against a declaration that parses and does nothing, and it is
	 * the one place that rule cannot hold: the name is resolved against the live set
	 * of sheets, which an app may add to at runtime for a theme, so an unmatched
	 * name is as likely to be a sheet that has not arrived as a typo -- and this
	 * runs inside a frame, where there is nobody to report to and a throw would
	 * bring the screen down over a stylesheet.
	 */
	#syncAnimation(target: T, base: Style, now: number): void {
		const live = this.#entries.get(target);
		const name = base.animationName;

		if (name === 'none' || base.animationDuration <= 0 || base.animationIterationCount <= 0) {
			// a zero duration or zero iterations is an animation with no play time,
			// which CSS gives no effect beyond its fill; treating it as nothing
			// running is the same answer with one state fewer to hold
			if (live) {
				live.animation = undefined;
			}
			return;
		}

		const frames = this.#cascade.keyframes(name);
		if (!frames) {
			if (live) {
				live.animation = undefined;
			}
			return;
		}

		const entry = this.#entryFor(target, base);
		if (entry.animation && entry.animation.name === name) {
			entry.animation = { ...entry.animation, ...timing(base) };
			return;
		}

		entry.animation = {
			name,
			start: now,
			stops: index(frames),
			...timing(base),
		};
	}

	/** Drops transitions and animations that have finished. */
	#retire(entry: Entry, now: number): void {
		for (const [property, transition] of entry.transitions) {
			if (now >= transition.start + transition.duration) {
				entry.transitions.delete(property);
			}
		}

		const animation = entry.animation;
		if (animation && now >= endOf(animation)) {
			// a `forwards` fill keeps its last value on screen, so the *override*
			// outlives the animation. What does not outlive it is the entry being
			// active, which is what stops the frame loop
			entry.animation = undefined;
			if (animation.fill === 'forwards' || animation.fill === 'both') {
				for (const [property, value] of this.#animationValues(
					animation,
					entry,
					endOf(animation),
					this.#level
				)) {
					entry.transitions.delete(property);
					filled(entry).set(property, value);
				}
			}
		}
	}

	/** Every property override in effect at a moment, animation under transitions. */
	#overridesAt(entry: Entry, now: number, level: ColorLevel): Map<PropertyName, unknown> {
		const out = new Map<PropertyName, unknown>(entry.fill);

		if (entry.animation) {
			for (const [property, value] of this.#animationValues(entry.animation, entry, now, level)) {
				out.set(property, value);
			}
		}

		// transitions last, because CSS puts them above animations: a transition is
		// a response to a change that has already happened and an animation is a
		// loop, so the loop losing is the only order that lets a component stop one
		for (const [property, transition] of entry.transitions) {
			const elapsed = now - transition.start;
			if (elapsed < 0) {
				// the delay has not run out: the before-change value is what is on
				// screen, which is CSS's own answer for a delayed transition
				out.set(property, transition.from);
				continue;
			}
			const t = ease(
				transition.easing,
				transition.duration <= 0 ? 1 : Math.min(1, elapsed / transition.duration)
			);
			out.set(property, interpolate(property, transition.from, transition.to, t, level));
		}

		// an override equal to the base is not an override: the renderer has
		// already written the base onto the element, so presenting the same value
		// again would keep an entry alive to say nothing
		for (const [property, value] of out) {
			if (sameValue(value, entry.base[property])) {
				out.delete(property);
			}
		}

		return out;
	}

	/** What a running animation says every property it touches is, at a moment. */
	#animationValues(
		animation: Running,
		entry: Entry,
		now: number,
		level: ColorLevel
	): Map<PropertyName, unknown> {
		const out = new Map<PropertyName, unknown>();
		const progress = progressOf(animation, now, this.#reduced);
		if (progress === undefined) {
			return out;
		}

		const t = ease(animation.easing, progress);

		for (const [property, stops] of animation.stops) {
			out.set(property, valueAt(stops, property, t, entry.base[property], level));
		}

		return out;
	}
}

/**
 * The filled values an entry is holding, which exist only once a `forwards` fill
 * has outlived its animation.
 *
 * A lazily created map rather than one per entry, because the common entry has
 * none and the common animation does not fill.
 */
function filled(entry: Entry): Map<PropertyName, unknown> {
	entry.fill ??= new Map();
	return entry.fill;
}

/** The timing half of an animation's declaration, which is taken up in place. */
function timing(style: Style): Omit<Running, 'name' | 'start' | 'stops'> {
	return {
		delay: style.animationDelay,
		direction: style.animationDirection,
		duration: style.animationDuration,
		easing: style.animationTimingFunction,
		fill: style.animationFillMode,
		iterations: style.animationIterationCount,
	};
}

/** When an animation stops changing. `Infinity` for an infinite one. */
function endOf(animation: Running): number {
	return animation.start + animation.delay + animation.duration * animation.iterations;
}

/**
 * How far through its iteration an animation is, with the direction applied.
 *
 * `undefined` means it is presenting nothing: either the delay has not run out
 * and the fill does not reach backwards, or it is an infinite animation under
 * reduced motion.
 *
 * **Reduced motion collapses a finite animation to its end state and refuses an
 * infinite one outright.** The ticket asked for the end state and that is the
 * answer for anything that has one; an infinite animation has no end state, so
 * the honest collapse is not to run it -- which for the spinner's case is the
 * base style, and is what a CI log has always got.
 */
function progressOf(animation: Running, now: number, reduced: boolean): number | undefined {
	const { delay, direction, duration, fill, iterations, start } = animation;

	if (reduced) {
		// a reduced-motion animation is one that has already finished, which is what
		// makes the rule one sentence rather than two: an infinite animation has no
		// end state to collapse to and does not run, and a finite one leaves behind
		// exactly what its fill mode says it leaves behind -- the final frame for
		// `forwards`, and the element's own style for anything else.
		//
		// The `isFinite` half is a **statement rather than a claim**, and a sabotage
		// pass is what said so: deleting it changes no test, because
		// `Infinity % 1` is `NaN`, `ease()` hands `NaN` straight back, and every
		// comparison in `valueAt()` is then false -- so both endpoints fall back to
		// the underlying value and the override is dropped for being equal to the
		// base. The right answer by five accidents in a row is not an answer to
		// rest on, so the intent is written where it is decided
		if (!Number.isFinite(iterations) || (fill !== 'forwards' && fill !== 'both')) {
			return undefined;
		}
		return directed(finalIteration(iterations), finalOffset(iterations), direction);
	}

	const elapsed = now - start - delay;

	if (elapsed < 0) {
		// before the delay runs out, a `backwards` fill shows the first frame and
		// anything else shows nothing. The first frame is the one the *direction*
		// starts at, which for `reverse` is the end of the sequence
		if (fill !== 'backwards' && fill !== 'both') {
			return undefined;
		}
		return directed(0, 0, direction);
	}

	const total = duration * iterations;
	if (elapsed >= total) {
		if (fill !== 'forwards' && fill !== 'both') {
			return undefined;
		}
		return directed(finalIteration(iterations), finalOffset(iterations), direction);
	}

	return directed(Math.floor(elapsed / duration), (elapsed % duration) / duration, direction);
}

/** Which iteration an animation ends on. */
function finalIteration(iterations: number): number {
	return Math.max(0, Math.ceil(iterations) - 1);
}

/** How far into that iteration it ends. A whole count ends at the end of one. */
function finalOffset(iterations: number): number {
	const fraction = iterations % 1;
	return fraction === 0 ? 1 : fraction;
}

/** `animation-direction` applied to an iteration and an offset within it. */
function directed(iteration: number, offset: number, direction: AnimationDirection): number {
	switch (direction) {
		case 'reverse':
			return 1 - offset;
		case 'alternate':
			return iteration % 2 === 0 ? offset : 1 - offset;
		case 'alternate-reverse':
			return iteration % 2 === 0 ? 1 - offset : offset;
		default:
			return offset;
	}
}

/**
 * The stops a `@keyframes` declares, per property, with a repeated offset
 * collapsed to its last writer.
 */
function index(frames: Keyframes): Map<PropertyName, readonly (readonly [number, unknown])[]> {
	const byProperty = new Map<PropertyName, Map<number, unknown>>();

	for (const frame of frames) {
		for (const [property, value] of frame.declarations) {
			if (INTERPOLATION.get(property) === 'none') {
				// an animation that animated `animation-duration` would be asking what
				// its own duration is in order to find out what it is. Skipped rather
				// than refused at parse time, because a keyframe block is read before
				// anything knows it will be used as one
				continue;
			}
			let stops = byProperty.get(property);
			if (!stops) {
				stops = new Map();
				byProperty.set(property, stops);
			}
			stops.set(frame.offset, value);
		}
	}

	const out = new Map<PropertyName, readonly (readonly [number, unknown])[]>();
	for (const [property, stops] of byProperty) {
		out.set(property, Object.freeze([...stops].sort((a, b) => a[0] - b[0])));
	}
	return out;
}

/**
 * One property's value at a point in a keyframe sequence.
 *
 * The missing endpoints are the **base** value, which is CSS's implicit 0% and
 * 100% keyframes taking the underlying value -- and it is what makes
 * `@keyframes fade { from { color: red } }` ease into whatever the element's own
 * colour is rather than holding red forever.
 */
function valueAt(
	stops: readonly (readonly [number, unknown])[],
	property: PropertyName,
	t: number,
	base: unknown,
	level: ColorLevel
): unknown {
	let lo: readonly [number, unknown] = [0, base];
	let hi: readonly [number, unknown] = [1, base];
	let foundLo = false;
	let foundHi = false;

	for (const stop of stops) {
		if (stop[0] <= t) {
			lo = stop;
			foundLo = true;
		}
		if (!foundHi && stop[0] >= t) {
			hi = stop;
			foundHi = true;
		}
	}

	if (!foundLo) {
		lo = [0, base];
	}
	if (!foundHi) {
		hi = [1, base];
	}

	const span = hi[0] - lo[0];
	if (span <= 0) {
		return hi[1];
	}

	return interpolate(property, lo[1], hi[1], (t - lo[0]) / span, level);
}

/** Whether a `transition-property` names a property. */
function watches(watched: Style['transitionProperty'], property: PropertyName): boolean {
	return watched === 'all'
		? (ANIMATABLE_PROPERTIES as readonly string[]).includes(property)
		: watched.includes(property);
}

/** Two style values, compared the way `difference()` compares them. */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	return (
		typeof a === 'object' &&
		typeof b === 'object' &&
		a !== null &&
		b !== null &&
		(a as { type?: string }).type === (b as { type?: string }).type &&
		(a as { value?: number }).value === (b as { value?: number }).value
	);
}

/** Whether two override maps say the same thing. */
function same(a: Map<PropertyName, unknown>, b: Map<PropertyName, unknown>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [property, value] of a) {
		if (!b.has(property) || !sameValue(value, b.get(property))) {
			return false;
		}
	}
	return true;
}

/** Which properties two override maps disagree about, in either direction. */
function changedProperties(
	a: Map<PropertyName, unknown>,
	b: Map<PropertyName, unknown>
): PropertyName[] {
	const out: PropertyName[] = [];
	for (const [property, value] of a) {
		if (!b.has(property) || !sameValue(value, b.get(property))) {
			out.push(property);
		}
	}
	for (const property of b.keys()) {
		if (!a.has(property)) {
			out.push(property);
		}
	}
	return out;
}

/** The base style with the overrides written over it. */
function apply(base: Style, overrides: Map<PropertyName, unknown>): Style {
	const style = { ...base } as Record<PropertyName, unknown>;
	for (const [property, value] of overrides) {
		style[property] = value;
	}
	return style as Style;
}
