/**
 * What the skill format asks of a `SKILL.md`, as assertions both the skills this
 * repository ships and the skill `sigil reference --skill` writes are held to
 * (SIG-720). One definition, so a generated skill cannot pass a laxer check than
 * a hand-written one.
 */

import { expect } from 'vitest';
import { parseDocument } from 'yaml';

/**
 * A `SKILL.md`'s front matter, as its keys and values, read by a YAML parser
 * because that is what an agent's loader reads it with -- a line split passed an
 * unquoted description holding `: `, which every real parser refuses. Every value
 * the format takes is a string. Either line ending, because a committed
 * `SKILL.md` is checked out with CRLF on Windows.
 *
 * @param markdown - The file.
 * @returns The keys and values.
 */
export function frontMatter(markdown: string): Map<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown.replace(/\r\n/g, '\n'))?.[1];
  if (block === undefined) {
    throw new Error('no front matter');
  }
  const doc = parseDocument(block, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new Error(`front matter is not YAML: ${doc.errors[0]!.message}`);
  }
  const meta: unknown = doc.toJS();
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error('front matter is not a mapping');
  }
  return new Map(
    Object.entries(meta).map(([key, value]) => {
      if (typeof value !== 'string') {
        throw new Error(`front matter "${key}" is not a string`);
      }
      return [key, value];
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
