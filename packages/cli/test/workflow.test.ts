import { allLines, expressionsInRun, outsideSteps, readWorkflow, runBlocks } from './workflow.ts';
import { describe, expect, it } from 'vitest';

/** A workflow with one job whose steps are the given lines, at the usual indents. */
const job = (steps: string, header = '  check:', stepsKey = '    steps:') =>
  `name: T\non: push\njobs:\n${header}\n    runs-on: ubuntu-latest\n${stepsKey}\n${steps}\n`;

describe('the workflow reader', () => {
  it('should find an expression in a run block when `steps:` is a shape it cannot read', () => {
    // read as no steps at all, so the per-step answer was empty over a file full of them
    const text = job('      - run: echo ${{ github.head_ref }}', '  check:', '    steps: &steps');
    expect(expressionsInRun(readWorkflow(text))).toStrictEqual(['a run block outside any step']);
  });

  it.each(["  check: # the job's name", '  "check":', "  'check':"])(
    'should read the job header %j, and keep every line of the job',
    (header) => {
      const wf = readWorkflow(job('      - uses: actions/checkout@v4', header));
      expect([...wf.jobs.keys()]).toStrictEqual(['check']);
      expect(wf.jobs.get('check')?.steps).toHaveLength(1);
      expect(allLines(wf).some((line) => line.includes('checkout@v4'))).toBe(true);
    }
  );

  it('should refuse a job header it cannot read rather than drop its lines', () => {
    expect(() => readWorkflow(job('      - run: true', '  check: { }'))).toThrow(
      /Unrecognized job header/
    );
  });

  it.each(['|', '| # note', '|2-', '|-2', '>+'])(
    'should keep a `#` line of a script under `run: %s`, which GitHub expands',
    (indicator) => {
      const text = job(
        `      - run: ${indicator}\n          # \${{ secrets.X }}\n          echo hi`
      );
      const wf = readWorkflow(text);
      expect(runBlocks(allLines(wf))[0]).toContain('secrets.X');
      expect(outsideSteps(wf, /secrets\./)).toStrictEqual([]);
      expect(expressionsInRun(wf)).toHaveLength(1);
    }
  );

  it('should read a `steps:` line that carries a comment as the steps', () => {
    const wf = readWorkflow(
      job('      - run: echo ${{ x }}', '  check:', '    steps: # the steps')
    );
    expect(wf.jobs.get('check')?.steps).toHaveLength(1);
  });

  it('should read a `- run:` step with more than one space after the dash', () => {
    const wf = readWorkflow(job('      -   run: echo ${{ github.ref_name }}'));
    expect(expressionsInRun(wf)).toHaveLength(1);
  });

  it('should keep the script of a `-   run: |` step, `#` lines and what follows it', () => {
    const wf = readWorkflow(
      job(
        '      -   run: |\n            # ${{ secrets.X }}\n            echo hi\n          env:\n            A: b'
      )
    );
    const [block] = runBlocks(allLines(wf));
    expect(block).toContain('secrets.X');
    // the sibling key at the step's own column ends the block
    expect(block).not.toContain('A: b');
  });

  it('should name a step by a `name:` that is not its first key, or follows a wide dash', () => {
    const wf = readWorkflow(
      job('      -   name: Wide\n          run: true\n      - run: true\n        name: Late')
    );
    expect(wf.jobs.get('check')?.steps.map((step) => step.name)).toStrictEqual(['Wide', 'Late']);
  });

  it('should not read a `defaults: run:` setting as a script', () => {
    const text = job('      - run: echo hi').replace(
      '    runs-on: ubuntu-latest\n',
      '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: ${{ matrix.dir }}\n'
    );
    expect(expressionsInRun(readWorkflow(text))).toStrictEqual([]);
  });

  it('should end the steps at a job-level key, and name an unnamed step by its first line', () => {
    const wf = readWorkflow(job('      - run: echo hi\n    env:\n      X: ${{ secrets.X }}'));
    const check = wf.jobs.get('check');
    expect(check?.steps.map((step) => step.name)).toStrictEqual(['- run: echo hi']);
    expect(outsideSteps(wf, /secrets\./)).toStrictEqual([
      'job check, after its steps: X: ${{ secrets.X }}',
    ]);
  });
});
