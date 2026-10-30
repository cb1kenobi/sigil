import { createMultiProgress } from '../../src/components/multi-progress.js';
import {
  createProgress,
  createRateEstimator,
  formatDuration,
  formatRate,
} from '../../src/components/progress.js';
import { loadCatalog } from '../../src/i18n/index.js';
import { setQuiet } from '../../src/style/output.js';
import { screenSetup, setup } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(async () => {
  setQuiet(undefined);
  await loadCatalog(undefined, {});
});

/** A clock a test moves by hand, in milliseconds. */
function clock(): { advance(ms: number): void; now(): number } {
  let t = 0;
  return {
    advance(ms) {
      t += ms;
    },
    now: () => t,
  };
}

const FULL = '█';
const LIGHT = '░';

describe('createRateEstimator()', () => {
  it('should have no estimate before anything has been reported', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    expect(estimator.rate()).to.equal(undefined);
    expect(estimator.eta(10)).to.equal(undefined);
  });

  it('should take the pace so far from the first sample', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    time.advance(1000);
    estimator.update(10);

    expect(estimator.rate()).to.equal(10);
    expect(estimator.eta(90)).to.equal(9);
  });

  it('should say nothing is left to wait for when nothing is left', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    expect(estimator.eta(0)).to.equal(0);
  });

  it('should settle on the same pace however often the work reports', () => {
    const slow = clock();
    const fast = clock();
    const a = createRateEstimator({ now: slow.now });
    const b = createRateEstimator({ now: fast.now });

    for (let i = 1; i <= 20; i++) {
      slow.advance(1000);
      a.update(i * 10);
    }
    for (let i = 1; i <= 200; i++) {
      fast.advance(100);
      b.update(i);
    }

    expect(a.rate()).to.be.closeTo(10, 1e-9);
    expect(b.rate()).to.be.closeTo(10, 1e-9);
  });

  // the point of a moving average: a number that jumps is worse than a slow one
  it('should not jump when one second is ten times faster than the rest', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });
    let done = 0;

    for (let i = 0; i < 20; i++) {
      time.advance(1000);
      done += 10;
      estimator.update(done);
    }
    time.advance(1000);
    done += 100;
    estimator.update(done);

    const rate = estimator.rate() ?? 0;
    expect(rate).to.be.greaterThan(10);
    expect(rate).to.be.lessThan(30);
  });

  it('should follow a lasting change in pace', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });
    let done = 0;

    for (let i = 0; i < 10; i++) {
      time.advance(1000);
      done += 10;
      estimator.update(done);
    }
    for (let i = 0; i < 30; i++) {
      time.advance(1000);
      done += 50;
      estimator.update(done);
    }

    expect(estimator.rate()).to.be.closeTo(50, 1);
  });

  it('should fold samples closer than a tenth of a second into the next one', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    time.advance(10);
    estimator.update(5);
    expect(estimator.rate()).to.equal(undefined);

    time.advance(990);
    estimator.update(10);
    expect(estimator.rate()).to.equal(10);
  });

  it('should lengthen the estimate while nothing is reported', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    time.advance(1000);
    estimator.update(10);
    const before = estimator.eta(100) ?? 0;

    time.advance(10_000);

    expect(estimator.eta(100)).to.be.greaterThan(before * 5);
  });

  it('should start again when the work goes backwards', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    time.advance(1000);
    estimator.update(50);
    time.advance(1000);
    estimator.update(10);

    expect(estimator.rate()).to.equal(undefined);
  });

  it('should not promise a time nobody could act on', () => {
    const time = clock();
    const estimator = createRateEstimator({ now: time.now });

    time.advance(1000);
    estimator.update(1);

    expect(estimator.eta(1e9)).to.equal(undefined);
  });
});

describe('formatDuration()', () => {
  it.each([
    [0, '0s'],
    [0.4, '0s'],
    [9.6, '10s'],
    [59, '59s'],
    [60, '1m 00s'],
    [185, '3m 05s'],
    [3599, '59m 59s'],
    [3600, '1h 00m'],
    [7800, '2h 10m'],
  ])('should word %s seconds as %s', (seconds, text) => {
    expect(formatDuration(seconds)).to.equal(text);
  });
});

