/**
 * Output formats: the command returns data, a serializer presents it.
 *
 *   node demos/parser/12-formats.js list
 *   node demos/parser/12-formats.js list --json
 *   node demos/parser/12-formats.js list --format csv
 *   node demos/parser/12-formats.js list --format yaml
 *   node demos/parser/12-formats.js list --format nope
 *   node demos/parser/12-formats.js report --json
 *   node demos/parser/12-formats.js boom --json
 *   node demos/parser/12-formats.js boom --format csv
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
 * no data to serialize.
 */
import { main } from '@ttylabs/sigil';

/** What `list` answers with, and what it draws. One value, two presentations. */
const rows = [
  { name: 'alpha', size: 12 },
  { name: 'bravo', size: 7 },
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

/** A serializer an app brings, which is the division: `json` ships, this does not. */
const toCsv = (value) =>
  isError(value)
    ? `error\n${JSON.stringify(value.error.message)}`
    : ['name,size', ...(value.rows ?? []).map((row) => `${row.name},${row.size}`)].join('\n');

/** And one more, to show that `--format` takes a name rather than only JSON. */
const toYaml = (value) =>
  isError(value)
    ? `error:\n  message: ${value.error.message}`
    : (value.rows ?? []).map((row) => `- name: ${row.name}\n  size: ${row.size}`).join('\n');

/** The human form, which both commands below draw the same way. */
const table = () => rows.map((row) => `${row.name.padEnd(8)}${row.size}`).join('\n');

await main({
  argv: process.argv.length > 2 ? undefined : ['list'],
  schema: {
    name: 'formats',

    // `json` is built in and needs no entry here. These two are the app's, which
    // is what keeps the runtime at zero dependencies: an app that wants YAML
    // brings the YAML library it chose.
    formats: { csv: toCsv, yaml: toYaml },

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
          throw new TypeError('nothing to list');
        },
      },

      watch: {
        desc: 'Declare no format, so --json is not an option here',
        run: () => process.stdout.write('watching (nothing to serialize)\n'),
      },
    },
  },
});
