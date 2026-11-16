import {
  type Diagnostic,
  DiagnosticError,
  diagnosticLocation,
  diagnosticMessage,
  formatDiagnostic,
} from '../src/build/diagnostic.js';
import { discoverApp, readAppCommands } from '../src/build/discover.js';
import { checkCatalogs } from '../src/build/i18n.js';
import { resolveCommandTree } from '../src/build/tree.js';
import { diagnosticsView, render, writeDiagnostics } from '../src/report.js';
import { tempDir } from './temp.js';
import { ESC, strip } from '@ttylabs/sigil/ansi';
import { escapeControls } from '@ttylabs/sigil/error-handler';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A diagnostic quotes names it did not choose -- a file the file system holds, a
 * command the app's source declared -- and a terminal acts on what it is handed.
 * SIG-443: the location printed the file exactly as it was on disk, so a routed
 * file named `c<ESC>]0;T<BEL>d` retitled the window of whoever read a piped build.
 * Written with escapes, never raw bytes, for the reason `sources.test.ts` exists.
 */

/** A name that is a retitle sequence, and one that is the one-character CSI. */
const TITLE = 'c\u001b]0;T\u0007d';
const CSI = 'x\u009b2Jy';

/** A terminal that takes colour. */
const TERMINAL = { env: { FORCE_COLOR: '3' }, stream: { columns: 100, isTTY: true } } as const;

function diagnostic(over: Partial<Diagnostic> = {}): Diagnostic {
  return {
    column: 3,
    file: `src/${TITLE}.ts`,
    line: 12,
    message: 'something to say about it',
    severity: 'error',
    ...over,
  };
}

/**
 * Every control character left in some output, newlines aside.
 *
 * The laid-out form is coloured, so the SGR the report itself chose is taken off
 * first -- and only that: `strip()` would also take off an injected sequence,
 * which is the canvas hiding the defect from the one test that is looking for it.
 */
function controls(out: string): string[] {
  const sgr = new RegExp(`${ESC}\\[[\\d;:]*m`, 'g');
  return [...out.replaceAll(sgr, '').matchAll(/[\p{Cc}]/gu)]
    .map((m) => m[0])
    .filter((c) => c !== '\n');
}

function laidOut(items: readonly Diagnostic[]): string {
  return render((width) => diagnosticsView(items, { width }), TERMINAL);
}