describe('what a bar says about its pace, translated', () => {
  it('should word the time and the rate from the catalog', async () => {
    await loadCatalog(
      {
        de: async () => ({
          '{0} {1}/s': '{0} {1} pro Sekunde',
          '{0}m {1}s': '{0} Min. {1} Sek.',
          'ETA {0}': 'noch {0}',
        }),
      },
      {},
      'de'
    );
    const ui = screenSetup({ columns: 80 });
    const time = clock();
    const bar = createProgress({
      ansi: ui.ansi,
      barWidth: 4,
      eta: true,
      now: time.now,
      rate: true,
      terminal: ui.terminal,
      total: 1000,
      unit: 'Dateien',
    });

    time.advance(1000);
    bar.current = 10;

    expect(ui.frame).to.contain('10 Dateien pro Sekunde  noch 1 Min. 39 Sek.');
  });
});

describe('formatRate()', () => {
  it('should keep a decimal below ten and drop it above', () => {
    expect(formatRate(3.24)).to.equal('3.2/s');
    expect(formatRate(9.96)).to.equal('10.0/s');
    expect(formatRate(120.4)).to.equal('120/s');
  });

  it('should name the unit when there is one', () => {
    expect(formatRate(3.24, 'files')).to.equal('3.2 files/s');
  });
});

describe('createProgress() with a rate and a time remaining', () => {
  it('should draw neither unless asked', () => {
    const ui = screenSetup({ columns: 60 });
    const time = clock();
    const bar = createProgress({
      ansi: ui.ansi,
      barWidth: 10,
      now: time.now,
      terminal: ui.terminal,
      total: 100,
    });

    time.advance(1000);
    bar.current = 10;

    expect(ui.frame).to.equal(`${FULL}${LIGHT.repeat(9)} 10%`.replace(/^/, ''));
  });

  it('should show the pace and the time remaining beside the percentage', () => {
    const ui = screenSetup({ columns: 70 });
    const time = clock();
    const bar = createProgress({
      ansi: ui.ansi,
      barWidth: 10,
      eta: true,
      now: time.now,
      rate: true,
      terminal: ui.terminal,
      total: 100,
      unit: 'files',
    });

    time.advance(1000);
    bar.current = 10;

    expect(ui.frame).to.equal(`${FULL}${LIGHT.repeat(9)} 10% 10 files/s  ETA 9s`);
  });

  it('should show only the time when only the time was asked for', () => {
    const ui = screenSetup({ columns: 70 });
    const time = clock();
    const bar = createProgress({
      ansi: ui.ansi,
      barWidth: 10,
      eta: true,
      now: time.now,
      terminal: ui.terminal,
      total: 100,
    });

    time.advance(1000);
    bar.current = 10;

    expect(ui.frame).to.equal(`${FULL}${LIGHT.repeat(9)} 10% ETA 9s`);
  });

  it('should say nothing about pace once the work is finished', () => {
    const ui = screenSetup({ columns: 70 });
    const time = clock();
    const bar = createProgress({
      ansi: ui.ansi,
      barWidth: 4,
      eta: true,
      now: time.now,
      rate: true,
      terminal: ui.terminal,
      total: 10,
    });

    time.advance(1000);
    bar.current = 5;
    expect(ui.frame).to.contain('ETA');

    time.advance(1000);
    bar.done('Copied');

    expect(ui.log.join('\n')).to.contain('100%');
    expect(ui.log.join('\n')).to.not.contain('ETA');
    expect(ui.log.join('\n')).to.not.contain('/s');
  });

  it('should leave a rate out of the plain form, where it would change every line', () => {
    const { ansi, stdout, terminal } = setup({ isTTY: false });
    const time = clock();
    const bar = createProgress({
      ansi,
      eta: true,
      now: time.now,
      rate: true,
      step: 50,
      terminal,
      text: 'Files',
      total: 100,
    });

    for (let i = 0; i < 100; i++) {
      time.advance(1000);
      bar.tick();
    }

    expect(stdout.text).to.equal('Files 0%\nFiles 50%\nFiles 100%\n');
  });
});

