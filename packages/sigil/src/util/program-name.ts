import { withoutUnsafe } from './escape-controls.js';
import { basename } from 'node:path';

/**
 * The program's name, for anything that prints one.
 *
 * The root context is named from the schema, and `parse()` calls it `global`
 * when the schema did not say -- an internal placeholder, and not something to
 * print. The name of the running script is the better guess, because it is what
 * the user typed.
 *
 * One definition because two readers print it: help's usage line, and the
 * `schema` command's `program` (SIG-717), which has to name the program help
 * names or an agent reading both is told two different things.
 *
 * @param declared - What the schema calls the program, if anything.
 * @returns The name to print.
 */
export function programName(declared: string | undefined): string {
  const script = process.argv[1] ? basename(process.argv[1]) : undefined;
  return declared ?? script ?? 'cli';
}

/** What is wrong with a program's name, where something is. */
export type ProgramNameProblem = 'missing' | 'unsafe' | 'whitespace';

/**
 * What is wrong with a program's name for anything that prints it as one word,
 * or nothing where it will do.
 *
 * One word, because a reference prints it into a heading, a usage line and a
 * front matter title, none of which survives a line break; and nothing a
 * terminal acts on or hides, the class `escapeControls()` names (SIG-643). The
 * name is trimmed first, as `commandSurface()` trims it.
 *
 * Written here rather than inside `commandSurface()` because two readers ask:
 * that function refuses such a name, and the `schema` command stays out of an
 * app whose name it would refuse (SIG-717) -- a command help lists and that can
 * only fail would be the worse answer. One rule, so the two cannot disagree
 * about which names those are.
 *
 * @param name - The name, untrimmed.
 * @returns The problem, or `undefined`.
 */
export function programNameProblem(name: string): ProgramNameProblem | undefined {
  const program = name.trim();

  if (!program) {
    return 'missing';
  }
  // asked before whitespace, so a name holding both is said to hold the one a
  // reader cannot see -- the order the message always had
  if (withoutUnsafe(program) !== program) {
    return 'unsafe';
  }
  if (/\s/u.test(program)) {
    return 'whitespace';
  }
  return undefined;
}
