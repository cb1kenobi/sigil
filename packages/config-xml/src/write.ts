import {
  CDATA_NODE,
  COMMENT_NODE,
  ELEMENT_NODE,
  elementChildren,
  nameOf,
  settingAttrs,
  TEXT_NODE,
  type XmlAttr,
  type XmlNode,
} from './names.js';
import { readElement, type ReadShape } from './read.js';
import { isPlainObject } from '@ttylabs/sigil/config';

/**
 * Mutating a DOM so that it says what a value says, touching nothing else.
 *
 * ## Diff first, which is a correctness rule rather than an optimization
 *
 * The obvious mechanism -- walk the value, find or create each node, set it --
 * **corrupts the file**. Measured: assigning `textContent` to a CDATA-bearing
 * element *with the string it already holds* turns
 * `<banner><![CDATA[<b>hi</b>]]></banner>` into
 * `<banner>&lt;b&gt;hi&lt;/b&gt;</banner>`, because the assignment replaces the
 * CDATA section with a text node. So a walk that sets unconditionally destroys
 * every CDATA section in the file on any write, including for keys nobody
 * touched. Found by review, and it is the same rule the JSONC writer keeps for
 * the same reason: touch only what changed.
 *
 * The diff is structural rather than careful. What the DOM currently says is
 * read back through `readElement()` -- the **same** mapping the store reads with
 * -- and a subtree whose current value equals its target is skipped whole. So
 * the write cannot come to disagree with the read about what a path means,
 * which is the drift two separate walks would produce.
 *
 * ## And the comparison is at the level of the bytes
 *
 * A layer's value has been through `coerceLayer()`, so an `int` setting holds
 * the **number** `8080` where the document holds the string `'8080'`. Comparing
 * those as values says they differ, and then every typed setting is rewritten on
 * every save -- which is the CDATA defect again, arriving through the schema
 * rather than through a careless walk. So a scalar is compared as the text it
 * would be written as, because the question this diff asks is whether the bytes
 * have to change.
 *
 * ## The spelling follows the DOM where it fits, and the value where it does not
 *
 * A setting already spelled as an attribute stays an attribute and one spelled
 * as an element stays an element -- the DOM is what remembers which, which is
 * what makes a round trip clean and is why a sentinel mapping was refused. An
 * attribute holds a string and nothing else, so a value that is an object or a
 * list at a path currently spelled as an attribute **promotes**: the attribute
 * is removed and elements are written. Which is the general statement -- an
 * element can hold anything and an attribute is the special case this store
 * preserves where it still fits -- rather than the `setAttribute('server',
 * '[object Object]')` a review round measured.
 *
 * A key with no existing spelling becomes a child **element**, which is the
 * conservative half: an element can hold a scalar, an object or a list, so it is
 * the one answer that never has to be promoted later.
 *
 * Nothing in here is translated: what it throws is about a value the **app**
 * handed over, which is the line `represent.ts` and `dotted.ts` already draw.
 */

/** Enough of a DOM document to mutate one, structurally. */
export interface XmlDoc {
  createCDATASection(data: string): XmlNode;
  createElementNS(ns: string | null, qualified: string): XmlNode;
  createTextNode(data: string): XmlNode;
}

/** Enough of a mutable DOM element. */
export interface XmlEl extends XmlNode {
  appendChild(node: XmlNode): unknown;
  getAttributeNS(ns: string | null, name: string): string | null;
  insertBefore(node: XmlNode, before: XmlNode | null): unknown;
  readonly namespaceURI?: string | null;
  readonly nextSibling?: XmlNode | null;
  readonly ownerDocument?: XmlDoc | null;
  readonly parentNode?: XmlEl | null;
  readonly prefix?: string | null;
  readonly previousSibling?: XmlNode | null;
  removeAttributeNS(ns: string | null, name: string): unknown;
  removeChild(node: XmlNode): unknown;
  setAttributeNS(ns: string | null, qualified: string, value: string): unknown;
}

/** The indentation a document that names none gets, which is the house default. */
const DEFAULT_STEP = '  ';

/**
 * The text a scalar is written as.
 *
 * A `Date` is the one non-plain object that gets through `canRepresent()`, and
 * its ISO form is why: `transformValue(iso, 'date')` reads one back, so a
 * `Date` really does round-trip where a `Map` or a class instance reaches the
 * file as `[object Map]`. Which is the same reasoning `jsonCanHold()` records
 * for letting a `toJSON` through, narrowed to the one case the schema can read.
 */
