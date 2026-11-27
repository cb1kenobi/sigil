/**
 * An agent skill for an app, written from its command surface (SIG-720).
 *
 * Coding agents load Agent Skills: a `SKILL.md` whose front matter is always in
 * context and whose body is read when the description matches the task. An app
 * built with sigil already knows everything its skill would say -- its commands,
 * what each takes, what each does to the world -- so the toolchain writes it
 * rather than an author keeping one by hand in step with the code.
 *
 * Two files, because that is what a skill is for. `SKILL.md` is the short one:
 * what the program is, its commands with what running each one does, and the
 * three facts an agent needs to call any of them well -- `schema` for exact
 * input, `--json` for output it can parse, and what a failure looks like.
 * `reference.md` is the long one, the markdown reference `sigil reference`
 * already prints, which an agent reads only when it needs a command's options in
 * full. Nothing here is a second printer of a command: the reference is
 * `referenceDocument()`, and the exact input is the app's own `schema` command.
 *
 * ## Why it is `sigil reference` and not `sigil build`
 *
 * A command's options exist only inside its module, and a build parses modules
 * rather than running them -- the reason the reference is its own command. A
 * skill that listed commands without their input would be the one thing worse
 * than none, so it is generated where the surface is.
 */

import { referenceDocument } from './markdown.ts';
import type { UsageErrorCode } from '@ttylabs/sigil';
import {
  byCodeUnit,
  descriptionLine,
  type CommandSurface,
  type SurfaceCommand,
} from '@ttylabs/sigil/reference';

/** One file of a skill, relative to the skill's own directory. */
export interface SkillFile {
  readonly body: string;
  readonly file: string;
}

/**
 * Every code a usage error carries, which is what a caller branches on.
 *
 * Written out because the codes are a type, and checked against it in both
 * directions: `satisfies` refuses a code that is not one, and the conditional
 * type below stops compiling when the union gains a code this does not list.
 */
const USAGE_CODES = [
  'extra-arguments',
  'invalid-value',
  'missing-argument',
  'missing-option',
  'missing-value',
  'unexpected-argument',
  'unknown-command',
  'unknown-option',
  'unsupported-format',
] as const satisfies readonly UsageErrorCode[];

/** Fails to compile where a usage code is missing from {@link USAGE_CODES}. */
const COVERS_EVERY_CODE: [Exclude<UsageErrorCode, (typeof USAGE_CODES)[number]>] extends [never]
  ? true
  : false = true;
void COVERS_EVERY_CODE;

/**
 * A skill's name for a program: lowercase letters, digits and hyphens, at most
 * 64 characters, which is what the skill format asks for. A scoped or punctuated
 * program name is folded into that shape rather than refused, since the program's
 * own name is what an agent will search for.
 *
 * @param program - What the program is called.
 * @returns The name, never empty.
 */
export function skillName(program: string): string {
  const folded = program
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return folded || 'cli';
}

/**
 * The description in a skill's front matter: what the program does and when to
 * reach for the skill, on one line, as the format asks -- at most 1,024
 * characters and no angle brackets, which some loaders read as markup.
 *
 * @param program - What the program is called.
 * @param desc - The program's own description, if it has one.
 * @param json - Whether any command presents its result as JSON.
 * @returns The description.
 */
function skillDescription(program: string, desc: string | undefined, json: boolean): string {
  const said = desc ? descriptionLine(desc).replaceAll(/[<>]/g, '') : '';
  const what = said
    ? `${program}: ${said.replace(/[.!?]$/, '')}.`
    : `The ${program} command-line tool.`;
  const full = `${what} Use it to run ${program} from an agent: which commands it has, what each one takes and whether it changes anything, ${json ? 'how to get JSON out of it, ' : ''}and what its errors mean.`;
  return full.length <= 1024 ? full : `${full.slice(0, 1021).replace(/\s+\S*$/, '')}...`;
}

/**
 * A table cell, as `markdown.ts` writes one: a bar is the cell's end, so it is
 * escaped, and a description is one line.
 *
 * @param text - The text.
 * @returns The cell.
 */
function cell(text: string): string {
  return descriptionLine(text).replaceAll('|', '\\|');
}

/**
 * What running a command does, as its annotations say, for a table.
 *
 * @param cmd - The command.
 * @returns The words, or a dash where it declared none.
 */
