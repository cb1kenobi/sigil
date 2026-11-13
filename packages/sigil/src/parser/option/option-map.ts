import type { Option } from '../../types.js';

/**
 * Reads an option map -- `{ '--flag': 'description' | () => 'description' |
 * { ...declaration } | null }` -- as the declarations it stands for, one entry at
 * a time.
 *
 * The one reading of that map, shared by a command's `options` and a help
 * section's. There used to be two, and they disagreed: the section's copy took a
 * string description and refused a thunk, although `HelpSection.options` is the
 * same `OptionDeclarations` type a command's is. A string or a thunk is the
 * shorthand for the description, and the two are the same statement written two
 * ways -- `initOption()` resolves either, so this does not have to know which it
 * was handed. `null` and `undefined` are a format and nothing else, and the key
 * fills in for an object's missing `format` without writing to the caller's
 * object.
 *
 * An array is refused rather than read. `Object.entries()` yields its indices,
 * so `options: ['--foo <x>']` used to declare an option **named `0`** whose
 * description was `--foo <x>`, and parse -- where `args` and `commands` refuse a
 * container of the wrong shape.
 *
 * A generator rather than a list, so each entry is checked when the caller
 * reaches it: a bad entry after a declaration that fails to build reports the
 * declaration, which is the order both callers always reported in.
 *
 * @param map - The option map, as declared.
 * @param where - What the map belongs to, as it reads in front of `options` in an
 * error: `''` for a command, `help section "Title" ` for a section.
 * @returns The declarations, in the map's order.
 */
export function* optionDeclarations(map: unknown, where = ''): Generator<Option, void, undefined> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new TypeError(`Expected ${where}options to be an object`);
  }

  for (const [format, value] of Object.entries(map)) {
    if (value === undefined || value === null) {
      yield { format };
    } else if (typeof value === 'string' || typeof value === 'function') {
      yield { desc: value as Option['desc'], format };
    } else if (typeof value === 'object') {
      const decl = value as Option;
      yield { ...decl, format: decl.format ?? format };
    } else {
      throw new TypeError(`Expected ${where}option to be an object`);
    }
  }
}