describe('createMultiProgress()', () => {
  it('should draw a row for each bar, with the bars starting in one column', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 4, terminal: ui.terminal });

    const a = group.add({ text: 'a', total: 10 });
    const b = group.add({ text: 'longer', total: 10 });
    a.tick(5);
    b.tick(10);

    expect(ui.log).to.deep.equal([
      `a      ${FULL}${FULL}${LIGHT}${LIGHT}  50%`,
      `longer ${FULL}${FULL}${FULL}${FULL} 100%`,
    ]);
  });

  it('should hold a column for a row that has no label of its own', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    group.add({ text: 'abc' });
    group.add();

    expect(ui.log).to.deep.equal([`abc ${LIGHT}${LIGHT}   0%`, `    ${LIGHT}${LIGHT}   0%`]);
  });

  it('should let each bar finish on its own', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    const a = group.add({ text: 'a', total: 4 });
    const b = group.add({ text: 'b', total: 4 });
    a.done();
    b.tick(2);

    expect(a.finished).to.equal(true);
    expect(b.finished).to.equal(false);
    expect(ui.log).to.deep.equal([`a ${FULL}${FULL} 100%`, `b ${FULL}${LIGHT}  50%`]);
  });

  it('should relabel a bar when it finishes', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    group.add({ text: 'a', total: 4 }).done('a: done');

    expect(ui.log).to.deep.equal([`a: done ${FULL}${FULL} 100%`]);
  });

  it('should take a bar out without a trace on stop', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    const a = group.add({ text: 'a' });
    group.add({ text: 'b' });
    a.stop();

    expect(ui.log).to.deep.equal([`b ${LIGHT}${LIGHT}   0%`]);
  });

  it('should write a finished bar above the frame and drop its row when asked not to keep it', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({
      ansi: ui.ansi,
      barWidth: 2,
      keep: false,
      terminal: ui.terminal,
    });

    const a = group.add({ text: 'a', total: 4 });
    group.add({ text: 'b', total: 4 });
    a.done('a done');

    expect(ui.log).to.deep.equal(['a done 100%', `b ${LIGHT}${LIGHT}   0%`]);
  });

  it('should write a line that stays above the bars', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    group.add({ text: 'a' });
    group.write('retrying');

    expect(ui.log).to.deep.equal(['retrying', `a ${LIGHT}${LIGHT}   0%`]);
  });

  it('should leave the bars where they are on done', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    group.add({ text: 'a', total: 2 }).tick();
    group.done();

    expect(ui.log).to.deep.equal([`a ${FULL}${LIGHT}  50%`]);
  });

  it('should erase the bars on stop', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    group.add({ text: 'a' });
    group.add({ text: 'b' });
    group.stop();

    expect(ui.log).to.deep.equal([]);
  });

  it('should not draw a bar of a group that has ended', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    const a = group.add({ text: 'a', total: 4 });
    group.done();
    const before = ui.output;
    a.tick(2);

    expect(ui.output).to.equal(before);
  });

  it('should start a fresh group on the first bar after the last one ended', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, barWidth: 2, terminal: ui.terminal });

    group.add({ text: 'a' });
    group.done();
    group.add({ text: 'b' });

    expect(ui.log).to.deep.equal([`a ${LIGHT}${LIGHT}   0%`, `b ${LIGHT}${LIGHT}   0%`]);
  });

  it('should clamp a bar to its total and refuse a total of zero', () => {
    const ui = screenSetup({ rows: 10 });
    const group = createMultiProgress({ ansi: ui.ansi, terminal: ui.terminal });

    const a = group.add({ total: 5 });
    a.tick(99);
    expect(a.current).to.equal(5);

    a.total = 0;
    expect(a.total).to.equal(1);
    expect(a.current).to.equal(1);
  });

  describe('with a rate and a time remaining', () => {
    it('should keep a separate estimate for each bar', () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const time = clock();
      const group = createMultiProgress({
        ansi: ui.ansi,
        barWidth: 4,
        eta: true,
        now: time.now,
        rate: true,
        terminal: ui.terminal,
      });

      const a = group.add({ text: 'a', total: 100 });
      const b = group.add({ text: 'b', total: 100 });
      time.advance(1000);
      a.current = 50;
      b.current = 10;

      expect(ui.log).to.deep.equal([
        `a ${FULL}${FULL}${LIGHT}${LIGHT}  50% 50/s  ETA 1s`,
        `b ${LIGHT.repeat(4)}  10% 10/s  ETA 9s`,
      ]);
    });

    it('should name the unit per bar when the bar has its own', () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const time = clock();
      const group = createMultiProgress({
        ansi: ui.ansi,
        barWidth: 2,
        now: time.now,
        rate: true,
        terminal: ui.terminal,
        unit: 'files',
      });

      const a = group.add({ text: 'a' });
      const b = group.add({ text: 'b', unit: 'MB' });
      time.advance(1000);
      a.current = 20;
      b.current = 30;

      expect(ui.log[0]).to.contain('20 files/s');
      expect(ui.log[1]).to.contain('30 MB/s');
    });
  });

  describe('when there is no terminal', () => {
    it('should write a labelled line for each bar every step percent', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, step: 50, terminal });

      const a = group.add({ text: 'a', total: 4 });
      const b = group.add({ text: 'b', total: 2 });
      a.tick(2);
      b.tick();
      a.tick(2);
      b.tick();

      expect(stdout.text).to.equal('a 0%\nb 0%\na 50%\nb 50%\na 100%\nb 100%\n');
    });

    it('should write one line per change rather than one per tick', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, step: 25, terminal });

      const a = group.add({ text: 'a', total: 100 });
      for (let i = 0; i < 100; i++) {
        a.tick();
      }

      expect(stdout.text).to.equal('a 0%\na 25%\na 50%\na 75%\na 100%\n');
    });

    it('should say a bar finished whatever step divides into', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, step: 30, terminal });

      const a = group.add({ text: 'a', total: 100 });
      a.tick(95);
      a.done('a done');

      expect(stdout.text).to.equal('a 0%\na 90%\na done 100%\n');
    });

    it('should leave the rate and the time out of every line', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const time = clock();
      const group = createMultiProgress({
        ansi,
        eta: true,
        now: time.now,
        rate: true,
        step: 50,
        terminal,
      });

      const a = group.add({ text: 'a', total: 10 });
      time.advance(1000);
      a.tick(5);
      time.advance(1000);
      a.tick(5);

      expect(stdout.text).to.equal('a 0%\na 50%\na 100%\n');
    });

    it('should leave out the label of a bar that has none', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, step: 100, terminal });

      group.add({ total: 2 }).done();

      expect(stdout.text).to.equal('0%\n100%\n');
    });

    it('should write a line passed to write() as it is', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, terminal });

      group.write('retrying');

      expect(stdout.text).to.equal('retrying\n');
    });

    it('should write nothing for a bar after the group ended', () => {
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, step: 50, terminal });

      const a = group.add({ text: 'a', total: 2 });
      group.done();
      a.tick(2);

      expect(stdout.text).to.equal('a 0%\n');
    });
  });

  describe('when asked to be quiet', () => {
    it('should draw nothing on a terminal', () => {
      setQuiet(true);
      const ui = screenSetup({ rows: 10 });
      const group = createMultiProgress({ ansi: ui.ansi, terminal: ui.terminal });

      const a = group.add({ text: 'a', total: 2 });
      a.tick();
      group.write('hello');
      a.done();
      group.done();

      expect(ui.output).to.equal('');
    });

    it('should write nothing to a pipe', () => {
      setQuiet(true);
      const { ansi, stdout, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, terminal });

      const a = group.add({ text: 'a', total: 2 });
      a.tick();
      group.write('hello');
      a.done();
      group.done();

      expect(stdout.text).to.equal('');
    });

    it('should still keep the values of a bar nobody sees', () => {
      setQuiet(true);
      const { ansi, terminal } = setup({ isTTY: false });
      const group = createMultiProgress({ ansi, terminal });

      const a = group.add({ total: 4 });
      a.tick(3);

      expect(a.current).to.equal(3);
    });
  });
});