export function textFor(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Whether the DOM already says what the target says.
 *
 * Scalars through `textFor()`, for the reason above. An array and an object
 * structurally, because that is what decides whether a subtree may be skipped.
 */
function same(current: unknown, target: unknown): boolean {
  if (Array.isArray(target)) {
    return (
      Array.isArray(current) &&
      current.length === target.length &&
      target.every((it, i) => same(current[i], it))
    );
  }

  if (isPlainObject(target)) {
    if (!isPlainObject(current)) {
      return false;
    }
    const keys = Object.keys(target);
    return (
      keys.length === Object.keys(current).length &&
      keys.every((key) => Object.hasOwn(current, key) && same(current[key], target[key]))
    );
  }

  return typeof current === 'string' && current === textFor(target);
}

/** The attribute node for a setting of this name, or nothing. */
function attrNamed(el: XmlNode, name: string): XmlAttr | undefined {
  return settingAttrs(el).find((at) => nameOf(at) === name);
}

/** The element children of this name, in document order. */
function childrenNamed(el: XmlEl, name: string): XmlEl[] {
  return elementChildren(el).filter((child) => nameOf(child) === name) as XmlEl[];
}

/** The whitespace after the last line break in the text just before a node. */
function indentBefore(node: XmlEl): string | undefined {
  const prev = node.previousSibling;
  if (!prev || prev.nodeType !== TEXT_NODE) {
    return undefined;
  }
  const data = prev.data ?? '';
  const at = Math.max(data.lastIndexOf('\n'), data.lastIndexOf('\r'));
  return at === -1 ? undefined : data.slice(at + 1);
}

/**
 * One level of indentation, read off the document.
 *
 * The first element whose own indent is longer than its parent's says what a
 * step is, which is the user's own answer rather than this package's. A
 * document with no line break in its layout -- `<a><b>1</b></a>` -- has none,
 * and then an insert stays on the line it is already on, which is what keeps a
 * single-line document single-line.
 */
function stepOf(root: XmlEl): string | undefined {
  const walk = (el: XmlEl, outer: string): string | undefined => {
    for (const child of elementChildren(el) as XmlEl[]) {
      const inner = indentBefore(child);
      if (inner !== undefined && inner.startsWith(outer) && inner.length > outer.length) {
        return inner.slice(outer.length);
      }
      const deeper = walk(child, inner ?? outer);
      if (deeper !== undefined) {
        return deeper;
      }
    }
    return undefined;
  };

  return walk(root, indentBefore(root) ?? '');
}

/**
 * Whether anything in the document is laid out on its own line.
 *
 * **Layout** whitespace rather than any line break: a text node that is nothing
 * but whitespace and holds a break is a document laid out across lines, and a
 * break *inside a value* is content. Without the distinction a single-line
 * document holding a multi-line CDATA section reads as laid out, and then a
 * container with no children to copy from is given a step the document does not
 * use. Found by review round 1, which reported it as a corrupted layout; what it
 * actually produces is a correct document formatted differently, because the
 * step is only read where there is no sibling to copy.
 */
function multiline(root: XmlEl): boolean {
  const walk = (el: XmlEl): boolean => {
    for (const node of Array.from(el.childNodes ?? [])) {
      if (node.nodeType === TEXT_NODE) {
        const data = node.data ?? '';
        if (data.trim() === '' && /[\n\r]/.test(data)) {
          return true;
        }
        continue;
      }
      if (node.nodeType === ELEMENT_NODE && walk(node as XmlEl)) {
        return true;
      }
    }
    return false;
  };

  return walk(root);
}

/** What this write needs that neither the DOM nor the value says. */
export interface WriteShape extends ReadShape {
  /** The document's root, which is where an insert's own indent bottoms out. */
  readonly root: XmlEl;
  /** One level of indentation, or nothing for a document laid out on one line. */
  readonly step: string | undefined;
}

/**
 * The shape a write reads off the document once rather than per node.
 *
 * `step` is `undefined` for a single-line document -- which is what keeps
 * `<a><b>1</b></a>` on one line -- and a real indent for every other, with
 * `DEFAULT_STEP` where the document is laid out across lines and nothing in it
 * says how far: `<a>\n</a>` has a line break and no nesting to read one off.
 *
 * A document written **from nothing** is laid out, which is the one case the
 * detection gets wrong on its own: a fresh `<config/>` has no text in it at
 * all, so it reads as single-line and a from-scratch file would come out as one
 * line however many settings it holds. That is a fact about the caller rather
 * than about the bytes, so the caller says it.
 *
 * @param root - The document's root element.
 * @param read - What the read needed, which this extends.
 * @param fresh - Whether the document is one this store just made.
 * @returns The shape.
 */
export function writeShape(root: XmlEl, read: ReadShape, fresh = false): WriteShape {
  return {
    multiple: read.multiple,
    root,
    step: fresh ? DEFAULT_STEP : multiline(root) ? (stepOf(root) ?? DEFAULT_STEP) : undefined,
    what: read.what,
  };
}

/** The document a node belongs to. */
function docOf(el: XmlEl): XmlDoc {
  const doc = el.ownerDocument;
  if (!doc) {
    throw new Error('A config XML element must belong to a document');
  }
  return doc;
}

/**
 * A new element, in its parent's own namespace and under its parent's prefix.
 *
 * Measured: `createElement('b')` inside `<n:cfg xmlns:n="urn:x">` yields
 * `<b>2</b>` beside `<n:a>1</n:a>` -- a new key silently out of the namespace
 * every other key is in, which for a document something else validates is a
 * file that stops validating. `createElementNS` with the parent's URI and
 * prefix is what puts it where its siblings are, and for a *default* namespace
 * the two spellings serialize identically -- measured -- so this is one rule
 * rather than a branch.
 */
function newElement(parent: XmlEl, name: string): XmlEl {
  const prefix = parent.prefix ?? null;
  return docOf(parent).createElementNS(
    parent.namespaceURI ?? null,
    prefix ? `${prefix}:${name}` : name
  ) as XmlEl;
}

/** Removes a child, and the whitespace that was laying it out. */
function dropChild(parent: XmlEl, child: XmlEl): void {
  const prev = child.previousSibling;
  parent.removeChild(child);
  // the indent in front of it, which belongs to the child rather than to the
  // parent: left behind, a removal leaves an indented blank line, which is the
  // line rule `removeFrom()` in the JSONC writer already keeps
  if (prev && prev.nodeType === TEXT_NODE && (prev.data ?? '').trim() === '') {
    parent.removeChild(prev);
  }
}

/**
 * Where an insert goes: past whatever shares the last child's line.
 *
 * Which is the JSONC writer's own finding in a second format. `last.nextSibling`
 * alone splices the new element **in front of** an inline comment, so
 *
 * ```xml
 * <config>
 *   <a>1</a> <!-- on a -->
 * </config>
 * ```
 *
 * gaining a `b` came out with the comment on `<b>`'s line -- a file saying
 * something **false**, which that writer's entry records as worse than losing
 * the comment outright. So the walk steps over horizontal whitespace and
 * comments until it meets a line break or anything else, and stops at whatever
 * that is.
 *
 * Measured. Found by review round 1.
 */
function afterLastLine(last: XmlEl): XmlNode | null {
  let at: XmlNode | null = last.nextSibling ?? null;

  while (at) {
    if (at.nodeType === COMMENT_NODE) {
      at = (at as XmlEl).nextSibling ?? null;
      continue;
    }
    if (at.nodeType === TEXT_NODE) {
      const data = at.data ?? '';
      // a break ends the line, so the insert belongs before this node; anything
      // with content in it is not trivia and ends the walk too
      if (/[\n\r]/.test(data) || data.trim() !== '') {
        return at;
      }
      at = (at as XmlEl).nextSibling ?? null;
      continue;
    }
    return at;
  }

  return null;
}

/** Appends a child, laid out the way its siblings are. */
function addChild(parent: XmlEl, child: XmlEl, shape: WriteShape): void {
  const existing = elementChildren(parent) as XmlEl[];
  const doc = docOf(parent);

  if (existing.length > 0) {
    // the **first child that has one** says how a child of this parent is laid
    // out, which is neither the first child nor the last. The first alone is
    // wrong for `<config><a>1</a>\n  <b>2</b>\n</config>`, where `<a>` shares
    // the opening tag's line and has no preceding text at all -- so an insert
    // read "no layout" off it and landed inline against `<b>`, which is laid
    // out. The last alone copies an outlier: a document whose indentation is
    // inconsistent gets the odd one out rather than the majority. Measured on
    // both, which is why it is neither.
    const indent = existing.map(indentBefore).find((it) => it !== undefined);
    const after = afterLastLine(existing[existing.length - 1] as XmlEl);

    if (indent !== undefined) {
      parent.insertBefore(doc.createTextNode(`\n${indent}`), after);
    }
    parent.insertBefore(child, after);
    return;
  }

  // nothing to copy a layout from, so it is the parent's own indent plus one
  // step -- and whatever whitespace the element held is this branch's to drop,
  // because what it writes replaces it. A scalar is already gone by the time
  // this runs, which is what `applyInto()` clears it for; whitespace is not,
  // and the **root** is where that shows: it reads as `{}` where a leaf reads
  // as `''`, so `<config>\n</config>` kept its newline and an insert added a
  // second one beside it -- a stray blank line in every file written into an
  // empty-but-laid-out document
  clearText(parent);

  if (shape.step === undefined) {
    parent.appendChild(child);
    return;
  }

  const outer = parent === shape.root ? '' : (indentBefore(parent) ?? '');
  parent.appendChild(doc.createTextNode(`\n${outer}${shape.step}`));
  parent.appendChild(child);
  parent.appendChild(doc.createTextNode(`\n${outer}`));
}

/** Drops every text and CDATA child of an element. */
function clearText(el: XmlEl): void {
  for (const node of Array.from(el.childNodes ?? [])) {
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
      el.removeChild(node);
    }
  }
}

