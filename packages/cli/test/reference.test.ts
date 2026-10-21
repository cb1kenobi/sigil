import { displayPath } from '../src/build/diagnostic.ts';
import { CONFIG_SCHEMA, readSigilConfig } from '../src/config.ts';
import { loadAppSchema } from '../src/reference/load.ts';
import { referenceDocument, referencePages } from '../src/reference/markdown.ts';
import { snapshotJson, snapshotOf } from '../src/reference/snapshot.ts';
import { syncReference } from '../src/reference/write.ts';
import type { CommandExample, Schema } from '@ttylabs/sigil';
import { commandSurface, type CommandSurface, type SurfaceCommand } from '@ttylabs/sigil/reference';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A temp directory of its own, removed afterwards. */
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-reference-'));
  temps.push(dir);
  return dir;
}

/** The surface for an app. */
async function surface(schema: Schema): Promise<CommandSurface> {
  return await commandSurface({ name: 'mycli', ...schema });
}

/** One page's body out of a reference, by its file. */
function pageFor(pages: { body: string; file: string }[], file: string): string {
  const found = pages.find((it) => it.file === file);

  if (!found) {
    throw new Error(`No ${file}: ${JSON.stringify(pages.map((it) => it.file))}`);
  }
  return found.body;
}

/** The lines of a markdown table that starts at a heading. */
function tableUnder(body: string, heading: string): string[] {
  const lines = body.split('\n');
  const at = lines.indexOf(heading);

  if (at === -1) {
    throw new Error(`No "${heading}" in:\n${body}`);
  }
  // the **contiguous** run rather than every bar-leading line to the end of the
  // file, which is what this was: a count assertion over `## Arguments` then
  // picked up the `## Options` rows as well, and a column assertion read two
  // tables as one. Found by writing the count half of the test below
  const rows = lines.slice(at).filter((line, index, all) => {
    const from = all.findIndex((it) => it.startsWith('|'));
    return index >= from && all.slice(from, index + 1).every((it) => it.startsWith('|'));
  });

  return rows;
}

/**
 * How many columns a table row has.
 *
 * Split on the bars that are **not** escaped, which is the whole point: a
 * choices list joined with `|` is what broke a row, and a counter that split on
 * every bar would agree with the bug.
 *
 * @param row - The row.
 * @returns The cells between the outer bars.
 */
function columns(row: string): number {
  return row.replaceAll('\\|', '').split('|').length - 2;
}

