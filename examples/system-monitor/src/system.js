/**
 * What the monitor reads and does to the machine, as a context.
 *
 * `App()` takes no props -- it is what `runApp()` and the examples' smoke test
 * mount as it is -- so what a test has to replace comes in through a context
 * instead: where the samples come from, when they are taken, what a kill does,
 * and which pid is the monitor's own. Outside a provider each is the real one.
 */

import { createSampler } from './sampler.js';
import { createContext } from '@ttylabs/sigil/renderer';

/**
 * @typedef {object} System
 * @property {() => { sample(): Promise<import('./sampler.js').Snapshot>, stop(): void }} sampler -
 *   Builds the sampler. A factory, because a sampler keeps the last reading to
 *   take a difference against, so each app wants one of its own. `stop()` ends
 *   any reading still in flight, and is called when the app quits.
 * @property {{ every(ms: number, fn: () => void): () => void }} clock - Schedules the
 *   ticks, and hands back the way to stop them.
 * @property {(pid: number) => void} kill - Sends the signal.
 * @property {number} interval - Milliseconds between samples.
 * @property {number} pid - The monitor's own pid, which it refuses to kill.
 */

/** @type {System} */
const real = {
  clock: {
    every(ms, fn) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  },
  interval: 1000,
  kill: (pid) => process.kill(pid, 'SIGTERM'),
  pid: process.pid,
  sampler: () => createSampler(),
};

/** The machine the monitor is about. `provideContext()` it with a fake in a test. */
export const SystemContext = createContext(real, 'system');