/**
 * Writes a scalar into an element, replacing **everything** it held.
 *
 * Only reached where the diff said the text has to change, which is what keeps
 * a CDATA section a CDATA section: the one way to destroy one is to write over
 * it, and nothing here writes over a value that already matches.
 *
 * ## Its attributes go with its children, which is the half that was missing
 *
 * An element holds a scalar or named parts and never both, so an element
 * becoming a leaf has to stop holding both -- and leaving the attributes behind
 * wrote `<server host="h">none</server>`, which is **mixed content the read
 * refuses**: a `save()` producing a file this store cannot read back. Two more
 * shapes of the same thing, each a wrong value rather than a throw:
 * `{ server: '' }` over `<server host="h"/>` left the attribute and read back
 * as `{ host: 'h' }`, and an emptied list over `<p n="a"/>` read back as
 * `[{ n: 'a' }]`. Found by review round 1, which reasoned it off a source it
 * had invented and was right about this anyway.
 *
 * ## And a value holding `]]>` falls back to a text node
 *
 * `createCDATASection` **throws** `data contains "]]>"` -- a DOM error naming
 * nothing -- and the value is perfectly representable as escaped text, so
 * refusing it would refuse the format's own answer. What is lost is the
 * author's CDATA spelling for that one element, which is the smaller of the
 * two: the standard `a]]]]><![CDATA[>b` split keeps it and produces a file
 * nobody wants to read.
 */
