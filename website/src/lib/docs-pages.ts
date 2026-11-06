import {
  COMPONENTS_LEDE,
  componentCapture,
  describeComponent,
  exampleSource,
  hasLineForm,
  takesSignal,
  viewRows,
  type OptionDoc,
} from './component-data.ts';
import {
  OPTIONS_INTRO,
  SHARED_OPTIONS,
  cap,
  keyLines,
  keysNote,
  relatedOf,
  viewLabels,
} from './component-text.ts';
import {
  COMPONENTS_HREF,
  FAMILIES,
  componentEntry,
  componentHref,
  componentsOf,
  family,
  type ComponentEntry,
} from './components.ts';
import { componentFamilies, docsSidebar } from './docs-sidebar.ts';
import { guideLink } from './guide-links.ts';
import { markdownPages, type Guide } from './guides.ts';
import { fence } from './markdown-doc.ts';
import type { SidebarSection } from './nav.ts';
import { referenceDoc, referenceHref, referenceLink, type ReferenceDoc } from './reference.ts';
import { repoFileUrl } from './site.ts';
import { commandRow, plainText } from './terminal-rows.ts';

/**
 * Every docs page the site builds, as Markdown: the one loader of what the docs
 * say, for every reader that wants them as text rather than as a page.
 *
 * Two read it. Site search (SIG-254, `search-records.ts`) indexes the guides and
 * the command reference from it, and the Markdown corpus (SIG-267, `llms.ts`)
 * serves every page as a `.md` and concatenates them into `llms-full.txt`. Each
 * part of the site is one function below, reading what its route reads -- a
 * guide through `guide()`, a command through `referenceDoc()`, a component
 * through its capture -- so neither reader can say something about a page the
 * page does not.
 *
 * ## What a page's markdown is
 *
 * The page's content with its title as the `h1`, and nothing from the site
 * around it: no sidebar, no breadcrumb, no rail, no "Edit on GitHub". A guide
 * and a command page are their own source, which is already Markdown. A
 * component page is generated, so it is written out here from the same capture
 * and the same words (`component-text.ts`) the page draws: the output as
 * ` ```console ` blocks with the colour taken out, the options and the keys as
 * GFM tables.
 *
 * Links are left as each source writes them, with `link` saying where each goes
 * on the site -- the same function the rendered page hands its renderer -- so a
 * reader decides what a link should be for its own use: search ignores them,
 * and the corpus makes them absolute.
 *
 * ## Which pages, in what order
 *
 * The docs sidebar's, in its order (`docsSections()`), and only those that
 * resolve: the sidebar names `/docs/about` before SIG-266 has built it, and a
 * page that is not there has no Markdown to give.
 */

/** What part of the site a page is. */
export type DocsPageKind = 'guide' | 'command' | 'components' | 'component';

/** One docs page, as Markdown. */
export interface DocsPage {
  readonly kind: DocsPageKind;
  /** The page's route. */
  readonly href: string;
  /** What the page is called, as its `h1` says it. */
  readonly title: string;
  /** What the page is, a sentence or two. */
  readonly description: string;
  /** The content, its title as the `h1`, with links as the source writes them. */
  readonly markdown: string;
  /** Where a link in `markdown` goes on the site, as the rendered page resolves it. */
  readonly link: (href: string) => string | undefined;
  /** For a command, the argv path it documents. */
  readonly argv?: readonly string[];
}

/** For markdown whose links are already the site's own routes. */
const sameLink = (href: string) => href;

// -------------------------------------------------------------------- guides

function guidePage(it: Guide, href: string): DocsPage {
  return {
    kind: 'guide',
    href,
    title: it.title,
    description: it.description,
    markdown: it.source,
    // relative to `packages/sigil/docs/`, where every guide is; About is in the
    // root `docs/`, so with SIG-266 this resolves from the file's own directory,
    // which `test/llms.test.ts` holds by following every link into the repository
    link: guideLink,
  };
}

// ----------------------------------------------------------------- reference

function commandPage(doc: ReferenceDoc): DocsPage {
  return {
    kind: 'command',
    href: referenceHref(doc.slug),
    title: doc.title,
    description: doc.description ?? '',
    markdown: doc.body,
    link: referenceLink,
    argv: doc.path,
  };
}

