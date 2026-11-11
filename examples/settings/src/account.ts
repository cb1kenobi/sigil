/**
 * What the screen saves to and signs in against, as a context.
 *
 * `App()` takes no props -- it is what `runApp()` and the examples' smoke test
 * mount as it is -- so what a test replaces comes in through a context, the way
 * the system monitor's machine does. Outside a provider it is the one below,
 * which keeps everything in memory: there is no server behind this example, and
 * saving writes nowhere.
 */

import { type Context, createContext } from '@ttylabs/sigil/renderer';

/** Every setting the screen edits. */
export interface Settings {
  compact: boolean;
  digest: boolean;
  direct: boolean;
  email: string;
  mentions: boolean;
  name: string;
  pause: boolean;
  phone: string;
  reduceMotion: boolean;
  sms: boolean;
  textSize: number;
  theme: 'dark' | 'light' | 'system';
}

/** What the screen talks to. */
export interface Account {
  /** The settings to start from. */
  load(): Settings;
  /** Keeps what was saved. */
  save(settings: Settings): void;
  /**
   * Checks a user name and a password. Slow on purpose in the default, so the
   * dialog's busy state is something a person can see.
   *
   * @returns Whether they match.
   */
  signIn(user: string, password: string): Promise<boolean>;
}

/** The password the default account takes, for every user name. */
export const DEMO_PASSWORD = 'swordfish';

/** What a fresh run starts from. */
export const DEFAULTS: Readonly<Settings> = Object.freeze({
  compact: false,
  digest: true,
  direct: true,
  email: 'ada@example.com',
  mentions: true,
  name: 'Ada Lovelace',
  pause: false,
  phone: '',
  reduceMotion: false,
  sms: false,
  textSize: 14,
  theme: 'system',
});

let kept: Settings = { ...DEFAULTS };

const memory: Account = {
  load: () => ({ ...kept }),
  save(settings) {
    kept = { ...settings };
  },
  signIn: (_user, password) =>
    new Promise((resolve) => {
      setTimeout(() => resolve(password === DEMO_PASSWORD), 400);
    }),
};

/** The account the screen is about. `provideContext()` it with a fake in a test. */
export const AccountContext: Context<Account> = createContext(memory, 'account');
