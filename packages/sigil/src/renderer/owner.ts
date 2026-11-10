/**
 * The owner tree: what a component created, and what disposes it.
 *
 * A component's body runs **once**. There is no re-render, no virtual tree and
 * no diff -- the reactive parts of what it built are effects that update nodes
 * in place, so a signal change runs the one effect that reads it and touches the
 * one node it wrote. That is the whole reason signals came first, and it leaves
 * exactly one problem behind: something has to know what a component made, so
 * that unmounting it can take the effects with it. A long-running CLI that skips
 * that leaks a watcher per mount, and nothing above can see them to clean up.
 *
 * So every component body runs under an owner. Effects created through
 * `createEffect()` register with it, `onCleanup()` adds to it, `onMount()`
 * queues against the root, and context is looked up along it. Disposing an owner
 * disposes its children first and then runs its own cleanups in reverse -- the
 * order things were built in, undone.
 */

import { effect as defaultEffect, unowned, untrack } from '../signals/index.js';
import { raise, refuseAsync } from '../signals/raise.js';

/** What a component is: a function of props that builds one element. */
export type Cleanup = () => void;

/**
 * An owner: the scope a component's body ran in.
 *
 * Opaque on purpose. Everything worth doing with one is a function below, and a
 * caller that reaches into the fields is a caller the lifecycle can no longer
 * account for.
 */
export interface Owner {
  readonly parent: Owner | undefined;
}

/** The effect factory an owner tree runs its effects through. */
export type EffectFactory = (fn: () => void | Cleanup) => Cleanup;

class OwnerNode implements Owner {
  readonly children = new Set<OwnerNode>();
  readonly cleanups: Cleanup[] = [];
  /** Set on a root owner only; every other node walks up to find it. */
  context: Map<symbol, unknown> | undefined;
  disposed = false;
  /** Set on a root owner only. */
  effects: EffectFactory | undefined;
  /** Set on a root owner only: callbacks waiting for a frame to have happened. */
  mounts: Cleanup[] | undefined;
  readonly parent: OwnerNode | undefined;
  /** Set on a root owner only: where an unmount's throws go. */
  report: ((error: unknown) => void) | undefined;

  constructor(parent: OwnerNode | undefined) {
    this.parent = parent;
    parent?.children.add(this);
  }

  root(): OwnerNode {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let at: OwnerNode = this;
    while (at.parent) {
      at = at.parent;
    }
    return at;
  }
}

/** The owner whose body is running. */
let current: OwnerNode | undefined;

/**
 * Cleanups for the effect run in progress, or `undefined` outside one.
 *
 * `onCleanup()` inside an effect body belongs to *that run* rather than to the
 * component, because the body is about to run again and whatever it set up is
 * about to be set up again. Anywhere else it belongs to the component.
 */
let runCleanups: Cleanup[] | undefined;

/** Whether an effect body is running, which is what makes ownership implicit. */
let inBody = 0;

/**
 * The owner whose body is running, if any.
 *
 * @returns The owner, or `undefined` outside a component.
 */
export function getOwner(): Owner | undefined {
  return current;
}

/**
 * Runs `fn` with `owner` current.
 *
 * What an escape hatch looks like: a callback that has to create effects or read
 * context after the body that registered it has returned -- a promise settling,
 * a key handler -- has no owner of its own, and this is how it borrows one.
 *
 * @param owner - The owner to run under.
 * @param fn - What to run.
 * @returns Whatever `fn` returned.
 */
export function runWithOwner<T>(owner: Owner | undefined, fn: () => T): T {
  const previousOwner = current;
  const previousCleanups = runCleanups;
  const previousBody = inBody;
  // a fresh ownership scope, not just a different context to read: what `fn`
  // registers belongs to `owner`. Both of the others have to be put aside for
  // that to be true, and both were found by `For` rather than reasoned out.
  // `runCleanups` left standing sent a row's `onCleanup` to the *effect run*
  // that built it, so every row was torn down at the end of every reconcile --
  // disposing rows that had not gone anywhere. `inBody` left standing made
  // `createEffect()` decline to register with the branch, on a rule written for
  // re-registering against one owner that this is the opposite of: the branch
  // is a new owner each time and disposing it is what disposes the effect
  current = owner as OwnerNode | undefined;
  runCleanups = undefined;
  inBody = 0;
  try {
    // and detached at the signals level too, or the ownership this establishes
    // is the second of two that disagree: an effect created here while some
    // other effect's body is running would be a child of *that* one and die
    // when it re-runs. `For` is where the two met -- its reconcile is an effect
    // body, so every row it built was disposed by the next reconcile, kept rows
    // included
    return unowned(fn);
  } finally {
    current = previousOwner;
    runCleanups = previousCleanups;
    inBody = previousBody;
  }
}

