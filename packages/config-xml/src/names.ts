/**
 * What a path segment is, and what is not a setting at all.
 *
 * Nothing in here is translated: it is read by every other module and throws
 * nothing. The refusals that *do* throw are in `read.ts`, and those are
 * translated, because a document is a user's.
 */

/** Where a namespace declaration lives, which is not a setting. */
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Where `xml:space` and `xml:lang` live, which are the spec's and not a setting. */
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** The node types this mapping reads, spelled out because a DOM constant is not in scope. */
export const ELEMENT_NODE = 1;
/** A text node. */
export const TEXT_NODE = 3;
/** A CDATA section, which is a text node wearing a different number. */
export const CDATA_NODE = 4;
/** A comment, which is trivia an insert has to step over rather than through. */
export const COMMENT_NODE = 8;

/**
 * Enough of a DOM element for this mapping, structurally.
 *
 * A structural interface rather than `@xmldom/xmldom`'s own types, which is the
 * shape `MouseSurface` and `InputStream` already take in the runtime: what this
 * module wants is four properties, and naming them is what lets a test hand over
 * a literal. It is also what keeps `@xmldom/xmldom`'s types out of this
 * package's published declarations, so a consumer on a different version of it
 * does not get a type error from ours.
 */
export interface XmlNode {
  readonly attributes?: ArrayLike<XmlAttr> | null;
  readonly childNodes?: ArrayLike<XmlNode> | null;
  readonly data?: string | null;
  readonly lineNumber?: number | null;
  readonly localName?: string | null;
  readonly nodeName?: string | null;
  readonly nodeType: number;
}

/** Enough of a DOM attribute for this mapping. */
export interface XmlAttr {
  readonly localName?: string | null;
  readonly namespaceURI?: string | null;
  /**
   * The qualified name, which a *write* needs where a read does not.
   *
   * `setAttributeNS(null, 'mode', ...)` on an element whose attribute is
   * `n:mode` adds a **second** attribute rather than updating the first --
   * which is the two-answers-for-one-setting this mapping refuses, created by
   * the write that was meant to keep the spelling. So an update is made against
   * the attribute's own namespace and qualified name.
   */
  readonly nodeName?: string | null;
  readonly value?: string | null;
}

/**
 * The attributes of an element that are settings.
 *
 * A namespace declaration and anything in the `xml` namespace are skipped,
 * **by namespace rather than by spelling**: `xmlns:n` has a `localName` of `n`,
 * so a prefix declaration would otherwise become a setting called `n`, and
 * `xml:space="preserve"` -- which is the spec's own answer to whitespace, and so
 * the one attribute an author is most likely to write here -- would become a
 * setting called `space`. Matching the URI is what makes that exact rather than
 * a guess at which names are reserved.
 *
 * @param el - The element.
 * @returns Its setting attributes.
 */
export function settingAttrs(el: XmlNode): XmlAttr[] {
  const out: XmlAttr[] = [];
  const list = el.attributes;

  for (let i = 0; i < (list?.length ?? 0); i++) {
    const at = (list as ArrayLike<XmlAttr>)[i] as XmlAttr;
    const ns = at.namespaceURI ?? null;
    if (ns === XMLNS_NS || ns === XML_NS) {
      continue;
    }
    out.push(at);
  }

  return out;
}

/** The element children of an element, in document order. */
export function elementChildren(el: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const list = el.childNodes;

  for (let i = 0; i < (list?.length ?? 0); i++) {
    const node = (list as ArrayLike<XmlNode>)[i] as XmlNode;
    if (node.nodeType === ELEMENT_NODE) {
      out.push(node);
    }
  }

  return out;
}

/** Everything a text or CDATA child of an element holds, concatenated. */
export function ownText(el: XmlNode): string {
  let out = '';
  const list = el.childNodes;

  for (let i = 0; i < (list?.length ?? 0); i++) {
    const node = (list as ArrayLike<XmlNode>)[i] as XmlNode;
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
      out += node.data ?? '';
    }
  }

  return out;
}

/**
 * The path segment a node or attribute names.
 *
 * The **local** name, so a prefix is not part of a path. That is this package's
 * own central argument applied one level in: a setting has one path whatever
 * store it came from, and a prefix is a document-level spelling decision --
 * `xmlns:n` against `xmlns:cfg` must not change which config key an app reads,
 * and a JSON layer has no prefix to shadow `n:port` with anyway.
 *
 * What it costs is that two differently-prefixed names with one local name
 * collide, which `read.ts` refuses the way it refuses an attribute and a child
 * of one name -- the same rule, met through a second door.
 *
 * @param node - The element or attribute.
 * @returns Its local name.
 */
export function nameOf(node: {
  readonly localName?: string | null;
  readonly nodeName?: string | null;
}): string {
  // `localName` is what every DOM sets and what `@xmldom/xmldom` sets for both
  // elements and attributes; `nodeName` is the fallback for a hand-written
  // literal in a test, which is what the structural interface is for
  return node.localName ?? node.nodeName ?? '';
}
