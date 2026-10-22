/**
 * The command surface, printed as markdown.
 *
 * `oclif readme` writes a command reference into a README on publish and
 * Salesforce generates a whole doc site from one; sigil generated a help
 * *screen* and nothing that outlived the process. This is the reference, over
 * the one surface the snapshot is printed from -- so a page and a snapshot
 * cannot come to disagree about what a command accepts.
 *
 * ## One printer, two layouts, and the destination is what decides
 *
 * A page per command is what a docs site routes on and the only shape that
 * stays navigable past a dozen commands; one document is what a pipe gets and
 * what a README injection wants. Both come out of `page()`, which returns its
 * two halves -- the front matter and the body -- so the layouts differ in what
 * they keep rather than in how they print.
 *
 * ## Every string a declaration owns is escaped on the way out
 *
 * A program name, a command name, an option spelling, a placeholder built from
 * `choices`, a description: each is a string an app wrote, and a reference is a
 * file somebody commits. So a cell's bars are escaped by `table()`, a code span
 * is fenced long enough by `code()`, a verbatim block is fenced by `fenced()`,
 * and every one of them flattens its whitespace and drops the control
 * characters -- which is this repository's own rule about what ships: a raw
 * escape sequence in a committed file is a sequence waiting for something to
 * print it.
 */

import type {
  CommandSurface,
  SurfaceArgument,
  SurfaceCommand,
  SurfaceOption,
} from '@ttylabs/sigil/reference';

/**
 * What joins a path into a flat file name.
 *
 * A dash, because a directory of pages is flat -- a docs site routes on a file
 * name and a nested directory is a second routing shape for one reference. Which
 * is also why a command whose own name holds one is **refused** rather than
 * silently sharing a page: see `listed()`.
 */
const JOIN = '-';

/**
 * Every C0, `DEL` and C1 character, which is what `\p{Cc}` is.
 *
 * Named by the property rather than enumerated, which is the rule the build's
 * own escape pass records: a class of escapes trips `no-control-regex` and the
 * answer is not a suppression a formatter can detach from the line it was
 * written over. A newline is in the set and is handed back by the one caller
 * that keeps it.
 */
const CONTROL = /\p{Cc}/gu;

/** One page a reference comes to. */
export interface ReferencePage {
  /** Its content, front matter included, ending in exactly one newline. */
  readonly body: string;
  /** Its file name, relative to the destination and always forward-slashed. */
  readonly file: string;
  /** The argv path it documents, which is what the front matter carries. */
  readonly path: readonly string[];
}

/**
 * One line of prose that cannot open a markdown block.
 *
 * A `desc` is spliced in as its own paragraph, so whatever it starts with is at
 * the start of a line after a blank one -- which is where every block opener in
 * CommonMark lives. Measured: `desc: '# of files to keep'` rendered as an
 * `<h1>`, and a description beginning `- `, `1. `, `>` or `---` is a list, a
 * quote or a rule. "Every string a declaration owns is escaped on the way out"
 * is this module's own claim and these two were not. Found by review.
 *
 * A backslash escapes any ASCII punctuation in CommonMark, which covers every
 * opener but an ordered list's digit -- `\1` is not an escape and renders as a
 * backslash -- so for `1. ` and `1) ` it is the **punctuation** that is escaped
 * rather than the digit, which is what makes the list marker not one.
 *
 * @param text - What the declaration said, or nothing.
 * @returns The one-line form, safe at the start of a line.
 */