function setLeaf(el: XmlEl, value: unknown): void {
  const cdata = Array.from(el.childNodes ?? []).some((node) => node.nodeType === CDATA_NODE);

  for (const attr of settingAttrs(el)) {
    el.removeAttributeNS(attr.namespaceURI ?? null, nameOf(attr));
  }
  for (const child of elementChildren(el) as XmlEl[]) {
    dropChild(el, child);
  }
  clearText(el);

  const text = textFor(value);
  if (text === '') {
    return;
  }

  const doc = docOf(el);
  el.appendChild(
    cdata && !text.includes(']]>') ? doc.createCDATASection(text) : doc.createTextNode(text)
  );
}

/**
 * Makes an element say what a value says, touching nothing that already agrees.
 *
 * `current` is passed in rather than read here, which is two things: the caller
 * already has it, so a deep tree is not re-read once per level, and it is what
 * carries the **path** -- a `multiple` setting at `server.tags` is wrapped only
 * if the read that produced `current` knew it was at `server.tags`, and a read
 * rooted at each element would have called it `tags`.
 *
 * @param el - The element.
 * @param current - What `readElement(el, path, shape)` said.
 * @param target - What it should hold.
 * @param path - The element's own dotted path, empty at the root.
 * @param shape - What neither the DOM nor the value says.
 */
