/**
 * A command's input as JSON Schema, read off the command surface (SIG-717).
 *
 * Every tool-calling system an agent uses -- MCP, the Anthropic and OpenAI tool
 * definitions, and the frameworks over them -- describes a tool's input as a
 * JSON Schema object. A sigil command already declares everything one needs, so
 * this is one more printer over the surface rather than a second description of
 * the app: a tool call's arguments are keyed exactly as `argv` is, so what an
 * agent sends and what `run()` reads are one vocabulary.
 *
 * ## It describes the typed form, which is what `checkValue()` judges
 *
 * A value from argv is a string and `transformValue()` turns it into a value. A
 * value in a tool call arrives already typed, and `checkValue()` is the function
 * that judges one of those -- so `int` is `integer` and `bool` is `boolean` here,
 * rather than a string with a pattern. `checkValue()` also takes a string for
 * every type and coerces it, which this does not advertise: a schema is a
 * description for a caller to write to, and `"8080"` for a port is a spelling a
 * caller has no reason to choose.
 *
 * ## It is sound rather than complete
 *
 * Whatever a schema here accepts, the parser accepts too: `checkValue()` takes
 * it, and so do the command's `choices`. The converse is not promised, and the
 * gaps are deliberate and written down rather than discovered:
 *
 * - **A string where a type has a typed form.** Above.
 * - **The calendar.** `DATE_PATTERN` is the shape `date` checks first, and the
 *   calendar and the clock are checked after it, arithmetically -- `2024-02-30`
 *   matches the pattern and is refused. JSON Schema has no way to say "a day
 *   that exists" short of a `format`, and a `format` is an annotation a
 *   validator is free to ignore.
 * - **A `date` given as an epoch.** `checkValue()` reads a 13-digit integer as
 *   one; a caller writing a date writes a string.
 * - **Undeclared options.** `allowUnknownOptions` is on by default and the
 *   parser takes them, while `additionalProperties` is `false` here. A tool
 *   description that invites arguments nothing declares is an invitation to
 *   invent them, and a model will.
 * - **What is hidden.** A hidden option still resolves, and is left out unless
 *   asked for, for the reason help leaves it out.
 * - **A choice the type cannot hold.** String `choices` on an `int` or a
 *   `number` are compared after coercion, so `'443'` is never among them and
 *   the parser refuses every value; the `enum` says so, `[]`. Sound, and a
 *   declaration nothing can satisfy -- which is the declaration's mistake.
 *
 * `auto` is `{}`, any value at all, because `checkValue()` passes a typed value
 * through untouched. A **string** sent to it is still guessed at, so `"007"`
 * arrives as `7` -- which is the reason `auto` is not the default type, met from
 * the other side. `json` is any value **but** a string, for the reason given
 * where it is written.
 */

import { escapeUnsafeJson } from '../util/escape-controls.js';
import { checkValue, DATE_PATTERN } from '../util/transform.js';
import type { CommandSurface, SurfaceArgument, SurfaceCommand, SurfaceOption } from './surface.js';

/** The dialect every schema here is written in. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The subset of JSON Schema this writes.
 *
 * Written out rather than typed as a loose record so that a reader sees every
 * keyword that can appear, and so a keyword nothing here produces is a type
 * error rather than a typo.
 */
export interface JsonSchema {
  $schema?: string;
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
  const?: unknown;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  maximum?: number;
  minItems?: number;
  minimum?: number;
  not?: JsonSchema;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string;
}

/** What `inputSchema()` and `inputSchemas()` may be told. */
export interface InputSchemaOptions {
  /**
   * Whether hidden commands and hidden options are included. Off by default,
   * for the reason help leaves them out: they are reachable, and not offered.
   */
  readonly hidden?: boolean;
  /**
   * Only the command at this argv path and the commands below it, by each
   * segment's canonical name. The command it names is included even when it is
   * hidden, because naming one is asking for it -- the rule `help <command>`
   * already follows. `inputSchemas()` alone reads it.
   */
  readonly under?: readonly string[];
}

/**
 * What a command declares about running it, in MCP's own words (SIG-718).
 *
 * MCP's tool annotations rather than sigil's property names, because this is
 * the document a tool definition is built from: an MCP server hands the object
 * over as it is, and every other reader is no worse off for the `Hint`.
 * A hint the command did not declare is absent rather than `false`, because
 * MCP gives an absent one a default of its own -- `destructiveHint` is `true`
 * unless said otherwise -- and writing `false` would be a claim the author
 * never made.
 */
export interface ToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly readOnlyHint?: boolean;
}

