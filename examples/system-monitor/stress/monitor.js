/**
 * The monitor itself, as a workload: `src/root.js`'s `App`, stand-ins and all,
 * fed by the same machine the stress workload is.
 *
 * Nothing of the monitor is changed or copied. `SystemContext` is the seam its
 * own tests already replace, so the machine goes in behind it with a clock the
 * harness fires: one `step()` is one tick, which takes one reading.
 */

import { App, stylesheet } from '../src/root.js';
import { SystemContext } from '../src/system.js';
import { createMachine } from './machine.js';
import { provideContext } from '@ttylabs/sigil/renderer';

/**
 * Builds the workload.
 *
 * @param {{ processes?: number, cores?: number, churn?: number, seed?: number }} [opts] -
 *   The machine's, which `machine.js` documents.
 * @returns {import('./measure.js').Workload}
 */
export function createMonitor(opts = {}) {
  const machine = createMachine(opts);
  /** @type {() => void} */
  let tick = () => {};

  /** @type {import('../src/system.js').System} */
  const system = {
    clock: {
      every(_ms, fn) {
        tick = fn;
        return () => {
          tick = () => {};
        };
      },
    },
    interval: 1000,
    kill: () => {},
    pid: -1,
    sampler: () => ({
      sample: async () => machine.step(),
      stop() {},
    }),
  };

  return {
    App: () => provideContext(SystemContext, system, App),
    sheets: [stylesheet],
    step: () => tick(),
  };
}
