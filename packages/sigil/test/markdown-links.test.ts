import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every relative link in the repository's markdown, followed.
 *
 * SIG-33 deleted `docs/migrating-from-cli-kit.md` and left a link to it at the
 * end of `getting-started.md`, and only review caught it: `guides.test.ts` runs a
 * guide's code and never looks at its links. The likelier break is quieter than
 * a deleted file, too -- `getting-started.md` links into `../README.md#...` nine
 * times, and renaming a README heading takes one of those away with nothing to
 * say so.
 *
 * So a link has to land: on a file git has or is about to have, and, when it
 * carries a `#fragment`, on a heading in the markdown file it points into.
 * `http(s):` and `mailto:` are skipped, because this needs no network; any other
 * scheme, an absolute path, or a path out of the repository fails, so that one is
 * a decision rather than something nobody checked.
 *
 * It is every markdown file git has rather than a list, and that is cheaper than
 * it sounds: when it was written the tree held some three hundred relative links
 * and none of them was dead -- the `AGENTS.md` files and `docs/history/`
 * included, which link to each other by file and cost nothing to keep honest. A
 * list is a list somebody forgets to add a README to. It lives here rather than
 * beside the guides because it is a property of the tree, like
 * `sources.test.ts`, and needs no build.
 *
 * A fragment is matched against the slug GitHub gives a heading, which was
 * checked against GitHub's own rendering of every markdown file here rather
 * than written from memory -- see `slug()`. Setext headings, `<a id>` anchors
 * and `<a href>` links are not read, since nothing here uses them: a fragment
 * aimed at one of the first two fails loudly, and the third is not checked.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Everything git tracks or would add, as git spells it: `/`-separated on every
 * platform, which is also how a link spells it. Untracked files count so that a
 * new guide can be linked before it is staged; ignored ones do not, because
 * `dist/` exists on the machine that built it and nowhere a reader is.
 */
function files(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    maxBuffer: 1 << 24,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/**
 * A markdown file as LF, whatever the checkout gave it -- `.gitattributes`
 * leaves `.md` to `text=auto`, so Windows checks it out CRLF.
 */
function read(name: string): string | undefined {
  try {
    return readFileSync(join(root, name), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // tracked and deleted but not yet staged, which is not this test's business
    return undefined;
  }
}

/** Every character but a newline as a space, so that offsets keep their line. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * The file with every fenced block blanked. A fence closes on a run of the same
 * character at least as long as the one that opened it, which is what lets a
 * four-backtick block show a three-backtick one.
 */
function withoutFences(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === undefined) {
        if (marker === undefined) {
          return line;
        }
        fence = marker;
      } else if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined;
      }
      return blank(line);
    })
    .join('\n');
}

/**
 * A code span: a run of backticks that no backslash escapes, to the next run of
 * exactly as many within the same paragraph -- so a stray backtick cannot
 * swallow the rest of the file.
 */
