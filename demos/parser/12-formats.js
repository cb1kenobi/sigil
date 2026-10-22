/**
 * Output formats: the command returns data, a serializer presents it.
 *
 *   node demos/parser/12-formats.js          # every line below, in order
 *   node demos/parser/12-formats.js list
 *   node demos/parser/12-formats.js list --json
 *   node demos/parser/12-formats.js list --format csv
 *   node demos/parser/12-formats.js list --format yaml
 *   node demos/parser/12-formats.js list --format nope
 *   node demos/parser/12-formats.js report --json
 *   node demos/parser/12-formats.js boom --json
 *   node demos/parser/12-formats.js boom --format csv
 *   node demos/parser/12-formats.js boom --format yaml
 *   node demos/parser/12-formats.js watch --json
 *
 * What `run()` does not do is the point: nothing below computes two answers.
 * Every command here works out one value and returns it, and which presentation
 * reaches the terminal is the framework's -- so `list --json | jq .total` is
 * clean and `list` on a terminal is a table, out of one code path.
 *
 * The one thing the framework cannot decide is **where a command's own human
 * form goes**, because stdout belongs to the serializer once a format is
 * selected. `list` and `report` are the two honest answers to that, and the
 * comments on each say which. `watch` declares no `format` at all, so `--json`
 * is not one of its options -- which is what keeps the flag off a command with
 * no data to serialize. Typing it anyway is **swallowed** rather than refused,
 * because `allowUnknownOptions` is on by default; what the opt-in buys is that
 * the option is in no registry, so it is on no help screen and in no completion
 * script for a command that has nothing to present.
 *
 * Run it with no arguments and it walks every one, which is the one way to see
 * the design rather than read it: the same `run()` under each presentation, in
 * order, with the exit code printed where there is one. Several of those steps
 * write to **stderr** -- `report`'s own human form, and every failure's error,
 * rendered or serialized -- so on a terminal they arrive interleaved with the
 * headings, and piped they separate. That is the claim demonstrated by being run rather than asserted:
 * `report --json | jq .total` answers the row count with the table still on
 * screen.
 *
 * And one of the rows is named `charlie "big, loud"`, which is there to be
 * **escaped**: a space, a comma and a pair of double quotes is the one value
 * every format below has to say something different about. `json` escapes the
 * quotes and needs nothing written here, because that is what `JSON.stringify`
 * is; CSV wraps the field and doubles them; YAML quotes the scalar and
 * backslashes them. `boom --format csv` and `boom --format yaml` are the same
 * message through the same two rules, side by side -- which is the point a
 * serializer an app brings has to get right, and the naive interpolation gets
 * wrong in the direction that does not announce itself.
 */
import { main } from '@ttylabs/sigil';

/**
 * What `list` answers with, and what it draws. One value, several presentations.
 *
 * The third name holds a space, a comma and a pair of double quotes, which is
 * the one row worth having: every format below has to say something different
 * about it, and the naive version of each -- `${row.name},${row.size}` and
 * `- name: ${row.name}` -- turns it into a file that lies rather than one that
 * fails. `json` needs nothing, because escaping is what `JSON.stringify` is.
 */
const rows = [
  { name: 'alpha', size: 12 },
  { name: 'bravo', size: 7 },
  { name: 'charlie "big, loud"', size: 31 },
];

/**
 * A serializer is handed **both** of a run's two answers, which is the half an
 * app has to know and the half the first version of this demo got wrong: on the
 * failure path it gets `{ error: { message, name } }` rather than the shape the
 * command returns, so a serializer written only for the data silently produces
 * a header row with no rows under it and the error is simply gone. Which is
 * what `boom --format csv` did. So each of these says what it does with a
 * payload, and the shape is `SerializedError`.
 */
const isError = (value) => value !== null && typeof value === 'object' && 'error' in value;

/**
 * One CSV field, escaped the way RFC 4180 says.
 *
 * A field holding a comma, a quote or a line break is wrapped in quotes and its
 * own quotes are **doubled** -- which is worth a function rather than an
 * interpolation, because the interpolation is wrong in the direction that does
 * not announce itself: one field holding a comma becomes two columns, so a row
 * of three values parses as four and every consumer reads the wrong one. A
 * serializer an app brings is the app's to get right, which is the half of
 * "`yaml`, `xml`, `csv` and `tsv` are an app's to bring" that a demo can show.
 */
const csvCell = (text) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/** A serializer an app brings, which is the division: `json` ships, this does not. */
const toCsv = (value) =>
  isError(value)
    ? // the error goes through the same escaping, because a message is a field
      // too -- and `JSON.stringify`, which this used, is the *other* grammar:
      // it writes `\"` where CSV wants `""`
      `error\n${csvCell(value.error.message)}`
    : ['name,size', ...(value.rows ?? []).map((row) => `${csvCell(row.name)},${row.size}`)].join(
        '\n'
      );

