import { commandRow, type Row } from './terminal-rows.ts';

/**
 * What the 404 and the error page print in their terminal block.
 *
 * Both are written as if `sigil open <address>` had been run and failed, so the
 * page is the one thing on the site that shows what sigil's own errors look
 * like. The glyph is coloured the way the CLI's log colours its `✖` (`term-red`)
 * and what hangs off the message -- the hint, a digest -- is dim, as
 * `glyphRows()` draws a `key=value` field. Nothing else is coloured, because the
 * message is the program's text.
 */

/** What stands in for the address before the browser has said what it is. */
const UNKNOWN_ADDRESS = '<address>';

function failure(message: string): Row {
  return {
    spans: [{ className: 'text-term-red', text: '✖' }, { text: ` ${message}` }],
  };
}

function dim(text: string): Row {
  return { spans: [{ className: 'text-dim', text }] };
}

/**
 * The 404's rows.
 *
 * @param path - The address that missed. `null` until the browser has said: the
 *   server renders the page once for every address, so it cannot know.
 * @param suggestion - The nearest page, or nothing when none is close, in which
 *   case there is no line for it rather than a shrug.
 * @returns The rows.
 */
export function notFoundRows(path: string | null, suggestion?: string): Row[] {
  const address = path ?? UNKNOWN_ADDRESS;

  return [
    commandRow(`sigil open ${address}`),
    failure(path === null ? 'No page at that address' : `No page at ${path}`),
    ...(suggestion === undefined ? [] : [dim(`  Did you mean ${suggestion}?`)]),
  ];
}

/**
 * The error page's rows.
 *
 * **The digest and nothing else, in production.** Next withholds the message of
 * a server error from the browser so as not to leak what threw; the digest is the
 * one thing that ties this screen to a line in the server log. A `detail` is the
 * message of a development error, which the caller passes only outside
 * production.
 *
 * @param path - The page that failed.
 * @param digest - The error's digest, absent for an error that began in the browser.
 * @param detail - The error's message, for development.
 * @returns The rows.
 */
export function errorRows(path: string, digest?: string, detail?: string): Row[] {
  return [
    commandRow(`sigil open ${path}`),
    failure('Something went wrong rendering this page.'),
    ...(digest === undefined ? [] : [dim(`  digest ${digest}`)]),
    ...(detail === undefined ? [] : [dim(`  ${detail}`)]),
  ];
}
