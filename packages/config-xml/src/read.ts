import { elementChildren, nameOf, ownText, settingAttrs, type XmlNode } from './names.js';
import { __ } from '@ttylabs/sigil/i18n';

/**
 * A DOM element read as a plain value.
 *
 * Every message in here is translated, which is the line the runtime's config
 * module already draws: a *document* is a user's, so what it can provoke is
 * something they can act on, and the path and the line number are what make it
 * actionable. A schema declaration and a dotted path are the app's and stay
 * English, which is why nothing in `names.ts` or `represent.ts` is translated.
 *
 * ## Attributes and child elements share one path space
 *
 * ```xml
 * <server port="8080"><host>example.com</host></server>
 * ```
 *
 * ```
 * server.port -> '8080'
 * server.host -> 'example.com'
 * ```
 *
 * Which is the whole of this package's design, and the reason is not a
 * preference about spelling. A sentinel -- `_attributes`, `$`, `@_`, which is
 * what xml2js and fast-xml-parser both do -- puts **one setting at two paths
 * depending on the format of the layer it came from**:
 *
 * | layer | file says | path under a sentinel |
 * | -- | -- | -- |
 * | system, XML | `<server port="8080"/>` | `server._attributes.port` |
 * | user, JSON | `{"server":{"port":9090}}` | `server.port` |
 *
 * Two paths, so neither shadows the other: the merged view holds both, the
 * system default is invisible at the path an app reads, and a user who deletes
 * their override gets `undefined` rather than `8080`. The precedence chain --
 * the one thing a layered config exists to provide -- would be broken by the
 * *format* of a layer, which is precisely what a store interface is supposed to
 * make invisible. The same argument rules out a parallel accessor and an
 * XPath-ish `server/@port`, which are the same second path space wearing
 * different hats.
 *
 * ## Which means a name used twice is refused
 *
 * One path space has one value per name, so an attribute and a child element of
 * one name -- or two differently-prefixed children with one local name -- is a
 * document with two answers for one setting. Refused where it was written,
 * naming the line, rather than resolved by a precedence nobody will remember.
 * The house rule: what is decidable at load time fails at load time.
 *
 * ## And an element holds a scalar or named parts, never both
 *
 * `<name>Chris<title>Mr</title></name>` and `<a b="1">text</a>` are the same
 * problem -- a value for the element itself *and* a value for something named
 * inside it, with no path for the first. Refused, and it is one rule rather than
 * two: non-whitespace text beside any attribute or element child is mixed
 * content. Whitespace is not, because every pretty-printed document has it.
 */

/** What a read needs to know that the document cannot say. */
export interface ReadShape {
  /**
   * The dotted paths a schema declared `multiple`.
   *
   * Which is the one thing the mapping cannot infer, and leaving it out is a
   * **real app failing to start**: an XML list of one occurrence is a scalar,
   * so a setting declared `multiple: true` meets `'a'` where it wants `['a']`
   * and `coerceSetting()` throws `Expected a list of values` on the first load.
   * The same document in JSON -- `{"plugins":"a"}` -- throws identically, so
   * core is right and this is the format leaking through a store whose job is
   * to hide it.
   *
   * It is **only** this. A collapse rule inferred from the document was the
   * other candidate and cannot exist: one child of one tag is ambiguous between
   * a list of one and an object of one, so "a wrapper whose children share a
   * tag is an array" would turn `<server><host>x</host></server>` into
   * `server: ['x']`. The schema names `plugins` and does not name `server`,
   * which is the declaration removing an ambiguity the data cannot -- the shape
   * every other such decision in this repository takes.
   */
  readonly multiple: ReadonlySet<string>;
  /** The file, for a message that can name it. */
  readonly what: string;
}

/** Where a refusal happened, as far as the parser can say. */
function at(node: XmlNode, what: string): string {
  const line = node.lineNumber ?? undefined;
  return line === undefined ? what : `${what}:${line}`;
}

/**
 * A child's value, wrapped where the path is a declared list.
 *
 * The empty case is the half that is not obvious: an emptied list writes a
 * single empty element, so an empty one at a declared `multiple` path reads
 * back as `[]` rather than `['']`. Which is what makes `[] -> <plugins/> -> []`
 * hold, and it is why `canRepresent()` refuses a list whose one item is the
 * empty string -- those are the same bytes, so the format cannot hold both and
 * the one it holds is the one a round trip needs.
 */