/**
 * Builds a detached owner and runs `fn` under it.
 *
 * The root of a tree of owners, which is what a renderer mounts into and what a
 * test uses to own a handful of effects without one.
 *
 * **Detached from tracking as well as from ownership.** `runWithOwner()` already
 * puts the signals layer's parentage aside, so nothing built here dies with the
 * effect that happened to be running; what it did not put aside is the
 * *consumer*, so a body that read a signal directly -- `spinnerView()` reads its
 * label to build the text node -- made the caller's effect a sink of it. A
 * spinner started from an effect then re-ran that effect on every later
 * `s.text = ...` (SIG-321). A root has nothing above it, at either level.
 *
 * @param fn - Handed the disposer for the owner it is running under.
 * @param effects - The effect factory this tree runs through. Defaults to the
 *   module's `effect()`.
 * @returns Whatever `fn` returned.
 */
export function createRoot<T>(
  fn: (dispose: Cleanup) => T,
  effects?: EffectFactory,
  report?: (error: unknown) => void
): T {
  const owner = new OwnerNode(undefined);
  owner.effects = effects;
  owner.mounts = [];
  owner.report = report;
  return untrack(() => runWithOwner(owner, () => fn(() => disposeOwner(owner, true))));
}

/**
 * Creates a child owner under the current one.
 *
 * What `Show` and `For` mount a branch into: the branch's effects and cleanups
 * belong to it, so swapping the branch away disposes exactly what that branch
 * built and nothing else.
 *
 * @returns The owner and its disposer.
 */
export function createBranch(): { dispose: Cleanup; owner: Owner } {
  if (current?.disposed) {
    // the same answer `createEffect()` gives, for the same reason: there is
    // nothing left that would ever dispose this branch, so it does not start.
    // Handed back already disposed, so that what runs under it starts nothing
    // either
    const dead = new OwnerNode(undefined);
    dead.disposed = true;
    return { dispose: () => {}, owner: dead };
  }

  const owner = new OwnerNode(current);
  return {
    // what the disposal threw is reported rather than returned and dropped.
    // `Show` and `For` are the callers, and neither is in a position to do
    // anything with a cleanup's throw -- while dropping it is how an unmount
    // that failed to unsubscribe something becomes silent
    dispose: () => {
      const errors = disposeOwner(owner, false);
      if (errors.length > 0) {
        reportTo(owner, errors);
      }
    },
    owner,
  };
}

/**
 * Hands errors to the root owner's sink, or throws them where there is none.
 *
 * Throwing is the fallback rather than dropping, because a `createRoot()` with
 * no renderer over it has nowhere else to put them and silence is the one answer
 * that is always wrong.
 *
 * @param owner - Any owner in the tree.
 * @param errors - What was thrown.
 */
function reportTo(owner: OwnerNode, errors: readonly unknown[]): void {
  const sink = owner.root().report;
  if (!sink) {
    raise(errors, 'Errors while unmounting');
    return;
  }
  for (const error of errors) {
    sink(error);
  }
}

/**
 * Registers a cleanup with the current scope.
 *
 * Inside an effect body that is the run, and the callback fires before the body
 * runs again. Anywhere else it is the component, and the callback fires when the
 * component is unmounted.
 *
 * @param fn - What to run.
 */
export function onCleanup(fn: Cleanup): void {
  if (runCleanups) {
    runCleanups.push(fn);
    return;
  }

  if (current?.disposed) {
    // nothing will ever run it otherwise, and a cleanup that never runs is the
    // subscription this whole file exists to cancel
    fn();
    return;
  }

  current?.cleanups.push(fn);
}

/**
 * Registers a callback to run once the tree has been through a frame.
 *
 * After a frame rather than at the end of the body, because the useful thing to
 * do here is read what the component came out as -- `element.box` is where it
 * landed and how big it is, and during the body there is no answer to either.
 * That makes `onMount` the same promise for a component mounted by the first
 * frame and for one a `Show` revealed forty frames later.
 *
 * Outside a renderer nothing drains the queue, so a callback registered under a
 * bare `createRoot()` never fires -- that is the honest answer rather than
 * running it early against a tree that has no boxes.
 *
 * The callback runs under the owner of the component that registered it, so an
 * effect it creates, an `onCleanup()` it registers and a `useContext()` it reads
 * mean what they would have meant in the body. Queued bare, it ran with no owner
 * at all: its effects outlived the unmount and the renderer's `dispose()`, its
 * cleanups were dropped, and every context read its default. A component that is
 * already gone by the time the frame lands -- a `Show` that closed again before
 * anything was drawn -- was never on screen, so its callback is skipped rather
 * than run against an owner that would refuse everything it tried.
 *
 * @param fn - What to run.
 */