const CODE = /(?<![`\\])(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?)(?<!`)\1(?!`)/g;

/** The file with fences, code spans and HTML comments blanked. */
function prose(markdown: string): string {
  return withoutFences(markdown)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(CODE, blank);
}

/** The entities a heading here might plausibly spell; any other is left as typed. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** Stands in for an escaped `_` while emphasis is taken out, so it is not taken too. */
const UNDERSCORE = '';

/**
 * A heading's text as GitHub renders it, before it is slugged. A code span keeps
 * its content verbatim. Outside one: a backslash escape is the character it
 * escapes, a link is its text, an image and a tag are nothing, an entity is
 * decoded, and `_` emphasis loses its delimiters -- `_options_` is `options`,
 * while `snake_case` and the unpaired `_` in `score_` stay as they are.
 */
function headingText(raw: string): string {
  const inline = (text: string) =>
    text
      .replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => (char === '_' ? UNDERSCORE : char))
      .replace(/<[^>]+>/g, '')
      .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.*?\S)\1(?![\p{L}\p{N}_])/gu, '$2')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&([a-z]+);/g, (entity, name: string) => ENTITIES[name] ?? entity)
      .replaceAll(UNDERSCORE, '_');

  // a link first, since its text may hold a code span and its destination must
  // not survive as words
  const linked = raw.replace(
    /(!?)\[((?:[^\]`]|`[^`]*`)*)\]\([^)]*\)/g,
    (_, image: string, text: string) => (image ? '' : text)
  );

  let text = '';
  let at = 0;
  for (const match of linked.matchAll(CODE)) {
    text += inline(linked.slice(at, match.index)) + match[2]!;
    at = match.index + match[0].length;
  }
  return text + inline(linked.slice(at));
}

/**
 * GitHub's heading slug: lowercase, then everything dropped but what Unicode
 * calls a word character -- alphabetic, a mark, a decimal digit, connector
 * punctuation, a joiner -- and `-` and the space, and each space a `-`. Not each
 * run of spaces, so `` `x` — y `` is `x--y` once the dash has gone.
 *
 * Read off GitHub's own rendering rather than written from memory: every
 * heading of every markdown file in this repository, 787 of them, slugs to the
 * id GitHub gave it, and so does a scratch file of the cases the repository does
 * not have yet. That is where each part of the class comes from -- `é`, `ß`,
 * `日本語` and the circled `Ⓐ` are kept and `İ` lowercases to `i̇`; `½` and `²`
 * are numbers but not digits and go, as does an emoji, while the zero-width
 * joiner inside one stays; an `&amp;` goes and `caf&eacute;` is `café`, which is
 * the one case here that stays wrong, since only `ENTITIES` is decoded.
 */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Every heading's fragment. A repeat gets `-1`, `-2`, skipping any suffix a
 * heading already claimed, so `Dup`, `Dup-1`, `Dup` is `dup`, `dup-1`, `dup-2`
 * and `Dup`, `Dup`, `Dup-1` is `dup`, `dup-1`, `dup-1-1` -- both as GitHub has it.
 */
function anchors(markdown: string): Set<string> {
  const taken = new Map<string, number>();
  for (const match of withoutFences(markdown).matchAll(
    /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm
  )) {
    const base = slug(headingText(match[1]!));
    let id = base;
    while (taken.has(id)) {
      const count = taken.get(base)! + 1;
      taken.set(base, count);
      id = `${base}-${count}`;
    }
    taken.set(id, 0);
  }
  return new Set(taken.keys());
}

interface Link {
  readonly line: number;
  readonly target: string;
}

/** Every inline link and image, and every reference definition, outside code. */
function links(markdown: string): Link[] {
  const text = prose(markdown);
  const found: { index: number; target: string }[] = [];
  for (const match of text.matchAll(/\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)/g)) {
    found.push({ index: match.index, target: match[1]!.replace(/^<(.*)>$/, '$1') });
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    found.push({ index: match.index, target: match[1]!.replace(/^<(.*)>$/, '$1') });
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, target }) => ({
      line: text.slice(0, index).split('\n').length,
      target,
    }));
}

/**
 * What is wrong with one link, or `undefined` when it lands.
 *
 * @param from - The file the link is in, as git spells it.
 * @param target - The link's destination, as written.
 * @param known - Every file git has, and every directory holding one.
 * @param headings - The fragments of a markdown file, as git spells it.
 */
function check(
  from: string,
  target: string,
  known: ReadonlySet<string>,
  headings: (name: string) => ReadonlySet<string> | undefined
): string | undefined {
  if (/^(?:https?|mailto):/i.test(target)) {
    return undefined;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    return 'has a scheme this does not follow';
  }

  const hash = target.indexOf('#');
  let path: string;
  let fragment: string | undefined;
  try {
    path = decodeURI(hash === -1 ? target : target.slice(0, hash));
    fragment = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  } catch {
    return 'is not a well-formed URL';
  }
  if (posix.isAbsolute(path)) {
    return 'is absolute, which means something different on GitHub and on npm';
  }

  const resolved = path === '' ? from : posix.join(posix.dirname(from), path).replace(/\/$/, '');
  if (resolved === '..' || resolved.startsWith('../')) {
    return 'points out of the repository';
  }
  if (!known.has(resolved)) {
    return `points at ${resolved}, which does not exist`;
  }
  if (fragment === undefined) {
    return undefined;
  }

  // a directory renders its README, so that is where a fragment on one lands
  const page = known.has(`${resolved}/README.md`) ? `${resolved}/README.md` : resolved;
  const found = headings(page);
  if (found === undefined) {
    return `has a fragment into ${page}, which is not markdown`;
  }
  if (!found.has(fragment)) {
    return `points at #${fragment}, which is no heading in ${page}`;
  }
  return undefined;
}

describe('links in markdown', () => {
  const all = files();
  const known = new Set(all);
  for (const name of all) {
    for (let dir = posix.dirname(name); dir !== '.'; dir = posix.dirname(dir)) {
      known.add(dir);
    }
  }
  const markdown = all.filter((name) => name.endsWith('.md'));

  const cache = new Map<string, Set<string>>();
  const headings = (name: string) => {
    if (!name.endsWith('.md')) {
      return undefined;
    }
    let found = cache.get(name);
    if (found === undefined) {
      found = anchors(read(name) ?? '');
      cache.set(name, found);
    }
    return found;
  };

  it('should have found them, so that this is testing something', () => {
    // a reader that stopped matching would pass every case below
    expect(markdown).toContain('packages/sigil/docs/getting-started.md');
    expect(markdown).toContain('packages/sigil/README.md');
    let relative = 0;
    let fragments = 0;
    for (const name of markdown) {
      for (const { target } of links(read(name) ?? '')) {
        if (!/^(?:https?|mailto):/i.test(target)) {
          relative++;
          fragments += target.includes('#') ? 1 : 0;
        }
      }
    }
    expect(relative).toBeGreaterThan(200);
    expect(fragments).toBeGreaterThan(30);
  });

  it('should resolve, to a file and to a heading', () => {
    const dead: string[] = [];
    for (const name of markdown) {
      const text = read(name);
      if (text === undefined) {
        continue;
      }
      for (const { line, target } of links(text)) {
        const problem = check(name, target, known, headings);
        if (problem !== undefined) {
          dead.push(`${name}:${line}: (${target}) ${problem}`);
        }
      }
    }
    expect(dead, dead.join('\n')).toEqual([]);
  });
});

