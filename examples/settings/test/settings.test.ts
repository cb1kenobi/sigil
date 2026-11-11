import { type Account, AccountContext, DEFAULTS, type Settings } from '../src/account.ts';
import { LOGIN_CHECKS, SETTINGS_CHECKS } from '../src/checks.ts';
import { createForm } from '../src/form.ts';
import { LOGIN_HINT, LOGIN_REFUSED } from '../src/login.tsx';
import { App, stylesheet } from '../src/root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { ESCAPE_TIMEOUT } from '@ttylabs/sigil/input';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, ctrl, frame, KEYS } from '@ttylabs/sigil/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings screen run by `runApp()` over a fake terminal, with a fake account
 * behind `AccountContext`: what `src/index.ts` does, minus the real terminal and
 * the in-memory account. The form and the checks are tested on their own first,
 * since they are plain functions of signals.
 */

describe('createForm', () => {
  const make = () =>
    createForm(
      { a: 'x', b: false },
      { a: (a, { b }) => (b && a === '' ? 'a is needed while b is on' : undefined) }
    );

  it('should be clean and valid as built', () => {
    const form = make();
    expect(form.dirty.get()).toBe(false);
    expect(form.valid.get()).toBe(true);
    expect(form.errors.get()).toStrictEqual([]);
  });

  it('should be dirty while a field differs from what was saved, and clean again when it is put back', () => {
    const form = make();
    form.fields.a.value.set('y');
    expect(form.fields.a.changed.get()).toBe(true);
    expect(form.fields.b.changed.get()).toBe(false);
    expect(form.dirty.get()).toBe(true);
    form.fields.a.value.set('x');
    expect(form.dirty.get()).toBe(false);
  });

  it('should re-run a check when another field it reads changes', () => {
    const form = make();
    form.fields.a.value.set('');
    expect(form.valid.get()).toBe(true);
    form.fields.b.value.set(true);
    expect(form.errors.get()).toStrictEqual(['a']);
    expect(form.fields.a.error.get()).toBe('a is needed while b is on');
  });

  it('should say nothing under a field until it is touched, and then follow the value', () => {
    const form = make();
    form.fields.b.value.set(true);
    form.fields.a.value.set('');
    expect(form.fields.a.message.get()).toBe('');
    form.touch('a');
    expect(form.fields.a.message.get()).toBe('a is needed while b is on');
    form.fields.a.value.set('z');
    expect(form.fields.a.message.get()).toBe('');
  });

  it('should touch every field when touched with no key, which is a refused submit', () => {
    const form = make();
    form.touch();
    expect(form.fields.a.touched.get()).toBe(true);
    expect(form.fields.b.touched.get()).toBe(true);
  });

  it('should save on commit and put the saved values back on revert', () => {
    const form = make();
    form.fields.a.value.set('y');
    form.touch();
    expect(form.commit()).toStrictEqual({ a: 'y', b: false });
    expect(form.dirty.get()).toBe(false);
    expect(form.fields.a.touched.get()).toBe(false);

    form.fields.a.value.set('w');
    form.fields.b.value.set(true);
    form.touch();
    form.revert();
    expect(form.values()).toStrictEqual({ a: 'y', b: false });
    expect(form.dirty.get()).toBe(false);
    expect(form.fields.a.touched.get(), 'a cancelled form says nothing about its fields').toBe(
      false
    );
  });
});

describe('the checks', () => {
  const settings = (patch: Partial<Settings>) => ({ ...DEFAULTS, ...patch });

  it('should want a display name, and not too long a one', () => {
    expect(SETTINGS_CHECKS.name?.('  ', settings({}))).toBe('Enter a display name');
    expect(SETTINGS_CHECKS.name?.('x'.repeat(41), settings({}))).toBe('Keep it to 40 characters');
    expect(SETTINGS_CHECKS.name?.('Ada', settings({}))).toBeUndefined();
  });

  it('should want something shaped like an email address', () => {
    expect(SETTINGS_CHECKS.email?.('', settings({}))).toBe('Enter an email address');
    expect(SETTINGS_CHECKS.email?.('ada@', settings({}))).toBe(
      'Enter an address like name@example.com'
    );
    expect(SETTINGS_CHECKS.email?.('ada@example.com', settings({}))).toBeUndefined();
  });

  it('should want a phone number only while SMS is ticked', () => {
    expect(SETTINGS_CHECKS.phone?.('', settings({ sms: false }))).toBeUndefined();
    expect(SETTINGS_CHECKS.phone?.('', settings({ sms: true }))).toBe('SMS needs a phone number');
    expect(SETTINGS_CHECKS.phone?.('call me', settings({}))).toBe(
      'Use digits and spaces, with + for a country code'
    );
    expect(SETTINGS_CHECKS.phone?.('+44 20 7946 0000', settings({ sms: true }))).toBeUndefined();
  });

  it('should want a user name and a password of eight characters', () => {
    const login = { password: '', user: '' };
    expect(LOGIN_CHECKS.user?.('', login)).toBe('Enter your user name');
    expect(LOGIN_CHECKS.user?.('ada lovelace', login)).toBe('Only letters, digits and . _ -');
    expect(LOGIN_CHECKS.user?.('ada.l', login)).toBeUndefined();
    expect(LOGIN_CHECKS.password?.('', login)).toBe('Enter your password');
    expect(LOGIN_CHECKS.password?.('short', login)).toBe('At least 8 characters');
    expect(LOGIN_CHECKS.password?.('swordfish', login)).toBeUndefined();
  });
});

