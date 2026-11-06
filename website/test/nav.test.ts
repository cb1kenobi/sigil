import { componentFamilies } from '../src/lib/docs-sidebar.ts';
import {
  NAV_ITEMS,
  activeSection,
  componentSidebar,
  isCurrentLink,
  isDocsPath,
  pagerAround,
  sidebarSections,
} from '../src/lib/nav.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the current section', () => {
  it('should be Docs on getting started and on any other docs page', () => {
    assert.equal(activeSection('/docs/getting-started'), 'docs');
    assert.equal(activeSection('/docs/parser/options'), 'docs');
    assert.equal(activeSection('/docs/about'), 'docs');
    assert.equal(activeSection('/docs'), 'docs');
  });

  it('should be Components under /docs/components, and not Docs as well', () => {
    assert.equal(activeSection('/docs/components'), 'components');
    assert.equal(activeSection('/docs/components/spinner'), 'components');
  });

  it('should be CLI for the command reference and its pages', () => {
    assert.equal(activeSection('/reference'), 'cli');
    assert.equal(activeSection('/reference/add'), 'cli');
  });

  it('should be Examples for the examples page', () => {
    assert.equal(activeSection('/examples'), 'examples');
    assert.equal(activeSection('/examples/spinner'), 'examples');
  });

  it('should be none on the home page and on a page outside every section', () => {
    assert.equal(activeSection('/'), undefined);
    assert.equal(activeSection('/nope'), undefined);
  });

  it('should match on a path segment, not on a prefix', () => {
    assert.equal(activeSection('/docs-archive'), undefined);
    assert.equal(activeSection('/references'), undefined);
    assert.equal(activeSection('/docs/components-old'), 'docs');
    assert.equal(activeSection('/examples2'), undefined);
  });

  it('should ignore a trailing slash', () => {
    assert.equal(activeSection('/docs/components/'), 'components');
    assert.equal(activeSection('/reference/'), 'cli');
  });

  it('should be reachable from every nav item, and from no two', () => {
    for (const item of NAV_ITEMS) {
      assert.equal(activeSection(item.href), item.section, item.href);
    }
    assert.equal(new Set(NAV_ITEMS.map((item) => item.section)).size, NAV_ITEMS.length);
  });
});

describe('the header width', () => {
  it('should follow the docs layout for docs pages and no others', () => {
    assert.equal(isDocsPath('/docs/getting-started'), true);
    assert.equal(isDocsPath('/docs/components/spinner'), true);
    // the index has no sidebar, and is as wide as the pages that have none
    assert.equal(isDocsPath('/docs/components'), false);
    assert.equal(isDocsPath('/docs/components/'), false);
    assert.equal(isDocsPath('/'), false);
    // the command reference has the sidebar and the rail, so it is as wide
    assert.equal(isDocsPath('/reference'), true);
    assert.equal(isDocsPath('/reference/add'), true);
    assert.equal(isDocsPath('/references'), false);
    assert.equal(isDocsPath('/examples'), false);
    assert.equal(isDocsPath('/docs-archive'), false);
  });
});

describe('the sidebar', () => {
  const sections = sidebarSections({
    commands: [{ label: 'sigil add', href: '/reference/add' }],
    guides: [{ label: 'Getting started', href: '/docs/getting-started' }],
    parser: [{ label: 'Commands', href: '/docs/parser#commands' }],
  });

  it('should be Docs, Parser, CLI, Components and About, in that order', () => {
    assert.deepEqual(
      sections.map((section) => section.id),
      ['docs', 'parser', 'cli', 'components', 'about']
    );
    assert.deepEqual(
      sections.map((section) => section.label),
      ['Docs', 'Parser', 'CLI', 'Components', 'About']
    );
  });

  it('should set the commands in mono and nothing else', () => {
    for (const section of sections) {
      for (const link of section.links) {
        assert.equal(link.mono === true, section.id === 'cli', link.href);
      }
    }
  });

  it('should link Components and About to the pages other tickets build', () => {
    const hrefs = sections.flatMap((section) => section.links.map((link) => link.href));

    for (const href of [
      '/docs/components#prompts',
      '/docs/components#output',
      '/docs/components#fullscreen',
      '/docs/components',
      '/docs/about',
    ]) {
      assert.ok(hrefs.includes(href), href);
    }
  });

  it('should mark a page as the current one and a place on a page as never', () => {
    const [guide] = sections[0]!.links;
    const [part] = sections[1]!.links;

    assert.equal(isCurrentLink(guide!, '/docs/getting-started'), true);
    assert.equal(isCurrentLink(guide!, '/docs/getting-started/'), true);
    assert.equal(isCurrentLink(guide!, '/docs/parser'), false);
    assert.equal(isCurrentLink(part!, '/docs/parser'), false);
  });

  it('should have every link in it go somewhere that is a page or a place on one', () => {
    for (const section of sections) {
      for (const link of section.links) {
        assert.match(link.href, /^\/[a-z/-]*(#[a-z-]+)?$/, link.href);
      }
    }
  });
});

describe("a component page's sidebar", () => {
  const families = componentFamilies();

  it("should be the way back to the index, then the component's family with it marked", () => {
    const scoped = componentSidebar(families, '/docs/components/select/');

    assert.deepEqual(
      scoped?.map((section) => section.id),
      ['all-components', 'prompts']
    );
    assert.deepEqual(scoped?.[0]?.links, [{ label: '← All components', href: '/docs/components' }]);
    assert.equal(scoped?.[1]?.label, 'Prompts');
    assert.ok(
      scoped?.[1]?.links.some((link) => isCurrentLink(link, '/docs/components/select')),
      'select() is marked'
    );
  });

  it('should list a family in the order the index does, set in mono', () => {
    const output = componentSidebar(families, '/docs/components/table')?.[1];

    assert.equal(output?.id, 'output');
    assert.ok(output?.links.every((link) => link.mono));
    assert.equal(output?.links[0]?.href, '/docs/components/log');
  });

  it('should leave every other page the whole sidebar', () => {
    for (const path of ['/docs/components', '/docs/getting-started', '/reference/add']) {
      assert.equal(componentSidebar(families, path), undefined, path);
    }
  });
});

describe('the previous and next pages', () => {
  const links = ['a', 'b', 'c'].map((label) => ({ label, href: `/${label}` }));

  it('should be the neighbours within the section', () => {
    assert.deepEqual(pagerAround(links, '/b'), {
      previous: { title: 'a', href: '/a' },
      next: { title: 'c', href: '/c' },
    });
  });

  it('should have no previous on the first page and no next on the last', () => {
    assert.equal(pagerAround(links, '/a').previous, undefined);
    assert.equal(pagerAround(links, '/c').next, undefined);
  });

  it('should have neither for a page that is not in the section', () => {
    assert.deepEqual(pagerAround(links, '/nope'), {});
  });
});