describe('the markdown reference', () => {
  it('should write a page per command, the index first', async () => {
    const pages = referencePages(
      await surface({ commands: { db: { commands: { migrate: { run() {} } } } } })
    );

    expect(pages.map((it) => it.file)).toStrictEqual(['index.md', 'db.md', 'db-migrate.md']);
  });

  it('should carry front matter whose every value is JSON', async () => {
    // JSON is a subset of YAML, so this parses as YAML for a site that wants
    // one *and* is readable with `JSON.parse` by a site that would rather not
    // take a dependency to read three keys -- which is what the website does
    const body = pageFor(
      referencePages(await surface({ commands: { go: { desc: 'Go: somewhere', run() {} } } })),
      'go.md'
    );
    const matter = body.slice(4, body.indexOf('\n---\n', 3));
    const keys: Record<string, unknown> = {};

    for (const line of matter.split('\n')) {
      const at = line.indexOf(':');
      keys[line.slice(0, at)] = JSON.parse(line.slice(at + 1).trim());
    }

    // the colon in the description is what makes this a real claim rather than
    // a shape: a hand-rolled `key: value` front matter would have split on it
    expect(keys).toStrictEqual({ description: 'Go: somewhere', path: ['go'], title: 'mycli go' });
  });

  it('should give every table row the columns its header has', async () => {
    // the bug this is named for: a table row is split on its bars *before*
    // anything inside it is parsed, so a code span is no shelter and
    // `--lint [a|b|c]` added three columns to its own row and shifted every
    // cell after it. Found by reading a generated page
    // the header, the rule, and one row per declaration -- `go` has one
    // argument, two options and no children, and the root lists `go`
    const expected: Record<string, number> = {
      '## Arguments': 3,
      '## Options': 4,
      '## Subcommands': 3,
    };

    const pages = referencePages(
      await surface({
        commands: {
          go: {
            // a newline **and** a bar in one description, which is the pair the
            // two halves of this test are each about
            args: [{ choices: ['one', 'two'], desc: 'Which\none | two', name: '[which]' }],
            options: {
              '--lint [lint]': { choices: ['oxlint', 'eslint', 'biome'] },
              '--sep [s]': { desc: 'A | B | C' },
            },
            run() {},
          },
        },
      })
    );

    for (const { body, file } of pages) {
      for (const heading of ['## Arguments', '## Options', '## Subcommands']) {
        if (!body.includes(heading)) {
          continue;
        }

        const rows = tableUnder(body, heading);
        const head = columns(rows[0] as string);

        expect(head, `${file} ${heading}`).toBeGreaterThan(1);
        for (const row of rows) {
          expect(columns(row), `${file} ${heading}: ${row}`).toBe(head);
        }

        // and the **count**, because the column check alone cannot see the other
        // way a cell breaks a table: a newline in one ends the row, leaving a
        // first line with the right number of columns and a continuation line
        // `tableUnder()` filters out for not starting with a bar. So a row that
        // was torn in half passed the test written for the bar bug. Found by
        // review
        expect(rows.length, `${file} ${heading}`).toBe(expected[heading] as number);
      }
    }
  });

  it('should keep a bar out of a choices placeholder, having escaped it', async () => {
    const body = pageFor(
      referencePages(
        await surface({
          commands: { go: { options: { '--lint [l]': { choices: ['a', 'b'] } }, run() {} } },
        })
      ),
      'go.md'
    );

    // escaped and still legible: `\|` is what GFM specifies for a literal bar
    // in a cell, honoured inside a code span too
    expect(body).toContain('`--lint [a\\|b]`');
  });

  it('should drop a control character from a description rather than printing it', async () => {
    const body = pageFor(
      referencePages(
        await surface({
          commands: { go: { desc: `A${String.fromCharCode(0x1b)}[31m red one`, run() {} } },
        })
      ),
      'go.md'
    );

    // a raw escape sequence in a committed file is a sequence waiting for
    // something to print it, which is this repository's standing rule.
    //
    // `\t`, `\n` and `\r` are excused, which is the same three `tsdown.config.ts`
    // excuses for the same reason -- they are the file's own formatting, and a
    // markdown page is nothing but newlines. The first version of this asserted
    // `\p{Cc}` flat and failed on them, which is the assertion being wrong rather
    // than the code
    expect(body.replaceAll(/[\t\n\r]/gu, '')).not.toMatch(/\p{Cc}/u);
    expect(body).toContain('A[31m red one');
  });

  it('should flatten a multi-line description into its cell', async () => {
    const body = pageFor(
      referencePages(
        await surface({
          commands: { go: { options: { '--x': { desc: 'One\ntwo', type: 'bool' } }, run() {} } },
        })
      ),
      'go.md'
    );

    expect(body).toContain('| One two |');
  });

  it('should leave a hidden command and its subtree out', async () => {
    const pages = referencePages(
      await surface({
        commands: {
          seen: { run() {} },
          unseen: { commands: { under: { run() {} } }, hidden: true },
        },
      })
    );

    // `hidden` means "not listed" and a reference is a listing -- and it takes
    // its subtree with it, because a listing that named a hidden command's
    // children would have named the branch anyway
    expect(pages.map((it) => it.file)).toStrictEqual(['index.md', 'seen.md']);
    expect(pageFor(pages, 'index.md')).not.toContain('unseen');
  });

  it('should leave a hidden option out of the table and out of the usage line', async () => {
    const body = pageFor(
      referencePages(
        await surface({
          commands: { go: { options: { '--secret': { hidden: true, type: 'bool' } }, run() {} } },
        })
      ),
      'go.md'
    );

    expect(body).not.toContain('--secret');
    // and `[options]` goes with it: a usage line that names a placeholder for
    // nothing is a usage line that lies
    expect(body).toContain('mycli go\n```');
  });

  it('should print only the spelling a negated flag is described by', async () => {
    const it = await surface({
      commands: { build: { options: { '--no-clean': { desc: 'Keep it' } }, run() {} } },
    });
    const body = pageFor(referencePages(it), 'build.md');

    // help leaves the positive spelling off the row, because printing both reads
    // as two options that mean opposite things while the description describes
    // one of them -- and a reference is a listing, so it follows
    expect(body).toContain('`--no-clean`');
    expect(body).not.toContain('--clean`');
    // and the *snapshot* keeps both, because both resolve: this is the one pair
    // where the two readers deliberately disagree
    expect(JSON.stringify(snapshotOf(it))).toContain('"--clean"');
  });

  it('should refuse two commands that want one file', async () => {
    // a flat directory has no separator a route name cannot contain, so this is
    // reachable by a command genuinely called `db-migrate` beside a `db migrate`
    const it = await surface({
      commands: {
        db: { commands: { migrate: { run() {} } } },
        'db-migrate': { run() {} },
      },
    });

    expect(() => referencePages(it)).toThrow(/both want db-migrate\.md/u);
  });

  it('should refuse a command whose path cannot be a file name', async () => {
    // the severe one: a page's file is the path joined flat, so a segment
    // holding a separator -- or spelled `..` -- wrote **outside** the
    // destination while the summary said it had written into it. Measured: a
    // command declared `'../evil'` put `evil.md` one directory above `--out`,
    // and `a/b` wrote into a subdirectory the website's own reader never looks
    // in. Neither could be seen again either, because the stale sweep reads the
    // destination's top level -- so `--check` agreed with a file that was not
    // there. Found by review
    for (const name of ['../evil', 'a/b', '.', '..']) {
      const it = await surface({ commands: { [name]: { run() {} } } });

      expect(() => referencePages(it), name).toThrow(/cannot be a file name/u);
    }
  });

  it('should refuse two commands whose files differ only in case', async () => {
    // the destination's filesystem is not knowable and the default one on macOS
    // and Windows is case-insensitive, so `DB` and `db` are two keys and one
    // file there: the second write won and `--check` then compared that one
    // file twice and passed with a command's page absent. Folded
    // unconditionally rather than per platform, because a committed reference
    // is read on every platform. Found by review
    const it = await surface({ commands: { DB: { run() {} }, db: { run() {} } } });

    expect(() => referencePages(it)).toThrow(/both want/u);

    // and a pair neither of which is uniformly the upper one, which is the
    // input the *lookup* fold is load bearing for: the walk is sorted by code
    // unit, so for `DB`/`db` the uppercase always arrives first and a folded
    // `set` alone catches it. `Ab` sorts before `aB`, so with the `get`
    // unfolded the second missed and both pages were written -- to one file, on
    // the filesystem this is about
    const mixed = await surface({ commands: { Ab: { run() {} }, aB: { run() {} } } });

    expect(() => referencePages(mixed)).toThrow(/both want/u);
  });

  it('should read a space in a declared name as the separator it is', async () => {
    // which is what makes a page's flat file name unambiguous, and it is the
    // premise two other decisions here rest on: `key()` joins a path with NUL
    // and `linked()` does not angle-bracket for a space, both because a path
    // segment cannot hold one. `initCommand()`'s label rule reads whitespace as
    // the separator between a name and its aliases, so `'go x'` is a command
    // named `go` aliased `x`. A review round reported the opposite as measured
    // -- the symptom reproduces and the cause is a registry collision, which is
    // the parser's and predates this
    const it = await surface({ commands: { 'go x': { run() {} } } });

    expect(it.commands.map((cmd) => cmd.path)).toStrictEqual([[], ['go']]);
    expect(referencePages(it).map((page) => page.file)).toStrictEqual(['index.md', 'go.md']);
  });

  it('should pad a code span whose content ends in a backtick', async () => {
    // CommonMark's other half: a span whose content starts or ends with a
    // backtick needs a space inside the delimiters, or the run and the content
    // run together and the span ends somewhere else. Found by review
    const body = pageFor(
      referencePages(await surface({ commands: { 'x`': { run() {} } } })),
      'x`.md'
    );

    expect(body).toContain('# `` mycli x` ``');
  });

  it('should not let a description open a markdown block', async () => {
    // a `desc` is spliced in as its own paragraph, so whatever it starts with
    // is at the start of a line after a blank one -- which is where every block
    // opener in CommonMark lives. Measured through `react-markdown` and
    // `remark-gfm`: `# of files to keep` rendered as an `<h1>` where the escape
    // renders it as a paragraph, and `- a label` as a list. This module's own
    // claim is that every string a declaration owns is escaped on the way out,
    // and these two were not. Found by review
    const body = pageFor(
      referencePages(
        await surface({
          commands: {
            go: {
              desc: '# of files to keep',
              examples: { label: '- a label', text: 'mycli go' },
              run() {},
            },
          },
        })
      ),
      'go.md'
    );

    expect(body).toContain('\n\\# of files to keep\n');
    expect(body).toContain('\n\\- a label\n');

    // and an ordered list's marker, where the **punctuation** is what is
    // escaped: `\\1` is not an escape in CommonMark and renders as a backslash
    const ordered = pageFor(
      referencePages(await surface({ commands: { go: { desc: '1. first', run() {} } } })),
      'go.md'
    );

    expect(ordered).toContain('\n1\\. first\n');

    // and an HTML block, which is the worst of the openers rather than one more
    // of them: CommonMark's type 1 and type 2 blocks -- `<pre`, `<script`,
    // `<style`, `<textarea`, `<!--` -- do **not** end at a blank line, so a
    // description beginning with one swallowed every later line of the page.
    // Measured: `## Usage` became literal text with the usage fence and the
    // examples inside one raw HTML run. Found by review
    for (const open of ['<pre>keep this', '<script>alert(1)', '<!-- hidden']) {
      const page = pageFor(
        referencePages(await surface({ commands: { go: { desc: open, run() {} } } })),
        'go.md'
      );

      expect(page, open).toContain(`\n\\${open}\n`);
      // the rest of the page is still the page
      expect(page, open).toContain('\n## Usage\n');
    }
  });

  it('should fence an example past a fence of its own that is indented', async () => {
    // CommonMark lets a **closing** fence be indented up to three spaces, so a
    // run at column 0 is not the whole of what can close one: measured, an
    // example holding `see\n   ```\ndone` closed the block at the indented run
    // and `done` came out as a paragraph of the page. Round 1 fixed the
    // unindented case. Found by review
    const body = pageFor(
      referencePages(
        await surface({
          commands: {
            go: { examples: { label: 'Indented', text: 'see\n   ```\ndone' }, run() {} },
          },
        })
      ),
      'go.md'
    );

    expect(body).toContain('````\nsee\n   ```\ndone\n````');
  });

  it('should encode a link destination as a URL rather than as a file name', async () => {
    // `#` and `?` are each a different wrong answer rather than a broken one:
    // `](go#x.md)` is a link to `go` with a fragment of `x.md` and `](go?x.md)`
    // one with a query, which is what `react-markdown` really produced.
    // Measured, both characters survive into a command name. Found by review
    const index = pageFor(
      referencePages(await surface({ commands: { 'go#x': { run() {} }, 'go?x': { run() {} } } })),
      'index.md'
    );

    expect(index).toContain('](go%23x.md)');
    expect(index).toContain('](go%3Fx.md)');
  });

  it('should angle-bracket a link whose file name a bare destination cannot hold', async () => {
    // measured: `(`, `)`, `<`, `>` and a backtick all survive into a command
    // name, so a page's file name can hold one -- and GFM requires a paren in a
    // bare destination to be balanced, so `](go(x.md)` ends the link one
    // character early. Found by review
    const index = pageFor(
      referencePages(await surface({ commands: { 'go(x': { run() {} } } })),
      'index.md'
    );

    expect(index).toContain('](<go(x.md>)');
  });

  it('should encode rather than strip what an angle-bracketed link cannot hold', async () => {
    // the one pair an angle-bracketed destination cannot hold either. The first
    // version **stripped** them, so `go<x.md` came out as a link to `gox.md` --
    // a page that is not there, which is a wrong value where a broken link is
    // merely broken. Found by review
    const index = pageFor(
      referencePages(await surface({ commands: { 'go<x': { run() {} } } })),
      'index.md'
    );

    expect(index).toContain('](go%3Cx.md)');
    expect(index).not.toContain('gox.md');
  });

  it('should fence an example that holds a fence of its own', async () => {
    // an example's text is the one string a page writes verbatim, and a fence
    // of exactly three backticks is one the content can close -- after which
    // the rest of the page was parsed as markdown. Found by review
    const body = pageFor(
      referencePages(
        await surface({
          commands: {
            go: { examples: { label: 'Nested', text: '```sh\nmycli go\n```' }, run() {} },
          },
        })
      ),
      'go.md'
    );

    // four backticks, which is one more than the longest run inside it
    expect(body).toContain('````\n```sh');
    expect(body).toContain('```\n````');
  });

  it('should keep a backtick in a name inside its own code span', async () => {
    // a command genuinely called ``tick`x`` -- a routed file by that name --
    // came out as a code span ending at its own content, which left the rest of
    // the heading parsed as markdown. CommonMark's rule is a delimiter longer
    // than the longest run in the content, padded where it starts or ends with
    // one. Found by review
    const body = pageFor(
      referencePages(await surface({ commands: { 'tick`x': { run() {} } } })),
      'tick`x.md'
    );

    expect(body).toContain('# ``mycli tick`x``');
  });

  it('should name a subcommand as a link on a page and as code in a document', async () => {
    const it = await surface({ commands: { go: { run() {} } } });

    expect(pageFor(referencePages(it), 'index.md')).toContain('[`mycli go`](go.md)');
    // a document has no files to point at, and an anchor is renderer-specific:
    // a subtly wrong link goes nowhere, which is worse than a name that was
    // never a link
    expect(referenceDocument(it)).toContain('| `mycli go` |');
    expect(referenceDocument(it)).not.toContain('](go.md)');
  });

  it('should hold no front matter in the one-document form', async () => {
    const doc = referenceDocument(await surface({ commands: { go: { run() {} } } }));

    // a document holding several front matters is one no site can read
    expect(doc.startsWith('# ')).toBe(true);
    expect(doc).not.toContain('title: "mycli go"');
    expect(doc).toContain('\n---\n\n# `mycli go`');
  });

  it('should list a command in the document exactly where the pages do', async () => {
    // one function decides what a reference contains, so a document that held a
    // command the pages left out would be two answers to one question
    const it = await surface({
      commands: { seen: { run() {} }, unseen: { hidden: true, run() {} } },
    });

    expect(referenceDocument(it)).not.toContain('unseen');
    expect(referenceDocument(it).match(/^# /gmu)).toHaveLength(referencePages(it).length);
  });

  it('should say once that a root option resolves under a command', async () => {
    const it = await surface({
      commands: { go: { run() {} } },
      options: { '--far': { type: 'bool' } },
    });

    const body = pageFor(referencePages(it), 'go.md');

    expect(body).toContain('resolves here too');
    // and the **usage line** says so too, which is the half that was wrong: it
    // read the command's own options alone, so a page said `mycli go` on the
    // usage line and "every option `mycli` declares resolves here too" four
    // lines below it. Two sentences on one page disagreeing. Found by review
    expect(body).toContain('mycli go [options]');

    // and not where there is nothing to inherit, because a sentence about
    // nothing is a sentence a reader has to check
    const bare = await surface({ commands: { go: { run() {} } } });
    const plain = pageFor(referencePages(bare), 'go.md');

    expect(plain).not.toContain('resolves here too');
    expect(plain).not.toContain('[options]');
  });

  it('should name every ancestor an option is inherited from, not only the root', async () => {
    // options resolve across the whole context chain, so a grandparent's
    // option is typable at a grandchild -- measured through a real `main()`,
    // `mycli db migrate --conn x` lands on `argv.conn` where `--conn` is
    // `db`'s. The first version read the root alone, so a nested page said
    // `mycli db migrate` on its usage line over a `--conn` the parse accepts,
    // and nothing on the page pointed at `db`. Found by review
    const it = await surface({
      commands: { db: { commands: { migrate: { run() {} } }, options: { '--conn [url]': {} } } },
      options: { '--far': { type: 'bool' } },
    });
    const body = pageFor(referencePages(it), 'db-migrate.md');

    expect(body).toContain('mycli db migrate [options]');
    // both of them, root first, which is the order help prints its own
    // `Global options` in
    expect(body).toContain(
      'Every option [`mycli`](index.md) and [`mycli db`](db.md) declare resolves here too'
    );

    // and one ancestor reads as one, rather than as a list of one
    const one = await surface({
      commands: { db: { commands: { migrate: { run() {} } }, options: { '--conn [url]': {} } } },
    });

    expect(pageFor(referencePages(one), 'db-migrate.md')).toContain(
      'Every option [`mycli db`](db.md) declares resolves here too'
    );
  });

  it('should say on the page which command a bare invocation runs', async () => {
    // both fields were recorded in the snapshot and printed nowhere, which is a
    // field the reference parses and does nothing with -- and each is a thing a
    // reader of the page needs: `mycli <entry>` runs `build`, and a namespace
    // lists its children and does nothing of its own, which is otherwise
    // indistinguishable from a command taking no arguments. Found by review
    const it = await surface({
      commands: {
        build: { args: ['<entry>'], default: true, run() {} },
        db: { commands: { up: { run() {} } } },
      },
    });
    const pages = referencePages(it);

    expect(pageFor(pages, 'build.md')).toContain('Runs when no command is named at `mycli`.');
    expect(pageFor(pages, 'db.md')).toContain('takes no action of its own');
    // and an ordinary command says neither
    expect(pageFor(pages, 'db-up.md')).not.toContain('no command is named');
    expect(pageFor(pages, 'db-up.md')).not.toContain('no action of its own');

    // and the **parent** says which child a bare invocation runs, on the page
    // that describes that invocation: the first version said this on the
    // child's page alone and then told the index it "takes no action of its
    // own" -- a page contradicting itself about the one thing it is for. Found
    // by review
    const index = pageFor(pages, 'index.md');

    expect(index).toContain(
      'With no command named, [`mycli build`](build.md) runs, so its arguments and options are typable here.'
    );
    expect(index).not.toContain('takes no action of its own');
  });

  it('should spell the command slot optional where a default child exists', async () => {
    // `[command]` rather than `<command>`, which is what `usageLine()` already
    // prints and what the parse does: a command token is not required when
    // something runs without one. Measured, the page said `<command>` where
    // help said `[command]` over the same schema, and bare `mycli` exits 0.
    // Found by review
    const withDefault = await surface({ commands: { build: { default: true, run() {} } } });
    const without = await surface({ commands: { build: { run() {} } } });

    expect(pageFor(referencePages(withDefault), 'index.md')).toContain('mycli [command]');
    expect(pageFor(referencePages(without), 'index.md')).toContain('mycli <command>');
  });

  it('should not claim a bare invocation is a command its own default supersedes', async () => {
    // `dispatchDefaultCommand()` adopts a default and then asks *that* command
    // for a default of its own, so with a nested default `mycli` on its own runs
    // the **leaf**: measured through `main()`, root -> `build` -> `fast` runs
    // `fast` for `[]`, `['build']` and `['build', 'fast']` alike. The sentence
    // said "`mycli` on its own is this command" on `build.md`, which is false of
    // exactly that schema -- and a default command with a required argument is
    // the same over-claim one step shorter, since `mycli` alone exits 1 there.
    // What is true of all three is which parent dispatches it. Found by review
    const it = await surface({
      commands: {
        build: { commands: { fast: { default: true, run() {} } }, default: true, run() {} },
      },
    });
    const pages = referencePages(it);

    expect(pageFor(pages, 'build.md')).toContain('Runs when no command is named at `mycli`.');
    expect(pageFor(pages, 'build-fast.md')).toContain(
      'Runs when no command is named at `mycli build`.'
    );
    for (const file of ['build.md', 'build-fast.md']) {
      expect(pageFor(pages, file), file).not.toContain('on its own is this command');
    }
  });

  it('should print an option\u2019s default and say it may be repeated', async () => {
    // help prints both beside the description and the page printed neither, so
    // the artifact that is *for reading* said less than `--help` about the same
    // declaration. The snapshot drops both, deliberately. Found by review
    const body = pageFor(
      referencePages(
        await surface({
          commands: {
            go: {
              options: {
                '--external [pkg]': { desc: 'A package', multiple: true },
                '--out [dir]': { default: 'dist', desc: 'Where it goes' },
              },
              run() {},
            },
          },
        })
      ),
      'go.md'
    );

    expect(body).toContain('| `--external [pkg]` | `string` | A package (may be repeated) |');
    expect(body).toContain('| `--out [dir]` | `string` | Where it goes (default: dist) |');
    // and **no** `...`, on the hint or on the type: an option takes one value
    // per use, so `[pkg...]` is the spelling of an argument that consumes the
    // rest -- measured, `--external a b` is `{ external: ['a'], dir: 'b' }`.
    // Help prints `[pkg]` and the type the parser has is `string`
    expect(body).not.toContain('pkg...');
    expect(body).not.toContain('string...');
    // while an argument keeps it, because there it is the `...` in the name
    const variadic = pageFor(
      referencePages(await surface({ commands: { go: { args: ['[files...]'], run() {} } } })),
      'go.md'
    );

    expect(variadic).toContain('`[files...]`');
  });

  it('should keep an example help would print, and omit a label it would not', async () => {
    // help's `exampleList()` keeps any entry with a truthy `text` and prints the
    // label only where there is one, and requiring a `label` too dropped the
    // example from the reference -- which is the one place a reference may not
    // say less than help about what it was given. Measured: `go --help` printed
    // `mycli go --now` and `go.md` had no Examples section at all. Found by
    // review
    const body = pageFor(
      referencePages(
        await surface({
          commands: {
            go: {
              // `CommandExample.label` is **required** in the declaration type,
              // so this shape is reachable from JavaScript rather than from
              // TypeScript -- which is why the cast is here rather than the
              // type being widened: that is a change to `Command`'s own public
              // types, and what is being fixed is that help tolerates the shape
              // and the reference did not
              examples: [
                { text: 'mycli go --now' },
                { label: '  ', text: 'mycli go --later' },
              ] as unknown as CommandExample[],
              run() {},
            },
          },
        })
      ),
      'go.md'
    );

    expect(body).toContain('## Examples');
    expect(body).toContain('mycli go --now');
    // and no empty paragraph where a blank label was, which is the thing the
    // filter was there to avoid and achieved by dropping the example instead
    expect(body).not.toMatch(/\n\n\n\n/u);
  });

  it('should name a hidden default child, which has no page to link to', async () => {
    // the default child is read off the **whole** surface rather than off the
    // visible children: a hidden command may be the default, and a parent whose
    // default child is hidden still does something when argv names no command.
    // Read off `children` the parent instead said it "takes no action of its
    // own", which is false of exactly that invocation -- and the name is spelled
    // as code rather than linked, because a hidden command gets no page. Found
    // by review
    const it = await surface({
      commands: {
        build: { default: true, hidden: true, run() {} },
        db: { commands: { up: { run() {} } } },
      },
    });
    const index = pageFor(referencePages(it), 'index.md');

    expect(index).toContain('With no command named, `mycli build` runs');
    expect(index).not.toContain('](build.md)');
    expect(index).not.toContain('takes no action of its own');
  });

  it('should spell the default sentence\u2019s invocation through a code span', async () => {
    // every other name on the page goes through `code()`, because a backtick in
    // a program name or a path segment closes a single-backtick span: this
    // interpolated between one pair, so a program called ``my`cli`` rendered as
    // a code span of `my` followed by prose. Found by review
    const body = pageFor(
      referencePages(
        await surface({ commands: { build: { default: true, run() {} } }, name: 'my`cli' })
      ),
      'build.md'
    );

    expect(body).toContain('named at ``my`cli``.');
  });

  it('should name `<command>` only where something is listed under it', async () => {
    const it = await surface({
      commands: { db: { commands: { migrate: { run() {} } } }, go: { run() {} } },
    });
    const pages = referencePages(it);

    expect(pageFor(pages, 'db.md')).toContain('mycli db <command>');
    expect(pageFor(pages, 'go.md')).not.toContain('<command>');
  });

  it('should spell an alias at the position it is typed in', async () => {
    const body = pageFor(
      referencePages(
        await surface({ commands: { db: { commands: { migrate: { alias: 'm', run() {} } } } } })
      ),
      'db-migrate.md'
    );

    expect(body).toContain('`mycli db m`');
  });
});

describe('the command surface snapshot', () => {
  it('should sort every key, however deep', async () => {
    const it = snapshotOf(
      await surface({ commands: { go: { args: ['<x>'], options: { '--y': {} }, run() {} } } })
    );

    const sorted = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          sorted(entry);
        }
        return;
      }
      if (typeof value !== 'object' || value === null) {
        return;
      }

      const keys = Object.keys(value);
      expect(keys, JSON.stringify(value)).toStrictEqual([...keys].sort());
      for (const entry of Object.values(value)) {
        sorted(entry);
      }
    };

    sorted(it);
  });

  it('should sort the commands whatever order it was handed them in', () => {
    // the claim said straight: the snapshot's order is **its own**, so that
    // changing the order a *reference* reads in is not a change to the surface.
    // Asserted over a scrambled literal rather than over a tree, because the
    // two orders coincide for every ordinary tree -- depth-first in name order
    // and lexicographic on a space-joined path agree wherever a space sorts
    // before every character a name can hold, which it does -- so a tree could
    // only reach this through a command whose own name holds a space. The
    // surface is plain data, so the input that makes the sort matter is a
    // surface, not an app
    const bare = (path: string[]): SurfaceCommand => ({
      args: [],
      default: false,
      desc: undefined,
      examples: [],
      hidden: false,
      options: [],
      path,
      runnable: true,
      tokens: path.slice(-1),
    });

    // three pairs, each of which only one comparator gets right. `z` before
    // `\u00e4` is **code unit**: `localeCompare` puts the umlaut first in every
    // locale there is, so a machine's own setting would otherwise decide the
    // bytes of a committed file. Precomposed, written as an escape: the
    // *decomposed* spelling begins with an `a` and so discriminates nothing,
    // which is how the first version of this test came out backwards. `['a', 'b']` before `['a b']` is **segment
    // wise**, and that half is a **declared statement rather than a guard**: a
    // joined code-unit comparison answers the same thing for every reachable
    // name, because a name cannot hold a character below `0x20` and so the
    // space a join inserts sorts before everything a segment can continue with.
    // It is here so the order is pinned at all. And a path before its own
    // extension is the length tie-break, which is load bearing
    const order = [[], ['a'], ['a', 'b'], ['a b'], ['z'], ['\u00e4']];
    const paths = [['z'], [], ['\u00e4'], ['a', 'b'], ['a b'], ['a']];
    // as **arrays**, because the whole point of the middle pair is that they
    // join to one string: asserting the joined form cannot tell `['a b']` from
    // `['a', 'b']`, so a comparator that joined with a space -- the bug the
    // comment describes -- produced the expected answer from either input
    // order. Found by review
    const sortedPaths = (list: string[][]): string[][] =>
      (
        snapshotOf({ commands: list.map(bare), program: 'mycli' }) as {
          commands: { path: string[] }[];
        }
      ).commands.map((cmd) => cmd.path);

    expect(sortedPaths(paths)).toStrictEqual(order);
    // and the same answer from the reverse, which is what says the order is the
    // snapshot's own rather than the input's
    expect(sortedPaths([...paths].reverse())).toStrictEqual(order);
  });

  it('should sort the commands by path rather than in the reference order', async () => {
    const it = snapshotOf(
      await surface({
        commands: { db: { commands: { migrate: { run() {} } } }, ant: { run() {} } },
      })
    ) as { commands: { path: string[] }[] };

    // by path, so that changing the order a *reference* reads in is not a
    // change to the surface
    expect(it.commands.map((cmd) => cmd.path.join(' '))).toStrictEqual([
      '',
      'ant',
      'db',
      'db migrate',
    ]);
  });

  it('should never sort the arguments, because their order is their position', async () => {
    const it = snapshotOf(
      await surface({ commands: { copy: { args: ['<to>', '<from>'], run() {} } } })
    ) as { commands: { args: { name: string }[]; path: string[] }[] };
    const copy = it.commands.find((cmd) => cmd.path[0] === 'copy');

    expect(copy?.args.map((arg) => arg.name)).toStrictEqual(['to', 'from']);
  });

  it('should sort an argument\u2019s choices, which the arguments\u2019 own order is not', async () => {
    // a reordered `choices` list accepts exactly the same set of values, so what
    // moved is the hint on the screen rather than what argv takes -- which is
    // the rule an option's choices already followed and an argument's did not.
    // `should never sort the arguments` pins the order of the arguments
    // themselves rather than the choices inside one, so nothing could see it.
    // Found by review
    const one = snapshotJson(
      await surface({
        commands: { go: { args: [{ choices: ['b', 'a'], name: 'what' }], run() {} } },
      })
    );
    const other = snapshotJson(
      await surface({
        commands: { go: { args: [{ choices: ['a', 'b'], name: 'what' }], run() {} } },
      })
    );

    expect(one).toBe(other);
    expect(one).toContain('"a",');
  });

  it('should sort an option and its spellings', async () => {
    const it = snapshotOf(
      await surface({
        commands: {
          go: {
            options: {
              '-b, -a, --second, --first, --ant [v]': {
                choices: ['zero', 'two', 'one'],
                env: ['B_TWO', 'A_ONE'],
              },
              '-z, --zed [v]': {},
            },
            run() {},
          },
        },
      })
    ) as {
      commands: {
        options: { choices: string[]; env: string[]; long: string[]; short: string[] }[];
        path: string[];
      }[];
    };
    const go = it.commands.find((cmd) => cmd.path[0] === 'go');

    expect(go?.options.map((opt) => opt.long[0])).toStrictEqual(['--ant', '--zed']);
    // and each option's **own** lists, which the assertion above cannot see: it
    // reads one spelling per option, so a declaration's internal order was
    // unpinned and `choices` was in fact not sorted at all. Found by review
    expect(go?.options[0]?.long).toStrictEqual(['--ant', '--first', '--second']);
    expect(go?.options[0]?.short).toStrictEqual(['-a', '-b']);
    // `env` in **declaration** order, not sorted: `envValue()` answers with the
    // first variable that is set, so the order is the precedence and sorting it
    // hid a real surface change. The first version of this assertion expected
    // the sorted form, which locked the defect in. Found by review
    expect(go?.options[0]?.env).toStrictEqual(['B_TWO', 'A_ONE']);
    expect(go?.options[0]?.choices).toStrictEqual(['one', 'two', 'zero']);
  });

  it('should order two options by code unit rather than by the machine locale', async () => {
    // the same reason the commands are: a committed artifact sorted by a
    // setting is one whose bytes depend on who ran the generator. `--B` before
    // `--a` is the discriminator -- ICU puts the lowercase spelling first and a
    // code-unit sort puts every uppercase letter before every lowercase one.
    // Found by review
    const it = snapshotOf(
      await surface({
        commands: { go: { options: { '--B [v]': {}, '--a [v]': {} }, run() {} } },
      })
    ) as { commands: { options: { long: string[] }[]; path: string[] }[] };
    const go = it.commands.find((cmd) => cmd.path[0] === 'go');

    expect(go?.options.flatMap((opt) => opt.long)).toStrictEqual(['--B', '--a']);
    expect('--B'.localeCompare('--a')).toBeGreaterThan(0);
  });

  it('should hold which command is the default and which path has a handler', async () => {
    // both are a thing argv reaches and neither was recorded: a command marked
    // `default` is dispatched when argv named none, so moving the mark changes
    // what a bare invocation does, and a namespace gaining a `run` is a path
    // that did nothing and now does something. Found by review
    const it = snapshotOf(
      await surface({
        commands: {
          db: { commands: { up: { run() {} } } },
          go: { default: true, run() {} },
        },
      })
    ) as { commands: { default: boolean; path: string[]; runnable: boolean }[] };
    const at = (path: string) => it.commands.find((cmd) => cmd.path.join(' ') === path);

    expect(at('go')?.default).toBe(true);
    expect(at('db')?.default).toBe(false);
    // a namespace with no `index` module lists its children and has no `run`
    expect(at('db')?.runnable).toBe(false);
    expect(at('db up')?.runnable).toBe(true);
  });

  it('should keep an environment list in declaration order, which is precedence', async () => {
    // `envValue()` answers with the **first** variable that is set, so the order
    // is which one wins -- and sorting it meant a pull request that swapped
    // `['SERVER_PORT', 'PORT']` for `['PORT', 'SERVER_PORT']` did not fail
    // `--check` and the file told a reader the wrong winner. `ordered()` is for
    // a set, which `long`, `short` and `choices` are and `env` is not. Found by
    // review
    const one = snapshotJson(
      await surface({
        commands: { go: { options: { '--port [n]': { env: ['SERVER_PORT', 'PORT'] } }, run() {} } },
      })
    );
    const other = snapshotJson(
      await surface({
        commands: { go: { options: { '--port [n]': { env: ['PORT', 'SERVER_PORT'] } }, run() {} } },
      })
    );

    expect(one).not.toBe(other);
    expect(one).toContain('"SERVER_PORT",');
  });

  it('should record the environment variables an argument reads', async () => {
    // an argument reads them exactly as an option does -- `initArg()` stores
    // `envs` and `envValue()` reads them with the same first-wins rule -- and
    // the surface recorded none, so renaming one could not fail `--check`.
    // Measured: `ENTRY=x mycli` fills the argument. Found by review
    const json = snapshotJson(
      await surface({
        commands: {
          go: { args: [{ env: ['ENTRY', 'FALLBACK'], name: '<entry>' }], run() {} },
        },
      })
    );

    expect(json).toContain('"ENTRY"');
    // in declaration order, for the reason an option's is
    expect(json.indexOf('"ENTRY"')).toBeLessThan(json.indexOf('"FALLBACK"'));
  });

  it('should hold what argv accepts and not what the screen says', async () => {
    const json = snapshotJson(
      await surface({
        commands: {
          go: {
            desc: 'A description',
            examples: { label: 'The usual', text: 'mycli go' },
            options: { '--x [hint]': { default: 'a-dflt', desc: 'An option', group: 'Advanced' } },
            run() {},
          },
        },
      })
    );

    // the line this draws: a `desc` change must not fail a check, because a
    // snapshot that moved when a description was reworded is one nobody could
    // leave on
    for (const absent of [
      'A description',
      'An option',
      'The usual',
      'Advanced',
      'hint',
      'a-dflt',
    ]) {
      expect(json, absent).not.toContain(absent);
    }
    expect(json).toContain('"--x"');
  });

  it('should hold no version, no timestamp and no path', async () => {
    const json = snapshotJson(await surface({ commands: { go: { run() {} } }, version: '9.9.9' }));

    // either would move the file on every release, which turns the check into
    // noise and trains people to refresh it without reading it
    expect(json).not.toContain('9.9.9');
    expect(json).not.toContain(root);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it('should order a non-ASCII name by code unit, not by the machine locale', async () => {
    // `localeCompare` reads the process locale, so the same surface printed
    // different bytes on a German laptop and on CI -- which for a committed
    // artifact is a check that fails over who ran the generator. Measured:
    // `Intl` puts the umlaut before `z` in `de`, `sv` and `en` alike, where a
    // code-unit sort puts it after every ASCII letter there is
    const umlaut = '\u00e4ber';
    const it = snapshotOf(
      // a computed key, because the escape is the point and `oxfmt` unquotes a
      // string key -- which turned `'\u00e4ber'` into a *decomposed* literal
      // whose first code unit is an `a`, so the test discriminated nothing and
      // came out backwards. Found by reading the bytes rather than the screen
      await surface({ commands: { [umlaut]: { run() {} }, zed: { run() {} } } })
    ) as { commands: { path: string[] }[] };
    const names = it.commands.map((cmd) => cmd.path.join(' ')).filter(Boolean);

    expect(names).toStrictEqual(['zed', '\u00e4ber']);
    // the discriminator said out loud, so that this test cannot quietly become
    // one about two names a locale and a code unit happen to agree about
    expect('zed'.localeCompare('\u00e4ber')).toBeGreaterThan(0);
  });

  it('should answer the same bytes twice for one app', async () => {
    const schema: Schema = {
      commands: { b: { options: { '--z [v]': {}, '--a [v]': {} }, run() {} }, a: { run() {} } },
      name: 'mycli',
    };

    expect(snapshotJson(await commandSurface(schema))).toBe(
      snapshotJson(await commandSurface(schema))
    );
  });

  it('should end in exactly one newline', async () => {
    const json = snapshotJson(await surface({ commands: { go: { run() {} } } }));

    expect(json.endsWith('}\n')).toBe(true);
  });
});

describe('writing a reference', () => {
  it('should report a file that is not there and then write it', () => {
    const dir = temp();
    const files = [{ body: 'one\n', file: 'a.md' }];

    expect(syncReference(dir, files, { check: true })).toStrictEqual([
      { kind: 'added', path: expect.stringContaining('a.md') },
    ]);
    // `--check` writes nothing, which is the whole of what it is for
    expect(() => readFileSync(join(dir, 'a.md'), 'utf-8')).toThrow();

    expect(syncReference(dir, files)).toHaveLength(1);
    expect(readFileSync(join(dir, 'a.md'), 'utf-8')).toBe('one\n');
    expect(syncReference(dir, files, { check: true })).toStrictEqual([]);
  });

  it('should report a file whose content moved', () => {
    const dir = temp();
    syncReference(dir, [{ body: 'one\n', file: 'a.md' }]);

    expect(syncReference(dir, [{ body: 'two\n', file: 'a.md' }], { check: true })).toStrictEqual([
      { kind: 'changed', path: expect.stringContaining('a.md') },
    ]);
  });

  it('should read a CRLF file as saying what an LF one says', () => {
    // git checks a markdown file out with CRLF on Windows -- `.gitattributes`
    // says `text=auto` and lists no `*.md` -- so a byte comparison would fail
    // `--check` on all three Windows jobs over a tree with nothing wrong with
    // it, which is the fifth time this repository has been bitten by that
    const dir = temp();
    writeFileSync(join(dir, 'a.md'), 'one\r\ntwo\r\n', 'utf-8');

    expect(
      syncReference(dir, [{ body: 'one\ntwo\n', file: 'a.md' }], { check: true })
    ).toStrictEqual([]);
  });

  it('should raise a read that failed for a reason other than absence', () => {
    // `ENOENT` alone is nothing, which is `isMissing()`'s rule one package
    // along and the defect that rule exists for: reading every error as absence
    // is how a file that exists and cannot be read comes to be reported as a
    // file to write -- and then the write fails with a message about something
    // else. A directory where a file was named is the reachable shape
    const dir = temp();
    mkdirSync(join(dir, 'a.md'));

    expect(() => syncReference(dir, [{ body: 'one\n', file: 'a.md' }], { check: true })).toThrow(
      /EISDIR|EPERM|EACCES/u
    );
  });

  it('should report a page a command no longer has, and never delete it', () => {
    const dir = temp();
    writeFileSync(join(dir, 'gone.md'), 'old\n', 'utf-8');

    const changes = syncReference(dir, [{ body: 'one\n', file: 'a.md' }], { sweep: true });

    expect(changes.filter((it) => it.kind === 'stale')).toStrictEqual([
      { kind: 'stale', path: expect.stringContaining('gone.md') },
    ]);
    // reported and left: the destination is a directory a docs site owns as
    // well, and `sigil build`'s own refusal -- the app root and above -- does
    // not reach a destination typed one directory wrong
    expect(readFileSync(join(dir, 'gone.md'), 'utf-8')).toBe('old\n');
  });

  it('should not call a page stale because its name differs only in case', () => {
    // the severe one: `listed()` folds the case when it refuses two pages that
    // want one file, and this compared names exactly -- so on a
    // case-insensitive volume, which is the one that fold was added for,
    // renaming a command `DB` to `db` wrote the new bytes into the entry still
    // called `DB.md` and every `--check` after it reported that entry stale for
    // ever, with the diagnostic telling the reader to delete the only copy of
    // the page. Measured. Found by review
    const dir = temp();
    const files = [{ body: 'new\n', file: 'db.md' }];

    writeFileSync(join(dir, 'DB.md'), 'old\n', 'utf-8');

    const sensitive = !existsSync(join(dir, 'db.md'));

    // a check first, where the page is not written yet: on a case-insensitive
    // volume the two names are one file, so what moved is the content
    expect(syncReference(dir, files, { check: true, sweep: true }).map((it) => it.kind)).toEqual(
      sensitive ? ['added', 'stale'] : ['changed']
    );

    // and then a write, after which the bytes are what the generator would
    // produce -- so a second check has nothing to say
    syncReference(dir, files, { sweep: true });

    expect(syncReference(dir, files, { check: true, sweep: true })).toEqual(
      sensitive ? [{ kind: 'stale', path: displayPath(join(dir, 'DB.md')) }] : []
    );
    // and the page really does hold the new bytes under whichever name the
    // volume kept
    expect(readFileSync(join(dir, 'db.md'), 'utf-8')).toBe('new\n');
  });

  it('should leave a file that is not a page alone', () => {
    const dir = temp();
    writeFileSync(join(dir, 'logo.svg'), '<svg/>', 'utf-8');

    expect(
      syncReference(dir, [{ body: 'one\n', file: 'a.md' }], { sweep: true }).filter(
        (it) => it.kind === 'stale'
      )
    ).toStrictEqual([]);
  });

  it('should sweep only where it was asked to, which a single file never is', () => {
    const dir = temp();
    writeFileSync(join(dir, 'other.md'), 'x\n', 'utf-8');

    expect(syncReference(dir, [{ body: '{}\n', file: 'a.json' }], { check: true })).toHaveLength(1);
  });

  it('should make the directory it writes into', () => {
    const dir = join(temp(), 'deep', 'deeper');

    syncReference(dir, [{ body: 'one\n', file: 'a.md' }]);

    expect(readFileSync(join(dir, 'a.md'), 'utf-8')).toBe('one\n');
  });
});

describe('reading an app', () => {
  it('should take a schema a function returned', async () => {
    // which is what an app whose schema reads the environment has to be, and
    // what the generated bin already calls -- so an app that works built works
    // here
    const dir = temp();

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'fn-app' }),
      'utf-8'
    );
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'index.mjs'),
      'export default () => ({ name: "fn-app", commands: { go: { run() {} } } });\n',
      'utf-8'
    );

    const { app, schema } = await loadAppSchema({ cwd: dir });

    expect(schema.name).toBe('fn-app');
    expect(app.manifest.name).toBe('fn-app');
  });

  it('should say so where the entry exports nothing that can be a schema', async () => {
    const dir = temp();

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'bad-app' }),
      'utf-8'
    );
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.mjs'), 'export const other = 1;\n', 'utf-8');

    await expect(loadAppSchema({ cwd: dir })).rejects.toThrow(/exports no schema/u);
  });
});

