import { REPO_URL } from './site.ts';

/**
 * The longest path put in an issue's title. An address can be as long as the
 * reader's browser allows, and a title that fills the form is not one anybody
 * reads.
 */
const MAX_PATH = 120;

/** @returns The path, cut to `MAX_PATH` characters with an ellipsis when it is longer. */
function shorten(path: string): string {
  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH - 1)}…` : path;
}

/**
 * GitHub's "new issue" form with a title and a body filled in.
 *
 * Built from `REPO_URL` so the repository is spelt in one place. The reader still
 * has to press the button, which is the point: nothing is sent from here.
 *
 * @param issue - What to prefill.
 * @param issue.title - The issue's title.
 * @param issue.body - The issue's body, markdown.
 * @returns The address.
 */
export function newIssueUrl({ title, body }: { title: string; body: string }): string {
  const params = new URLSearchParams({ title, body });
  // `+` for a space is what a form submission writes and GitHub reads, but
  // `%20` is what every URL parser agrees on
  return `${REPO_URL}/issues/new?${params.toString().replaceAll('+', '%20')}`;
}

/**
 * The issue a reader files over a link that leads nowhere.
 *
 * @param path - The address that missed. `null` before the browser has said which: the server
 *   prerenders one 404 for every address.
 * @param referrer - The page the reader came from, when the browser said.
 * @returns The address of the prefilled form.
 */
export function brokenLinkUrl(path: string | null, referrer?: string | null): string {
  return newIssueUrl({
    title: path === null ? 'Broken link' : `Broken link: ${shorten(path)}`,
    body: [
      path === null
        ? 'An address leads to the "Page not found" page.'
        : `The address \`${shorten(path)}\` leads to the "Page not found" page.`,
      ...(referrer ? [`I came from: ${referrer}`] : []),
    ].join('\n\n'),
  });
}

/**
 * The issue a reader files over a page that failed to render.
 *
 * @param path - The page that failed.
 * @param digest - The error's digest, which ties the report to the server log. Absent when
 *   the error came from the browser.
 * @returns The address of the prefilled form.
 */
export function errorReportUrl(path: string, digest?: string): string {
  return newIssueUrl({
    title: `Error rendering ${shorten(path)}`,
    body: [
      `The page \`${shorten(path)}\` failed to render.`,
      ...(digest ? [`Digest: \`${digest}\``] : []),
    ].join('\n\n'),
  });
}