/** Every app a test started, so a failed assertion still gives its terminal back. */
const running: { exit(code?: number): void }[] = [];

// the borders, the list's pointer and the sidebar's marks are drawn from the
// environment, and a Windows runner says ASCII: these say what a terminal that
// draws box characters is, so the screens below are the same on every runner
beforeEach(() => {
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('WT_SESSION', '1');
});
afterEach(() => {
  for (const app of running.splice(0)) {
    app.exit();
  }
  vi.unstubAllEnvs();
});

/**
 * Runs the screen over a fake terminal, with an account the test can see into.
 *
 * `signIn` answers when the test says so: `answer()` settles the attempt in
 * flight, so a test can look at the dialog while it is busy.
 */
function mount({ columns = 80, rows = 24 } = {}) {
  const term = createTestTerminal({ columns, rows });
  const saved: Settings[] = [];
  const attempts: { password: string; user: string }[] = [];
  let settle: ((ok: boolean) => void) | undefined;
  const account: Account = {
    load: () => ({ ...DEFAULTS }),
    save: (settings) => {
      saved.push(settings);
    },
    signIn: (user, password) => {
      attempts.push({ password, user });
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
  const app = runApp(() => provideContext(AccountContext, account, App), {
    detect: false,
    mouse: true,
    sheets: [stylesheet],
    terminal: term.terminal,
  });
  running.push(app);

  // a key, the effect it wakes and the frame that effect asks for are each a
  // turn of their own
  const settleFrames = async () => {
    for (let i = 0; i < 3; i++) {
      await frame(app);
    }
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      await term.press(key);
      await settleFrames();
    }
  };
  const screen = () => term.viewport.join('\n');
  /** The row and column of `text` on screen, 1-based as a mouse report counts. */
  const at = (text: string) => {
    const row = term.viewport.findIndex((line) => line.includes(text));
    expect(row, `"${text}" is on screen`).toBeGreaterThanOrEqual(0);
    return { column: (term.viewport[row] ?? '').indexOf(text) + 1, row: row + 1 };
  };
  /** A left click on the first cell of `text`: SGR press then release. */
  const click = async (text: string) => {
    const { column, row } = at(text);
    await press(`\x1b[<0;${column};${row}M`, `\x1b[<0;${column};${row}m`);
  };
  const escape = async () => {
    await term.press(KEYS.escape);
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
    await settleFrames();
  };
  const answer = async (ok: boolean) => {
    settle?.(ok);
    settle = undefined;
    await settleFrames();
  };

  return { answer, app, attempts, click, escape, press, saved, screen, term };
}

describe('the settings screen', () => {
  it('should open on Appearance with the sidebar focused, and move between sections with the arrows', async () => {
    const s = mount();
    await s.press();
    expect(s.screen()).toContain('─ Appearance ─');
    expect(s.screen()).toContain('How the app looks.');

    await s.press(KEYS.down);
    expect(s.screen()).toContain('─ Notifications ─');
    expect(s.screen()).toContain('Pause all');
    expect(s.screen()).not.toContain('How the app looks.');
  });

  it('should start with nothing to save, and Save and Cancel left out of the ring', async () => {
    const s = mount();
    await s.press();
    expect(s.screen()).toContain('No unsaved changes');
    // the sidebar, then the four Appearance controls, and round to the sidebar
    // again: neither disabled button takes a stop
    await s.press(KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab);
    expect(s.screen()).not.toContain('[ Save ]');
    expect(s.screen()).not.toContain('[ Cancel ]');
    await s.press(KEYS.down);
    expect(s.screen(), 'the sidebar has the focus again').toContain('─ Notifications ─');
  });

  it('should mark a change, enable Save, and save on Enter', async () => {
    const s = mount();
    await s.press(KEYS.tab, KEYS.down);
    expect(s.screen()).toMatch(/◉ light/);
    expect(s.screen()).toContain('Unsaved changes');
    // the section with the change in it is marked in the sidebar
    expect(s.screen()).toMatch(/Appearance +[•*]/);

    // Enter on a radio set is the form's, and the form saves
    await s.press(KEYS.enter);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]?.theme).toBe('light');
    expect(s.screen()).toContain('No unsaved changes');
    expect(s.screen()).toContain('Settings saved');
    expect(s.screen()).not.toMatch(/Appearance +[•*]/);
  });

  it('should put every change back on Cancel', async () => {
    const s = mount();
    // the slider, two steps right, then Tab past the switch and the checkbox and
    // Save to Cancel
    await s.press(KEYS.tab, KEYS.tab, KEYS.right, KEYS.right);
    expect(s.screen()).toContain('16 pt');
    await s.press(KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab);
    expect(s.screen()).toContain('[ Cancel ]');
    await s.press(KEYS.enter);
    expect(s.screen()).toContain('14 pt');
    expect(s.screen()).toContain('No unsaved changes');
    expect(s.screen()).toContain('Changes discarded');
    expect(s.saved).toHaveLength(0);
  });

  it('should disable the notification checkboxes while everything is paused', async () => {
    const s = mount();
    await s.press(KEYS.down, KEYS.tab, KEYS.right);
    expect(s.screen()).toMatch(/◉ on/);
    // the four checkboxes left the ring with the switch's flip, so the next stop
    // is Save, which the change enabled
    await s.press(KEYS.tab);
    expect(s.screen()).toContain('[ Save ]');

    // and they come back when it flips back
    await s.press(KEYS.shiftTab, KEYS.left, KEYS.tab, KEYS.space);
    expect(s.screen()).toMatch(/\[ \] Mentions/);
  });

  it('should show what is wrong under a field once the focus has left it', async () => {
    const s = mount();
    await s.press(KEYS.down, KEYS.down, KEYS.tab, ctrl('u'));
    const under = /^│.* {14}Enter a display name/m;
    expect(s.screen(), 'not while it is being typed').not.toMatch(under);
    // but the bar says what stops a save straight away, and Save is disabled
    expect(s.screen()).toContain("Can't save: Name: Enter a display name");
    expect(s.screen()).toMatch(/Profile +!/);

    await s.press(KEYS.tab);
    expect(s.screen()).toMatch(under);

    // fixing it takes the line away at once
    await s.press(KEYS.shiftTab, 'Ada');
    expect(s.screen()).not.toContain('Enter a display name');
    expect(s.screen()).toContain('Unsaved changes');
  });

  it('should refuse to save an invalid form on Enter, and show every error it has', async () => {
    const s = mount();
    // SMS ticked with no phone number: the problem is in Profile, which nobody
    // has visited
    await s.press(KEYS.down, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.space);
    expect(s.screen()).toMatch(/\[x\] By SMS as well/);
    expect(s.screen()).toContain("Can't save: Phone: SMS needs a phone number");
    expect(s.screen()).toMatch(/Profile +!/);
    // Save is disabled, so the next stop is Cancel, which the change enabled
    await s.press(KEYS.tab);
    expect(s.screen()).toContain('[ Cancel ]');

    await s.press(KEYS.shiftTab, KEYS.enter);
    expect(s.saved).toHaveLength(0);

    await s.click('Profile');
    expect(s.screen()).toMatch(/^│.* {14}SMS needs a phone number/m);
  });

  it('should switch sections and tick a checkbox with the mouse, and ignore a click on a disabled button', async () => {
    const s = mount();
    await s.press();
    await s.click('Save');
    expect(s.saved).toHaveLength(0);

    await s.click('Notifications');
    expect(s.screen()).toContain('─ Notifications ─');
    await s.click('Weekly digest');
    expect(s.screen()).toMatch(/\[ \] Weekly digest/);
    expect(s.screen()).toContain('Unsaved changes');

    await s.click('Save');
    expect(s.saved[0]?.digest).toBe(false);
  });

  it('should cut a long status with an ellipsis rather than wrap it into the footer', async () => {
    // at 60 columns the reason SMS stops a save is wider than the bar has room
    // for, and a text that wrapped drew its second line over the key-help row
    // under it -- where the one cell the footer leaves blank let an "m" through
    const s = mount({ columns: 60, rows: 16 });
    await s.press(KEYS.down, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.space);
    expect(s.term.viewport.at(-2)).toMatch(/^ Can't save: Phone: SMS needs a phone …/);
    expect(s.term.viewport.at(-1)).toMatch(/^tab next · /);
  });

  it('should quit on q with nothing focused that takes it', async () => {
    const s = mount();
    await s.press('q');
    expect(await s.app.exited).toBe(0);
  });
});

