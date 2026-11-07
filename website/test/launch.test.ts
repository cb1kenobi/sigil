import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The pre-launch pass (SIG-273), as far as it can be held without a browser.
 *
 * What only a browser can see -- sideways scroll at 390px, the tab order, a
 * ring that an ancestor's `overflow` cuts off, touch target sizes, what still
 * moves under reduced motion -- is `scripts/check-pages.ts`, run by hand
 * against a served build. These are the parts of the same checklist that are
 * true or false of the source.
 */

const root = join(import.meta.dirname, '..');
const src = join(root, 'src');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const layout = read('src/app/layout.tsx');
const css = read('src/app/globals.css');

/** Every `.ts` and `.tsx` under `src/`. */
function sources(dir = src): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('accessibility', () => {
  it('should put a skip link to #main first in every page, ahead of the header', () => {
    const body = layout.slice(layout.indexOf('<body'));
    const skip = body.indexOf('<a\n          href="#main"');
    assert.ok(skip > 0, 'no skip link in the root layout');
    assert.ok(skip < body.indexOf('<SiteHeader />'), 'the skip link is not first');
    assert.match(body, /<main id="main"/u);
  });

  it('should have one header, one main and one footer, and no other element of the three', () => {
    const count = (tag: string) =>
      // an element, not a mention of one in a comment's backticks
      sources().filter((file) =>
        new RegExp(`(?<!\`)<${tag}[\\s>]`, 'u').test(readFileSync(file, 'utf8'))
      );
    assert.deepEqual(
      count('header').map((file) => relative(src, file)),
      ['components/site-header.tsx']
    );
    assert.deepEqual(
      count('main').map((file) => relative(src, file)),
      ['app/layout.tsx']
    );
    assert.deepEqual(
      count('footer').map((file) => relative(src, file)),
      ['components/site-footer.tsx']
    );
  });

  it('should label every nav, and name the three a docs page has Main, Documentation and On this page', () => {
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      for (const [, attributes] of text.matchAll(/<nav\b([^>]*)>/gu)) {
        assert.match(attributes ?? '', /aria-label(ledby)?=/u, relative(src, file));
      }
    }
    assert.match(read('src/components/site-header.tsx'), /<nav aria-label="Main"/u);
    assert.match(read('src/components/docs-sidebar.tsx'), /aria-label="Documentation"/u);
    assert.match(read('src/components/docs-rail.tsx'), /<nav\s+aria-label="On this page"/u);
  });

  it('should hide the decorative layers from assistive technology, and give them no text to copy', () => {
    for (const file of ['src/components/glow.tsx']) {
      const text = read(file);
      assert.match(text, /aria-hidden="true"/u, file);
      // one self-closing element: nothing inside it to read or to select
      assert.match(text, /<div\s[^>]*\/>/u, file);
    }
    // the seal is hidden unless it is given a title, and the hero's large one is not
    assert.match(read('src/components/seal.tsx'), /\{ 'aria-hidden': true \}/u);
    const hero = /<Seal\b[^>]*size=\{784\}[^>]*\/>/u.exec(read('src/app/page.tsx'))?.[0];
    assert.ok(hero, 'no large seal on the home page');
    assert.doesNotMatch(hero, /title=/u);
  });

  it('should name the icon-only links and buttons', () => {
    // the icon-only link's name is the default; About's button passes its own text
    const github = read('src/components/github-link.tsx');
    assert.match(github, /name = 'sigil on GitHub'/u);
    assert.match(github, /aria-label=\{name\}/u);
    const menu = read('src/components/mobile-nav.tsx');
    assert.match(menu, /aria-label="Open menu"/u);
    assert.match(menu, /aria-label="Close menu"/u);
  });

  it('should draw a 2px #B7A2FF ring on whatever takes focus, scrollers included', () => {
    assert.match(css, /--color-link: #b7a2ff;/u);
    // not a list of elements: Chrome makes a scrolling box focusable without a
    // `tabindex`, and a list would leave it the browser's own 1px ring
    assert.match(
      css,
      /:where\(:focus-visible\) \{\s*outline: 2px solid var\(--color-link\);\s*outline-offset: 2px;/u
    );
  });

  it('should give the install box and the component output tab semantics', () => {
    for (const file of [
      'src/components/install-command.tsx',
      'src/components/component-output.tsx',
    ]) {
      const text = read(file);
      for (const role of ['tablist', 'tab', 'tabpanel']) {
        assert.match(text, new RegExp(`role="${role}"`, 'u'), `${file}: ${role}`);
      }
      // the arrow keys, Home and End, from the one definition
      assert.match(text, /nextTabIndex\(/u, file);
      assert.match(text, /tabIndex=\{selected \? 0 : -1\}/u, file);
    }
  });

  it('should stop every transition and animation under prefers-reduced-motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(css)?.[1];
    assert.ok(block, 'no reduced-motion block in globals.css');
    assert.match(block, /animation-duration: 0s !important;/u);
    assert.match(block, /transition-duration: 0s !important;/u);
    assert.match(block, /scroll-behavior: auto !important;/u);
    // and nothing scrolls smoothly from script, which the stylesheet cannot stop
    for (const file of sources()) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /behavior: 'smooth'/u, relative(src, file));
    }
  });

  it('should pass every contrast pairing the contrast script checks', () => {
    const run = spawnSync(process.execPath, [join(root, 'scripts/check-contrast.ts')], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});

describe('performance', () => {
  /** The `src` of every `localFont()` in the root layout. */
  const declared = [...layout.matchAll(/'\.\.\/fonts\/([^']+\.woff2)'/gu)].map(([, file]) => file!);
  const fonts = readdirSync(join(src, 'fonts')).filter((file) => file.endsWith('.woff2'));

  it('should serve its fonts from the repository, never from Google at build time', () => {
    assert.match(layout, /from 'next\/font\/local'/u);
    for (const file of sources()) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /from 'next\/font\/google'/u,
        relative(src, file)
      );
    }
  });

  it('should swap every face in, and leave every face preloaded', () => {
    const calls = layout.split('localFont(').slice(1);
    assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.match(call, /display: 'swap'/u);
      assert.doesNotMatch(call, /preload: false/u);
    }
  });

  it('should ship only the faces the layout declares, and declare each one once', () => {
    // a vendored file nothing declares is dead weight in the repository, and a
    // declared face is preloaded on every page whether a page draws it or not --
    // which is why Barlow is the one weight the headings use (SIG-273)
    assert.deepEqual([...declared].sort(), [...fonts].sort());
    assert.equal(new Set(declared).size, declared.length);
    assert.deepEqual(
      declared.filter((file) => file.startsWith('barlow')),
      ['barlow-semi-condensed-latin-600.woff2']
    );
  });

  it('should keep the highlighter out of every client module and what they import', () => {
    /** Resolves an import specifier from `from` to a file under `src/`, or a bare package name. */
    const resolveImport = (from: string, specifier: string): string => {
      const base = specifier.startsWith('@/')
        ? join(src, specifier.slice(2))
        : specifier.startsWith('.')
          ? resolve(dirname(from), specifier)
          : undefined;
      if (!base) return specifier;
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
      }
      return base;
    };

    const client = sources().filter((file) =>
      readFileSync(file, 'utf8').startsWith("'use client';")
    );
    assert.ok(client.length > 5, 'found no client modules');

    const seen = new Set<string>();
    const reached: string[] = [];
    const walk = (file: string, path: string[]) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      // static imports and re-exports, but not `import type`, which is erased
      for (const [, specifier] of text.matchAll(
        /^(?:import|export)\s+(?!type\s)[^'"]*?from\s+'([^']+)'/gmu
      )) {
        const target = resolveImport(file, specifier!);
        const trail = [...path, relative(src, target)];
        if (/^shiki(\/|$)/u.test(target) || target === join(src, 'lib/highlight.ts')) {
          reached.push(trail.join(' -> '));
        } else if (target.startsWith(src) && existsSync(target)) {
          walk(target, trail);
        }
      }
    };
    for (const file of client) walk(file, [relative(src, file)]);

    assert.deepEqual(reached, []);
  });

  it('should load the search runtime only when search opens', () => {
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /^import[^;]*pagefind/mu, relative(src, file));
    }
    const search = read('src/components/search/site-search.tsx');
    // one dynamic import, built at call time so the bundler cannot follow it
    assert.equal(search.match(/await import\(/gu)?.length, 1);
    assert.match(search, /import\(\/\* webpackIgnore: true \*\/ url\)/u);
    // and the only caller that starts it is opening the dialog, or a query typed into it
    const show = search.slice(search.indexOf('const show = useCallback'));
    assert.match(show.slice(0, show.indexOf('}, []);')), /loadPagefind\(\)/u);
    assert.equal(search.match(/loadPagefind\(\)/gu)?.length, 3);
  });
});