describe('the reference config', () => {
  it('should be declared in the schema the file is validated against', () => {
    // read off `CONFIG_SCHEMA` rather than written out, so a key added without
    // a type is this test failing rather than a value nothing checks
    expect(Object.keys(CONFIG_SCHEMA)).toEqual(
      expect.arrayContaining(['reference.out', 'reference.snapshot'])
    );
  });

  it('should refuse a destination that is absolute or empty', () => {
    const dir = temp();
    const write = (reference: unknown): void =>
      writeFileSync(join(dir, 'sigil.json'), JSON.stringify({ reference }), 'utf-8');

    write({ out: '' });
    expect(() => readSigilConfig(dir)).toThrow(/"reference\.out" must be a non-empty string/u);

    write({ snapshot: '/etc/surface.json' });
    expect(() => readSigilConfig(dir)).toThrow(/"reference\.snapshot" must be relative/u);

    // a reference is a committed artifact, so an absolute path in the config is
    // one machine's answer written into a file every machine reads
    write({ out: './docs', snapshot: 'surface.json' });
    expect(readSigilConfig(dir).reference).toStrictEqual({
      out: './docs',
      snapshot: 'surface.json',
    });
  });

  it('should refuse a section that is not an object, and ignore a key it does not declare', () => {
    const dir = temp();

    writeFileSync(join(dir, 'sigil.json'), JSON.stringify({ reference: [] }), 'utf-8');
    expect(() => readSigilConfig(dir)).toThrow(/"reference" must be an object/u);

    writeFileSync(
      join(dir, 'sigil.json'),
      JSON.stringify({ reference: { nonsense: 1, out: 'docs' } }),
      'utf-8'
    );
    expect(readSigilConfig(dir).reference).toStrictEqual({ out: 'docs' });
  });
});
