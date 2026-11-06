import { DocsPage } from '@/components/docs-page';
import { guideLink } from '@/lib/guide-links';
import { about } from '@/lib/guides';
import { ABOUT_HREF, guideHref } from '@/lib/nav';
import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { posix } from 'node:path';

export function generateMetadata(): Metadata {
  const it = about();

  return pageMetadata({ path: ABOUT_HREF, title: it.title, description: it.description });
}

/**
 * `/docs/about`: the story of sigil and how it is made (SIG-266).
 *
 * A route of its own beside `/docs/[slug]` rather than a guide, because it is
 * not in the Docs section's reading order and has no Previous or Next: it is
 * the sidebar's last section, on its own, and the footer's "TTY Labs". The
 * content is `docs/about.md` (`about()`), read and drawn the way a guide is, so
 * the page is its markdown and nothing here adds a word to it. Its links are
 * relative to that file, so they hold on GitHub as well.
 */
export default function About() {
  const it = about();
  const from = posix.dirname(it.repoPath);

  return (
    <DocsPage
      crumbs={[{ label: 'Docs', href: guideHref('getting-started') }, { label: it.title }]}
      headings={it.sections.filter((section) => section.id !== '')}
      link={(href) => guideLink(href, from)}
      pager={{}}
      repoPath={it.repoPath}
      source={it.source}
      title={it.title}
      wide
    />
  );
}
