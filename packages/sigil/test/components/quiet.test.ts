/**
 * What quiet comes to for every built-in that draws progress.
 *
 * The claim is **zero bytes**, and it is asserted on the stream rather than on a
 * picture, because an empty tree is not zero bytes: measured, a `mountLive()`
 * writes a newline on construction, before any `frame()` and whatever the
 * component drew. That is what rules out the obvious implementation -- a
 * component returning nothing under quiet -- and what makes the sink backend the
 * one place bytes are decided.
 */

import { createInlineCanvas, createSinkCanvas } from '../../src/canvas/index.js';
import { createDecrypt, decrypt } from '../../src/components/decrypt.js';
import { mountLevel, mountLive } from '../../src/components/mount.js';
import { commandPalette } from '../../src/components/palette.js';
import { createProgress } from '../../src/components/progress.js';
import { confirm, text as promptText } from '../../src/components/prompt.js';
import { createSpinner } from '../../src/components/spinner.js';
import { createTypewriter } from '../../src/components/typewriter.js';
import { box, text as textNode } from '../../src/element/index.js';
import { parse } from '../../src/parser/parse.js';
import { setQuiet } from '../../src/style/output.js';
import { setup } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  setQuiet(undefined);
  vi.useRealTimers();
});

describe('a spinner', () => {
  it('should write nothing at all when it was asked to be quiet', () => {
    const loud = setup({ isTTY: false });
    const quiet = setup({ isTTY: false });

    for (const [harness, opts] of [
      [loud, {}],
      [quiet, { quiet: true }],
    ] as const) {
      const spinner = createSpinner({ terminal: harness.terminal, text: 'one', ...opts });
      spinner.start();
      spinner.text = 'two';
      spinner.succeed('done');
    }

    // the baseline is what a CI log has always got: one line per change
    expect(loud.stdout.output).toBe('one\ntwo\n✔ done\n');
    expect(quiet.stdout.output).toBe('');
  });

  it('should leave no line behind even for a settle it never started', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    createSpinner({ quiet: true, terminal, text: 'never ran' }).succeed();
    expect(stdout.output).toBe('');
  });

  it('should start no timer when it was asked to be quiet', () => {
    vi.useFakeTimers();
    const { terminal } = setup({ isTTY: true });
    createSpinner({ quiet: true, terminal, text: 'work' }).start();
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * The defect the one fold closed. This read `live` -- the raw terminal fact --
   * where every other component read `live && motion !== 'reduce'`, so a
   * terminal with the preference set left the spinner spinning at eighty
   * milliseconds a frame, which is the one thing that variable exists to stop.
   *
   * A terminal is what makes it matter: on a pipe `live` is false anyway, so the
   * old reading and the new one agree and nothing can see the difference.
   */
  it('should start no timer under a motion preference on a terminal', () => {
    vi.useFakeTimers();
    const { terminal } = setup({ isTTY: true });
    createSpinner({ reducedMotion: 'reduce', terminal, text: 'work' }).start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should still animate on a terminal nobody had an opinion about', () => {
    vi.useFakeTimers();
    const { terminal } = setup({ isTTY: true });
    createSpinner({ terminal, text: 'work' }).start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

/**
 * `write()` is "a line that stays, above the frame", and with nothing mounted
 * there is no frame -- so the three lazy components wrote straight through the
 * terminal, which bypassed the backend and therefore the fold. Found by review,
 * reproduced as `"leaked\n"` on every one of them.
 *
 * The second shape is the common one: `settle()` clears `mounted`, so every
 * `write()` after a `succeed()` took the unmounted branch.
 */
describe('a facade write with nothing mounted', () => {
  it('should write nothing under quiet, before anything started', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    createSpinner({ quiet: true, terminal, text: 'work' }).write('a note');
    createTypewriter({ quiet: true, terminal, text: 'work' }).write('a note');
    createDecrypt({ quiet: true, terminal, text: 'work' }).write('a note');
    expect(stdout.output).toBe('');
  });

  it('should write nothing under quiet, after it settled', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const spinner = createSpinner({ quiet: true, terminal, text: 'work' });
    spinner.start();
    spinner.succeed('done');
    spinner.write('a note after the settle');
    expect(stdout.output).toBe('');
  });

  it('should still write it when nothing asked for quiet', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    createSpinner({ terminal, text: 'work' }).write('a note');
    expect(stdout.output).toBe('a note\n');
  });

  it('should honour the process-wide request as well as the option', () => {
    setQuiet(true);
    const { stdout, terminal } = setup({ isTTY: false });
    createSpinner({ terminal, text: 'work' }).write('a note');
    expect(stdout.output).toBe('');
  });
});

describe('a progress bar', () => {
  it('should write nothing at all when it was asked to be quiet', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const bar = createProgress({ quiet: true, terminal, text: 'work', total: 4 });
    for (let at = 1; at <= 4; at++) {
      bar.current = at;
    }
    bar.done();
    expect(stdout.output).toBe('');
  });

  /**
   * The one facade that mounts as it is built, so its level is resolved before
   * `main()` has read argv -- which a command module's own body is early enough
   * to reach. Found by review in round three. Every update after the request is
   * silent; the frame the construction painted is not, and that is the eager
   * mount rather than the gate, because deferring it would cost the zero frame
   * every piped run already gets.
   */
  it('should stop drawing when the request arrives after it was built', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const bar = createProgress({ terminal, text: 'early', total: 2 });
    setQuiet(true);
    bar.current = 1;
    bar.current = 2;
    bar.write('a note');
    bar.done();
    // the construction frame, and nothing after it
    expect(stdout.output).toBe('early 0%\n');
  });

  it('should draw nothing at all when it was built after the request', () => {
    setQuiet(true);
    const { stdout, terminal } = setup({ isTTY: false });
    const bar = createProgress({ terminal, text: 'late', total: 2 });
    bar.current = 2;
    bar.done();
    expect(stdout.output).toBe('');
  });

  /**
   * The mount's level is resolved **once**, so the gates on `draw()` and
   * `write()` can only suppress: a bar built under a request holds the sink for
   * its life, and lifting the request does not start it drawing. Found by review
   * round 4, which is the other order from the residue above.
   *
   * Right for the lifecycle an app has -- one `main()`, one request, components
   * built inside `run()` -- and pinned so that it is a decision rather than a
   * surprise: what reaches it is a caller lifting the request mid-run.
   */
  it('should stay a sink after the request is lifted, because a mount resolves once', () => {
    setQuiet(true);
    const { stdout, terminal } = setup({ isTTY: false });
    const bar = createProgress({ terminal, text: 'late', total: 2 });
    setQuiet(undefined);
    // the fold says draw now, which is what makes the silence the mount's
    expect(mountLevel({ terminal })).toBe('reduce');
    bar.current = 1;
    bar.text = 'moved';
    bar.write('a line');
    bar.done('Finished');
    expect(stdout.output).toBe('');
  });

  /**
   * `done()` and `stop()` give the terminal back, which is not progress -- a
   * quiet run that left the cursor hidden is the terminal-eating failure
   * `Terminal.restore()` exists for. So `draw()` is gated and the mount's own
   * teardown is not, and what reaches the stream is the erase and the cursor
   * rather than a percentage. Found by review round 4.
   */
  it('should give the terminal back on a quiet run, which is not a percentage', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const bar = createProgress({ terminal, text: 'work', total: 4 });
    setQuiet(true);
    const built = stdout.output;
    bar.current = 2;
    // nothing was added for the update, which is the gate
    expect(stdout.output).toBe(built);

    bar.done('Finished');
    const after = stdout.output.slice(built.length);
    // the cursor is shown again, and no percentage and no label went out
    expect(after).toContain('\u001b[?25h');
    expect(after).not.toContain('50%');
    expect(after).not.toContain('Finished');
  });

  /**
   * `stop()`'s half of the same rule, which is its own test because it is its own
   * method: a sabotage gating it survived the one above, since that asserts
   * `done()`'s teardown and nothing asserted this one's. `stop()` erases the
   * region as well as showing the cursor, which is what takes the construction
   * frame the comment calls residue back off a screen.
   */
  it('should still erase and show the cursor for a quiet stop', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const bar = createProgress({ terminal, text: 'work', total: 4 });
    setQuiet(true);
    const built = stdout.output;
    bar.stop();
    const after = stdout.output.slice(built.length);
    expect(after).toContain('\u001b[?25h');
    // the erase, which is what makes it a teardown rather than a frame
    expect(after).toContain('\u001b[0J');
  });

  it('should write a line per step when it was not', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const bar = createProgress({ step: 50, terminal, text: 'work', total: 4 });
    bar.current = 4;
    bar.done();
    expect(stdout.text).toContain('work 100%');
  });

  /**
   * A bar that fills is the thing that moves, so a motion preference asks for
   * the percentage rather than the bar -- which is the resolved answer reaching
   * a component that used to read the raw terminal fact. A terminal is again
   * what makes it matter.
   */
  it('should draw a percentage rather than a bar under a motion preference', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const bar = createProgress({ reducedMotion: 'reduce', terminal, text: 'work', total: 4 });
    bar.current = 2;
    bar.done();
    expect(stdout.text).toContain('50%');
    expect(stdout.text).not.toContain('█');
  });

  it('should draw a bar on a terminal nobody had an opinion about', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const bar = createProgress({ terminal, text: 'work', total: 4 });
    bar.current = 2;
    bar.done();
    expect(stdout.text).toContain('█');
  });
});

