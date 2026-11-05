import { GUIDES, readGuide, steps } from '../../packages/cli/test/guides.ts';
import { captures, lookup } from '../src/lib/transcripts.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The captured transcripts against the guides they were captured from.
 *
 * A terminal block only uses a capture whose text is exactly the page's, so a
 * stale capture is never *wrong* on screen -- it is silently unused, and the
 * block falls back to the glyph rules. That is the failure this is for: nothing
 * looks broken, and the real colour has quietly gone. The runnable steps are
 * `packages/cli/test/guides.ts`'s, the same ones the guide test runs and the
 * capture script captures, so all three agree about which lines are runs.
 */
describe('the captured transcripts', () => {
  const all = captures();

  it('should exist for every guide', () => {
    assert.deepEqual(
      all.map((capture) => capture.guide).sort(),
      GUIDES.map((guide) => `packages/sigil/docs/${guide.file}`).sort()
    );
  });

  for (const guide of GUIDES) {
    it(`should match every run in ${guide.file}; if not, run \`node scripts/capture-transcripts.ts\``, () => {
      const runs = steps(guide, readGuide(guide.file)).steps.flatMap((step) =>
        step.kind === 'run' ? [step] : []
      );
      const find = lookup(all);
      const capture = all.find((it) => it.guide.endsWith(`/${guide.file}`));

      assert.ok(runs.length > 5, 'the guide has runs to capture');
      for (const run of runs) {
        assert.notEqual(
          find(run.typed, run.expected),
          undefined,
          `\`$ ${run.typed}\` has no capture`
        );
      }
      // and nothing captured that the guide no longer runs
      assert.equal(capture?.runs.length, runs.length);
    });
  }

  it('should hold real colour, or there is nothing to draw from', () => {
    assert.ok(all.some((capture) => capture.runs.some((run) => run.output.includes('\u001b['))));
  });
});
