# @ttylabs/config-yaml

A YAML config layer for [sigil](https://github.com/cb1kenobi/sigil), as a
separate package rather than as a parser you wire in yourself.

```sh
npm install @ttylabs/config-yaml
```

```js
import { yaml } from '@ttylabs/config-yaml';
import { createConfig, json } from '@ttylabs/sigil/config';
import * as paths from '@ttylabs/sigil/paths';

const config = await createConfig({
  schema: {
    'server.port': { type: 'int', default: 8080 },
    plugins: { multiple: true },
  },
  layers: [
    { name: 'system', readOnly: true, store: yaml('/etc/myapp/config.yaml') },
    { name: 'user', store: json(paths.configHome('myapp', 'config.json')) },
  ],
});

config.get('server.port');
```

## Why a package rather than an option

`@ttylabs/sigil` has **zero** production dependencies, and that is a hard
constraint rather than a preference. A YAML config layer wants a YAML parser, so
there are two ways to have one: the app hands a store a reference to a parser, or
a separate package depends on one directly.

This is the second, and it is the better read of the constraint. The rule is
about the _runtime's_ dependencies, and a store package is a thing an app
installs **only if it wants YAML** — so an app that does not pays nothing, where
injection makes every app wire a parser into a store it does not otherwise care
about.

It is also the **second** external implementation of `ConfigStore`, after
[`@ttylabs/config-xml`](../config-xml), and that matters more than either format:
one implementation proves an interface is writable, two prove it is not shaped
around the first one. Neither needed a line of `@ttylabs/sigil` to change.

[`yaml`](https://eemeli.org/yaml/) is the parser, and not `js-yaml`. It has no
dependencies of its own, and the reason it is the one is that it has a **document
model**: `js-yaml` parses to a plain value and dumps from one, so every comment
in the file is gone on the first write. Under sigil's lossless rule that is not a
quality gap, it is a store whose writes are refused by default, always — which is
a read-only store wearing a write method.

## It reads YAML 1.2's core schema, pinned

This is the one place a YAML store can silently disagree with the rest of the
library. YAML 1.1 and YAML 1.2 do not read the same scalars the same way, and
every row here is measured against `yaml` 2.9.1 rather than read off a spec:

| in the file        | 1.2 core         | 1.1             |
| ------------------ | ---------------- | --------------- |
| `verbose: yes`     | string `'yes'`   | boolean `true`  |
| `verbose: no`      | string `'no'`    | boolean `false` |
| `verbose: on`      | string `'on'`    | boolean `true`  |
| `mode: 017`        | **number 17**    | **number 15**   |
| `at: 12:30`        | string `'12:30'` | **number 750**  |
| `at: 1:2:3`        | string `'1:2:3'` | **number 3723** |
| `size: 1_000`      | string `'1_000'` | number 1000     |
| `when: 2026-10-19` | string           | a `Date`        |
| `a: 0o17`          | number 15        | string `'0o17'` |

The famous one is the first — the Norway problem, `NO` for Norway becoming
`false` — and it is **not** the one that would bite a CLI config. The two that
would are `017` and `12:30`: a file mode written the way every shell writes one
is a different number under the two versions, and a time or a version-ish string
is a number under 1.1. Both are silent.

On sigil's own `bool` vocabulary the two versions **happen to agree** —
`verbose: yes` reaches a `bool` setting as `true` whether the parser handed over
the string or the boolean, because `transformValue()` takes
`true`/`t`/`yes`/`y`/`on`/`1` and their negatives. That agreement is luck rather
than design: the two vocabularies were settled independently, and nothing stops a
word being added to one of them and not the other. Which is the argument for
pinning rather than taking the parser's default. `yaml` 2.9.1 already defaults to
1.2 core, so the pin changes no answer today; what it buys is that a `yaml` major
that moved its default would not move what your file means.

One thing is deliberately **not** 1.2 core: merge keys are enabled.

## Everything YAML has that JSON does not

### Merge keys and aliases are read

```yaml
defaults: &d
  retries: 3
staging:
  <<: *d
  host: staging.example.com
mirror: *d
```

```
defaults.retries -> 3
staging.retries  -> 3
staging.host     -> 'staging.example.com'
mirror.retries   -> 3
```

`merge: true` is on because without it a `<<` reads as a literal key spelled
`<<` — a file that reads **wrong** rather than one that errors, which is the
worst of the three outcomes available.

### A write that touches one is refused

An anchor, an alias and a merge key are the three things YAML has that no other
config format does, and a write that touched one would be wrong in a different
way each time. Each is measured against `yaml` 2.9.1:

| the write                                             | what the parser does                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `set('mirror.retries', 5)` through an alias           | throws `Expected YAML collection at mirror. Remaining path: ...` |
| `delete('staging.retries')`, which came from the `<<` | answers `false` and changes **nothing**                          |
| `set('defaults.retries', 5)` on the aliased anchor    | moves `staging.retries` too — a path the write never claimed     |
| `delete('defaults')` while something aliases `&d`     | leaves a document whose `toString()` throws                      |

So, over the document above:

```
Cannot write "mirror.retries" in /etc/myapp/config.yaml: "mirror" is an alias, on line 6
Cannot remove "staging.retries" from /etc/myapp/config.yaml: it comes from the merge key on line 4
```

Nothing else in the file is affected — an anchor or an alias on a path your write
does not touch survives untouched, which is what the diff buys.

**A `set()` of a merged key is allowed**, and it is the one exception.
`set('staging.retries', 5)` writes `retries: 5` into `staging`, shadowing the
merge: the anchor is untouched, `defaults.retries` stays `3`, and a re-read
answers exactly what was written. (Only the **removal** is refused, because that
is the one `deleteIn()` answers `false` to.) Shadowing is the only way to make that path
hold that value without editing an anchor every map that merges it also reads.
The surprise — a key that used to track `defaults` now does not — is what a
`set()` on that path asks for.

An anchor **nothing aliases** is a label rather than shared state, so writing
what it names is allowed too.

### What is refused at read, naming the line

- **A multi-document stream** (`---`). A config file holding two documents has no
  meaning in a layered merge, and taking the first silently drops the rest.
- **An unknown tag.** `yaml` reports one as a _warning_ and resolves the scalar
  to its own text, so `a: !custom 5` would read as `'5'` with the tag gone.
- **A tag outside the core schema.** `!!set`, `!!omap`, `!!binary`, `!!timestamp`
  and `!!pairs` each resolve without a warning to a JS `Set`, `Map`, `Buffer` or
  `Date` — a value no other layer format can hand back, which the merge carries
  by reference and this store's own `canRepresent()` then refuses to write. An
  explicit **core** tag is fine: `!!str 5` is how you force a string.
- **A mapping key that is a collection.** `[1, 2]: a` names no config path, and
  `toJS()` would stringify it _and print a warning to stderr_. A scalar key of
  any type is fine: `1: a` is the path `1`, which is where `{"1": "a"}` puts it
  in JSON.
- **Two keys that name one path.** `1: a` and `"1": b` are two distinct YAML keys
  and one config path, so without this the second silently wins.
- **A recursive alias**, whose value is a cycle, and **an alias that comes before
  its anchor**, which `toJS()` and `toString()` both throw about.
- **A root that is not a mapping.** Merging `42` or a sequence would make every
  key of every layer below it vanish.

A file that is **not there**, one holding nothing but whitespace, and one holding
nothing but comments all read as an empty document — which is the same answer
`json()` gives, because an absent config is the ordinary state of one.

## It writes by editing the document

`write()` re-reads the file, parses it, diffs your value against what the
document says, and calls `setIn()` or `deleteIn()` for **each path that
differs**. So this:

```js
config.set('server.port', 9090);
await config.save();
```

over this:

```yaml
# the app's settings
server:
  # where to listen
  port: 8080
  host: example.com
defaults: &d
  retries: 3
staging:
  <<: *d
plugins:
  - a
  - b
motd: |
  line one
  line two
```

changes `8080` to `9090` and leaves **every other byte identical** — both
comments, the anchor, the merge key, the block scalar, the sequence and every
space of indentation.

A sequence is diffed by **index**, so a `push` is one edit and a comment on an
item nothing touched stays where it is.

### Your file's own shape is kept

A byte order mark, CRLF line endings and the exact run of newlines the file ends
with are detected at read and reapplied at write, so none of them is a loss. So
is the **layout**: `yaml` renders indentation from options rather than from the
source, so the store reads the file's own and renders with it. Measured, that
detection was right on the first try for all 24 documents it was tried against —
one-, two-, four-, six- and eight-space indentation, an unindented sequence, a
tight flow collection — with a bounded fallback for a shape it has not met.

### What it cannot carry, per document

`layer.wouldLose` is **absent** where a write of that file would lose nothing,
which is the normal case: twenty-four of the thirty-five documents this package
measures itself against round-trip byte for byte, comments and anchors and merge
keys and block scalars among them.

Where a document holds something `Document.toString()` renormalizes, it is
reported and the write refuses unless you say so:

```js
await config.save({ lossy: true });
```

The complete residual, each measured:

| what                                                      | becomes              |
| --------------------------------------------------------- | -------------------- |
| `a: 1   # c`                                              | `a: 1 # c`           |
| `a: 1` + tab + `# c`                                      | `a: 1 # c`           |
| a run of blank lines inside the document                  | one blank line       |
| `a: 1` then `# tail`                                      | a blank line between |
| `? a` / `: 1`                                             | `a: 1`               |
| a folded scalar's own line breaks                         | one folded line      |
| `!!str 5`                                                 | `!!str "5"`          |
| an indented comment above an **unindented** sequence item | column 0             |
| a flow collection written across lines                    | one line             |
| a block scalar indented past the step                     | the step             |
| four-space indent with an unindented sequence             | a two-space indent   |

The last is the parser's own limitation rather than a detection failure:
`{ indent: 4, indentSeq: false }` does not reproduce it, because `yaml` indents
the sequence by the step whatever `indentSeq` says once the step is not two.

Each entry names the **line**, and that is exact rather than a guess: what is
compared is the two renderings line by line, so a line this points at is a line
where your file and a no-op write really do differ. (The XML store matches
patterns against the source instead, which needs a pass blanking every comment
and CDATA section to stop it naming a line with nothing wrong with it.)

What is **not** exact that way is which of the rows above a difference is, and
that is worth knowing because it was wrong once: the blank-line row fired on two
documents with no blank line in either, because any rendering **shorter** than
the source leaves the tail comparing against nothing. So each row is narrow and
each has a test; where none of them recognizes a difference, the line is still
named and the message says only that.

## What YAML cannot hold

`canRepresent()` refuses these at the `set()` that wrote them, naming the path:

- **`undefined`**, which YAML writes as `null`. (Core drops a key holding either
  `null` or `undefined` before it reaches a store, so this is for a `write()` you
  made directly.)
- **`NaN`**, which writes as `.nan` and reads back as `NaN` — a value
  `checkValue()` refuses on a `number` setting, so writing one produces a config
  the next run cannot load.
- **A `bigint`**, for a different reason from JSON's: `JSON.stringify` _throws_
  for one, where YAML writes `10` happily and it reads back as the **number** 10.
  No data type reads a bigint back.
- **A function or a symbol**, which `toString()` throws `Tag not resolved` about.
- **An invalid `Date`**, whose own `toJSON` is `null`.
- **A `Map`, a `Set`, a class instance** — each writes its own contents and reads
  back as a plain mapping or a sequence, which is a different kind.
- **A hole in a sequence**, which writes as `null`.
- **A value that refers back to itself.**

That is **wider** than either sibling store, and in both directions it is the
format rather than a preference:

- `Infinity` and `-Infinity` are **allowed**, written `.inf` and `-.inf`. They
  read back as themselves and `checkValue()` takes one, so the value survives
  the round trip and the next load. `jsonCanHold()` refuses both, because JSON
  rewrites them as `null`.
- **Every string there is** is allowed. XML refuses a whole class — a C0 control,
  a lone surrogate, `U+FFFE`, a value whose own leading or trailing whitespace
  matters — because it has no escape for most of them. YAML has a double-quoted
  scalar with an escape for everything, and `yaml` reaches for one when it has
  to: measured through a real UTF-8 file, `\u0000`, `\u007f`, NEL, LS, PS, a bare
  CR, `U+FFFE`, both halves of a surrogate pair on their own and `' padded '` each
  round-trip byte for byte.
- **Any key** is allowed, because YAML quotes one. What a key still cannot be is
  unreachable-by-path, and that is _core's_ refusal rather than this one's:
  `__proto__` and `constructor` are `Unsafe config key`, which names the layer.

Everything else is written as YAML's own scalar, so a number is a number and a
boolean is a boolean — which is the inverse of the XML store, where everything is
a string. A `Date` is written as its ISO form, because `type: 'date'` reads one
back.

### One consequence worth knowing

The check is asked of the **merged document** rather than of what you passed, so
that a key your write is not claiming cannot refuse a write that never touches
it. Which means a file that already holds something YAML cannot carry refuses
**every** write to that file. Reading such a file is fine; only writing it back
is refused.

## Options

```js
yaml(path, { format: 'yml' });
```

| option   | default  | what it is                                    |
| -------- | -------- | --------------------------------------------- |
| `format` | `'yaml'` | what to call this store's format in a message |

`.yml` and `.yaml` are **one store**, which is what that option exists to make
visible rather than to work around: two registrations would be two stores to keep
in agreement about a schema version, a residual table and three write refusals,
for two spellings of one format. So the extension is not read at all and the
store is the same either way.

It is a constructor option rather than anything on `ConfigStore`, so the
published interface is unchanged. The whole surface, since an exported type is
API you can write into your own signatures: `yaml` and `YamlStoreOptions`.
Everything else a store needs is `@ttylabs/sigil/config`'s.

There is deliberately **no `schema` option**, which
[`@ttylabs/config-xml`](../config-xml) needs: an XML list with one occurrence is
indistinguishable from a scalar, and YAML spells a one-item list `[a]` or `- a`.
So there is no ambiguity for a schema to resolve.

## A known gap: translating this package's messages

Everything a user's _file_ can provoke is translated through
`@ttylabs/sigil/i18n`, which is the line sigil draws: a schema declaration and a
dotted path are the app's own and stay English, and a refusal naming a line is
something a user can act on.

What does not work yet is `sigil check` knowing about it. That check compares an
app's catalogs against `SIGIL_KEYS` plus the app's own, and a key belonging to a
_dependency_ is in neither — so an app that translates one gets a warning on
correct code with a message pointing the wrong way. The shape of the fix is
`sigil check` reading an `./i18n-keys` subpath from each dependency that
publishes one and unioning it into the framework set — purely additive, and a
change to what `sigil check` promises every app rather than anything about YAML,
which is why it is not taken here.

## What this costs

`@ttylabs/config-yaml` is **10 kB** of its own code over one module, plus `yaml`,
which is about 300 kB of JavaScript and has no dependencies of its own. An app
that does not import this pays nothing for either, and the published declaration
names no `yaml` type — so a consumer that reads this store's signature does not
take the parser's types on.

## License

MIT
