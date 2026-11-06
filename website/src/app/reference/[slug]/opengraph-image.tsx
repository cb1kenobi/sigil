/**
 * Every command's page shares the reference section's card.
 *
 * This file exists because of how metadata merges: a page that sets its own
 * `openGraph` (see `pageMetadata()`) replaces the whole object its parent
 * segment built, and the parent's `opengraph-image` is part of that object. A
 * file here puts the card back on the page that would otherwise have none, and
 * is also the place a card per command would go.
 */
export { alt, contentType, default, size } from '../opengraph-image';
// the same set as the page's, so the cards are built with it rather than per request
export { generateStaticParams } from './page';