/** One runnable command and what it takes. */
export interface CommandInputSchema {
  /**
   * What running it does, where the command declared any of it. Absent where
   * it declared none, so a command that says nothing reads the same as before.
   */
  readonly annotations?: ToolAnnotations;
  /** What it is for, exactly as the declaration resolved it. */
  readonly description?: string;
  /** Its input, as an object schema keyed by `argv` destination. */
  readonly inputSchema: JsonSchema;
  /** The argv path from the root, by each segment's canonical name. */
  readonly path: readonly string[];
}

/** Every runnable command of an app, and what each one takes. */
export interface InputSchemaDocument {
  /** Each runnable command, in the surface's order. */
  readonly commands: readonly CommandInputSchema[];
  /** What the program is called. */
  readonly program: string;
}

/**
 * What a value of one data type is, in its typed form.
 *
 * `int` and `count` are bounded to the safe integers because past them a number
 * is not the integer that was written, which `checkValue()` refuses. An
 * unrecognized type is `{}`, which is what `checkValue()` does with one: it
 * hands the value back untouched.
 *
 * @param type - The declared data type.
 * @returns A fresh schema, which a caller may add to.
 */
function typeSchema(type: string): JsonSchema {
  switch (type) {
    case 'bool':
    case 'yesno':
      return { type: 'boolean' };
    case 'count':
    case 'int':
      return {
        maximum: Number.MAX_SAFE_INTEGER,
        minimum: Number.MIN_SAFE_INTEGER,
        type: 'integer',
      };
    case 'date':
      return { pattern: DATE_PATTERN, type: 'string' };
    case 'json':
      // any value but a string, because a string is not a value here: it is
      // read as JSON **text**, so `"a"` is refused and `"[1]"` arrives as an
      // array. A caller sends the value itself. Found by the soundness test
      return { not: { type: 'string' } };
    case 'number':
      return { type: 'number' };
    case 'string':
      return { type: 'string' };
    default:
      return {};
  }
}

/**
 * Whether a value is one JSON can carry, recursively.
 *
 * @param value - The value.
 * @returns `true` for a string, a finite number, a boolean, `null`, or an array
 *   or plain object of those.
 */
function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value as object).every(isJson);
  }
  return false;
}

/**
 * A value as a caller would send it, if it is one the parser takes unchanged.
 *
 * The question an `enum` and a `default` both have to answer: a schema saying a
 * value is allowed must mean that the value, sent as JSON, reaches the command
 * as that value. So the value is put through `checkValue()` and kept only if it
 * comes back as itself -- which drops a string choice `'7'` on an `int`, since
 * `'7'` arrives as `7` and `7` is not among the choices, and drops a choice JSON
 * cannot carry at all. A `Date` is the one value that is rewritten rather than
 * dropped: it has a JSON spelling the `date` type reads back as the same
 * instant.
 *
 * @param value - The value.
 * @param type - The declared data type.
 * @returns The value as JSON, or `undefined` if there is none.
 */
