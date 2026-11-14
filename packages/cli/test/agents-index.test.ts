import { root } from './guides.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The table under "Where the subsystem decisions live" in the root `AGENTS.md`:
 * a row per `AGENTS.md` that records decisions, naming the sections in it.
 *
 * It is how a comment that names a section resolves in one hop, and nothing
 * else reads it -- so it drifted the way prose does, one ticket at a time. Six
 * sections across four files had been added without joining their row, one
 * nested file had no row at all, and a label had been shortened into words no
 * heading uses. Each was correct on its own day.
 */

const index = readFileSync(join(root, 'AGENTS.md'), 'utf-8').replace(/\r\n/g, '\n');

/**
 * Files that list their main topics rather than every section. The root says
 * why beside the table, and a row named here is still held to its labels being
 * headings.
 */
const PARTIAL: ReadonlySet<string> = new Set(['packages/sigil/src/components/AGENTS.md']);

/**
 * Tracked `AGENTS.md` files that are not a subsystem's decisions. `next dev`
 * writes the website's, and it says how to read the Next.js docs.
 */
const NOT_DECISIONS: ReadonlySet<string> = new Set(['AGENTS.md', 'website/AGENTS.md']);

interface Row {
  path: string;
  entries: string[];
}

function rows(): Row[] {
  const section = /^## Where the subsystem decisions live\n([\s\S]*?)^## /m.exec(index)?.[1] ?? '';
  return [...section.matchAll(/^\| \[`[^`]+`\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|$/gm)].map(
    ([, path, entries]) => ({ path: path!, entries: entries!.split(' · ') })
  );
}

/**
 * A file's `###` headings, outside code fences, without the `(SIG-nnn)` a
 * heading may end with: the row names the decision, and the ticket is in the
 * file.
 */
function headings(path: string): string[] {
  const source = readFileSync(join(root, path), 'utf-8')
    .replace(/\r\n/g, '\n')
    .replace(/^```[\s\S]*?^```/gm, '');
  return [...source.matchAll(/^### (.+)$/gm)].map(([, heading]) =>
    heading!.replace(/ \(SIG-\d+\)$/, '')
  );
}

describe('the AGENTS.md index', () => {
  const table = rows();

  it('should read a row for each file it links', () => {
    // a heading or a table shape that moved would otherwise read as no rows,
    // and every assertion below would pass over nothing
    expect(table.length).toBeGreaterThan(20);
    for (const { path } of table) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });

  it('should have a row for every AGENTS.md that records decisions', () => {
    const tracked = execFileSync('git', ['ls-files', '*AGENTS.md'], {
      cwd: root,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((path) => path && !NOT_DECISIONS.has(path));

    expect(tracked.toSorted()).toEqual(table.map((row) => row.path).toSorted());
  });

  it("should label each entry with a heading's own words", () => {
    for (const { path, entries } of table) {
      const own = headings(path);
      for (const entry of entries) {
        expect(own, `${path}: ${entry}`).toContain(entry);
      }
    }
  });

  it('should list every section in file order, except where the root says otherwise', () => {
    for (const { path, entries } of table) {
      if (!PARTIAL.has(path)) {
        expect(entries, path).toEqual(headings(path));
      }
    }
  });

  it('should name only partial rows that really are partial', () => {
    // one that has caught up should leave the list, or it stops being checked
    for (const path of PARTIAL) {
      const row = table.find((candidate) => candidate.path === path);
      expect(row, path).toBeDefined();
      expect(row!.entries.length, path).toBeLessThan(headings(path).length);
    }
  });
});
