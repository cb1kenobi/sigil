import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * A bar chart and a table as long as somebody's data, built where an app builds
 * them: on a main thread.
 *
 * Both spread their rows into one call -- `Math.min(0, ...values)` for the bar
 * chart's scale, `Math.max(heading, ...cells)` for a column's width, and
 * `box(props, ...rows)` for both -- which puts every row on the call stack as an
 * argument, and past about 125,000 of them a main thread throws `RangeError:
 * Maximum call stack size exceeded`. See "No spread of a data-sized array" in
 * `src/components/AGENTS.md`.
 *
 * In a child rather than in this file, because this file is not on a main thread:
 * vitest runs it in a worker, whose stack is four times the size and spreads
 * 300,000 arguments without complaint -- so both of these passed in-process
 * against the code that failed them, at the size that fails an app. A cheap path
 * is tested in-process at a million instead, which a worker cannot spread either;
 * these two build seconds of elements at that size. The child imports `dist/`,
 * so it needs a build first, which is what `pnpm test` does.
 */
const LONG = 200_000;

const CASES = {
  barChart: `
    const { barChartView } = await import(dist + 'components/chart.mjs');
    const data = Array.from({ length: LONG }, (_, i) => ({ label: 'x', value: i === 1 ? 6 : -6 }));
    const { element, width } = barChartView(data, {
      ascii: true, colorLevel: 0, env: {}, platform: 'linux', showValues: false, width: 13,
    });
    const row = (i) => element.children[i].children.map((child) => child.text).join('').trimEnd();
    return { first: row(0), rows: element.children.length, second: row(1), width };
  `,
  tableView: `
    const { tableView } = await import(dist + 'components/table.mjs');
    const { element, width } = tableView(Array.from({ length: LONG }, (_, i) => [String(i)]));
    return { rows: element.children.length, width };
  `,
};

type Outcome = { error: string } | { value: Record<string, unknown> };

describe("a chart and a table as long as somebody's data, on a main thread", () => {
  const outcomes: Record<string, Outcome> = {};

  beforeAll(() => {
    const dist = new URL('../../dist/', import.meta.url).href;
    const source = `
      const dist = ${JSON.stringify(dist)};
      const LONG = ${LONG};
      const cases = {
        ${Object.entries(CASES)
          .map(([name, body]) => `${JSON.stringify(name)}: async () => {${body}}`)
          .join(',\n')}
      };
      for (const [name, run] of Object.entries(cases)) {
        let outcome;
        try {
          outcome = { value: await run() };
        } catch (err) {
          outcome = { error: String(err) };
        }
        process.stdout.write(JSON.stringify({ name, ...outcome }) + '\\n');
      }
    `;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
    });
    expect(ran.stderr).toBe('');
    for (const line of ran.stdout.split('\n').filter((it) => it !== '')) {
      const { name, ...outcome } = JSON.parse(line) as { name: string } & Outcome;
      outcomes[name] = outcome;
    }
  }, 60_000);

  it('should build a bar chart of many bars, scaled from the lowest where one is negative', () => {
    // from -6 to 6 over the eleven cells after the label: a -6 is at the bottom
    // and draws nothing, and the 6 is the whole width -- where a scale from zero
    // would have drawn nothing for any of them
    expect(outcomes.barChart).toEqual({
      value: { first: 'x', rows: LONG, second: 'x ###########', width: 13 },
    });
  });

  it('should build a table of many rows', () => {
    expect(outcomes.tableView).toEqual({ value: { rows: LONG, width: '199999'.length } });
  });
});