function paragraph(text: string | undefined): string {
  const flat = oneLine(text);

  // a thematic break, a setext underline, a heading, a quote, a bullet, a code
  // fence, an HTML block and the two ordered-list markers.
  //
  // `<` is in the set and was not, which is the worst of the openers rather than
  // one more of them: CommonMark's type 1 and type 2 HTML blocks -- `<pre`,
  // `<script`, `<style`, `<textarea` and `<!--` -- do **not** end at a blank
  // line, so a description beginning with one swallowed every later line of the
  // page. Measured: `desc: '<pre>keep this'` made `## Usage` literal text and
  // put the usage fence and the examples inside one raw HTML run. A
  // backslash-escaped `<` opens nothing. Found by review, and the comment this
  // replaces called the set "the whole of what opens a block", which is the
  // claim that let it ship
  return flat.replace(/^(?:([-=_#>+*~`|[<])|(\d{1,9})([.)]))/u, (all, mark, digits, dot) =>
    mark === undefined ? `${digits as string}\\${dot as string}` : `\\${all as string}`
  );
}

/**
 * One string as one line of prose.
 *
 * Every run of whitespace becomes one space and every control character goes,
 * because a `desc` is a one-line description wherever it is printed -- a
 * newline in one breaks a table row, a paragraph and a front-matter value
 * alike, and all three are reachable from a declaration that wrapped its own
 * text. `\s+` collapses first so that a newline is replaced by a space rather
 * than removed, which is what joins two wrapped words rather than running them
 * together.
 *
 * @param text - What the declaration said, or nothing.
 * @returns The one-line form.
 */
function oneLine(text: string | undefined): string {
  return (text ?? '').replaceAll(/\s+/gu, ' ').replaceAll(CONTROL, '').trim();
}

/**
 * One table cell's text.
 *
 * `oneLine()` and nothing else: the bar escaping belongs to `table()`, which is
 * the one function that knows a cell sits between columns. It was here, and that
 * put it in the wrong place twice over -- a code span built for a *heading* went
 * through `code()`, which escaped a bar that is an ordinary character there, so
 * a program name holding one rendered a visible backslash. One reader of "a bar
 * is a column separator", in the function about columns.
 *
 * @param text - What the declaration said.
 * @returns The cell.
 */
function cell(text: string | undefined): string {
  return oneLine(text);
}

/**
 * A cell's `|` characters escaped, because that is the column separator.
 *
 * A table row is split on its bars **before** anything inside it is parsed, so
 * a code span is no shelter: a choices list joined with `|` --
 * `--lint [oxlint|eslint|biome|none]`, which is what the placeholder spells --
 * added three columns to its own row and shifted every cell after it. Found by
 * reading the generated page rather than by a test, which is why there is now a
 * test that every row in a table has the columns its header does.
 *
 * `\|` is what GFM specifies for a literal bar in a cell and it is honoured
 * inside a code span too, which is the one place it has to work here.
 *
 * @param text - The cell's content.
 * @returns It, safe to put between two bars.
 */
function bars(text: string): string {
  return text.replaceAll('|', '\\|');
}

/**
 * Something spelled as code.
 *
 * One function for every code span a page holds -- a heading, a table cell, an
 * alias, a subcommand's name -- because each is a string a declaration owns: a
 * placeholder built from `choices`, and an argument's or an option's name, which
 * is whatever a route file or a format string was called. It does **not** escape
 * a bar: that is `table()`'s, which is the one function that knows a cell sits
 * between columns, and escaping here put a visible backslash in a heading.
 *
 * The delimiter is **longer than the longest run of backticks in the content**,
 * which is CommonMark's own rule and is the one thing a single backtick cannot
 * do: a command genuinely called ``tick`x`` -- a routed file by that name -- came
 * out as a code span ending at its own content. Padded with a space where the
 * content starts or ends with one, which is the other half of that rule. Found
 * by review.
 *
 * @param text - What to show.
 * @returns The code span, with the fence long enough. The bars are `table()`'s.
 */
function code(text: string): string {
  const flat = oneLine(text);
  const longest = Math.max(0, ...[...flat.matchAll(/`+/gu)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';

  return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * A string as a JSON scalar, which is what the front matter holds.
 *
 * JSON is a subset of YAML, so a front matter whose values are JSON parses as
 * YAML for any site that expects it *and* is readable with `JSON.parse` by one
 * that would rather not take a YAML dependency to read three keys. What that
 * buys is the thing a hand-rolled `key: value` front matter gets wrong: a
 * description holding a colon, a quote or a `#` is escaped by construction
 * rather than by a rule somebody has to remember.
 *
 * @param value - The value.
 * @returns It, JSON-encoded.
 */
function scalar(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The placeholder a value is typed in, brackets and all.
 *
 * `<>` where a value has to be given and `[]` where it need not, which is the
 * convention the declarations are written in and the one help already prints.
 * The choices stand in for the hint where there are any, because
 * `--lint <oxlint|eslint|biome|none>` says everything the hint would and more.
 *
 * @param required - Whether a value has to be given.
 * @param multiple - Whether more than one is taken.
 * @param name - The hint, or the argument's name.
 * @param choices - The values it accepts.
 * @returns The placeholder.
 */
function placeholder(
  required: boolean,
  multiple: boolean,
  name: string,
  choices: readonly string[]
): string {
  const inner = (choices.length > 0 ? choices.join('|') : name) + (multiple ? '...' : '');
  return required ? `<${inner}>` : `[${inner}]`;
}

/**
 * How a repeatable declaration says so, which is not the same for the two.
 *
 * `...` belongs to an **argument**, where it is the `...` in `<files...>` and
 * where it means the slot consumes the rest. An **option** never does: it takes
 * one value per use and `multiple` collects repeated uses, so `--tag a b` leaves
 * `b` positional. Measured: `sigil build --external a b` is
 * `{ external: ['a'], dir: 'b' }`, and the committed page said
 * `--external [pkg...]` with a type of `string...`, neither of which is a thing
 * -- help prints `--external [pkg]` and the type the parser has is `string`.
 *
 * So an option says it in prose beside the description, which is one spelling
 * where there were two, and the one help already uses for the hint. Found by
 * review.
 */
const REPEATABLE = 'may be repeated';

/**
 * How an argument is spelled where it is typed.
 *
 * @param arg - The argument.
 * @returns `<dir>`, `[files...]`.
 */
function argSpelling(arg: SurfaceArgument): string {
  return placeholder(arg.required, arg.multiple, arg.name, arg.choices);
}

/**
 * How an option is spelled where it is typed.
 *
 * Short spellings first, which is what lines the long names up in help and
 * reads the same way here. A flag has no placeholder at all, because there is
 * no value to type.
 *
 * @param opt - The option.
 * @returns `-y, --yes`, `--out <path>`.
 */
function optionSpelling(opt: SurfaceOption): string {
  // a negated flag answers to the positive spelling too -- `--no-color` also
  // accepts `--color` -- and help deliberately leaves it off the row, because
  // printing both reads as two options that mean opposite things while the
  // description describes one of them. A reference is a listing, so it follows.
  //
  // The *snapshot* keeps both, because both resolve: dropping `--color` from
  // what argv accepts would be a surface change, and this is not one. That is
  // the sharpest difference between the two readers
  const positive = `--${opt.name}`;
  const long = opt.long.filter((name) => !(opt.negate && name === positive));
  const spellings = [...opt.short, ...long].join(', ');

  if (!opt.takesValue) {
    return spellings;
  }

  // `false` for the ellipsis, which is the whole of the fix above: an option
  // takes one value per use, so a hint of `[pkg...]` is the spelling of an
  // argument that consumes the rest
  return `${spellings} ${placeholder(opt.required, false, opt.hint ?? 'value', opt.choices)}`;
}

/**
 * The data type a value is coerced with, as a reader meets it.
 *
 * The declaration's own vocabulary -- `string`, `int`, `bool` -- rather than a
 * translation into some other type system, because that is the word the app
 * wrote and the word `docs/parser.md` documents. `...` marks a repeated option
 * for the same reason an argument's name carries one.
 *
 * @param type - The data type.
 * @param multiple - Whether more than one value is collected.
 * @returns The type, in backticks.
 */
function typeCell(type: string, multiple: boolean): string {
  return code(`${type}${multiple ? '...' : ''}`);
}

/**
 * A description cell with what the declaration adds to it.
 *
 * The default and the repeatability, which help prints beside a description and
 * this printed nowhere: the page said less than `--help` about the same
 * declaration, which for the artifact that is *for reading* is the wrong way
 * round. The snapshot drops both, deliberately and for the reason recorded
 * there.
 *
 * `cell()` wraps the **whole** of it rather than the description alone, which
 * is where that call was: a `default` is a value a declaration owns and
 * `scalarText()` hands back a string as it stands, so a multi-line one -- and
 * `String(fn)` for a computed default, which is the function's own source --
 * put a raw newline in the row. GFM ends a row at the first one, so the rest
 * became a stray paragraph and the website rendered a broken table. Measured:
 * `default: 'a\nb'` and `default: () => {\n  return process.cwd();\n}` each
 * tore the row in two, leaving a first line with two columns where the header
 * has three, and a control character in a default reached the committed page
 * raw. Found by review, twice, and by the row-count test having no default in
 * its fixture to see it with.
 *
 * One pass at the boundary rather than one per note: this returns a cell, so
 * every string that reaches it is cleaned where it becomes one -- which is also
 * what makes a note added later clean without anybody having to remember.
 *
 * What that collapses is a *run* of spaces inside a default `scalarText()`
 * quoted, so `default: '   '` reads `(default: " ")` where help prints all
 * three. Markdown collapses inline whitespace on the way to HTML anyway, so
 * what the committed page says is what the website was going to render either
 * way -- which is the one place this is deliberately not help's own text.
 *
 * @param opt - The option.
 * @returns The cell.
 */
function described(opt: SurfaceOption): string {
  const notes = [
    ...(opt.multiple ? [REPEATABLE] : []),
    ...(opt.default === undefined ? [] : [`default: ${scalarText(opt.default)}`]),
  ];

  return cell(
    notes.length === 0 ? opt.desc : [opt.desc, `(${notes.join(', ')})`].filter(Boolean).join(' ')
  );
}

/**
 * One default as prose, which is help's own rule rather than a second one.
 *
 * A string is printed as it is unless printing it as it is would show nothing
 * or would not show where it begins and ends; anything else is JSON, and what
 * cannot be written as JSON -- a circular object, a `BigInt`, a function -- is
 * written as itself rather than failing the page. Which is `format()` in
 * `src/help/index.ts`, said again here because that one is not exported and a
 * reference may not fail over a default it cannot print.
 *
 * @param value - Whatever the declaration put there.
 * @returns The text.
 */
function scalarText(value: unknown): string {
  if (typeof value === 'string') {
    return value === value.trim() && value !== '' ? value : JSON.stringify(value);
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A markdown table, or nothing at all where there are no rows.
 *
 * Three columns, and there is no `Values` column: the placeholder already
 * carries the choices -- `--lint [oxlint|eslint|biome|none]` -- so a column for
 * them would be the same fact twice, and in every table that has none it would
 * be an empty column. Fixed rather than dropped where a *cell* is empty,
 * because a table whose shape depends on its contents is one whose diff moves
 * for a reason that is not the content.
 *
 * @param head - The column headings.
 * @param rows - The rows.
 * @returns The table's lines, or none.
 */
function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) {
    return [];
  }

  return [
    // the header is **not** escaped, and that is the rule this repository keeps
    // about a guard that cannot change an answer: every header this module
    // passes is one of its own literals -- `Argument`, `Type`, `Description`,
    // `Option`, `Command` -- and none holds a bar. A sabotage of it failed
    // nothing, which is what said so
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    // every cell escaped **here**, which is the one place that knows a cell sits
    // between columns: GFM splits a row on its bars *before* it parses the
    // inline content, so an unescaped one adds a column even inside a code span
    // -- measured, a `--lint [oxlint|eslint|biome|none]` hint added three. And a
    // `\|` inside a code span in a table really does render as a bar, which is
    // what makes escaping after the fencing right rather than merely safe
    ...rows.map((row) => `| ${row.map(bars).join(' | ')} |`),
  ];
}

/**
 * The usage line, as a reader would type it.
 *
 * `[options]` only where there are any to pass, and `<command>` only where
 * something is under it -- a usage line that names a placeholder for nothing is
 * a usage line that lies. The arguments come last and in declaration order,
 * because that is the order they are read in.
 *
 * @param program - What the program is called.
 * @param cmd - The command.
 * @param children - Whether anything is listed under it.
 * @param options - Whether any option is passable here, its own or an
 *   ancestor's.
 * @returns The line.
 */
function usage(
  program: string,
  cmd: SurfaceCommand,
  children: boolean,
  options: boolean,
  fallback: boolean
): string {
  const parts = [program, ...cmd.path];

  // its own **or an ancestor's**, which is the half the first version got
  // wrong: options resolve across the whole context chain, so a command that
  // declares none and sits under a root that declares some still takes them --
  // and the page said `mycli go` on the usage line and "every option `mycli`
  // declares resolves here too" four lines below it. Two sentences on one page
  // disagreeing, which is why the fact is passed in rather than re-derived.
  // Found by review
  if (options) {
    parts.push('[options]');
  }
  if (children) {
    // `[command]` where a default child exists, which is what `usageLine()`
    // already prints and what the parse does: a command token is not required
    // when something runs without one. Measured, the page said `<command>`
    // where help said `[command]` over the same schema, and bare `mycli` exits
    // 0. Found by review
    parts.push(fallback ? '[command]' : '<command>');
  }
  for (const arg of cmd.args) {
    parts.push(argSpelling(arg));
  }

  return parts.join(' ');
}

/**
 * A path as a key no two different paths can share.
 *
 * Joined with NUL rather than with a space, and that is a **statement rather
 * than a guard**: a path segment cannot hold a space, because `initCommand()`'s
 * label rule reads whitespace as the separator between a name and its aliases --
 * measured, a `commands` key of `'go x'` declares a command named `go` aliased
 * `x`, and a routed file called `a b.js` does the same. So no two paths can
 * collide on a space-joined key and this changes no answer today.
 *
 * It is written this way because the key's correctness then does not rest on
 * that rule holding: NUL is the one character a name cannot contain for a
 * reason of its own, since `tokensFor()` drops a name holding a control
 * character -- so a command with one is not in the surface at all.
 *
 * A review round reported the ambiguity as measured, with a hidden `a b` making
 * a visible `a`->`b` page vanish. The symptom reproduces and the cause is a
 * different one: `a b.js` *becomes* a command named `a`, which collides in the
 * registry with the `a/` directory beside it, and the hidden one wins or loses
 * by registration order. That is the parser's, it predates this feature, and it
 * is recorded rather than worked around here.
 *
 * @param path - The argv path.
 * @returns The key.
 */
function key(path: readonly string[]): string {
  return path.join('\u0000');
}

/**
 * Where another command is, or nothing at all.
 *
 * The one thing the two layouts answer differently, and a parameter rather than
 * a second printer: a page points at a file, and a concatenated document has no
 * files to point at.
 */
type Link = (path: readonly string[]) => string | undefined;

/**
 * One command named, as a link where there is somewhere to link to.
 *
 * The document form deliberately links **nowhere**. An anchor would be the
 * obvious answer and is renderer-specific -- how a heading becomes a fragment is
 * GitHub's own rule, and a subtly wrong anchor is a link that goes nowhere,
 * which is worse than a name that was never a link. A document is one scroll and
 * a reader has their renderer's outline.
 *
 * @param text - What to show.
 * @param path - The command's path.
 * @param link - How to point at it.
 * @returns The markdown.
 */
function linked(text: string, path: readonly string[], link: Link): string {
  const href = link(path);

  if (!href) {
    return code(text);
  }

  // the destination is a **URL** rather than a file name, so it is encoded as
  // one: measured, `(`, `)`, `<`, `>`, `|`, `#`, `?` and a backtick all survive
  // into a command name, and each of the last four is a different wrong answer
  // rather than a broken one -- `](go#x.md)` is a link to `go` with a fragment
  // of `x.md`, and `](go?x.md)` one with a query. `encodeURIComponent()` is the
  // transform that makes the href resolve to the file: a browser asking for
  // `go%23x.md` fetches `go#x.md`.
  //
  // Encoded rather than **stripped**, which is what the first version did to
  // `<` and `>`: `go<x.md` came out as `gox.md`, a link to a page that is not
  // there, which is a wrong value where a broken link is merely broken.
  //
  // What encoding leaves is a paren, which is legal in a bare destination only
  // when it is balanced -- so what is left for the angle brackets is exactly
  // that, and inside them there is nothing left that cannot appear. Found by
  // review, twice.
  const url = encodeURIComponent(href);
  const dest = /[()]/u.test(url) ? `<${url}>` : url;
  return `[${code(text)}](${dest})`;
}

/**
 * Names joined as prose, which is one list in one place.
 *
 * `a`, `a and b`, `a, b and c` -- the serial comma left out, which is this
 * repository's own house style and is what the rest of its prose does.
 *
 * @param names - The names, already spelled.
 * @returns The list.
 */
function list(names: readonly string[]): string {
  if (names.length < 2) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
}

/**
 * A block of verbatim text, in a fence long enough to hold it.
 *
 * An example's text is the one string a page writes **verbatim**, and a fence of
 * exactly three backticks is one the content can close: an example whose text
 * held one broke out, after which the rest of the page was parsed as markdown.
 * Measured. The control characters go for the reason every other string's do --
 * a raw escape sequence in a committed file is a sequence waiting for something
 * to print it -- with the newline kept, because an example may legitimately be
 * more than one line and help prints one verbatim too.
 *
 * @param text - The verbatim text.
 * @returns The fenced lines.
 */
function fenced(text: string): string[] {
  const body = text.replaceAll(CONTROL, (c) => (c === '\n' ? c : ''));
  // ` {0,3}` because CommonMark lets a **closing** fence be indented up to three
  // spaces, so a run at column 0 is not the whole of what can close one: an
  // example holding `see\n   ```\ndone` closed the block at the indented run
  // and `done` came out as a paragraph of the page. Round 1 fixed the
  // unindented case and this is the other way a fence closes. Found by review
  const longest = Math.max(2, ...[...body.matchAll(/^ {0,3}(`+)/gmu)].map((m) => m[1]!.length));
  const fence = '`'.repeat(longest + 1);

  return [fence, body, fence];
}

/**
 * The file one command's page goes in.
 *
 * @param path - The argv path, empty for the root.
 * @returns The file name, relative and flat.
 */
function fileFor(path: readonly string[]): string {
  return path.length === 0 ? 'index.md' : `${path.join(JOIN)}.md`;
}

/**
 * The front matter, as YAML a `JSON.parse` can read a value out of.
 *
 * @param cmd - The command.
 * @param program - What the program is called.
 * @returns The lines, fences included.
 */
function frontMatter(cmd: SurfaceCommand, program: string): string[] {
  const title = [program, ...cmd.path].join(' ');
  const lines = [`title: ${scalar(title)}`, `path: ${scalar(cmd.path)}`];
  // `oneLine()` rather than `cell()`: the front matter is **data** a consumer
  // parses, so an escape written for a table column would reach it as a literal
  const desc = oneLine(cmd.desc);

  if (desc) {
    lines.push(`description: ${scalar(desc)}`);
  }

  return ['---', ...lines, '---'];
}

/**
 * One command's page, as its two halves.
 *
 * Two halves rather than one string, because the two layouts want different
 * amounts of it: a file carries the front matter and a concatenated document
 * must not, since a document holding several of them is one no site can read.
 * The first version returned the whole page and took the front matter back off
 * by matching the fences it had just written -- two readers of one shape, where
 * splitting it is one decision each.
 *
 * @param cmd - The command.
 * @param surface - The whole surface, for the program's name and the children.
 * @param link - How to point at another command, which is the one thing the two
 *   layouts answer differently.
 * @returns The front matter and the body, as lines.
 */
function page(
  cmd: SurfaceCommand,
  surface: CommandSurface,
  link: Link
): { body: string[]; matter: string[] } {
  const { program } = surface;
  const title = [program, ...cmd.path].join(' ');
  const here = key(cmd.path);

  // the direct children, which is derived rather than recorded: a command's
  // subcommands are the entries one segment longer whose path starts with this
  // one, so recording them on the command as well would be the same fact twice
  const children = surface.commands.filter(
    (it) =>
      !it.hidden && it.path.length === cmd.path.length + 1 && key(it.path.slice(0, -1)) === here
  );

  // every **ancestor** with a visible option, not only the root: options
  // resolve across the whole context chain, so a grandparent's option is
  // typable at a grandchild -- measured through a real `main()`,
  // `mycli db migrate --conn x` lands on `argv.conn` where `--conn` is `db`'s.
  // The first version read the root alone, so a nested page said `mycli db
  // migrate` on its usage line over a `--conn` the parse accepts. Root first,
  // which is the order help prints `Global options` in. Found by review
  const inherited = surface.commands
    .filter(
      (it) =>
        it.path.length < cmd.path.length &&
        key(it.path) === key(cmd.path.slice(0, it.path.length)) &&
        it.options.some((opt) => !opt.hidden)
    )
    .sort((a, b) => a.path.length - b.path.length);
  const options = cmd.options.filter((opt) => !opt.hidden);
  // `code()` rather than a hand-written pair of backticks, for the reason every
  // other code span here goes through it: a name holding one closes the span and
  // the rest of the heading is parsed as markdown. A program name is `schema.name`
  // and a path segment is a route name, so neither is this package's to trust
  // the **default child**, read off the whole surface rather than off `children`,
  // which is filtered to the visible ones: a hidden command may be the default,
  // and a parent whose default child is hidden still does something when argv
  // names no command. Only a visible one is linked, because a hidden command
  // has no page to point at
  const fallback = surface.commands.find(
    (it) =>
      it.default && it.path.length === cmd.path.length + 1 && key(it.path.slice(0, -1)) === here
  );

  const lines = [`# ${code(title)}`];

  if (cmd.desc) {
    // `paragraph()` rather than `cell()`: this is a paragraph, where a bar is an
    // ordinary character -- escaping it writes a backslash a reader sees -- and
    // where a leading `#` or `- ` opens a block, which `cell()` would not have
    // escaped either
    lines.push('', paragraph(cmd.desc));
  }

  lines.push(
    '',
    '## Usage',
    '',
    ...fenced(
      usage(
        program,
        cmd,
        children.length > 0,
        options.length > 0 || inherited.length > 0,
        fallback !== undefined
      )
    )
  );

  // `default` and `runnable` reach the page, because each is a thing a reader of
  // it needs, and they go **beside the usage line** because that is what each is
  // about: a bare invocation runs the default command, so the page describing
  // that command is the page that has to say so -- and a namespace lists its
  // children and does nothing of its own, which is otherwise indistinguishable
  // from a command whose usage line happens to take no arguments. Both were
  // recorded in the snapshot and printed nowhere, which is a field the reference
  // parses and does nothing with. Found by review
  if (cmd.default) {
    lines.push(
      '',
      // `code()`, which every other name on the page goes through: this
      // interpolated the invocation between one pair of backticks, so a program
      // called ``my`cli`` produced `` `my`cli` `` and the sentence rendered as a
      // code span of `my` followed by prose. Found by review
      // "named at <parent>" rather than "`mycli` on its own is this command",
      // which over-claimed: `dispatchDefaultCommand()` adopts a default and then
      // asks *that* command for a default of its own, so with a nested default
      // `mycli` on its own runs the **leaf** -- measured, root -> `build` ->
      // `fast` runs `fast` for `[]`, `['build']` and `['build', 'fast']` alike.
      // A command with required arguments is the same sentence one step shorter:
      // `mycli` alone then exits 1 with `Missing required arguments`. What is
      // true of every one of those is that this command is what the parent
      // dispatches, so that is what it says -- and the parent's own sentence,
      // which names this command, is where a reader following the chain goes
      // next. Found by review
      `Runs when no command is named at ${code([program, ...cmd.path.slice(0, -1)].join(' '))}.`
    );
  }

  if (fallback) {
    // which child a bare invocation runs, on the page that describes that
    // invocation. The first version said this on the *child's* page alone and
    // then told the parent it "takes no action of its own" -- on the page for
    // the invocation that dispatches the child, which is a page contradicting
    // itself. Found by review
    const named = fallback.hidden
      ? code([program, ...fallback.path].join(' '))
      : linked([program, ...fallback.path].join(' '), fallback.path, link);

    lines.push(
      '',
      `With no command named, ${named} runs, so its arguments and options are typable here.`
    );
  } else if (!cmd.runnable && children.length > 0) {
    lines.push('', 'Lists the commands under it and takes no action of its own.');
  }

  if (cmd.tokens.length > 1) {
    lines.push(
      '',
      '## Aliases',
      '',
      ...cmd.tokens
        .slice(1)
        .map((token) => `- ${code([program, ...cmd.path.slice(0, -1), token].join(' '))}`)
    );
  }

  if (cmd.args.length > 0) {
    lines.push(
      '',
      '## Arguments',
      '',
      ...table(
        ['Argument', 'Type', 'Description'],
        cmd.args.map((arg) => [
          code(argSpelling(arg)),
          typeCell(arg.type, arg.multiple),
          cell(arg.desc),
        ])
      )
    );
  }

  if (options.length > 0) {
    lines.push(
      '',
      '## Options',
      '',
      ...table(
        ['Option', 'Type', 'Description'],
        options.map((opt) => [code(optionSpelling(opt)), typeCell(opt.type, false), described(opt)])
      )
    );
  }

  // said once, as prose, rather than repeated into every command's table. Which
  // is why the surface records each option where it was declared: the
  // inheritance is a fact about the parser, not about any one command -- and it
  // names **each** ancestor that declares one, because a reader looking for
  // `--conn` has to know which page to open
  if (inherited.length > 0) {
    const names = inherited.map((it) => linked([program, ...it.path].join(' '), it.path, link));

    lines.push(
      '',
      `Every option ${list(names)} ${inherited.length === 1 ? 'declares' : 'declare'} resolves here too.`
    );
  }

  if (cmd.examples.length > 0) {
    lines.push('', '## Examples');
    for (const example of cmd.examples) {
      // the label is **omitted** where there is none or where it is blank after
      // `oneLine()`, rather than pushed as an empty paragraph: help prints an
      // example with no label at all, and a blank line in its place is the
      // thing the surface's old `typeof label === 'string'` filter was there to
      // avoid -- which it did by dropping the example instead. Found by review
      const said = paragraph(example.label);

      // `paragraph()` for the label, which is prose rather than a cell: the bars
      // a cell would escape are bars a reader wants to see, and a leading `#`
      // is a heading unless something escapes it
      lines.push('', ...(said ? [said, ''] : []), ...fenced(example.text));
    }
  }

  if (children.length > 0) {
    lines.push(
      '',
      '## Subcommands',
      '',
      ...table(
        ['Command', 'Description'],
        children.map((child) => [
          linked([program, ...child.path].join(' '), child.path, link),
          cell(child.desc),
        ])
      )
    );
  }

  return { body: lines, matter: frontMatter(cmd, program) };
}

/**
 * Every command that gets a page, with the file it goes in.
 *
 * A hidden command gets none, which is `hidden` taken at its word -- and it
 * takes its subtree with it, for the reason the catalog records: a listing that
 * named a hidden command's children would have named the branch anyway. The
 * *snapshot* records both, because a hidden command is still reachable.
 *
 * Two commands whose paths join to one file name is **refused**, because
 * writing two pages to one file silently loses one -- and a flat directory has
 * no separator a route name cannot contain, so this is reachable by a command
 * genuinely called `db-migrate` beside a `db migrate`.
 *
 * One function for both layouts, so that what a reference *contains* is decided
 * once: a document that held a command the pages left out, or the other way
 * round, would be two answers to one question.
 *
 * @param surface - The surface.
 * @returns The commands, in the surface's own order, with their file names.
 * @throws If two commands want the same file.
 */
function listed(surface: CommandSurface): { cmd: SurfaceCommand; file: string }[] {
  const hidden = new Set(surface.commands.filter((cmd) => cmd.hidden).map((cmd) => key(cmd.path)));

  const out: { cmd: SurfaceCommand; file: string }[] = [];
  const taken = new Map<string, readonly string[]>();

  for (const cmd of surface.commands) {
    // the ancestors as well as the command, because `hidden` on a parent is how
    // a whole branch is kept out of a listing
    if (cmd.path.some((_, at) => hidden.has(key(cmd.path.slice(0, at + 1))))) {
      continue;
    }

    const escapes = cmd.path.find(
      (segment) =>
        segment.includes('/') || segment.includes('\\') || segment === '.' || segment === '..'
    );

    // a path segment that is not a flat file name is **refused**, and this one
    // is not cosmetic: a command declared `'../evil'` wrote `evil.md` one
    // directory *above* the destination while the summary said it had written
    // into it, and `a/b` wrote a page into a subdirectory the website's own
    // reader never looks in. Neither could be seen again afterwards -- the stale
    // sweep reads the destination's top level, so `--check` agreed with a file
    // that was not there. Measured. Refused where the `-` collision already is,
    // because both are the same question: can this path be a file name
    if (escapes !== undefined) {
      throw new Error(
        `Cannot write a reference: the command "${cmd.path.join(' ')}" has a path segment ("${escapes}") that cannot be a file name, so its page would be written outside ${fileFor([])}'s directory. Rename it.`
      );
    }

    const file = fileFor(cmd.path);
    // keyed case-folded, because the destination's filesystem is not knowable
    // and the default one on macOS and Windows is case-insensitive: `DB` and
    // `db` are two keys and one file there, so the second write won and
    // `--check` then compared that one file twice and passed with a command's
    // page absent. Folded unconditionally rather than per platform, because a
    // committed reference is read on every platform
    const clash = taken.get(file.toLowerCase());

    if (clash) {
      throw new Error(
        `Cannot write a reference: "${clash.join(' ')}" and "${cmd.path.join(' ')}" both want ${file}. A page's file name joins the command path with "${JOIN}" and is matched without regard to case, so a command whose own name holds one -- or differs from a sibling's only in case -- collides; rename one of them.`
      );
    }

    taken.set(file.toLowerCase(), cmd.path);
    out.push({ cmd, file });
  }

  return out;
}

/**
 * A page per command, the index first.
 *
 * @param surface - The surface.
 * @returns The pages.
 * @throws If two commands want the same file.
 */
export function referencePages(surface: CommandSurface): ReferencePage[] {
  return listed(surface).map(({ cmd, file }) => {
    const { body, matter } = page(cmd, surface, fileFor);
    return { body: `${[...matter, '', ...body].join('\n')}\n`, file, path: cmd.path };
  });
}

/**
 * The whole reference as one document, which is what a pipe gets.
 *
 * Many pages is the answer for a destination and one document is the answer for
 * a pipe, which is the honest reading of "one file or many" rather than a
 * refusal to choose: a pipe has nowhere to put many. It is `completion`'s own
 * shape one feature along -- a script to stdout, and an install that writes
 * files.
 *
 * The bodies and no front matter, because a document holding several of them is
 * one no site can read. Separated by a rule, so that a reader scrolling one
 * document can see where a command ends.
 *
 * @param surface - The surface.
 * @returns The markdown, ending in exactly one newline.
 */
export function referenceDocument(surface: CommandSurface): string {
  const bodies = listed(surface).map(({ cmd }) =>
    page(cmd, surface, () => undefined).body.join('\n')
  );
  return `${bodies.join('\n\n---\n\n')}\n`;
}