describe('the login dialog', () => {
  /** Opens the dialog from the Account section: the last one, and its first button. */
  const open = async () => {
    const s = mount();
    await s.press(KEYS.end, KEYS.tab, KEYS.enter);
    expect(s.screen()).toContain(LOGIN_HINT);
    return s;
  };

  it('should open on the user name, with Sign in disabled until the form is valid', async () => {
    const s = await open();
    // the dialog's own Sign in, disabled: Tab goes user, password, Cancel
    await s.press(KEYS.tab, KEYS.tab);
    expect(s.screen()).toContain('[ Cancel ]');
    await s.press(KEYS.tab, 'ada', KEYS.tab, 'swordfish', KEYS.tab);
    expect(s.screen()).toContain('[ Sign in ]');
  });

  it('should show a field error once the field is left, and none before', async () => {
    const s = await open();
    await s.press('ada lovelace');
    expect(s.screen()).not.toContain('Only letters');
    await s.press(KEYS.tab);
    expect(s.screen()).toContain('Only letters, digits and . _ -');
    await s.press('short', KEYS.shiftTab);
    expect(s.screen()).toContain('At least 8 characters');
  });

  it('should show every error on Enter in the password while the form is invalid, and not sign in', async () => {
    const s = await open();
    await s.press(KEYS.tab, 'abc', KEYS.enter);
    expect(s.screen()).toContain('Enter your user name');
    expect(s.screen()).toContain('At least 8 characters');
    expect(s.attempts).toHaveLength(0);
  });

  it('should mask the password', async () => {
    const s = await open();
    await s.press(KEYS.tab, 'swordfish');
    expect(s.screen()).toMatch(/│ •{9} +│/);
    // the hint says it once, and nothing else does
    expect(s.screen().split('swordfish')).toHaveLength(2);
  });

  it('should sign in on Enter, say so while it waits, and close with the user name', async () => {
    const s = await open();
    await s.press('ada', KEYS.enter, 'swordfish', KEYS.enter);
    expect(s.attempts).toStrictEqual([{ password: 'swordfish', user: 'ada' }]);
    expect(s.screen()).toContain('Signing in...');

    await s.answer(true);
    expect(s.screen()).not.toContain(LOGIN_HINT);
    expect(s.screen()).toMatch(/Account +ada/);
    expect(s.screen()).toContain('Signed in as ada');
    // the focus went to Sign out, which is the next thing to do here
    expect(s.screen()).toContain('[ Sign out ]');
  });

  it('should say a refused password under the form, clear it and keep the user name', async () => {
    const s = await open();
    await s.press('ada', KEYS.enter, 'not-the-one', KEYS.enter);
    await s.answer(false);
    expect(s.screen()).toContain(LOGIN_REFUSED);
    expect(s.screen()).toMatch(/│ ada +│/);
    expect(s.screen()).not.toContain('•');

    // typing again takes the line away
    await s.press('s');
    expect(s.screen()).not.toContain(LOGIN_REFUSED);
  });

  it('should close on Escape with no answer and give the focus back to Sign in', async () => {
    const s = await open();
    await s.press('ada');
    await s.escape();
    expect(s.screen()).not.toContain(LOGIN_HINT);
    expect(s.screen()).toMatch(/Account +not signed in/);
    expect(s.screen()).toContain('[ Sign in... ]');
  });

  it('should drop an answer that lands after the dialog was closed', async () => {
    // closed while the answer was on its way: a refusal landing after that must
    // not move the focus into a field that is no longer on screen
    const s = await open();
    await s.press('ada', KEYS.enter, 'not-the-one', KEYS.enter);
    expect(s.screen()).toContain('Signing in...');
    await s.escape();
    expect(s.screen()).toContain('[ Sign in... ]');
    await s.answer(false);
    expect(s.screen()).toContain('[ Sign in... ]');
    expect(s.screen()).toMatch(/Account +not signed in/);
  });

  it('should take keys only inside the dialog while it is open', async () => {
    const s = await open();
    // q is a letter in the user name, not the app's quit key
    await s.press('q');
    expect(s.screen()).toContain(LOGIN_HINT);
    expect(s.screen()).toMatch(/│ q +│/);
    await s.click('Cancel');
    expect(s.screen()).not.toContain(LOGIN_HINT);
  });
});