describe('a diagnostic that quotes a name with a control character in it', () => {
  it('should escape the file in the location, so the pipe prints no control character', () => {
    for (const file of [`src/${TITLE}.ts`, `src/${CSI}.ts`]) {
      const out = formatDiagnostic(diagnostic({ file }));

      expect(controls(out), out).toEqual([]);
      expect(out).toContain(escapeControls(file));
    }
  });

  it('should escape it the same way in the laid-out form, which shares the location', () => {
    const d = diagnostic();
    const out = laidOut([d]);

    expect(controls(out), out).toEqual([]);
    // stripped, so that what is left is what a person reads: the location is the
    // one `diagnosticLocation()` gave the pipe, byte for byte
    expect(strip(out)).toContain(`${diagnosticLocation(d)}: `);
    expect(diagnosticLocation(d)).toBe(`src/c\\x1B]0;T\\x07d.ts:12:3`);
  });

  it('should reach a stream through writeDiagnostics() clean in both forms', () => {
    for (const isTTY of [true, false]) {
      const chunks: string[] = [];
      writeDiagnostics([diagnostic(), diagnostic({ file: `src/${CSI}.ts` })], {
        stream: { columns: 100, isTTY, write: (s: string) => chunks.push(s) },
      });

      expect(controls(chunks.join('')), chunks.join('')).toEqual([]);
    }
  });

  it('should escape what the message quotes, which no producer is trusted to have done', () => {
    // a command called `'\x1b]0;T\x07'` is a string literal an app may write, and
    // `discover.ts` echoes it into a message without a word about it
    const message = `the "${TITLE}" command's "desc" is computed\r\u001b]52;c;AAAA\u0007`;

    for (const out of [
      formatDiagnostic(diagnostic({ message })),
      laidOut([diagnostic({ message })]),
    ]) {
      expect(controls(out), out).toEqual([]);
      // and the words a person reads are the escaped ones in both forms: the
      // canvas would have stripped a raw sequence to nothing, which hides what
      // the message quoted rather than showing it
      expect(strip(out)).toContain(escapeControls('\u001b]52;c;AAAA\u0007'));
    }
  });

  it('should escape the message of a DiagnosticError, which is the one-line form of each', () => {
    const error = new DiagnosticError([diagnostic({ message: `bad ${TITLE}` })]);

    expect(controls(error.message), error.message).toEqual([]);
  });

  it('should keep a newline, because that is how a message carries lines', () => {
    const message = 'one\n  two\nthree';

    expect(diagnosticMessage(diagnostic({ message }))).toBe(message);
    expect(formatDiagnostic(diagnostic({ message })).split('\n')).toHaveLength(3);
  });

  it('should not escape twice what a producer already escaped', () => {
    // `escapeControls()` writes four printable characters and no control one, so
    // a second pass has nothing to find -- asserted rather than argued, because a
    // doubled `\\x1B` is the failure a reader would meet as a garbled name
    const message = `Cannot route the file "${escapeControls(TITLE)}": it contains whitespace`;

    expect(diagnosticMessage(diagnostic({ message }))).toBe(message);
    expect(diagnosticMessage(diagnostic({ message }))).not.toContain('\\\\x');
  });

  it('should not let the forward-slash rule eat the escape', () => {
    // `displayPath()` turns every backslash into a slash, and the escape is
    // spelled with one: applied in the other order this reads `a/b/x1Bc.ts`
    expect(
      diagnosticLocation(diagnostic({ column: undefined, file: 'a\\b\u001bc.ts', line: undefined }))
    ).toBe('a/b\\x1Bc.ts');
  });
});

describe('a tab in a message', () => {
  it('should survive in both forms, because it acts on nothing and a Go panic is indented with it', () => {
    // TypeScript 7's compiler is a native binary, and the stack a panic prints
    // indents each frame with a tab: escaping it read `\x09/src/checker.go:42`
    const message = 'panic: boom\n\tgoroutine 1 [running]:\n\t/src/checker.go:42 +0x1d';

    expect(diagnosticMessage(diagnostic({ message }))).toBe(message);
    expect(formatDiagnostic(diagnostic({ message }))).toContain('\n\t/src/checker.go:42');
    // the laid-out form draws a tab as a space, and never as its escape
    const out = strip(laidOut([diagnostic({ message })]));
    expect(out).not.toContain('\\x09');
    expect(out).toContain('/src/checker.go:42 +0x1d');
  });

  it('should still be escaped in the location, where a file name has no business holding one', () => {
    expect(diagnosticLocation(diagnostic({ file: 'a\tb.ts', line: undefined }))).toBe('a\\x09b.ts');
  });

  it('should escape a carriage return, which can overwrite a line that was already said', () => {
    expect(controls(formatDiagnostic(diagnostic({ message: 'fine\rforged' })))).toEqual([]);
  });
});

