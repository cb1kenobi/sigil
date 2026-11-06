import { execFileSync } from 'node:child_process';

/**
 * When a file was last actually changed, from git rather than from a date
 * somebody has to remember to edit.
 *
 * Ported from titaniumsdk.com's `lastUpdated()`, with one addition that its
 * comment promises and its code leaves to chance: a **shallow clone** is
 * refused outright. In one, every file's most recent commit is the single
 * commit the clone holds, so every page would claim to have been modified at the
 * moment of the deploy -- a date, well formed and wrong, that a crawler learns
 * to distrust the whole sitemap over. No date is the honest answer there, as it
 * is where there is no git at all or the file is untracked.
 */

/** Runs git with these arguments and returns what it printed. */
export type Git = (args: string[]) => string;

const git: Git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * @param path - A file, absolute or relative to the working directory.
 * @param run - How to run git; the tests' seam, where the default is the real one.
 * @returns The date of the last commit to touch it as `YYYY-MM-DD`, or nothing where git cannot
 *   say.
 */
export function lastModified(path: string, run: Git = git): string | undefined {
  if (run !== git) {
    return ask(path, run);
  }
  if (!answered.has(path)) {
    answered.set(path, ask(path, run));
  }
  return answered.get(path);
}

/**
 * What git said of each file, for the life of the process.
 *
 * The 404 suggests the nearest page from the sitemap's list, and its boundary is
 * rendered with every page a build prerenders -- so without this, each page
 * asked git two questions per entry in the sitemap, which was a second a page
 * once the components joined it. A build is one checkout at one commit, so an
 * answer cannot change under it. Only the real git is remembered: a test's seam
 * answers what it is told to each time.
 */
const answered = new Map<string, string | undefined>();

/** Asks git, every time. */
function ask(path: string, run: Git): string | undefined {
  try {
    // anything but a plain `false` is a shallow clone, or a git too old to be
    // asked (before 2.15 it prints the flag back), and neither can be trusted
    if (run(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
      return undefined;
    }

    // %cs is the committer date as YYYY-MM-DD, with no timezone to get wrong
    const date = run(['log', '-1', '--format=%cs', '--', path]).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  } catch {
    // no git on the machine, or not a repository
    return undefined;
  }
}