// ---------------------------------------------------------------- components

/** Text for a GFM table cell: a `|` would end the cell, a newline the row. */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/gu, ' ').replaceAll('|', '\\|');
}

/** A GFM table. */
function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [head, head.map(() => '---'), ...rows]
    .map((row) => `| ${row.map(cell).join(' | ')} |`)
    .join('\n');
}

/** The Default column of the options table, as the page has it. */
function defaultOf(option: OptionDoc): string {
  return option.optional ? (option.default ?? 'none') : 'required';
}

/** A console block of what a terminal showed, without its colour. */
function consoleBlock(text: string): string {
  return fence(text.replace(/\s+$/u, ''), 'console');
}

/**
 * One component's page, as Markdown: the sections the page has, in its order.
 *
 * @param entry - The component.
 * @returns The page.
 */
function componentMarkdown(entry: ComponentEntry): string {
  const captured = componentCapture(entry.slug);
  const { api } = captured;
  const out: string[] = [`# ${entry.name}`, ''];

  out.push(entry.lede ? `${describeComponent(entry)} ${entry.lede}` : describeComponent(entry), '');

  const facts = [
    `Family: ${family(entry.family).title}`,
    `Exports: ${entry.exports.map((name) => `\`${name}\``).join(', ')}, from \`@ttylabs/sigil/components\``,
  ];
  if (hasLineForm(entry.slug)) {
    facts.push('Accessible: asks on plain lines a screen reader reads, with `SIGIL_ACCESSIBLE=1`');
  }
  if (takesSignal(entry.slug)) {
    facts.push('Takes an `AbortSignal`');
  }
  if (entry.registry) {
    facts.push(`Copy it into your app with \`sigil add ${entry.registry}\``);
  }
  facts.push(`Source: ${repoFileUrl(captured.source)}`);
  out.push(...facts.map((fact) => `- ${fact}`), '');

  out.push('## Example', '', fence(exampleSource(entry.slug), `js title="${entry.slug}.mjs"`), '');
  for (const label of viewLabels(entry, captured.views)) {
    out.push(
      `### ${label.label}`,
      '',
      label.caption,
      '',
      consoleBlock(plainText(viewRows(label.view))),
      ''
    );
  }

  if (api.options.length > 0) {
    out.push('## Options', '', OPTIONS_INTRO, '', fence(api.signature, 'ts'), '');
    out.push(
      table(
        ['Option', 'Type', 'Default', 'What it does'],
        api.options.map((option) => [
          `\`${option.name}\``,
          `\`${option.type}\``,
          defaultOf(option),
          option.description,
        ])
      ),
      ''
    );
    if (api.shared.length > 0) {
      out.push(`${SHARED_OPTIONS} ${api.shared.map((name) => `\`${name}\``).join(', ')}.`, '');
    }
  }

  if (captured.keys && captured.keys.length > 0) {
    out.push(
      '## Keys',
      '',
      table(
        ['Keys', 'What they do'],
        keyLines(entry, captured.keys).map((line) => [line.keys.map(cap).join(', '), line.does])
      ),
      '',
      keysNote(entry, captured.keys),
      ''
    );
  }

  for (const recipe of entry.recipes ?? []) {
    const output = captured.recipes?.[recipe.id];
    out.push(`## ${recipe.title}`, '', recipe.body, '');
    out.push(fence(exampleSource(recipe.file), `js title="${recipe.file}.mjs"`), '');
    if (output) {
      out.push(consoleBlock(plainText([commandRow(recipe.command), ...viewRows(output)])), '');
    }
  }

  out.push('## Related', '');
  for (const it of relatedOf(entry)) {
    out.push(`- [${it.name}](${componentHref(it.slug)}): ${describeComponent(it)}`);
  }

  return `${out.join('\n')}\n`;
}

function componentPage(entry: ComponentEntry): DocsPage {
  return {
    kind: 'component',
    href: componentHref(entry.slug),
    title: entry.name,
    description: describeComponent(entry),
    markdown: componentMarkdown(entry),
    link: sameLink,
  };
}

