import { captureHome } from '../scripts/lib/home-capture.ts';
import { homeScreens } from '../src/lib/home.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The home page's terminals against the programs they were captured from.
 *
 * `transcripts.test.ts` can compare a capture with a guide's text because a
 * guide holds the text. The home page's screens have no text of their own to
 * compare: they are what a prompt drew, what `todo --help` printed, what bash
 * offered for a tab, what `sigil --help` printed. So this runs them all again
 * and compares the whole result, which is the only check that notices a
 * component whose output changed, a command whose description was reworded, or
 * an edit to `src/content/home/todo.mjs` -- the three ways a page stops being
 * true without anything looking broken.
 *
 * It needs `@ttylabs/sigil` and `@ttylabs/cli` built, and `bash`.
 */
describe('the home page captures', () => {
  it('should be what the programs print now; if not, run `node scripts/capture-transcripts.ts`', async () => {
    const now = await captureHome();

    assert.deepEqual(
      now.screens,
      homeScreens(),
      'src/transcripts/home/screens.json is out of date: run `node scripts/capture-transcripts.ts`'
    );
  });
});
