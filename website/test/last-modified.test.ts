import { lastModified, type Git } from '../src/lib/last-modified.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** A git that answers the two questions asked of it. */
const git =
  (shallow: string, log: string): Git =>
  (args) =>
    args[0] === 'rev-parse' ? shallow : log;

describe('lastModified', () => {
  it('should give the date of the last commit to touch the file', () => {
    assert.equal(lastModified('a.md', git('false\n', '2026-11-04\n')), '2026-11-04');
  });

  it('should give no date in a shallow clone, where every file was last touched by the one commit', () => {
    assert.equal(lastModified('a.md', git('true\n', '2026-11-04\n')), undefined);
  });

  it('should give no date for a file git knows nothing about', () => {
    assert.equal(lastModified('a.md', git('false\n', '\n')), undefined);
  });

  it('should give no date from a git too old to be asked, which prints the flag back', () => {
    assert.equal(lastModified('a.md', git('--is-shallow-repository\n', '2026-11-04\n')), undefined);
  });

  it('should give no date where there is no git', () => {
    const missing: Git = () => {
      throw new Error('spawn git ENOENT');
    };
    assert.equal(lastModified('a.md', missing), undefined);
  });

  it('should refuse output that is not a date', () => {
    assert.equal(lastModified('a.md', git('false\n', 'fatal: not a repository')), undefined);
  });
});
