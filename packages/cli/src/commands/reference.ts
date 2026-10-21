/**
 * `sigil reference`: an app's command surface, as markdown or as a snapshot.
 *
 * Two artifacts over one payload. The markdown is for reading -- `oclif readme`
 * writes one into a README on publish and Salesforce generates a doc site from
 * it, and sigil generated a help *screen* and nothing that outlived the process.
 * The JSON is for diffing: a CLI's command surface is its public API, and
 * nothing in a build notices when it moves, so a pull request that renames a
 * flag breaks everybody's scripts and reads as a one-line change.
 * `@oclif/plugin-command-snapshot` commits the surface so that pull request
 * fails, and this is that.
 *
 * ## Why it is a command of its own rather than part of `sigil build`
 *
 * Because it imports the app, and the build must not. An option and an argument
 * live **only** inside the module that declares them -- `sigil build` lifts
 * `desc` and `hidden` and nothing lifts the rest, which is written down twice
 * already as the reason `ResolvedCommand` carries no options and the reason a
 * completion script is generated from the live registries rather than baked.
 * So a reference cannot be a static read, and the build's own rule is precisely
 * that it parses rather than imports, so that an app which opens a connection
 * at module scope does not do it during a build.
 *
 * An opt-in `sigil.json` key would make the surprise go away and would not make
 * the build a different kind of thing, which is what it would be: taking that
 * inside a ticket about documentation is the shape this repository refuses.
 * Three more reasons, each smaller and each real. A build writes into `--out`
 * and nothing else, where a reference lands in the source tree and would make
 * `git status` dirty after every build with no `clean()` to answer for it. It
 * would make a reference a built-app-only feature, where generating from the
 * registries is what makes it work in dev. And it couples a doc generation to a
 * bundle it has nothing to do with.
 *
 * So the config key says *where*, not *whether*, which is the same thing
 * `components` says to `sigil add`.
 *
 * ## The destination decides the layout, and the format decides its shape
 *
 * With nowhere to put anything, one document goes to stdout -- which is what
 * you pipe, and what a README injection wants. With `--out`, the markdown is a
 * page per command, because that is what a docs site routes on and the only
 * shape that stays navigable past a dozen commands. The snapshot is one file
 * either way, because it is one document by nature.
 *
 * ## `--check` is the half that is worth more
 *
 * It compares and refuses rather than writing, so a CI step is one line and a
 * surface that moved without the artifact being refreshed is a failed build.
 * Failing a **test** is what this repository does with its own artifacts --
 * `registry.test.ts` and the turbo hash assertions both live there -- and that
 * is a choice each app makes with this flag rather than one made for them: what
 * fails is whatever invoked it.
 */

import { displayPath } from '../build/diagnostic.ts';
import { readSigilConfig } from '../config.ts';
import { loadAppSchema } from '../reference/load.ts';
import { referenceDocument, referencePages } from '../reference/markdown.ts';
import { snapshotJson } from '../reference/snapshot.ts';
import { syncReference, type Change, type ReferenceFile } from '../reference/write.ts';
import { writeDiagnostics, writeSummary } from '../report.ts';
import { appRuns } from './_inspect.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { commandSurface } from '@ttylabs/sigil/reference';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * A destination as a reader should see it.
 *
 * **Whichever of the two is shorter**, which is one rule where the first version
 * had a rule and a claim that did not match it: it used the relative form unless
 * it climbed out of the app at all, under a comment saying it used the shorter
 * one -- and the toolchain's own destination is `../../website/src/reference`,
 * twenty-eight characters against eighty-five, so the summary printed an
 * absolute path with somebody's home directory in it beside a comment promising
 * it would not.
 *
 * Stating the rule properly also deleted a guard. A review round had sharpened
 * the climb test from `startsWith('..')` -- which is true of a sibling directory
 * called `..staging`, a legal name -- to an exact segment test; with the shorter
 * of the two winning there is no climb test left at all, because a path *inside*
 * the app is always shorter relative and a path outside it is decided by the
 * same comparison as everything else. A guard that cannot change an answer is
 * deleted rather than commented.
 *
 * The empty string is the app root itself, which is the one case the comparison
 * cannot answer: `relative()` of a directory against itself is `''`.
 *
 * @param root - The app's root.
 * @param dir - Where the reference went.
 * @returns The path, forward-slashed.
 */
