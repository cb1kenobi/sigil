import { Internal, type InternalOption } from '../../types.js';
import type { OptionRegistry } from './option-registry.js';

/**
 * A flag the parser adds for free: `--help`, `--version`, `--quiet`.
 */
export interface FreeFlag {
  /**
   * The description, asked for only when the flag is added -- so `__` renders
   * only for a flag that exists, which is when it rendered before the three
   * shared this.
   */
  desc: () => string;
  /** The long spelling without its dashes, which is also the name it is stored under. */
  name: string;
  /** The short form's letter, offered only when nothing else holds it. */
  short: string;
}

/**
 * Adds a parser-owned flag unless the app already claimed it.
 *
 * One function for the three flags of this shape, which were written out three
 * times and identically. Nothing is added over the top of what the app declared:
 * `find()` answers about spellings and `has()` about the key the registry stores
 * an option under, which is its name, and **both** have to be free for the long
 * form -- an option spelled `-x` and named `help` takes the key `help` without
 * answering to `--help`, and adding one there would replace it, leaving `-x`
 * pointing at whatever replaced it. The short form asks only `find()`, so a taken
 * `-h` costs the app the short form and a merely-_named_ `help` costs it the flag
 * entirely. That asymmetry is recorded in `AGENTS.md` and is the same for all
 * three.
 *
 * @param options - The registry to add to, which is the root context's.
 * @param flag - What the flag is called and says.
 * @returns The option added, marked parser-owned, or `undefined` when the app
 * had already claimed it.
 */
export async function addFreeFlag(
  options: OptionRegistry,
  flag: FreeFlag
): Promise<InternalOption | undefined> {
  const long = `--${flag.name}`;

  if (options.find(long) || options.has(flag.name)) {
    return undefined;
  }

  // the short form only when it is free: `-h`, `-v` and `-q` are each a common
  // spelling for something else, and taking one from an app that wants it would
  // be worse than not having it
  const short = `-${flag.short}`;
  const format = options.find(short) ? long : `${short}, ${long}`;
  await options.add({ desc: flag.desc(), format });

  const option = options.find(long);
  if (option) {
    // a flag always has a value, and this one is not the app's: an app that
    // never declared it should not find `<name>: false` in its argv
    option[Internal].parserOwned = true;
  }

  return option;
}
