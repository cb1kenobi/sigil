/** Plain text where the title had to be trimmed off, HTML otherwise. */
export type Detail = { html: string } | { text: string } | null;

/** A string as a regular expression that matches only itself. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** What Pagefind escapes in an excerpt, so the plain-text branch shows the characters. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

/**
 * Turns Pagefind's excerpt into the line shown under a result.
 *
 * Ported from titaniumsdk.com. A record's indexed text starts with its own
 * title, and a command's or an option's then repeats its last word --
 * `sigil build --out --out ...` -- because that is what makes a search for
 * `--out` find the option rather than a page mentioning it (see
 * `search-records.ts`). The excerpt therefore opens by repeating the title that
 * is already on the line above. Where that happens the prefix is dropped and
 * the rest shown as plain text; the title is the match, so losing the `<mark>`
 * costs nothing. Prose excerpts do not start with their title and keep their
 * highlighting.
 *
 * The excerpt is HTML, so its text is escaped: `npm run dev -- <arguments>`
 * arrives as `&lt;arguments&gt;`. The plain-text branch is drawn as text, so it
 * unescapes first, or the reader would see the entity. titaniumsdk.com did not,
 * and showed it.
 *
 * @param title - The result's title.
 * @param excerpt - Pagefind's excerpt: text, with `<mark>` around what matched.
 * @returns What to show, or nothing.
 */
export function resultDetail(title: string, excerpt: string): Detail {
  if (!excerpt) return null;
  const text = excerpt
    .replace(/<[^>]+>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|#39|#x27);/gu, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/gu, ' ')
    .trim();
  const last = title.split(/[\s.]+/u).pop() ?? '';
  const prefix = new RegExp(`^${literal(title)}\\s*(${literal(last)}\\s*)?`, 'iu');
  const trimmed = text.replace(prefix, '').trim();
  if (trimmed !== text) return trimmed ? { text: trimmed } : null;
  return { html: excerpt };
}