/**
 * One YAML scalar, always double-quoted.
 *
 * Always, rather than only where it is needed: a plain scalar is the one that
 * needs the long rule -- a leading `- `, `?`, `#` or quote, a `: ` anywhere in
 * it, a trailing space, something that would read back as a number or as `true`
 * -- so quoting unconditionally is the short answer that is always right, where
 * quoting conditionally is a rule to get wrong. Inside quotes a backslash and a
 * quote are escaped, which is where the third row shows up as `\"`.
 */
const yamlScalar = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** And one more, to show that `--format` takes a name rather than only JSON. */
const toYaml = (value) =>
  isError(value)
    ? `error:\n  message: ${yamlScalar(value.error.message)}`
    : (value.rows ?? [])
        .map((row) => `- name: ${yamlScalar(row.name)}\n  size: ${row.size}`)
        .join('\n');

/**
 * The human form, which both commands below draw the same way.
 *
 * The column is measured rather than a constant, because the third name is
 * wider than the `padEnd(8)` this had -- a table whose own width is a guess is
 * the thing `table()` in `@ttylabs/sigil/components` exists to not be, and this
 * is the hand-rolled version a demo can read in one line.
 */
const column = Math.max(...rows.map((row) => row.name.length)) + 2;
const table = () => rows.map((row) => `${row.name.padEnd(column)}${row.size}`).join('\n');

const schema = {
  name: 'formats',

  // `json` is built in and needs no entry here. These two are the app's, which
  // is what keeps the runtime at zero dependencies: an app that wants YAML
  // brings the YAML library it chose.
  formats: { csv: toCsv, yaml: toYaml },

  completion: false,
  commands: {
    list: {
      desc: 'List things, drawing to stdout where nothing asked for data',

      // the opt-in. `true` is every format this app provides; a list would be
      // only those names.
      format: true,

      run({ format }) {
        // the one line, and it is worth being exact about why it is not the
        // `if (json) … else …` this design exists to delete. That one computes
        // **two answers** and lets them drift. This asks whether to *present*
        // the one answer below it, which is the same question a spinner asks
        // `resolveOutput()` -- and it is here rather than in the framework
        // because this write is the command's own: `main()` could only
        // suppress it by patching `process.stdout.write`, which a spawned
        // child writing to the inherited fd would walk straight past
        if (format === undefined) {
          process.stdout.write(`${table()}\n`);
        }

        // computed once, whatever was asked for
        return { rows, total: rows.length };
      },
    },

    report: {
      desc: 'The same thing with no conditional, by drawing to stderr',
      format: true,

      run() {
        // the other answer: the human form goes to stderr, so both can be on
        // screen at once and a pipe still gets clean data. Which is the split
        // `sigil check` already makes -- its diagnostics and its summary are
        // on stderr precisely so that `--tree` can own stdout
        process.stderr.write(`${table()}\n`);

        return { rows, total: rows.length };
      },
    },

    boom: {
      desc: 'Fail, so the error can be read as data too',
      format: true,

      run() {
        // a script that gets JSON on success and a rendered message on failure
        // cannot be scripted against, so the error leaves through the same
        // selection: `{ "error": { "message", "name" } }`, on stderr, with the
        // exit code still carrying the verdict. Which is why `isError()` is up
        // at the top: a serializer this app wrote is handed that payload too,
        // and one written only for the data loses the error without saying so
        throw new TypeError('nothing to list, "alpha" is gone');
      },
    },

    watch: {
      desc: 'Declare no format, so --json is not an option here',
      run: () => process.stdout.write('watching (nothing to serialize)\n'),
    },
  },
};

/** What a bare run walks, and why each one is worth seeing. */
const tour = [
  [['list'], 'the human form, because nothing asked for data'],
  [['list', '--json'], 'the same value serialized, out of the same one code path'],
  [['list', '--format', 'csv'], 'a serializer this app brought, rather than one we ship'],
  [['list', '--format', 'yaml'], '--format takes a name, so `json` is not the only answer'],
  [['list', '--format', 'nope'], 'an unknown name names what the command does accept'],
  [['report', '--json'], 'the human form on stderr, so both can be on screen at once'],
  [['boom', '--json'], 'a failure leaves through the same selection, as data'],
  [['boom', '--format', 'csv'], "and through the app's own serializer too, which is why it checks"],
  [
    ['boom', '--format', 'yaml'],
    'the same message, escaped the other way -- escaping is per format',
  ],
  [['watch', '--json'], 'no `format` declared, so `--json` is swallowed and nothing serializes'],
];

// your own arguments win, which is every parser demo's rule; with none, walk the
// lot rather than doing one thing -- `list` alone is a table, and a table is the
// one presentation here that shows none of the design
if (process.argv.length > 2) {
  await main({ schema });
} else {
  for (const [argv, why] of tour) {
    console.log(`\n--- formats ${argv.join(' ')}\n    ${why}`);
    await main({ argv, schema });

    // `boom` and an unknown format each set one, and the exit code carrying the
    // verdict is half of what makes a serialized error scriptable -- so it is
    // printed where there is one and cleared, because the tour itself completed
    if (process.exitCode) {
      console.log(`    (exit code ${process.exitCode})`);
      process.exitCode = 0;
    }
  }
}
