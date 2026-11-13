/**
 * How `initCommand()` reads a command's name string, and what it says when it
 * refuses a `hidden` or a `default`.
 *
 * In a module of its own rather than inside `initCommand()` because `sigil
 * build` asks the same questions of a placeholder it reads out of source, and
 * reaches them through `@ttylabs/sigil/routes` (SIG-421). A build that refuses
 * what the runtime refuses has to say it in the runtime's words and name the
 * command the way the runtime does, and a second copy of either is a copy that
 * drifts -- which is what happened to the description messages, whose build
 * copy named the command by its raw key where the runtime parses it.
 */

/** The pieces of a command's name string. */
export interface ParsedName {
  /** Every other name argv may reach it by: the `@` and `!` labels, and the bare ones after the first. */
  aliases: string[];
  /** The `<required>` and `[optional]` arguments written inline. */
  args: string[];
  /** Whether a `!` label hides it. */
  hidden: boolean;
  /** The labels help prints, joined: everything but a `!` one. */
  label: string;
  /** What it is called: the first bare label, or the first prefixed one when there is none. */
  name: string;
}

const nameSplitRegExp = /[, ]+/;

/**
 * Reads a command's name string.
 *
 * @param unparsedName - The name string, as declared.
 * @returns Its pieces.
 * @throws If it names nothing, which is a name string of arguments, separators
 *   and stray prefixes alone.
 */
export function parseName(unparsedName: string): ParsedName {
  const aliases: string[] = [];
  const args: string[] = [];
  const labels: string[] = [];
  let hidden = false;
  let name: string | undefined;
  let fallbackName: string | undefined;

  for (let label of unparsedName.split(nameSplitRegExp)) {
    if (!label) {
      // a leading, trailing, or doubled separator
      continue;
    }

    const c = label[0];
    if ('<['.includes(c)) {
      args.push(label);
      continue;
    }

    if (c === '!') {
      // "!" hides the command, not just the label it sits on, so a stray
      // "!" still hides rather than quietly doing nothing
      hidden = true;
    }

    if ('!@'.includes(c)) {
      label = label.slice(1);
      if (!label) {
        // a stray "!" or "@" declares no name
        continue;
      }
      aliases.push(label);
      // a prefixed label names the command only if no bare label does
      fallbackName ??= label;
    } else if (name === undefined) {
      // the first bare label is the name...
      name = label;
    } else {
      // ...and every bare label after it is an alias
      aliases.push(label);
    }

    if (c !== '!') {
      labels.push(label);
    }
  }

  name ??= fallbackName;

  if (!name) {
    throw new Error(`Unable to determine command name from "${unparsedName}"`);
  }

  return {
    aliases,
    args,
    hidden,
    label: labels.join(', '),
    name,
  };
}

/**
 * What a `hidden` that is not a boolean is refused with.
 *
 * @param name - The name string as declared, which is what the runtime names.
 * @returns The message.
 */
export function hiddenTypeMessage(name: string): string {
  return `Expected hidden to be a boolean in "${name}" command`;
}

/**
 * What a `default` that is not a boolean is refused with.
 *
 * @param name - The name string as declared, which is what the runtime names.
 * @returns The message.
 */
export function defaultTypeMessage(name: string): string {
  return `Expected default in "${name}" command to be a boolean`;
}
