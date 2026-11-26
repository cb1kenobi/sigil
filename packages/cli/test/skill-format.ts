/**
 * What the skill format asks of a `SKILL.md`, as assertions both the skills this
 * repository ships and the skill `sigil reference --skill` writes are held to
 * (SIG-720). One definition, so a generated skill cannot pass a laxer check than
 * a hand-written one.
 */

import { expect } from 'vitest';

/**
 * A `SKILL.md`'s front matter, as its keys and values. Every value the format
 * takes is a string on one line, so a line is a key.
 *
 * @param markdown - The file.
 * @returns The keys and values.
 */
export function frontMatter(markdown: string): Map<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (block === undefined) {
    throw new Error('no front matter');
  }
  return new Map(
    block.split('\n').map((line) => {
      const match = /^([\w-]+):[ \t]*(.*)$/.exec(line);
      if (!match) {
        throw new Error(`not a key: ${line}`);
      }
      return [match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, '$2')];
    })
  );
}

/**
 * Asserts a `SKILL.md`'s front matter is what the format asks for.
 *
 * @param markdown - The file.
 * @param name - The skill's directory name, which its `name` has to be.
 */
export function expectSkillFrontMatter(markdown: string, name: string): void {
  const meta = frontMatter(markdown);

  expect([...meta.keys()].toSorted()).toStrictEqual(['description', 'name']);
  // the name is the directory's, in lowercase letters, digits and hyphens
  expect(meta.get('name')).toBe(name);
  expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  expect(name.length).toBeLessThanOrEqual(64);
  // what an agent matches on to decide whether to read the rest
  const description = meta.get('description')!;
  expect(description.length).toBeGreaterThan(50);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(description).not.toMatch(/[<>]/);
}