function effects(cmd: SurfaceCommand): string {
  const words = [
    ...(cmd.readOnly ? ['read-only'] : []),
    ...(cmd.destructive ? ['**destructive**'] : []),
    ...(cmd.idempotent ? ['idempotent'] : []),
  ];
  return words.length > 0 ? words.join(', ') : '--';
}

/** What a skill is told beyond the surface. */
export interface SkillOptions {
  /**
   * Whether `<program> schema` is the framework's command, which it is unless the
   * schema turned it off with `schema: false` or the app declares a `schema` of
   * its own -- the surface records the second and not the first. Defaults to
   * `true`.
   */
  readonly schemaCommand?: boolean;
}

/**
 * The skill for an app.
 *
 * @param surface - The app's surface, from `commandSurface()`.
 * @param opts - What the surface cannot say.
 * @returns `SKILL.md` and `reference.md`, in that order.
 */
export function skillFiles(surface: CommandSurface, opts: SkillOptions = {}): SkillFile[] {
  const { program } = surface;
  const root = surface.commands.find((cmd) => cmd.path.length === 0);
  // what an agent can run: a command with a handler, listed or not hidden. A
  // namespace lists what is under it and does nothing, and a hidden command is
  // one the author chose not to offer
  const runnable = surface.commands
    .filter((cmd) => cmd.runnable && !cmd.hidden)
    .toSorted((a, b) => byCodeUnit(a.path.join(' '), b.path.join(' ')));
  const json = runnable.some((cmd) => cmd.options.some((opt) => opt.selectsFormat));
  // the app's own `schema` takes the word, as an app's own `completion` does
  const schemaCommand =
    opts.schemaCommand !== false &&
    !surface.commands.some((cmd) => cmd.path.length === 1 && cmd.tokens.includes('schema'));

  const lines = [
    '---',
    `name: ${skillName(program)}`,
    // quoted, because unquoted YAML cannot hold the `: ` it always has, nor a
    // ` #` or a leading `[`. A JSON string is a double-quoted YAML one; the
    // `DEL` and C1 that JSON leaves raw cannot be here, since a description
    // drops control characters and the surface refuses a name holding one
    `description: ${JSON.stringify(skillDescription(program, root?.desc, json))}`,
    '---',
    '',
    `# \`${program}\``,
    '',
    ...(root?.desc ? [descriptionLine(root.desc), ''] : []),
    `This skill was written by \`sigil reference --skill\` from ${program}'s own command declarations, so it describes the version it was generated from. Every option of every command is in [reference.md](reference.md).`,
    '',
    '## Commands',
    '',
    '| Command | What it does | Running it |',
    '| --- | --- | --- |',
    ...runnable.map(
      (cmd) =>
        `| \`${[program, ...cmd.path].join(' ')}\` | ${cmd.desc ? cell(cmd.desc) : '--'} | ${effects(cmd)} |`
    ),
    '',
    '"Read-only" changes nothing, "destructive" may delete or overwrite data, and "idempotent" can be run again with the same input safely. A dash is a command that declares none of the three, which says nothing either way: ask before running it where a mistake would cost something.',
    '',
    '## Calling it',
    '',
    schemaCommand
      ? `- **Read the input before guessing it.** \`${program} schema\` prints every command's input as JSON Schema, keyed by the option's destination, with what each command declares about running it as MCP tool annotations; \`${program} schema <command>\` prints one. \`${program} <command> --help\` is the same thing for a person.`
      : `- **Read the input before guessing it.** Every option of every command is in [reference.md](reference.md), and \`${program} <command> --help\` prints the same for one command.`,
    ...(json
      ? [
          `- **Ask for JSON where a command offers it.** A command whose options include \`--json\` (or \`--format <name>\`) writes its result to stdout as JSON with \`--json\`, and its error to stderr as \`{"error":{"message","name","code"}}\`.`,
        ]
      : []),
    '- **Pass every value on the command line.** A command that would ask a question on a terminal fails without one instead of waiting, so give it what it would have asked for.',
    `- **Read the exit code.** \`0\` is success, \`2\` is a usage error -- the command line was wrong -- and \`1\` is any other failure. A usage error carries a \`code\` naming what was wrong: ${USAGE_CODES.map((code) => `\`${code}\``).join(', ')}.`,
    '',
  ];

  return [
    { body: lines.join('\n'), file: 'SKILL.md' },
    { body: referenceDocument(surface), file: 'reference.md' },
  ];
}
