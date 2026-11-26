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
