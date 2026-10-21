/**
 * What quiet comes to for the toolchain's own output.
 *
 * This is the acceptance test for the line the axis is drawn along -- **a result
 * is not a progress report** -- because the toolchain is the one app in this
 * repository whose output is all three kinds at once: diagnostics, which are the
 * answer to the question it was asked; a summary, which is a report about work
 * done; and prose, which is a note about what happened.
 *
 * Asserted against `report.ts` directly for the reason `report.test.ts` records:
 * a vitest worker's stderr has no `columns` and no `isTTY`, so what the two
 * forms do is invisible from a run. The spawn-based half is in
 * `output-forms.test.ts`, which is also the non-regression for the piped form.
 */

import type { Diagnostic } from '../src/build/diagnostic.js';
import { writeDiagnostics, writeNote, writeSummary } from '../src/report.js';
import { setQuiet } from '@ttylabs/sigil/style';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  setQuiet(undefined);
  delete process.env.SIGIL_REDUCED_MOTION;
});

/** A stream that records, standing in for stderr. */
function stream(isTTY = false) {
  const written: string[] = [];
  return {
    columns: 100,
    isTTY,
    get out(): string {
      return written.join('');
    },
    write(text: string): void {
      written.push(text);
    },
  };
}

const diagnostic: Diagnostic = {
  column: 7,
  file: 'commands/ship.ts',
  line: 2,
  message: 'something to say about it',
  severity: 'error',
};

describe('a quiet run', () => {
  it('should still write every diagnostic, which is the answer', () => {
    setQuiet(true);
    const to = stream();
    writeDiagnostics([diagnostic], { stream: to });
    expect(to.out).toContain('commands/ship.ts:2:7');
    expect(to.out).toContain('something to say about it');
  });

  it('should write no summary, which is a report about work done', () => {
    const loud = stream();
    writeSummary(['fixture-app', '13 commands'], loud);
    expect(loud.out).toContain('13 commands');

    setQuiet(true);
    const quiet = stream();
    writeSummary(['fixture-app', '13 commands'], quiet);
    expect(quiet.out).toBe('');
  });

  it('should write no note, which is prose about what happened', () => {
    const loud = stream();
    writeNote(['Not type-checked:', 'no tsconfig.json'], loud);
    expect(loud.out).toContain('no tsconfig.json');

    setQuiet(true);
    const quiet = stream();
    writeNote(['Not type-checked:', 'no tsconfig.json'], quiet);
    expect(quiet.out).toBe('');
  });

  it('should write nothing on a terminal either', () => {
    setQuiet(true);
    const to = stream(true);
    writeSummary(['fixture-app', '13 commands'], to);
    writeNote(['Not type-checked:', 'no tsconfig.json'], to);
    expect(to.out).toBe('');
  });
});

/**
 * The two axes are separate answers to separate questions, and a report is the
 * place that is easiest to get wrong: `reduce` means something to a spinner and
 * nothing at all to text. So a reduced-motion preference leaves every line of a
 * report exactly where it was.
 */
describe('a reduced-motion preference', () => {
  it('should leave a summary and a note exactly where they were', () => {
    process.env.SIGIL_REDUCED_MOTION = '1';
    const to = stream();
    writeSummary(['fixture-app', '13 commands'], to);
    writeNote(['Not type-checked:', 'no tsconfig.json'], to);
    expect(to.out).toContain('13 commands');
    expect(to.out).toContain('no tsconfig.json');
  });

  it('should write the same bytes as a run with no preference at all', () => {
    const plain = stream();
    writeSummary(['fixture-app', '13 commands'], plain);
    writeNote(['Not type-checked:', 'no tsconfig.json'], plain);

    process.env.SIGIL_REDUCED_MOTION = '1';
    const reduced = stream();
    writeSummary(['fixture-app', '13 commands'], reduced);
    writeNote(['Not type-checked:', 'no tsconfig.json'], reduced);

    expect(reduced.out).toBe(plain.out);
  });
});
