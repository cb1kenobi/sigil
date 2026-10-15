# @ttylabs/config-xml

An XML config layer for [sigil](https://github.com/cb1kenobi/sigil), as a
separate package rather than as a parser you wire in yourself.

```sh
npm install @ttylabs/config-xml
```

```js
import { xml } from '@ttylabs/config-xml';
import { createConfig } from '@ttylabs/sigil/config';
import { json } from '@ttylabs/sigil/config';
import * as paths from '@ttylabs/sigil/paths';

const schema = {
  'server.port': { type: 'int', default: 8080 },
  plugins: { multiple: true },
};

const config = await createConfig({
  schema,
  layers: [
    { name: 'system', readOnly: true, store: xml('/etc/myapp/config.xml', { schema }) },
    { name: 'user', store: json(paths.configHome('myapp', 'config.json')) },
  ],
});

config.get('server.port');
```

## Why a package rather than an option

`@ttylabs/sigil` has **zero** production dependencies, and that is a hard
constraint rather than a preference. An XML config layer wants an XML parser, so
there are two ways to have one: the app hands a store a reference to a parser, or
a separate package depends on one directly.

This is the second, and it is the better read of the constraint. The rule is
about the _runtime's_ dependencies, and a store package is a thing an app
installs **only if it wants XML** — so an app that does not pays nothing, where
injection makes every app wire a parser into a store it does not otherwise care
about. It is also the only way to find out whether `ConfigStore` is implementable
from outside that repository, which is what makes this worth having at all: an
interface nobody has implemented from outside is an interface nobody knows is
implementable.

`@xmldom/xmldom` is the parser. It has no dependencies of its own.

## The mapping: attributes and child elements share one path space

```xml
<config mode="dev">
  <server port="8080">
    <host>example.com</host>
  </server>
</config>
```

```
mode        -> 'dev'
server.port -> '8080'
server.host -> 'example.com'
```

So `<port>8080</port>` and `<server port="8080"/>` are the **same setting at the
same path**, which is the whole of this package's design and is not a preference
about spelling.

The obvious alternative is a reserved key — `_attributes`, `$`, `@_` — which is
what xml2js and fast-xml-parser both do. It is wrong here for a reason that has
nothing to do with taste: **a sentinel puts one setting at two paths depending on
the format of the layer it came from.**

| layer       | file says                  | path under a sentinel     |
| ----------- | -------------------------- | ------------------------- |
| system, XML | `<server port="8080"/>`    | `server._attributes.port` |
| user, JSON  | `{"server":{"port":9090}}` | `server.port`             |

Two paths, so neither shadows the other. The merged view holds both,
`get('server.port')` answers the user's, the system default is invisible at the
path an app reads, and a user who deletes their override gets `undefined` rather
than `8080`. The precedence chain — the one thing a layered config exists to
provide — would be broken by the _format_ of a layer, which is precisely what a
store interface is supposed to make invisible.

The same argument rules out a parallel accessor (`config.attr('server.port')`)
and an XPath-ish `server/@port`: both are a second path space wearing a different
hat.

### Which means a name used twice is refused

One path space has one value per name, so a document with two answers for one
setting is refused where it was written, naming the line:

```xml
<server port="1"><port>2</port></server>
```

```
/etc/myapp/config.xml:2: <server> sets "port" both as an attribute and as a child element
```

A prefix is **not** part of a path — `<n:port>` is `port` — because a prefix is a
document-level spelling decision and `xmlns:n` against `xmlns:cfg` must not change
which config key an app reads. Two differently-prefixed names with one local name
are therefore the same collision, through the other door.

### An element holds a scalar or named parts, never both

`<name>Chris<title>Mr</title></name>` and `<name sir="yes">Chris</name>` are the
same problem — a value for the element itself _and_ a value for something named
inside it, with no path for the first. Both are refused, naming the line, and it
is one rule rather than two. Whitespace is not mixed content, because every
pretty-printed document has it.

### Lists

Repeated siblings are an array at their own path:

```xml
<config>
  <plugins>a</plugins>
  <plugins>b</plugins>
</config>
```

```
plugins -> ['a', 'b']
```

Which is where `{"plugins":["a","b"]}` puts it too. A _wrapper_ —
`<plugins><plugin>a</plugin></plugins>` — is `plugins.plugin`, which is also where
`{"plugins":{"plugin":["a"]}}` puts it: those are two different **documents**
rather than one document in two formats, and each format spells each shape at the
same path.

A single occurrence is a **scalar** where nothing declared otherwise, which is the
asymmetry every XML-to-value mapper has, and the schema is how you get rid of it:

```js
const schema = { plugins: { multiple: true } };
xml(path, { schema }); // `<plugins>a</plugins>` is now ['a'], and `<plugins/>` is []
```

Passing the schema is **not optional** if you declare a `multiple` setting. Without
it, a list with one occurrence reads as `'a'`, `coerceSetting()` wants `['a']`, and
your app throws on its first load — which is the format leaking through a store
whose job is to hide it. It is the same object you pass to `createConfig()`, and the
store reads one field of it.

## It writes, through the DOM

`write()` re-reads the file, parses it, diffs your value against what the document
says, and **touches only what differs**. So this:

```js
config.set('server.port', '9090');
await config.save();
```

over this:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- the app's settings -->
<config mode="dev">
  <!-- where to listen -->
  <server port="8080">
    <host>example.com</host>
  </server>
  <banner><![CDATA[<b>hi</b>]]></banner>
</config>
```

changes `8080` to `9090` and leaves **every other byte identical** — the
declaration, both comments, the CDATA section, the attribute order and every space
of indentation.

Diffing first is a correctness rule rather than an optimization. Assigning text to
a CDATA-bearing element _with the string it already holds_ destroys the CDATA
section, so a walk that sets unconditionally corrupts every one in the file on any
write.

The spelling follows the document where it fits: a setting already written as an
attribute stays an attribute, one written as a child element stays an element, and
a key with no existing spelling becomes a child element. An object or a list at a
path currently spelled as an attribute **promotes** — the attribute is removed and
elements are written — because an attribute holds a string and nothing else.

### What it cannot carry, per document

`layer.wouldLose` is **absent** where a write of that file would lose nothing,
which is the normal case: seventeen of thirty-two measured documents round-trip
byte for byte through `@xmldom/xmldom` 0.9.12, comments and CDATA and DOCTYPE
among them.

Where a document holds something the serializer normalizes, it is reported and
the write refuses unless you say so:

```js
await config.save({ lossy: true });
```

The complete residual, each measured:

| what                             | becomes      |
| -------------------------------- | ------------ |
| `<a></a>`                        | `<a/>`       |
| `a='1'`                          | `a="1"`      |
| `<a b = "1"/>`                   | `<a b="1"/>` |
| `&#38;`                          | `&amp;`      |
| `&apos;` and `&quot;`            | `'` and `"`  |
| a bare `>` in text               | `&gt;`       |
| whitespace in an attribute value | a space      |
| NEL (U+0085) in text             | a newline    |

The last two are **required of every conforming parser** — attribute-value and
line-ending normalization are in the XML spec — so they are not this store's to
avoid. A byte order mark, CRLF line endings and a trailing newline are detected at
read and reapplied at write, so none of them is a loss.

Each row is matched against the document's **element content** — the source with
every comment, CDATA section, processing instruction and DOCTYPE blanked out, at
the same offsets so the line it reports is still the right one. A comment's own
text is reproduced verbatim, so an `&apos;` or a bare `>` inside one survives and
a row matching there would send you to a line with nothing wrong with it. NEL is
the exception and is matched against the raw bytes, because that one is
normalized everywhere a parser finds it, a comment included.

An **internal DTD entity reference** is refused at read rather than reported here:
`@xmldom/xmldom` cannot expand one, so the value would be the four characters
`&e;` where the document says `hi`. A wrong value is not something to write down
in a loss table and carry on from. A declaration nothing references is fine.

## What XML cannot hold

`canRepresent()` refuses these at the `set()` that wrote them, naming the path:

- **`null` and `undefined`** — XML has no such thing. (Core drops a key holding
  either before it reaches a store, so this is for a `write()` you made directly.)
- **A function, a symbol, a `Map`, a `Set`, a class instance** — each reaches a
  file as something unparseable or as `[object Map]`.
- **`NaN` and `Infinity`.** `NaN` reaches the file as the text `NaN`, which
  `transformValue()` refuses on a `number` setting — so writing one produces a
  config the next run cannot load.
- **A `bigint`**, for a different reason from JSON's: `JSON.stringify` _throws_
  for one, where `String(10n)` is exact text. It is that no data type reads one
  back — `'10'` on an `int` is the number `10` rather than `10n`.
- **A character XML cannot carry, or that a parser changes.** C0 controls except
  tab, newline and carriage return; a lone surrogate; U+FFFE and U+FFFF. Those are
  outside XML 1.0's `Char` production, and `@xmldom/xmldom` writes one **raw** —
  so without this the store writes a file it can read back and nothing else can.
  A carriage return and NEL (U+0085) are refused too, because a parser normalizes
  both to a newline. U+007F to U+009F are legal and are allowed.
- **A string whose own leading or trailing whitespace matters.** A leaf's text and
  an attribute's value are both trimmed on the way in, because whitespace around a
  value in XML is layout — so a padded string is one this store would read back as
  something else. Refused rather than quietly changed.
- **A name no element can have.** XML's `Name` production, minus the colon and
  minus `xmlns`, checked against each segment of the path _and_ each key of the
  value — so `set('1bad', 'v')` is refused at the `set()` rather than throwing
  `invalid character in qualified name` out of the DOM at a `save()`. The colon is
  excluded because a prefix is not part of a path here; `xmlns` because it is a
  namespace declaration rather than a name, which the production allows and the
  DOM refuses. Any other `xml`-prefixed name is allowed, because the format takes
  it.
- **An empty object**, which is the same bytes as the empty string. The mapping
  picks `''`, because that is what `set('host', '')` writes. To clear a subtree,
  `delete()` it. (The whole document is exempt: there `{}` is an empty config.)
- **A list of one empty string**, which is the same bytes as an empty list.

Everything else is written as **text**, which is a saving rather than a cost: XML
has no scalar kind, so a number, a boolean and a `Date` all reach the file as a
string and the schema coerces them back — exactly as an environment variable
already reaches an option. A `Date` is written as its ISO form, because
`type: 'date'` reads one back.

A value with no schema setting reads back as a **string**. That is the format
rather than this store, and it is what `type` is for.

### One consequence worth knowing

The check is asked of the **merged document** rather than of what you passed, so
that a key your write is not claiming cannot refuse a write that never touches
it. Which means a file that already holds something XML cannot carry — a stray
control character somebody pasted — refuses **every** write to that file, naming
the character and the key. That is conservative on purpose: the alternative is
the store deliberately writing a document no conforming tool can read. Reading
such a file is fine; only writing it back is refused.

## Options

```js
xml(path, { root: 'settings', schema });
```

| option   | default    | what it is                                               |
| -------- | ---------- | -------------------------------------------------------- |
| `root`   | `'config'` | the root element a file written **from nothing** gets    |
| `schema` | —          | your config schema, read for `multiple` and nothing else |

Both are constructor options rather than anything on `ConfigStore`, so the
published interface is unchanged. The type is exported as `XmlStoreOptions`, for
an app that wants to write its own wiring into a signature.

The whole surface, since an exported type is API an app can write into its own
signatures: `xml` and `XmlStoreOptions`. Everything else a store needs is
`@ttylabs/sigil/config`'s.

A file that is **not there**, and one holding nothing but whitespace, both read as
an empty document — which is the same answer `json()` gives, because an absent
config is the ordinary state of one and refusing to start over
`touch config.xml` is the wrong answer.

## A known gap: translating this package's messages

Everything a user's _file_ can provoke is translated through
`@ttylabs/sigil/i18n`, which is the line sigil draws: a schema declaration and a
dotted path are the app's own and stay English, and a collision or a mixed-content
refusal is something a user can act on.

What does not work yet is `sigil check` knowing about it. That check compares an
app's catalogs against `SIGIL_KEYS` plus the app's own, and a key belonging to a
_dependency_ is in neither — so an app that translates one gets:

```
"de" translates "...", which nothing asks for; the English may have been reworded
```

which is a warning on correct code, with a message pointing the wrong way. The
shape of the fix is `sigil check` reading an `./i18n-keys` subpath from each
dependency that publishes one and unioning it into the framework set — purely
additive, and a change to what `sigil check` promises every app rather than
anything about XML, which is why it is not taken here. Until then: translate
them and ignore the warning, or leave them in English.

## What this costs

`@ttylabs/config-xml` is **10 kB** of its own code over one module, plus
`@xmldom/xmldom`, which is about 270 kB of JavaScript and has no dependencies of
its own. An app that does not import this pays nothing for either.

## License

MIT