describe('a typewriter', () => {
  it('should write nothing at all when it was asked to be quiet', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const writer = createTypewriter({ quiet: true, terminal, text: 'hello there' });
    writer.start();
    writer.done();
    expect(stdout.output).toBe('');
    // and the value is still the whole string: quiet is about what reaches the
    // screen, not about what the component is holding
    expect(writer.text).toBe('hello there');
  });

  /**
   * A terminal is what makes it matter, and `done()` is why: on a pipe the whole
   * string is revealed either way, so the output is identical and nothing a test
   * reads can tell an animating typewriter from a finished one. What differs is
   * the timer.
   */
  it('should start no timer under a motion preference on a terminal', () => {
    vi.useFakeTimers();
    const { terminal } = setup({ isTTY: true });
    createTypewriter({ reducedMotion: 'reduce', terminal, text: 'hello there' }).start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should reveal over time on a terminal nobody had an opinion about', () => {
    vi.useFakeTimers();
    const { terminal } = setup({ isTTY: true });
    createTypewriter({ terminal, text: 'hello there' }).start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('should write the whole string when it was not', () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const writer = createTypewriter({ terminal, text: 'hello there' });
    writer.start();
    writer.done();
    expect(stdout.text).toContain('hello there');
  });
});

describe('a decrypt', () => {
  /**
   * The measurement that chose the mechanism. The promise is settled by an
   * effect created **inside** the build, so a quiet mount that skipped the build
   * would never resolve it -- measured, `await decrypt(text)` hangs. So the tree
   * is still built and the level is what tells it to finish at once; what must
   * not happen is a byte reaching the terminal, and that is the backend's.
   */
  it('should resolve rather than hang, and write nothing', async () => {
    const { stdout, terminal } = setup({ isTTY: false });
    await decrypt('hello world', { quiet: true, terminal });
    expect(stdout.output).toBe('');
  });

  it('should write its text when it was not asked to be quiet', async () => {
    const { stdout, terminal } = setup({ isTTY: false });
    await decrypt('hello world', { terminal });
    expect(stdout.text).toContain('hello world');
  });

  it('should hold no timer open for a reveal nobody can see', () => {
    vi.useFakeTimers();
    const { terminal } = setup({ isTTY: true });
    createDecrypt({ quiet: true, terminal, text: 'hello world' }).start();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a prompt', () => {
  /**
   * The exemption, and the line the whole axis is drawn along: a dialogue is not
   * a progress report. A silenced prompt draws no question and then waits
   * forever for an answer to a question nobody was shown, so the built-in says
   * `quiet: false` where it mounts -- which is the framework drawing the line
   * rather than every app remembering to.
   */
  it('should ask its question even where the process was asked to be quiet', async () => {
    setQuiet(true);
    const { stdin, stdout, terminal } = setup({ isTTY: true });
    const answered = promptText({ message: 'Your name', terminal });

    await vi.waitFor(() => expect(stdout.text).toContain('Your name'));
    stdin.send('chris\r');
    expect(await answered).toBe('chris');
  });
});

describe('the prompt plumbing every interactive surface shares', () => {
  /**
   * The exemption is one `quiet: false` in `run()`, which every prompt and the
   * command palette go through -- so what is worth pinning is the **door**
   * rather than one prompt. A second prompt is what says the first was not
   * passing for a reason of its own.
   */
  it('should ask a confirm as readily as a text field', async () => {
    setQuiet(true);
    const { stdin, stdout, terminal } = setup({ isTTY: true });
    const answered = confirm({ message: 'Overwrite it', terminal });

    await vi.waitFor(() => expect(stdout.text).toContain('Overwrite it'));
    stdin.send('y');
    expect(await answered).toBe(true);
  });

  it('should open a command palette too', async () => {
    setQuiet(true);
    const { stdin, stdout, terminal } = setup({ isTTY: true });
    const state = await parse({ argv: [], schema: { commands: { build: { run() {} } } } });
    const chosen = commandPalette(state, { terminal });

    await vi.waitFor(() => expect(stdout.text).toContain('build'));
    stdin.send('\u001b');
    await chosen;
  });
});

describe('a prompt and a bad quiet value', () => {
  /**
   * `run()` writes `quiet: false` **after** the caller's options, so a prompt
   * discards the value rather than reading it -- which means it cannot refuse a
   * bad one either, where every other facade throws. Documented on
   * `MountOptions.quiet` and pinned here, because it is the exact spot where a
   * "helpful" reordering of that spread would both break the exemption and
   * start throwing.
   */
  it('should ask its question rather than refusing a value it discards', async () => {
    const { stdin, stdout, terminal } = setup({ isTTY: true });
    const answered = promptText({ message: 'Your name', quiet: 'nonsense' as never, terminal });

    await vi.waitFor(() => expect(stdout.text).toContain('Your name'));
    stdin.send('chris\r');
    expect(await answered).toBe('chris');
  });

  it('should refuse the same value anywhere it is read', () => {
    const { terminal } = setup({ isTTY: true });
    expect(() => createProgress({ quiet: 'nonsense' as never, terminal })).toThrow(
      'Expected quiet to be a boolean'
    );
  });
});

describe('the process-wide request', () => {
  /**
   * What `--quiet` buys over an app passing the flag down by hand: a component
   * nobody wired up still honours it. Passing it at every call site is the
   * per-caller judgement this axis exists to replace, and one missed call site
   * is a flag that parses and does nothing.
   */
  it('should reach a component that was told nothing', () => {
    setQuiet(true);
    const { stdout, terminal } = setup({ isTTY: false });
    createSpinner({ terminal, text: 'work' }).succeed('done');
    expect(stdout.output).toBe('');
  });

  it('should leave a component alone once it has been taken back', () => {
    setQuiet(true);
    setQuiet(undefined);
    const { stdout, terminal } = setup({ isTTY: false });
    createSpinner({ terminal, text: 'work' }).succeed('done');
    expect(stdout.output).toBe('✔ done\n');
  });
});

describe('the sink backend', () => {
  /**
   * The guarantee stated on its own: whatever a component draws, nothing reaches
   * the terminal. A tree that draws real text is what makes it matter -- an
   * empty one would write a newline through the inline canvas and nothing
   * through this, so both would look like a pass for the wrong reason.
   */
  it('should write nothing for a tree that draws', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const mounted = mountLive(() => box({}, textNode('visible')), { quiet: true, terminal });
    mounted.frame();
    mounted.write('a line that stays');
    mounted.done();
    expect(stdout.output).toBe('');
  });

  it('should hand the component the quiet level', () => {
    const { terminal } = setup({ isTTY: true });
    const seen: string[] = [];
    mountLive(
      (level) => {
        seen.push(level);
        return box({});
      },
      { quiet: true, terminal }
    ).done();
    expect(seen).toEqual(['quiet']);
  });

  /**
   * `reduce` is the input that separates the resolved answer from the raw
   * terminal fact: there is a screen, so `isTTY && !closed` is true, and nothing
   * may move -- so a `live` that meant "not quiet" would say the wrong thing
   * about the one state the two values used to disagree in.
   */
  it('should report itself as not live for anything but a live screen', () => {
    const { terminal } = setup({ isTTY: true });
    const pipe = setup({ isTTY: false });
    expect(mountLive(() => box({}), { quiet: true, terminal }).live).toBe(false);
    expect(mountLive(() => box({}), { reducedMotion: 'reduce', terminal }).live).toBe(false);
    expect(mountLive(() => box({}), { terminal: pipe.terminal }).live).toBe(false);
    expect(mountLive(() => box({}), { terminal }).live).toBe(true);
  });

  /**
   * The sink is what quiet replaces a named backend with, because quiet is about
   * whether anything draws at all rather than about where it draws. A built-in
   * that really is the answer says `quiet: false`, which is the one statement
   * above the request.
   */
  it('should win over a backend the caller named', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    // an inline canvas rather than a second sink: a sink for a sink passes the
    // byte assertion whether or not anything was substituted, so only the
    // identity half carried the test
    const named = createInlineCanvas({ terminal });
    const mounted = mountLive(() => box({}, textNode('visible')), {
      backend: named,
      quiet: true,
      terminal,
    });
    mounted.frame();
    expect(stdout.output).toBe('');
    expect(mounted.backend).not.toBe(named);
  });

  it('should answer for its own size and never write through its terminal', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const sink = createSinkCanvas({ terminal });
    expect(sink.terminal).toBe(terminal);
    expect(sink.isLive).toBe(false);
    expect(sink.active).toBe(false);
    expect(sink.origin).toBeUndefined();
    expect(sink.toCanvas(0, 0)).toBeUndefined();
    sink.resize(40, 6);
    expect([sink.width, sink.height]).toEqual([40, 6]);
    // the convention the inline backend keeps, and a `createSinkCanvas()` an app
    // called itself is the only thing that can reach it: the renderer floors a
    // width before it resizes
    sink.resize(0, 0);
    expect([sink.width, sink.height]).toEqual([1, 1]);
    // every method, so that none of them is the one that writes
    sink.render(() => {});
    sink.present();
    sink.write('nope');
    sink.done();
    sink.stop();
    expect(stdout.output).toBe('');
  });

  /**
   * The same claim over a canvas with something **in** it, which is what a
   * sabotage pass said the test above cannot see: the draw callback is never
   * invoked, so the 1x1 canvas is blank, so a `render()` or a `present()` that
   * wrote `canvas.toString()` wrote the empty string and read as a pass. Two
   * guards covering for each other -- the emptiness and the absent write -- so
   * each needs its own input.
   *
   * `present()` is the interface's documented second mode, "paint it directly
   * and call `present()`", which nothing in the framework uses: the renderer
   * only ever calls `render()`, measured. So an app that reached for it is the
   * only caller there is, and it is the one this answers for.
   */
  it('should write nothing even for a canvas that holds something', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const sink = createSinkCanvas({ terminal });
    sink.resize(40, 3);

    sink.canvas.paint((painter) => {
      painter.text(0, 0, 'painted by hand');
    });
    expect(sink.canvas.toString()).toContain('painted by hand');
    sink.present();
    sink.present({ full: true });
    expect(stdout.output).toBe('');
  });

  /**
   * And the other half: `render()` does not invoke the draw at all, which is
   * what keeps the canvas blank and is a claim about cost rather than about
   * bytes -- so it is asserted as a count rather than through the output, where
   * the absent write already covers for it.
   */
  it('should invoke no draw, and write nothing for one that paints', () => {
    const { stdout, terminal } = setup({ isTTY: true });
    const sink = createSinkCanvas({ terminal });
    sink.resize(40, 3);

    let drew = 0;
    sink.render((painter) => {
      drew += 1;
      painter.text(0, 0, 'drawn by a frame');
    });

    // the two claims, and each catches one half: a `render()` that paints moves
    // the count, and one that paints *and* writes moves the output too. A third
    // assertion on the canvas was deleted for being unable to fail -- the only
    // writer of that string is the callback that did not run
    expect(drew).toBe(0);
    expect(stdout.output).toBe('');
  });
});