function wrap(value: unknown, path: string, shape: ReadShape): unknown {
  if (!shape.multiple.has(path)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return value === '' ? [] : [value];
}

/**
 * Reads an element's value.
 *
 * @param el - The element.
 * @param path - Its dotted path, empty at the root.
 * @param shape - What the document cannot say.
 * @returns The value.
 * @throws If the document has two answers for one setting, or mixed content.
 */
export function readElement(el: XmlNode, path: string, shape: ReadShape): unknown {
  const attrs = settingAttrs(el);
  const children = elementChildren(el);
  const text = ownText(el);

  // non-whitespace text beside anything named is mixed content, which has no
  // mapping worth picking. Asked before anything else, so the message names the
  // element rather than whichever name happened to collide inside it
  if (text.trim() !== '' && (attrs.length > 0 || children.length > 0)) {
    throw new Error(
      __`${at(el, shape.what)}: <${nameOf(el)}> has text beside its attributes or children, which has no config path`
    );
  }

  // nothing named, so the element is a leaf and its value is its text --
  // **trimmed**, because whitespace around a value in XML is layout rather than
  // content: a user who breaks a long description across lines for readability
  // means the words rather than the indentation, and an untrimmed read gives
  // every pretty-printed leaf its surrounding newlines. An attribute is trimmed
  // for the same reason read the other way: `<port>8080</port>` and
  // `<server port="8080"/>` are the same setting, so they must be the same
  // *value*, and trimming one and not the other is the format split this
  // mapping exists to refuse, one level in.
  //
  // What it gives up is a value whose own leading or trailing whitespace is
  // deliberate, and `canRepresent()` refuses writing one rather than letting a
  // round trip quietly change it. Nor does CDATA escape it: CDATA is about `<`
  // and `&` rather than about whitespace.
  if (attrs.length === 0 && children.length === 0) {
    return text.trim();
  }

  const out: Record<string, unknown> = {};
  // what put each name there, so that a collision names the two spellings that
  // disagreed rather than only saying one name was used twice. Null-prototype
  // for the reason every lookup table in this repository is: on a plain object
  // `constructor` reads back truthy, so a setting called that would collide
  // with nothing
  const from: Record<string, 'attribute' | 'element'> = Object.create(null) as Record<
    string,
    'attribute' | 'element'
  >;

  for (const attr of attrs) {
    const name = nameOf(attr);
    // two attributes of one *local* name, which takes two prefixes --
    // `<a n:mode="x" m:mode="y"/>` -- because a repeated plain attribute is a
    // parse error before this is reached. It is the cost of a path not carrying
    // a prefix, which `nameOf()` has the argument for
    if (Object.hasOwn(from, name)) {
      throw new Error(
        __`${at(el, shape.what)}: <${nameOf(el)}> has two attributes called "${name}" under different namespace prefixes`
      );
    }
    from[name] = 'attribute';
    out[name] = wrap((attr.value ?? '').trim(), path === '' ? name : `${path}.${name}`, shape);
  }

  // grouped by name in document order, so that a repeat is an array at the
  // repeated name's own path. Which is the same path the equivalent JSON has:
  // `<plugins>a</plugins><plugins>b</plugins>` is `{"plugins":["a","b"]}` and
  // `<plugins><plugin>a</plugin></plugins>` is `{"plugins":{"plugin":"a"}}`,
  // because those are two different documents rather than one document in two
  // formats. A review round read the first against the second and called it a
  // format split; the split it was looking at is between two shapes, and both
  // formats spell both shapes at the same path
  const grouped = new Map<string, XmlNode[]>();
  // the spellings each local name arrived under, which is what catches two
  // prefixes for one path. Grouping on the local name alone would merge
  // `<n:a/>` and `<m:a/>` into one array -- two namespaces silently becoming
  // one setting, which is the same two-answers-for-one-name the collision rule
  // refuses, through the door `nameOf()` opens by dropping the prefix
  const spellings = new Map<string, Set<string>>();

  for (const child of children) {
    const name = nameOf(child);
    const found = grouped.get(name);
    if (found) {
      found.push(child);
      (spellings.get(name) as Set<string>).add(child.nodeName ?? name);
    } else {
      grouped.set(name, [child]);
      spellings.set(name, new Set([child.nodeName ?? name]));
    }
  }

  for (const [name, nodes] of grouped) {
    // two complete sentences rather than one with the word `attribute` or
    // `element` in a slot: a translator handed a sentence with an English noun
    // interpolated into it cannot write theirs, which is the printf problem the
    // i18n work already refuses
    if (from[name] === 'attribute') {
      throw new Error(
        __`${at(el, shape.what)}: <${nameOf(el)}> sets "${name}" both as an attribute and as a child element`
      );
    }
    if ((spellings.get(name) as Set<string>).size > 1) {
      throw new Error(
        __`${at(el, shape.what)}: <${nameOf(el)}> has children called "${name}" under more than one namespace prefix`
      );
    }
    from[name] = 'element';

    const here = path === '' ? name : `${path}.${name}`;
    const values = nodes.map((node) => readElement(node, here, shape));

    out[name] = nodes.length > 1 ? values : wrap(values[0], here, shape);
  }

  return out;
}

/**
 * Reads a document's value off its root element.
 *
 * The root is the **document** rather than a setting, which is the one place
 * the leaf rule does not apply: its name is not in the path space -- `<cfg>`
 * and `<settings>` hold the same config -- and an element with nothing named in
 * it is therefore an empty config rather than the empty string. Without that,
 * `<config/>` reads as `''`, a store refuses it for not holding an object, and
 * an app whose config file exists and is empty cannot start.
 *
 * What it still refuses is a root holding a scalar: `<cfg>text</cfg>` is not a
 * config, and merging it would make every key of every layer below it vanish --
 * the rule `json()` already keeps for a file holding `42`.
 *
 * @param root - The root element.
 * @param shape - What the document cannot say.
 * @returns The document's value, which is an object.
 * @throws If the root holds something a layer cannot merge.
 */
export function readDocument(root: XmlNode, shape: ReadShape): Record<string, unknown> {
  if (settingAttrs(root).length === 0 && elementChildren(root).length === 0) {
    // and a root with *text* in it is still refused, through the check below:
    // the empty answer is only for one that says nothing at all
    if (ownText(root).trim() === '') {
      return {};
    }
  }

  const value = readElement(root, '', shape);

  if (!isRecord(value)) {
    throw new Error(__`${shape.what} must hold an object`);
  }

  return value;
}

/** Whether a read produced an object rather than a leaf's text. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