function shown(root: string, dir: string): string {
  const here = relative(root, dir);
  return displayPath(here && here.length < dir.length ? here : dir);
}

/**
 * The command that writes this artifact, as the reader would have to type it.
 *
 * Built from the **whole invocation** rather than from the format alone: a
 * destination that came from `--out` is not one `sigil reference` on its own
 * would write to, and neither is a schema that came from `[dir]` or `--entry`.
 * A message naming less than was typed tells the reader to run something that
 * writes somewhere else -- measured, the first version omitted `[dir]`, so
 * pasting its command in this repository wrote *this* toolchain's reference into
 * the app's docs directory, and it omitted `--entry`, so the command it printed
 * regenerated the conventional entry and put back the page it had just reported
 * as stale. Which is the one shape of wrong message this repository keeps
 * finding, in the one function whose whole job is to say the thing to do. Found
 * by review, twice.
 *
 * @param json - Whether the snapshot was asked for.
 * @param dir - What `[dir]` was given, which is `.` when it was not.
 * @param entry - What `--entry` was given, if it was.
 * @param out - What `--out` was given, if it was.
 * @returns The command.
 */
function refreshed(
  json: boolean,
  dir: string,
  entry: string | undefined,
  out: string | undefined
): string {
  const parts = ['sigil reference'];

  if (dir !== '.') {
    parts.push(word(dir));
  }
  if (json) {
    parts.push('--json');
  }
  if (entry !== undefined) {
    parts.push('--entry', word(entry));
  }
  if (out !== undefined) {
    parts.push('--out', word(out));
  }

  return parts.join(' ');
}

/**
 * One argument as a shell would have to read it.
 *
 * Quoted unless it is a single plain word, which is the smaller rule than
 * enumerating what a shell splits on -- and the enumeration was wrong:
 * `/[\s"'\\$`]/u` left `;`, `&`, `|`, `(`, `)` and `<` unquoted, so a
 * destination called `docs/foo;rm` printed a command whose second half is a
 * second command. Measured. The set a shell treats as ordinary is small and
 * known, so that is what is matched rather than the set it does not.
 *
 * **Single** quotes, which is the other half and was `JSON.stringify` -- double
 * quotes, inside which bash, zsh and PowerShell all still expand `$` and a
 * backtick. Measured by having bash parse the printed command: a path ending
 * `foo$HOME` was passed as `foo/Users/chris`, and one ending
 * `` foo`echo PWNED` `` ran the `echo`. A single-quoted string expands nothing
 * at all, and the one character it cannot hold is closed, escaped and reopened,
 * which is the shell's own idiom. Found by review, twice.
 *
 * @param text - The argument.
 * @returns It, safe to paste.
 */