/** The components index: each family, and each of its components in a line. */
function componentsIndexPage(): DocsPage {
  const out = ['# Components', '', COMPONENTS_LEDE, ''];

  for (const it of FAMILIES) {
    out.push(`## ${it.title}`, '', it.blurb, '');
    for (const entry of componentsOf(it.id)) {
      out.push(`- [${entry.name}](${componentHref(entry.slug)}): ${describeComponent(entry)}`);
    }
    out.push('');
  }

  return {
    kind: 'components',
    href: COMPONENTS_HREF,
    title: 'Components',
    description: COMPONENTS_LEDE,
    markdown: `${out.join('\n').trimEnd()}\n`,
    link: sameLink,
  };
}

// ---------------------------------------------------------------- resolution

/**
 * The docs page at a route, or nothing where the site has none.
 *
 * Each branch asks the source the route itself asks, so a page exists here
 * exactly when its route builds it: the markdown pages `markdownPages()`, the
 * components `COMPONENTS`, the reference the files in `src/reference/`. A segment is
 * matched against those lists and never joined onto a path, so nothing a URL
 * says can reach a file outside them.
 *
 * @param href - A route, without a fragment.
 * @returns The page.
 */
export function docsPage(href: string): DocsPage | undefined {
  const path = href.length > 1 ? href.replace(/\/+$/u, '') : href;
  const [root, first, second, ...rest] = path.split('/').slice(1);

  if (rest.length > 0) {
    return undefined;
  }

  if (root === 'reference' && second === undefined) {
    const slug = first === undefined ? 'index' : decodeURIComponent(first);
    if (first === 'index') {
      // the root command is at `/reference`, and one page has one address
      return undefined;
    }
    const doc = referenceDoc(slug);
    return doc && commandPage(doc);
  }

  if (root !== 'docs' || first === undefined) {
    return undefined;
  }

  if (path === COMPONENTS_HREF) {
    return componentsIndexPage();
  }
  if (first === 'components') {
    const entry = second === undefined ? undefined : componentEntry(second);
    return entry && componentPage(entry);
  }

  // a guide, or About once SIG-266 is in: every markdown file under `/docs/`
  const it = second === undefined ? markdownPages().find((page) => page.slug === first) : undefined;
  return it && guidePage(it, path);
}

/** One link of a docs section, and the page it is on. */
export interface DocsLink {
  readonly label: string;
  /** The link, with its `#fragment` if it has one. */
  readonly href: string;
  readonly page: DocsPage;
}

/** A section of the docs, as the sidebar labels it, with the pages that exist. */
export interface DocsSection {
  readonly id: SidebarSection['id'];
  readonly label: string;
  readonly links: readonly DocsLink[];
}

/**
 * The docs, section by section, as the sidebar has them.
 *
 * The sidebar's sections in its order, with each link resolved to its page and
 * a link to a page the site does not have left out, which is how About is not
 * here until SIG-266 builds it and is here the day it does, with nothing to
 * change. The Components section is the one that differs: the sidebar lists the
 * families as places on the index, and a component's own page is reached from
 * the component sidebar, so here it is the index and then every component in
 * the order the families list them.
 *
 * @returns The sections that have a page, in order.
 */
export function docsSections(): DocsSection[] {
  const sections: DocsSection[] = [];
  // the parser's sections are sixteen links to one page, which is read once
  const pages = new Map<string, DocsPage | undefined>();
  const pageAt = (href: string) => {
    if (!pages.has(href)) {
      pages.set(href, docsPage(href));
    }
    return pages.get(href);
  };

  for (const section of docsSidebar()) {
    const links =
      section.id === 'components'
        ? [
            { label: 'All components', href: COMPONENTS_HREF },
            ...componentFamilies().flatMap((it) => it.links),
          ]
        : section.links;

    const resolved = links.flatMap((link) => {
      const page = pageAt(link.href.split('#')[0]!);
      return page ? [{ label: link.label, href: link.href, page }] : [];
    });

    if (resolved.length > 0) {
      sections.push({ id: section.id, label: section.label ?? section.id, links: resolved });
    }
  }

  return sections;
}

/**
 * Every docs page, once each, in the order the sidebar reaches them.
 *
 * @returns The pages.
 */
export function docsPages(): DocsPage[] {
  const seen = new Set<string>();

  return docsSections()
    .flatMap((section) => section.links.map((link) => link.page))
    .filter((page) => !seen.has(page.href) && seen.add(page.href));
}