function asSent(value: unknown, type: string): unknown {
  if (value instanceof Date) {
    return type === 'date' && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
  }
  if (!isJson(value)) {
    return undefined;
  }

  try {
    return Object.is(checkValue(value, type), value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The schema for one value of a declaration: its type, narrowed by its choices.
 *
 * @param type - The declared data type.
 * @param choices - The declared choices, as values.
 * @returns The schema.
 */
function itemSchema(type: string, choices: readonly unknown[]): JsonSchema {
  const schema = typeSchema(type);

  if (choices.length > 0) {
    // every choice is checked one at a time, and one that cannot be sent is
    // left out rather than failing the schema: a list whose every entry is
    // left out is `enum: []`, which is true -- nothing can be sent that the
    // command will take
    schema.enum = choices.filter((choice) => asSent(choice, type) !== undefined);
  }
  return schema;
}

/**
 * A declared default as a schema's `default`, or nothing.
 *
 * Coerced the way the parser coerces it, so `default: 'yes'` on a flag is
 * `true` here as it is in `argv`, and a list of one is how a single default
 * reaches a `multiple` declaration. A function, or anything that does not come
 * back as itself, is left out: a `default` keyword is a claim about what the
 * command will see, and a guess is worse than no claim.
 *
 * @param value - What the declaration named.
 * @param type - The declared data type.
 * @param multiple - Whether the declaration collects a list.
 * @returns The default, or `undefined`.
 */
function defaultOf(value: unknown, type: string, multiple: boolean): unknown {
  if (value === undefined || typeof value === 'function') {
    return undefined;
  }

  const coerce = (it: unknown): unknown => {
    if (typeof it === 'string' && type !== 'string') {
      try {
        const value = checkValue(it, type);
        // a date is stated as it was written rather than as the instant it
        // reads as: a date with no offset is local time, so `2024-06-15` is
        // `05:00Z` in Chicago and `14:00Z` the day before in Auckland, and a
        // committed schema would differ by machine. The string is in the
        // pattern and reads back as the same date wherever it is sent from
        return type === 'date' ? it : asSent(value, type);
      } catch {
        return undefined;
      }
    }
    return asSent(it, type);
  };

  if (!multiple) {
    return coerce(value);
  }

  const list = (Array.isArray(value) ? value : [value]).map(coerce);
  return list.includes(undefined) ? undefined : list;
}

/**
 * Adds `description` and `default` to a schema where there is one.
 *
 * @param schema - The schema.
 * @param desc - The description.
 * @param value - The default, already in its sent form.
 * @returns The same schema.
 */
function annotate(schema: JsonSchema, desc: string | undefined, value: unknown): JsonSchema {
  if (desc !== undefined && desc !== '') {
    schema.description = desc;
  }
  if (value !== undefined) {
    schema.default = value;
  }
  return schema;
}

/** One property of an input schema, and whether it has to be given. */
interface Property {
  readonly required: boolean;
  readonly schema: JsonSchema;
}

/**
 * The property the options sharing one destination make, in one command.
 *
 * One destination is one property, which is the pairing the parser makes: a
 * valued option and its negated twin write the same `argv` key, so `--cheese
 * <type>` and `--no-cheese` are one `cheese` that is a type or `false`, and
 * `--color` with `--no-color` is one boolean. A negated flag declared alone is
 * the positive destination defaulting to `true`, which is what `argv` holds for
 * it -- `--no-color` alone is `color`, not `noColor`.
 *
 * @param group - The options, in declaration order, all with one `dest`.
 * @returns The property.
 */
function optionProperty(group: readonly SurfaceOption[]): Property {
  const valued = group.find((opt) => opt.takesValue);

  if (valued) {
    const value = defaultOf(valued.default, valued.type, valued.multiple);
    const item = itemSchema(valued.type, valued.choiceValues);
    const one: JsonSchema = valued.multiple ? { items: item, type: 'array' } : item;
    const negated = group.some((opt) => opt !== valued && opt.negate);

    return {
      // a required option that names a default is filled when it is left out,
      // so it is not one a caller has to give
      required: valued.required && value === undefined,
      schema: annotate(negated ? { anyOf: [one, { const: false }] } : one, valued.desc, value),
    };
  }

  // flags only. The positive spelling describes the destination where there is
  // one, and a negated flag on its own decides the default the parser gives it
  const positive = group.find((opt) => !opt.negate);
  const lead = positive ?? group[0];
  const type = group.some((opt) => opt.type === 'count') ? 'count' : lead.type;
  // what the parser gives a flag nobody used, which the surface leaves out as
  // noise for a reader and which is information for a caller: a counter is 0,
  // a flag is off, and a negated flag on its own is on
  const implied = type === 'count' ? 0 : positive === undefined;
  const value = defaultOf(lead.default, type, false) ?? implied;

  return {
    // a flag always has a value -- the implied one above -- so a run is never
    // missing one, `required` or not
    required: false,
    schema: annotate(
      typeSchema(type),
      positive?.desc ?? group.find((opt) => opt.desc !== undefined)?.desc,
      value
    ),
  };
}

/**
 * The property one positional argument makes.
 *
 * @param arg - The argument.
 * @returns The property.
 */
function argumentProperty(arg: SurfaceArgument): Property {
  const value = defaultOf(arg.default, arg.type, arg.multiple);
  const item = itemSchema(arg.type, arg.choiceValues);
  const schema: JsonSchema = arg.multiple
    ? {
        items: item,
        type: 'array',
        ...(arg.required && value === undefined ? { minItems: 1 } : {}),
      }
    : item;

  return {
    required: arg.required && value === undefined,
    schema: annotate(schema, arg.desc, value),
  };
}

/**
 * The commands whose options reach a command: the root, every ancestor, and the
 * command itself, outermost first.
 *
 * Read off the surface by path, which is unique: the walk that wrote it skips a
 * command it has already visited.
 *
 * @param surface - The surface.
 * @param command - The command.
 * @returns The chain.
 */
function chainOf(surface: CommandSurface, command: SurfaceCommand): SurfaceCommand[] {
  const above = surface.commands.filter(
    (it) =>
      it.path.length < command.path.length &&
      it.path.every((segment, i) => segment === command.path[i])
  );
  return [...above.sort((a, b) => a.path.length - b.path.length), command];
}

/**
 * A command's input as a JSON Schema object.
 *
 * One property per `argv` destination: every option of the command **and of
 * each command above it**, because options resolve across the whole chain, and
 * the command's own positional arguments -- an ancestor's are never read once a
 * subcommand is dispatched. A nearer declaration of a destination replaces an
 * outer one, as it does in the parse, and an argument replaces an option of the
 * same destination.
 *
 * Left out: a hidden option unless asked for, and the `--format` or `--json` a
 * `format` declaration adds, which picks how a result is presented rather than
 * what the command does and never reaches `argv`.
 *
 * @param surface - The surface the command is part of, for its ancestors.
 * @param command - The command.
 * @param opts - What to include.
 * @returns The schema, with `$schema` naming its dialect.
 */
export function inputSchema(
  surface: CommandSurface,
  command: SurfaceCommand,
  opts: InputSchemaOptions = {}
): JsonSchema {
  const properties = new Map<string, Property>();

  for (const cmd of chainOf(surface, command)) {
    // grouped per command, in declaration order, so a twin pairs with the twin
    // declared beside it and never with a namesake further up the chain
    const groups = new Map<string, SurfaceOption[]>();
    for (const opt of cmd.options) {
      if (opt.selectsFormat || (opt.hidden && !opts.hidden)) {
        continue;
      }
      groups.set(opt.dest, [...(groups.get(opt.dest) ?? []), opt]);
    }
    for (const [dest, group] of groups) {
      properties.set(dest, optionProperty(group));
    }
  }

  for (const arg of command.args) {
    properties.set(arg.dest, argumentProperty(arg));
  }

  const required = [...properties].filter(([, it]) => it.required).map(([dest]) => dest);

  return {
    $schema: JSON_SCHEMA_DIALECT,
    additionalProperties: false,
    properties: Object.fromEntries([...properties].map(([dest, it]) => [dest, it.schema])),
    ...(required.length > 0 ? { required } : {}),
    type: 'object',
  };
}

/**
 * A command's annotations as MCP names them, for spreading into its entry: an
 * `annotations` key only where there is at least one.
 *
 * @param cmd - The command.
 * @returns The key and its value, or nothing.
 */
function annotationsOf(cmd: SurfaceCommand): { annotations?: ToolAnnotations } {
  const hints: ToolAnnotations = {
    ...(cmd.destructive === undefined ? {} : { destructiveHint: cmd.destructive }),
    ...(cmd.idempotent === undefined ? {} : { idempotentHint: cmd.idempotent }),
    ...(cmd.readOnly === undefined ? {} : { readOnlyHint: cmd.readOnly }),
  };
  return Object.keys(hints).length > 0 ? { annotations: hints } : {};
}

/**
 * Every runnable command of an app, and the input each one takes.
 *
 * A command with no handler is left out, since there is nothing to call: a
 * namespace lists what is under it and exits. So is a hidden command, unless
 * asked for. The root is included when the schema itself declares a `run`.
 *
 * @param surface - The app's surface, from `commandSurface()`.
 * @param opts - What to include.
 * @returns The document.
 */
export function inputSchemas(
  surface: CommandSurface,
  opts: InputSchemaOptions = {}
): InputSchemaDocument {
  const under = opts.under ?? [];
  const below = (cmd: SurfaceCommand): boolean =>
    under.every((segment, i) => cmd.path[i] === segment);
  const named = (cmd: SurfaceCommand): boolean =>
    under.length > 0 && cmd.path.length === under.length && below(cmd);

  return {
    commands: surface.commands
      .filter((cmd) => cmd.runnable && below(cmd) && (!cmd.hidden || opts.hidden || named(cmd)))
      .map((cmd) => ({
        ...annotationsOf(cmd),
        ...(cmd.desc ? { description: cmd.desc } : {}),
        inputSchema: inputSchema(surface, cmd, opts),
        path: cmd.path,
      })),
    program: surface.program,
  };
}

/**
 * Every runnable command's input, as the text of a JSON document.
 *
 * The form to print or commit, written here rather than by each reader so they
 * all write the same bytes: a two-space indent and one trailing newline, the
 * shape of every other JSON file the toolchain writes, and every character
 * `escapeControls()` would escape written as a `\u` escape instead -- a choice
 * or a description may hold one, and this is printed to a terminal.
 *
 * @param surface - The app's surface, from `commandSurface()`.
 * @param opts - What to include.
 * @returns The JSON, ending in exactly one newline.
 */
export function inputSchemasJson(surface: CommandSurface, opts: InputSchemaOptions = {}): string {
  return `${escapeUnsafeJson(JSON.stringify(inputSchemas(surface, opts), undefined, 2))}\n`;
}