export function applyInto(
  el: XmlEl,
  current: unknown,
  target: unknown,
  path: string,
  shape: WriteShape
): void {
  if (same(current, target)) {
    return;
  }

  if (!isPlainObject(target)) {
    setLeaf(el, target);
    return;
  }

  // the element held a scalar and now holds named parts, so its text goes --
  // before anything is inserted, because `addChild()` reads the element's own
  // layout and a stale scalar would be laid out around
  if (!isPlainObject(current)) {
    clearText(el);
  }

  const held = isPlainObject(current) ? current : {};

  for (const [name, value] of Object.entries(target)) {
    const was = Object.hasOwn(held, name) ? held[name] : undefined;
    if (was !== undefined && same(was, value)) {
      continue;
    }
    writeKey(el, name, value, path === '' ? name : `${path}.${name}`, shape);
  }

  // and whatever the element says that the target does not
  for (const name of Object.keys(held)) {
    if (!Object.hasOwn(target, name)) {
      dropKey(el, name);
    }
  }
}

/** Writes one key of an object, picking a spelling. */
function writeKey(el: XmlEl, name: string, value: unknown, path: string, shape: WriteShape): void {
  const attr = attrNamed(el, name);
  const scalar = !isPlainObject(value) && !Array.isArray(value);

  if (attr) {
    if (scalar) {
      // against the attribute's own namespace and qualified name, or an update
      // to `n:mode` adds a second attribute called `mode` beside it
      el.setAttributeNS(attr.namespaceURI ?? null, attr.nodeName ?? name, textFor(value));
      return;
    }
    // promoted: an attribute holds a string, so a value that is an object or a
    // list cannot stay one. Removed *before* the elements are written, or the
    // document would hold the collision this mapping refuses
    el.removeAttributeNS(attr.namespaceURI ?? null, nameOf(attr));
  }

  const children = childrenNamed(el, name);

  if (Array.isArray(value)) {
    writeList(el, name, children, value, path, shape);
    return;
  }

  if (children.length === 0) {
    const child = newElement(el, name);
    addChild(el, child, shape);
    applyInto(child, '', value, path, shape);
    return;
  }

  // the document spells this name several times and the value is one thing, so
  // the first occurrence holds it and the rest go
  const first = children[0] as XmlEl;
  for (const extra of children.slice(1)) {
    dropChild(el, extra);
  }
  applyInto(first, readElement(first, path, shape), value, path, shape);
}

/** Reconciles a list against the elements of one name, by index. */
function writeList(
  el: XmlEl,
  name: string,
  children: readonly XmlEl[],
  value: readonly unknown[],
  path: string,
  shape: WriteShape
): void {
  // an empty list is **one empty element** rather than none, which is what
  // makes `[] -> <plugins/> -> []` hold at a declared `multiple` path: zero
  // elements is the key being *absent*, which merges as nothing and lets the
  // layer below show through rather than shadowing it with an explicit empty.
  // The first occurrence is kept and emptied rather than removed and replaced,
  // so an empty list leaves the element where the user had it
  if (value.length === 0) {
    const first = children[0] ?? newElement(el, name);
    if (!children[0]) {
      addChild(el, first, shape);
    }
    for (const extra of children.slice(1)) {
      dropChild(el, extra);
    }
    setLeaf(first, '');
    return;
  }

  // by index, which is the rule the JSONC writer already keeps for an array: by
  // identity would need a notion of element identity neither format has. So a
  // push is one insertion and an unshift rewrites every element
  for (let i = 0; i < value.length; i++) {
    const child = children[i];
    if (child) {
      applyInto(child, readElement(child, path, shape), value[i], path, shape);
      continue;
    }
    const made = newElement(el, name);
    addChild(el, made, shape);
    applyInto(made, '', value[i], path, shape);
  }

  for (const extra of children.slice(value.length)) {
    dropChild(el, extra);
  }
}

/** Removes whatever spells a key. */
function dropKey(el: XmlEl, name: string): void {
  const attr = attrNamed(el, name);
  if (attr) {
    el.removeAttributeNS(attr.namespaceURI ?? null, nameOf(attr));
  }
  for (const child of childrenNamed(el, name)) {
    dropChild(el, child);
  }
}