describe('what links in markdown are read as', () => {
  it('should slug a heading the way GitHub does', () => {
    // every id on the right is one GitHub rendered for the heading on the left:
    // the first four from this repository's own files, the rest from a scratch
    // file pushed to a throwaway branch for the purpose
    const rendered: [string, string][] = [
      ['### `main(opts)`', 'mainopts'],
      ['### `sigil/updates`', 'sigilupdates'],
      [
        '### `errorHandler`, `renderError`, `errorExitCode`',
        'errorhandler-rendererror-errorexitcode',
      ],
      ['## Deliberate decisions — do not "fix" these', 'deliberate-decisions--do-not-fix-these'],
      ['# Café déjà vu 🚀 rocket', 'café-déjà-vu--rocket'],
      ['## İstanbul ß ÅNGSTRÖM Ελληνικά 日本語', 'i̇stanbul-ß-ångström-ελληνικά-日本語'],
      ['# Nums ½ ² Ⓐ Ⅻ ٣ x‌y', 'nums---ⓐ-ⅻ-٣-x‌y'],
      ['## Emoji :tada: 👍🏽 👨‍👩‍👧 ✔︎ done', 'emoji-tada--‍‍-︎-done'],
      [
        '## a_b *em* _em2_ __strong__ [link](x) ![img](y.png) & <b>bold</b> -- dash',
        'a_b-em-em2-strong-link---bold----dash',
      ],
      [
        '## `__proto__` and _options_ and snake_case_name',
        '__proto__-and-options-and-snake_case_name',
      ],
      ['## Under_score_ _lead and trail_ x', 'under_score_-lead-and-trail-x'],
      ['## Escaped \\_under\\_ \\* \\# \\`tick\\`', 'escaped-_under_---tick'],
      ['## Link [`code` in it](z) and \\`not code\\`', 'link-code-in-it-and-not-code'],
      ['## nb&nbsp;sp and nb sp &#169; &#x41;B', 'nbsp-and-nbsp--ab'],
      ['## Tabs\tand  double  spaces', 'tabsand--double--spaces'],
      ['## Numbers 1.2.3 v2 (beta) [x] {y} <z>', 'numbers-123-v2-beta-x-y-'],
      ['## Trailing hashes ##', 'trailing-hashes'],
    ];
    for (const [heading, id] of rendered) {
      expect([...anchors(heading)], heading).toEqual([id]);
    }

    const ids = (markdown: string) => [...anchors(markdown)];
    expect(ids('## Dup\n\n## Dup\n\n## Dup-1')).toEqual(['dup', 'dup-1', 'dup-1-1']);
    expect(ids('## Dup\n\n## Dup-1\n\n## Dup')).toEqual(['dup', 'dup-1', 'dup-2']);
    expect(ids('## Dup\n\n## Dup\n\n## Dup')).toEqual(['dup', 'dup-1', 'dup-2']);
  });

  it('should not read a heading or a link out of code', () => {
    const markdown = [
      '```sh',
      '# a comment, not a heading',
      '[not](a-link.md)',
      '```',
      '',
      '````md',
      '```',
      '[still](not-a-link.md)',
      '```',
      '````',
      '',
      'An `[inline](span.md)` and ``a `[double](span.md)` one``.',
      '<!-- [a comment](gone.md) -->',
      '[real](real.md) and ![image](image.png "title")',
      '',
      '[ref]: ./ref.md',
    ].join('\n');
    expect([...anchors(markdown)]).toEqual([]);
    expect(links(markdown)).toEqual([
      { line: 14, target: 'real.md' },
      { line: 14, target: 'image.png' },
      { line: 16, target: './ref.md' },
    ]);
  });

  it('should name what is wrong with a link', () => {
    const known = new Set(['a.md', 'b', 'b/README.md', 'b/x.ts']);
    const headings = (name: string) =>
      name.endsWith('.md') ? new Set(name === 'a.md' ? ['top'] : ['readme']) : undefined;
    const problem = (target: string) => check('a.md', target, known, headings);

    expect(problem('https://example.com/nowhere')).toBeUndefined();
    expect(problem('mailto:somebody@example.com')).toBeUndefined();
    expect(problem('#top')).toBeUndefined();
    expect(problem('a.md#top')).toBeUndefined();
    expect(problem('./b/')).toBeUndefined();
    expect(problem('b#readme')).toBeUndefined();

    expect(problem('#nope')).toBe('points at #nope, which is no heading in a.md');
    expect(problem('c.md')).toBe('points at c.md, which does not exist');
    expect(problem('b/x.ts#L1')).toBe('has a fragment into b/x.ts, which is not markdown');
    expect(problem('../a.md')).toBe('points out of the repository');
    expect(problem('/a.md')).toMatch(/^is absolute/);
    expect(problem('ftp://example.com')).toBe('has a scheme this does not follow');
  });
});
