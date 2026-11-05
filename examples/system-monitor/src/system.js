/**
 * What the monitor reads and does to the machine, as a context.
 *
 * `App()` takes no props -- it is what `runApp()` and the examples' smoke test
 * mount as it is -- so the three things a test has to replace come in through a
 * context instead: where the samples come from, when they are taken, and what a
 * kill does. Outside a provider each is the real one.
 */

import { createSampler } from './sampler.js';
import { createContext } from '@ttylabs/sigil/renderer';

/**
 * @typedef {object} System
 * @property {() => { sample(): Promise<import('./sampler.js').Snapshot> }} sampler - Builds
 *   the sampler. A factory, because a sampler keeps the last reading to take a
 *   difference against, so each app wants one of its own.
 * @property {{ every(ms: number, fn: () => void): () => void }} clock - Schedules the
 *   ticks, and hands back the way to stop them.
 * @property {(pid: number) => void} kill - Sends the signal.
 * @property {number} interval - Milliseconds between samples.
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
  sampler: () => createSampler(),
};

/** The machine the monitor is about. `provideContext()` it with a fake in a test. */
export const SystemContext = createContext(real, 'system');