function word(text: string): string {
  // no `=`, which zsh expands: an unquoted word beginning with one is
  // equals-expansion, so `--out =out` -- a legal directory name -- printed a
  // command that bash passes as `=out` and **zsh** passes as `/bin/ls`'s
  // directory. Measured in the shell this diagnostic is pasted into by default.
  // `foo=bar` is quoted with it, which costs two characters. Found by review
  if (/^[\w./@:+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * What a change says, and what to do about it.
 *
 * Per kind rather than one sentence with the kind interpolated, because the
 * thing to do is not the same for all three: `sigil reference` writes a missing
 * or an out-of-date file and **does not** remove a stale one, so telling a
 * reader to run it over a left-over page is an instruction that does nothing.
 * Which is the one shape of wrong message this repository keeps finding -- a
 * sentence a reader follows to no result.
 *
 * @param kind - What is wrong.
 * @param refresh - The command that writes this artifact.
 * @returns The message, written as the thing to do.
 */
function said(kind: Change['kind'], refresh: string): string {
  if (kind === 'stale') {
    return `Not a page this reference writes, so a command was renamed or removed -- or this file is yours and belongs somewhere else. Delete it by hand: \`${refresh}\` writes pages and never removes one.`;
  }

  return kind === 'added'
    ? `Missing from the command reference. Run \`${refresh}\` to write it.`
    : `Not what the command surface says. Run \`${refresh}\` to refresh it.`;
}

/**
 * Annotated rather than inferred, which `--isolatedDeclarations` requires of a
 * default export; `AnyCommand` rather than `Command`, for the reason `check.ts`
 * records.
 */
const reference: AnyCommand = command({
  args: [{ desc: "The app's root, defaulting to the working directory", name: '[dir]' }],
  desc: 'Write a markdown command reference, or a snapshot of the command surface',
  examples: [
    { label: 'Print the whole reference as one document', text: 'sigil reference' },
    { label: 'Write a page per command', text: 'sigil reference --out docs/reference' },
    {
      label: "Fail when the committed snapshot is not what the app's surface says",
      text: 'sigil reference --json --out command-surface.json --check',
    },
  ],
  options: {
    '--check': {
      desc: 'Compare rather than write, and exit non-zero if anything moved',
      type: 'bool',
    },
    '--entry [file]': {
      desc: "The module declaring the app's schema, when the conventions find the wrong one",
    },
    '--json': {
      desc: 'Print a stable snapshot of the command surface rather than markdown',
      type: 'bool',
    },
    '--out [path]': {
      desc: 'Where it goes: a directory for the pages, a file for --json. Overrides sigil.json',
    },
  },

  async run({ argv }) {
    const cwd = String(argv.dir ?? '.');
    const json = !!argv.json;
    const { app, schema } = await loadAppSchema({ cwd, entry: argv.entry as string | undefined });
    const surface = await commandSurface(schema);

    const config = readSigilConfig(app.root).reference ?? {};
    const named = (argv.out as string | undefined) ?? (json ? config.snapshot : config.out);

    if (named === undefined) {
      if (argv.check) {
        throw new Error(
          `Nothing to check: name a destination with --out, or set "reference": { "${
            json ? 'snapshot' : 'out'
          }": "..." } in sigil.json.`
        );
      }

      process.stdout.write(json ? snapshotJson(surface) : referenceDocument(surface));
      return;
    }

    // relative to the **app** rather than to the working directory, so that one
    // `sigil.json` means one destination whichever directory the command was run
    // from -- which is the rule `components` already keeps. An absolute `--out`
    // is taken as given, since a caller who typed one meant it
    const dest = isAbsolute(named) ? named : resolve(app.root, named);

    // a snapshot is one file and the pages are a directory, which is the one
    // place `--out` means two things -- and it means them because the *format*
    // decides whether the answer is one document or many, which is the honest
    // statement rather than two flags for one idea
    const files: ReferenceFile[] = json
      ? [{ body: snapshotJson(surface), file: basename(dest) }]
      : referencePages(surface).map(({ body, file }) => ({ body, file }));
    const dir = json ? dirname(dest) : dest;

    const changes = syncReference(dir, files, { check: !!argv.check, sweep: !json });

    if (argv.check && changes.length > 0) {
      const refresh = refreshed(
        json,
        cwd,
        argv.entry as string | undefined,
        argv.out as string | undefined
      );

      writeDiagnostics(
        changes.map((change) => ({
          file: change.path,
          message: said(change.kind, refresh),
          severity: 'error' as const,
        })),
        {
          // the destination is reported as the app's own file rather than as an
          // absolute path, which is what `_inspect.ts` does with every
          // diagnostic and what makes two runs from two directories comparable
          // -- through the same `shown()` the summary uses, because a
          // destination outside the app is one `relative()` answers with a run
          // of `..` segments longer than the path itself
          relativeTo: (file) => shown(app.root, file),
          stream: process.stderr,
        }
      );

      throw new Error(
        `The command reference is ${changes.length} file${
          changes.length === 1 ? '' : 's'
        } out of date in ${app.manifest.name ?? app.root}`
      );
    }

    writeSummary(
      [
        ...appRuns(app),
        argv.check
          ? { class: 'cli-ok sigil-success', text: 'the command reference is up to date' }
          : `${files.length} file${files.length === 1 ? '' : 's'} into`,
        // the destination the caller named rather than the directory it was split
        // into: a snapshot is one file, and a summary naming its directory would
        // be naming the wrong thing
        ...(argv.check ? [] : [{ class: 'cli-path sigil-muted', text: shown(app.root, dest) }]),
        // a stale page is reported and never deleted, so a plain write still has
        // something to say about one: the destination is a docs directory an
        // author also owns, and `sigil build`'s own refusal -- the app root and
        // above -- does not reach a destination typed one directory wrong
        ...(!argv.check && changes.some((it) => it.kind === 'stale')
          ? [
              {
                class: 'cli-warning sigil-warn',
                text: `(${changes.filter((it) => it.kind === 'stale').length} stale, remove by hand)`,
              },
            ]
          : []),
      ],
      process.stderr
    );
  },
});

export default reference;
