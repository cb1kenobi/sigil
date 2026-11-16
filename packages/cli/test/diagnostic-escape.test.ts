import {
  type Diagnostic,
  DiagnosticError,
  diagnosticLocation,
  diagnosticMessage,
  formatDiagnostic,
} from '../src/build/diagnostic.js';
import { diagnosticsView, render, writeDiagnostics } from '../src/report.js';
import { ESC, strip } from '@ttylabs/sigil/ansi';
import { escapeControls } from '@ttylabs/sigil/error-handler';
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