export function onMount(fn: Cleanup): void {
  const owner = current;
  owner?.root().mounts?.push(() => {
    if (!owner.disposed) {
      runWithOwner(owner, fn);
    }
  });
}

/**
 * Drains the mount callbacks queued under a root owner.
 *
 * @param owner - The root owner.
 * @returns What the callbacks threw, if anything.
 */
export function drainMounts(owner: Owner): unknown[] {
  const root = (owner as OwnerNode).root();
  const queued = root.mounts;
  if (!queued?.length) {
    return [];
  }

  // drained rather than read and cleared, for the reason `Tree.take()` gives: a
  // component mounted *by* one of these callbacks queues against the next frame
  // rather than into the list being walked
  const taken = queued.splice(0, queued.length);
  const errors: unknown[] = [];
  for (const fn of taken) {
    try {
      fn();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Runs `fn` now, and again whenever a signal it read has changed, for as long as
 * the owner lives.
 *
 * This rather than the bare `effect()` from `signals`, because an effect is the
 * one thing a component creates that outlives its body: unmounting has to take
 * it away, and the signals layer has no idea what a component is. The body runs
 * with the creating owner current, so `useContext()` and `onCleanup()` mean
 * inside it what they meant outside.
 *
 * An effect created *inside* a body is not registered against the owner, and is
 * not leaked either: the signals layer already disposes an effect created inside
 * another effect's body along with it. Registering it here as well would grow
 * the owner's cleanup list by one entry per re-run, which is the leak this
 * function exists to prevent, arrived at from the other side.
 *
 * @param fn - What to run. May return a cleanup.
 * @returns Disposes the effect.
 */
export function createEffect(fn: () => void | Cleanup): Cleanup {
  const owner = current;
  if (owner?.disposed) {
    // the component this belongs to is gone, so there is nothing for an effect
    // to keep up to date and nothing left that would ever dispose it. Reached
    // by a callback that outlived its owner -- a key handler, a promise landing
    // after unmount -- which is exactly the case `runWithOwner()` exists for and
    // exactly the case where the answer is to do nothing
    return () => {};
  }
  const run = owner?.root().effects ?? defaultEffect;
  const owned = inBody === 0;

  const dispose = run(() => {
    const cleanups: Cleanup[] = [];
    const previousOwner = current;
    const previousCleanups = runCleanups;
    current = owner;
    runCleanups = cleanups;
    inBody++;

    let returned: void | Cleanup;
    try {
      returned = fn();
    } finally {
      current = previousOwner;
      runCleanups = previousCleanups;
      inBody--;
    }

    if (typeof returned === 'function') {
      cleanups.push(returned);
    } else {
      // the same refusal the signals layer makes, and it has to be made here
      // too: this wrapper always returns a function, so the check downstream
      // can no longer see what the body returned
      refuseAsync(returned);
    }

    // raised rather than returned, because this is the cleanup the *signals*
    // layer holds and that layer reports a throw from one on a re-run and raises
    // it at `dispose()`. Handing back the array swallowed it: an `onCleanup()`
    // written inside an effect body -- which is where an unsubscribe belongs --
    // failed in silence, while the same call in a component body was reported
    return cleanups.length > 0
      ? () => raise(runAll(cleanups), 'Errors in an effect cleanup')
      : undefined;
  });

  if (!owned || !owner) {
    return dispose;
  }

  owner.cleanups.push(dispose);
  // handed back as a disposer that also takes itself off the owner, because the
  // entry is a closure over the computed, the body and its cleanups, and an
  // owner that lives as long as the app -- the root, borrowed through
  // `runWithOwner()` by a handler that starts and stops effects -- otherwise
  // holds every one it was ever given until the app ends. Spliced rather than
  // left as a hole, so what stays is exactly the order it was registered in and
  // the teardown undoes it in reverse as before. From the end, because the
  // effect stopped by hand is usually the one most recently started. Not while
  // the owner is going: `runAll()` is walking the list by index, and a cleanup
  // that stops a sibling must not move the entries under it -- the list is
  // emptied after the walk anyway, and the second call to `dispose` is a no-op
  return () => {
    if (!owner.disposed) {
      const at = owner.cleanups.lastIndexOf(dispose);
      if (at !== -1) {
        owner.cleanups.splice(at, 1);
      }
    }
    dispose();
  };
}

/**
 * Runs every cleanup, in reverse, whatever any of them does.
 *
 * Reverse because it is the order they were built in, undone. Every one of them
 * runs even if an earlier one threw, for the reason the signals layer gives
 * about its own sweep: one throwing callback must not leave the rest of the
 * teardown undone, since what is left behind is a subscription nobody can reach
 * to cancel.
 *
 * @param cleanups - The cleanups, in registration order.
 * @returns What they threw, if anything.
 */
function runAll(cleanups: readonly Cleanup[]): unknown[] {
  const errors: unknown[] = [];
  for (let i = cleanups.length - 1; i >= 0; i--) {
    try {
      cleanups[i]?.();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Disposes an owner, its descendants first.
 *
 * Children first because a child's cleanup may read something the parent's
 * cleanup is about to tear down, which is the order everything else here is
 * built in.
 *
 * @param owner - The owner.
 * @param thrown - Whether to throw what the cleanups threw. A caller that asked
 *   for the disposal wants to hear about it; an unmount the renderer did on its
 *   own reports instead, which is `dispose()`'s caller's choice rather than
 *   this function's.
 * @returns What the cleanups threw, if anything.
 */
export function disposeOwner(owner: Owner, thrown: boolean): unknown[] {
  const node = owner as OwnerNode;
  if (node.disposed) {
    return [];
  }
  node.disposed = true;
  node.parent?.children.delete(node);

  const errors: unknown[] = [];
  // no copy: disposing a child deletes it from this set, and a `Set` iterator
  // handles both shapes of that -- the entry it is on, and a sibling a cleanup
  // disposed before the walk reached it, which is one that should be skipped
  // because it has already been disposed
  for (const child of node.children) {
    errors.push(...disposeOwner(child, false));
  }
  node.children.clear();

  errors.push(...runAll(node.cleanups));
  node.cleanups.length = 0;

  if (thrown) {
    raise(errors, 'Errors while disposing a component');
  }
  return errors;
}

/**
 * A value looked up along the owner chain rather than passed down by hand.
 *
 * Solid's shape, and it is what a theme, a terminal that is not the process's,
 * or a router needs: something every component below a point can read without
 * every component in between having to carry it.
 */
export interface Context<T> {
  readonly defaultValue: T;
  /** @internal */
  readonly id: symbol;
}

/**
 * Builds a context.
 *
 * @param defaultValue - What `useContext()` answers where nothing provided one.
 * @param name - A name, for debugging.
 * @returns The context.
 */
export function createContext<T>(defaultValue: T, name = 'context'): Context<T> {
  return { defaultValue, id: Symbol(name) };
}

/**
 * Provides a value for `context` to everything `fn` builds.
 *
 * Inside an effect body the scope it opens belongs to *that run*, the way an
 * `onCleanup()` there does: the body is about to run again and build the scope
 * again, so the one it built last time is disposed when it does, effects and
 * cleanups with it. Anywhere else it belongs to the component.
 *
 * @param context - The context.
 * @param value - The value.
 * @param fn - What to build under it.
 * @returns Whatever `fn` returned.
 */
export function provideContext<T, R>(context: Context<T>, value: T, fn: () => R): R {
  const owner = new OwnerNode(current);
  owner.context = new Map([[context.id, value]]);
  // registered before `fn` runs, so it sits in the run's list in the order it
  // was built, and thrown rather than returned so that a cleanup inside it that
  // fails is reported the way the run's own cleanups are: by the signals layer
  // on a re-run, and out of `dispose()` where somebody asked. Without it the
  // scope was a child of the component and `runWithOwner()` detached what was
  // built in it from the run, so every re-run left one more scope behind, its
  // effects live and its cleanups waiting for the whole tree to go
  runCleanups?.push(() => {
    disposeOwner(owner, true);
  });
  return runWithOwner(owner, fn);
}

/**
 * Reads the nearest provided value for `context`.
 *
 * @param context - The context.
 * @returns The value, or the context's default where nothing provided one.
 */
export function useContext<T>(context: Context<T>): T {
  for (let at = current; at; at = at.parent) {
    const held = at.context;
    if (held?.has(context.id)) {
      return held.get(context.id) as T;
    }
  }
  return context.defaultValue;
}