describe('a name in the source that holds a newline', () => {
  // the sink cannot tell a message's own line break from one inside a quoted name,
  // so a producer escapes what it echoes -- and a line a person's tooling reads as
  // a diagnostic is what a newline forges
  const FORGED = (n: number) => `\nsrc/forged.ts:1:1: error: FORGED-${n}`;

  /** Every printed line of a set of diagnostics, as an editor's problem matcher reads them. */
  function printed(diagnostics: readonly Diagnostic[]): string[] {
    return diagnostics.flatMap((d) => formatDiagnostic(d).split('\n'));
  }

  it('should not let a command name forge a second diagnostic line', () => {
    const dir = tempDir('sigil-forged-line-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'forged' })
    );
    mkdirSync(join(dir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(dir, 'src', 'commands', 'a.js'), 'export default { run() {} };\n');
    const key = (n: number) => JSON.stringify(`k${n}${FORGED(n)}`);
    writeFileSync(
      join(dir, 'src', 'index.js'),
      `const computed = Math.random();
export default {
  baseDir: import.meta.dirname,
  commands: {
    ${key(1)}: computed,
    ${key(2)}: { desc: 42, path: './commands/a.js' },
    ${key(3)}: { hidden: 'yes', path: './commands/a.js' },
    ${key(4)}: './missing${FORGED(4).replaceAll('\n', '\\n')}.js',
    ${key(5)}: { alias: computed, path: './commands/a.js' },
    ${key(6)}: { desc: computed, path: './commands/a.js' },
    ${key(7)}: { path: './commands/a.js', ${JSON.stringify(`unbaked${FORGED(7)}`)}: 1 },
    ${key(9)}: { name: 42, path: './commands/a.js' },
    ${key(10)}: { name: computed, path: './commands/a.js' },
    // a name string the runtime refuses to parse is named as written
    ${JSON.stringify('<x>\nsrc/forged.ts:1:1:')}: { desc: 42, path: './commands/a.js' },
  },
};\n`
    );

    const { diagnostics } = readAppCommands(discoverApp(dir));
    const lines = printed(diagnostics);

    // every one was reported, or this asserts nothing about what it names
    expect(diagnostics.length).toBeGreaterThanOrEqual(10);
    expect(
      lines.filter((line) => line.startsWith('src/forged.ts')),
      lines.join('\n')
    ).toEqual([]);
    // one line each, which is what a newline in a name would have broken
    expect(lines).toHaveLength(diagnostics.length);
  });

  // a directory named with a newline cannot be made on Windows
  it.skipIf(process.platform === 'win32')(
    'should not let the directory of a package that cannot be read forge one',
    () => {
      const dir = tempDir('sigil-forged-package-');
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'forged' })
      );
      const broken = join(dir, 'src', `pkg${FORGED(1)}`);
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, 'package.json'), '{ "name": ');
      writeFileSync(
        join(dir, 'src', 'index.js'),
        `export default {
  baseDir: import.meta.dirname,
  commands: { ${JSON.stringify(`p${FORGED(2)}`)}: ${JSON.stringify(`./pkg${FORGED(1)}`)} },
};\n`
      );

      const { diagnostics } = readAppCommands(discoverApp(dir));
      const lines = printed(diagnostics);

      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(
        lines.filter((line) => line.startsWith('src/forged.ts')),
        lines.join('\n')
      ).toEqual([]);
      expect(lines).toHaveLength(diagnostics.length);
    }
  );

  it('should not let a commands.json key or a declared alias forge one either', () => {
    const dir = tempDir('sigil-forged-routes-');
    writeFileSync(
      join(dir, 'list.js'),
      `export default { alias: [${JSON.stringify(`x${FORGED(1)}`)}] };\n`
    );
    writeFileSync(
      join(dir, 'commands.json'),
      JSON.stringify({
        [`stale${FORGED(2)}`]: { alias: [`z${FORGED(4)}`], desc: 'gone' },
        list: { alias: [`y${FORGED(3)}`], [`nope${FORGED(5)}`]: 1 },
      })
    );

    const { diagnostics } = resolveCommandTree(dir);
    const lines = printed(diagnostics);

    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(
      lines.filter((line) => line.startsWith('src/forged.ts')),
      lines.join('\n')
    ).toEqual([]);
  });

  it('should not let a locale forge one', () => {
    const diagnostics = checkCatalogs({
      catalogs: [
        { catalog: {}, locale: `de${FORGED(1)}` },
        { catalog: { extra: 'x' }, locale: `fr${FORGED(2)}` },
      ],
      file: '/app/src/index.ts',
      framework: ['Options:'],
      keys: ['own'],
    });
    const lines = printed(diagnostics);

    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
    expect(
      lines.filter((line) => line.startsWith('src/forged.ts')),
      lines.join('\n')
    ).toEqual([]);
  });
});
