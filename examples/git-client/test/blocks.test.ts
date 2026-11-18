import { blocksOf, type DiffSection, wholePath } from '../src/model.ts';
import { diffStops, parsePatch } from '@ttylabs/sigil/components';
import { describe, expect, it } from 'vitest';

/**
 * What the diff pane draws, as the blocks a `DiffView` takes, and the stops the
 * model finds in them -- pure, so no repository is needed.
 */

/** An unstaged rename, as `git diff -- new old` prints it without `-M`. */
const PATCH = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3b18e51',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/old.bin b/old.bin',
  'deleted file mode 100644',
  'index 5555555..0000000',
  'Binary files a/old.bin and /dev/null differ',
  '',
].join('\n');

describe('blocksOf', () => {
  it('should carry the file a whole-file line stands for, not only its section', () => {
    const section: DiffSection = {
      action: 'stage',
      files: parsePatch(PATCH),
      from: 'old.bin',
      label: 'Unstaged',
      lines: [],
      path: 'new.txt',
    };
    const stops = diffStops(blocksOf({ key: 'k', note: '', sections: [section], title: 't' }));

    expect(stops).toHaveLength(2);
    expect(stops[0]?.hunk).toBeDefined();
    // the binary file's line: Space has to stage `old.bin`, not the section's path
    expect(stops[1]?.hunk).toBeUndefined();
    expect(stops[1] && wholePath(stops[1])).toBe('old.bin');
  });

  it('should stage an untracked file by its own path, a b/ at its start and all', () => {
    const section: DiffSection = {
      action: 'stage',
      added: { path: 'b/notes.txt', text: 'hello\n' },
      files: [],
      label: 'Untracked',
      lines: [],
      path: 'b/notes.txt',
    };
    const [stop] = diffStops(blocksOf({ key: 'k', note: '', sections: [section], title: 't' }));

    expect(stop && wholePath(stop)).toBe('b/notes.txt');
  });
});
