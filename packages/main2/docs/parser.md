# Parser

The parser is a multi-pass, hierarchical argument parser. It resolves commands,
subcommands, options, flags, and positional arguments from a declarative schema.

```js
import { parse } from 'main2';

const state = await parse({
	argv: process.argv.slice(2),
	env: process.env,
	schema: {
		options: {
			'-v, --verbose': 'Print more output',
			'--no-color': 'Disable colored output',
		},
		commands: {
			build: {
				options: { '--target <name>': { choices: ['esm', 'cjs'] } },
				args: ['<entry>', '[rest...]'],
				run({ argv }) {
					// argv.target, argv.entry, argv.rest, argv.verbose, argv.color
				},
			},
		},
	},
});
```

## How resolution works

Two rules govern lookup, and they are deliberately different from each other:

- **Commands resolve against the innermost context only.** Once `build` is
  matched, a later `build` token is looked up in `build`'s own subcommands, not
  the root's. A token that repeats a command name becomes a positional
  argument.
- **Options resolve across the whole context chain.** A subcommand can use any
  option its parents declare, so `build --verbose` works when `--verbose` is
  declared at the root.

The parser makes repeated passes, one per discovered context, because an option
may appear before the command that declares it. `--target esm build` resolves:
the first pass finds `build`, the second pass resolves `--target` against it.

## Commands

Commands are declared as an object keyed by name, or as a path to a file,
directory, or npm package that exports one (see [Lazy loading](#lazy-loading)).

The name string carries more than a name:

| Syntax      | Meaning                                       |
| ----------- | --------------------------------------------- |
| `build`     | Command named `build`                         |
| `@b`        | Alias — resolves to the command, not its name |
| `!internal` | Hidden alias; also hides the command itself   |
| `<arg>`     | Inline required argument                      |
| `[arg]`     | Inline optional argument                      |

Labels are separated by commas or spaces, so `'build, @b <entry>'` declares a
command named `build`, aliased `b`, taking one required argument.

The first bare label names the command and every bare label after it becomes an
alias, so `'build, b'`, `'build b'`, and `'build, @b'` all declare a command
named `build` answering to `b`. A `@` or `!` prefixed label is always an alias;
it names the command only when the string has no bare label at all, which is
what makes `'@b'` and `'!internal'` on their own work, and why `'@ls, list'` is
named `list`. Empty labels — a leading, trailing, or doubled separator — are
ignored, and a name string with no label at all throws.

Aliases can also be given as a property, which is clearer for more than one:

```js
const schema = {
	commands: {
		build: { alias: ['b', 'compile'] },
	},
};
```

Inline arguments cannot be combined with an `args` array on the same command;
declaring both throws.

### Command properties

| Property   | Type                     | Notes                                               |
| ---------- | ------------------------ | --------------------------------------------------- |
| `alias`    | `string \| string[]`     | Additional names                                    |
| `args`     | `(string \| Argument)[]` | Positional arguments                                |
| `commands` | `object \| string`       | Subcommands, or a path to load them from            |
| `default`  | `boolean`                | Runs when argv named no command — see below         |
| `desc`     | `string`                 | Description for help                                |
| `hidden`   | `boolean`                | Omit from help; a `!` name prefix sets it too       |
| `hooks`    | `{ init, parse }`        | Lifecycle callbacks                                 |
| `options`  | `object`                 | Options scoped to this command and its children     |
| `run`      | `(state) => unknown`     | Handler invoked by `main2()` when this command wins |

A command is hidden if its name carries a `!` prefix **or** it declares
`hidden: true`. The two are additive: either one alone is enough, and an
explicit `hidden: false` does **not** un-hide a `!` prefixed name — marking a
name internal is the more deliberate act, and staying hidden is the safer
outcome. The same holds for a lazily loaded command: a `!` on the placeholder
wins over a `hidden: false` in the module, which never saw the prefix. Drop the
`!` to make the command visible. A command that declares neither always reads
back `hidden: false`, never `undefined`. A non-boolean `hidden` throws.

Note that a `!` prefixed label is still registered as an alias — it is only
left out of the help label — and it hides the whole command, not just that one
alias, so `'build, !internal'` hides `build` too. `!` marks the command, not
the label it happens to sit on: making it positional would mean `'!build, b'`
silently published a visible command. An alias that should stay out of help
without hiding the command goes in the `alias` property, which never reaches
the label.

### The default command

A command marked `default` runs when argv never named one:

```js
const schema = {
	commands: {
		build: { default: true, args: ['<entry>'], run() {} },
		test: {},
	},
};
```

`mycli` runs `build`, and `mycli out.js` runs `build out.js`. The default
stands in for the name that was never typed, so it joins the context chain
exactly as a typed name would: it becomes `state.cmd`, its options resolve, its
arguments take the positional values, and a token after it resolves against
_its_ subcommands — `mycli all` reaches `build`'s `all` subcommand. The one
difference is that `state.$` has no `Command` entry for it, because no token in
argv named it.

An explicit command name always wins. The default is only consulted once every
context argv named has been resolved, and only on the innermost one, so
`mycli test` runs `test` and nothing dispatches a default afterwards.

> [!IMPORTANT]
> The default runs even when it declares required arguments that were not
> supplied, so `mycli` with a default `build <entry>` fails with
> `Missing required arguments: <entry>`. `default` means the name is implied,
> not that the command steps aside when its arguments are missing — and the
> alternative, applying it only when there are no positional values at all,
> would make `mycli out.js` an `Unexpected argument`, which is the case a
> default command exists for. Give the argument a `default` if an unqualified
> invocation should work.

Every level gets its own default. A subcommand marked `default` runs when its
parent was named and nothing after it was, and a default whose own subcommands
declare one cascades:

| Schema                                 | `mycli`     | `mycli build` |
| -------------------------------------- | ----------- | ------------- |
| `build` default                        | `build`     | `build`       |
| `build > all` default                  | —           | `build all`   |
| `build` default, `build > all` default | `build all` | `build all`   |

Only the innermost command's arguments and the chain's options are checked, the
same as for a chain that was typed out — `mycli build all` never checks
`build`'s arguments either — so a default that cascades into a default of its
own does not enforce its parent's.

Two sibling commands both marked `default` throw while the schema is built —
`Only one default command is allowed: "build" and "test" are both default` —
rather than one of them quietly winning, since which one won would come down to
registration order, and for a directory of command modules that is whatever the
file system returned first.

> [!NOTE]
> `--help` short-circuits before the required-argument check, so `mycli --help`
> under a default command with required arguments prints help rather than
> reporting the missing argument. See
> [Help wins over what is missing](#help-wins-over-what-is-missing).

`default` has to be visible where the command is registered. A command that is
only a path is not loaded to find out whether its module claims to be the
default; declare it on the entry instead, which a lazily loaded command can do
alongside its `path`. A command **package** is the exception: its entry module
is read while the schema is built either way, so a `default` it exports is
honored.

> [!WARNING]
> A default command's options are declared only once it joins the chain, which
> is after argv has been walked, so nothing protects them from being taken as
> an earlier option's value: given `--verbose` on the default `build` and
> `--name [v]` at the root, `mycli --name --verbose` reads as
> `name: '--verbose'`. This is the same known bug as a subcommand's option used
> before its subcommand — see the warning under
> [How an option gets its value](#how-an-option-gets-its-value) — and naming
> the command works around it here too.

### Lazy loading

`commands` may be a path instead of an object. The parser resolves, in order:

1. A **package** — a directory with a `package.json`, loaded via its `exports`
   or `main`, falling back to `index.js` / `index.mjs` / `index.cjs`. The
   package's `name` and `description` fill in the command's `name` and `desc`.
2. A **directory** — every `.js`, `.mjs`, and `.cjs` file inside becomes a
   command named after the file.
3. A **file** — one command, named after the file unless a name is given.

The module must default-export a command object. Loading is deferred until the
command is actually matched, so a large CLI only pays for the branch it takes.

Only the placeholder sees the name string, so the aliases and help label parsed
from it are carried onto the loaded command; a module that declares its own
`name` string brings its own label instead. An `alias` the module declares is
merged in, but it cannot resolve the command — the parser has to match the
command before it can load the module that declares the alias, so a name a user
is expected to type belongs on the placeholder.

## Arguments

Positional arguments are declared as strings or objects:

| Syntax     | Required | Multiple |
| ---------- | -------- | -------- |
| `foo`      | no       | no       |
| `<foo>`    | yes      | no       |
| `[foo]`    | no       | no       |
| `foo...`   | no       | yes      |
| `<foo...>` | yes      | yes      |
| `[foo...]` | no       | yes      |
| `[foo]...` | no       | yes      |

A variadic argument collects every remaining positional value into an array,
so only the last argument may be variadic. An argument declared after one
could never be given a value, and the schema is rejected when it is
initialized:

```
Only the last argument can be variadic: <files...> is followed by [extra] in
the "build" command
```

That holds however the arguments are declared — inline in the command name
(`'build <files...> [extra]'`), in an `args` array, or by a lazily loaded
command module, which is checked when the module loads.

An optional argument that precedes a required one is promoted to required,
since there is no way to skip it.

### Argument properties

| Property    | Type                    | Notes                                    |
| ----------- | ----------------------- | ---------------------------------------- |
| `choices`   | `unknown[]`             | Allowed values; validated when present   |
| `default`   | `unknown`               | Used when the argument is absent         |
| `env`       | `string \| string[]`    | Environment fallback; first defined wins |
| `multiple`  | `boolean`               | Collect into an array                    |
| `name`      | `string`                | Required                                 |
| `required`  | `boolean`               |                                          |
| `transform` | `(value, state) => any` | Runs before type coercion                |
| `type`      | `DataType`              | Defaults to `string`                     |

## Options

Options are declared as an object whose **key is a format string**. The value
may be `null`, a description string, or an object of properties.

```js
const schema = {
	options: {
		'-v, --verbose': null, // flag
		'-o, --output <dir>': 'Where to write', // takes a value
		'--cache [dir]': {}, // optional value
		'--no-color': null, // negated flag
		'--tag <name>': { multiple: true }, // repeatable
	},
};
```

The format string is split on commas, spaces, pipes, and equals signs. Each
part is interpreted by shape:

| Part     | Meaning                                        |
| -------- | ---------------------------------------------- |
| `--name` | Long name; the first one becomes the base name |
| `-n`     | Short name                                     |
| `<hint>` | Takes a value, and the **option is required**  |
| `[hint]` | Takes a value                                  |

An option with no hint and no `choices` is a **flag**. A hint ending in `...`
is rejected — only a positional argument can be variadic. See
[Repeatable options](#repeatable-options).

> [!IMPORTANT]
> `<hint>` marks the _option_ as required, not just its value. This diverges
> from Commander and yargs, where `<>` means the value is mandatory when the
> option appears and the option's own requiredness is separate. Use `[hint]`
> for an optional option that takes a value. This is intentional and tested —
> see `test/parser/options.test.ts`.

The destination key on `state.argv` is the base name in camelCase, so
`--dry-run` becomes `argv.dryRun`.

### How an option gets its value

An option that takes a value looks in three places, in order:

1. An attached value — `--name=chris` or `--name"chris"`.
2. The next token, if it is allowed to be a value.
3. Nothing at all.

Step 2 is the interesting one:

> [!IMPORTANT]
> An option consumes the next token **unless that token resolves to an option
> that something in the context chain declared.** So `--name --verbose` leaves
> `--verbose` alone, while `--name --undeclared` takes `--undeclared` as the
> value.

This diverges from Commander, which reports `option argument missing` for any
value starting with a dash. Values legitimately start with a dash — `--num -15`,
`--filter -test` — and refusing all of them makes those spellings unreachable.
What a schema does know for certain is its own options, so those, and only
those, are protected. `--name=--verbose` forces the issue either way.

Protected tokens are declared long and short options anywhere in the context
chain, a short group that resolves against it (`-ab` where both are declared),
and the `--` terminator. A **command** name is not protected: when `--name
build` is read, `build` has not been matched yet, so `--name` takes it. Use an
attached value if that matters.

> [!WARNING]
> Protection only covers options that are already known when the token is read.
> A subcommand's option used _before_ its subcommand is not yet declared, so an
> earlier option takes it: given `--target` on `build`, `--name --target x
build` reads as `name: '--target'` and leaves `x` stranded. Putting the
> subcommand first works. This falls out of the multi-pass design — options are
> bound as they are read, which is also what lets `--name build` treat a
> command name as a plain value.

An option that reaches step 3 **throws**, required or not:

```
Missing value for option --name
```

`<>` and `[]` say whether the _option_ has to appear — `[value]` is an optional
option that **takes a value** — and neither says the value may be left out.

| Input                 | `--name <v>` (required) | `--name [v]` (optional) |
| --------------------- | ----------------------- | ----------------------- |
| `--name chris`        | `'chris'`               | `'chris'`               |
| `--name=chris`        | `'chris'`               | `'chris'`               |
| `--name`              | throws                  | throws                  |
| `--name=`             | `''`                    | `''`                    |
| `--name --declared`   | throws                  | throws                  |
| `--name --undeclared` | `'--undeclared'`        | `'--undeclared'`        |

`--name=` is different from `--name`: it **gave** a value, an empty one. Whether
that is allowed is the data type's question, and an empty value is a value only
where the type has one — `string` does, `bool` and `count` read it as off, and
every other type rejects it the way `date` and `json` always did. So `--port=`
on an `int` option throws `Invalid integer`, and `--name=` on a `<value>` string
option is `''`: requiredness is about the option appearing, not about what it
was given.

> [!NOTE]
> An empty **environment** variable is read as unset. `PORT=` in a shell or a
> `.env` file almost always means "not configured", so it falls through to
> `default` rather than failing the parse on a value most types reject.
> `--port=` remains the deliberate way to say empty, and is not second-guessed.

An attached value is taken exactly as it was typed. Only the name is trimmed,
so `--sep=` followed by a space is the one-space value `' '` and not `''` —
the same value `--sep ' '` gives, which is the point: the two spellings of one
thing must not disagree about whitespace the caller meant.

### Repeatable options

An option takes **one** value per use. `multiple` makes it repeatable, and each
use appends to an array:

```js
parse({
	argv: ['--tag', 'a', '--tag', 'b'],
	schema: { options: { '--tag <t>': { multiple: true } } },
});
// { tag: ['a', 'b'] }
```

An option never consumes consecutive values, so `--tag a b` is `tag: ['a']`
with `b` left as a positional. Consuming consecutive values is what a variadic
**argument** is for:

```js
parse({ argv: ['a', 'b', 'c'], schema: { args: ['<files...>'] } });
// { files: ['a', 'b', 'c'] }
```

This divides the job cleanly: repetition is unambiguous, while a greedy option
competes with the positional arguments for every token after it — which is why
Commander needs `--` and yargs needs `greedy-arrays=false` to get back out. It
is also the same rule as [how an option gets its value](#how-an-option-gets-its-value):
one token, then stop.

Because of that, a `...` hint on an option is a promise the parser will not
keep, so it is refused at schema-build time rather than accepted as decoration:

```js
parse({ schema: { options: { '--tag <tags...>': { multiple: true } } } });
// TypeError: Option "tag" hint cannot be variadic; use `multiple: true` to
// collect repeated uses into an array
```

An environment fallback or a scalar `default` on a `multiple` option is wrapped
in an array, so the value's shape does not depend on where it came from. How many
values arrived is decided before coercion: a string is one value even when it
parses to an array, so `ITEMS='[1,2]'` on a `json` option is `[[1, 2]]`, the same
as `--items '[1,2]'`. An array `default` is the list itself and is used as it is.

A counter is refused the same way, from the other direction: `type: 'count'`
already collects repeated uses — into a number rather than an array — so
`multiple` asks for nothing it does not do, and asking anyway used to produce a
value whose shape depended on argv:

```js
parse({ schema: { options: { '-v': { type: 'count', multiple: true } } } });
// TypeError: Option "v" cannot be a counter and collect; `type: 'count'`
// already counts repeated uses
```

### Undeclared options

An option-like token that nothing declared still produces a value, so a CLI can
pass options through without declaring them. Set
`settings.allowUnknownOptions` to `false` to throw `Unknown option "--foo"`
instead.

| Input         | Result                   |
| ------------- | ------------------------ |
| `--foo`       | `foo: true`              |
| `--foo=bar`   | `foo: 'bar'`             |
| `--foo bar`   | `foo: 'bar'`             |
| `--foo --bar` | `foo: true`, `bar: true` |
| `-x 1`        | `x: 1`                   |

They are resolved only after every command has been matched, so nothing is
called undeclared until every context that could have declared it is known.
They then differ from declared options in three ways, all of them because
nothing said what they are:

- They take the next token only when it is **not** option-like, since nothing
  declared that they take a value at all. A declared option is the mirror
  image: it is known to want a value, so it takes whatever follows.
- Values are coerced with `auto`, since there is no declared type to coerce to.
  `--age 20` is the number `20`, not `'20'`.
- `no-` is not read as negation. `--no-color` is `noColor: true`, not
  `color: false`.
- They never write a destination something active describes. An undeclared
  spelling can land on a declared destination — `--verbose` where `-v` is declared
  as `{ name: 'verbose' }`, or `--logLevel` where `--log-level` is declared — and
  writing it would replace a value the schema described, with its type, `choices`,
  `multiple`, and `transform` all skipped. The declared value stands and the
  undeclared one is dropped from `argv`; what was typed is still on `state.$`.
  Active means every option in the context chain, since that is where options
  resolve from, and the arguments of the command being run: an ancestor's
  arguments are not read once a subcommand is dispatched, so they own nothing and
  `mycli build --mode x` writes `mode` even where the root declares `[mode]`. What
  owns a destination is asked at the moment of the write, so an option a hook or a
  `transform` added mid-parse counts.

Only the `--long-name` and `-x` forms are recognized. An unresolved short group
such as `-abc` stays a positional value. Repeating an undeclared option
overwrites the previous value; it does not collect into an array. Undeclared
options are not pushed onto `state._`.

### Negation

A name beginning with `no-` becomes a negated flag. Both spellings are
registered, and the one actually typed decides the value:

| Input              | Result  |
| ------------------ | ------- |
| _(absent)_         | `true`  |
| `--color`          | `true`  |
| `--no-color`       | `false` |
| `--color=false`    | `false` |
| `--no-color=false` | `true`  |

Every other name a negated flag answers to turns the destination off, the same
as `--no-color` does. Given `-C, --no-color`, `-C` is `color: false`. Only the
positive spelling the flag registers for itself — `--color` — turns it on.

#### Declaring both a value and its negation

A valued option and a negated flag of the same name may be declared together.
They are two options sharing one destination: the valued one sets it and the
flag turns it off. Declaration order does not matter.

```js
{
	options: {
		'--cheese <type>': 'cheese flavour',
		'--no-cheese': 'hold the cheese'
	}
}
```

| Input            | Result                           |
| ---------------- | -------------------------------- |
| `--cheese gouda` | `cheese: 'gouda'`                |
| `--no-cheese`    | `cheese: false`                  |
| `--cheese`       | throws, `<type>` demands a value |

The valued option owns the destination's default, so the `true` a lone
negated flag would imply is dropped: the pair above starts out undefined, and
`--cheese [type]` with a `default` of `'mozzarella'` starts out
`'mozzarella'`. A `default` declared on the flag itself is still honored when
the valued twin declares none. Precedence over the shared destination is the
usual one: argv, then an environment variable declared on either twin — the
valued twin's are read first — then a default.

Because `<type>` makes the option required, anything that fills the shared
destination satisfies it — `--cheese <value>`, `--no-cheese`, or a `default`
or environment variable declared on either twin.

`choices` belong to whichever of the two wrote the value. They constrain the
values the valued option takes, not the `false` its twin means, so `--no-cheese`
is always allowed — including after a value has already been given:
`--cheese brie --no-cheese` is `cheese: false`, because the flag wrote last. A
`false` the valued option produced itself is still checked, whether it came from
its own `default` or from `--cheese false`.

The same rule holds wherever two declarations share a destination — an option and
a positional argument of the same name — and it is why a value is validated once,
by its writer, rather than once per declaration that can reach it.

A value with no writer is the exception, and it is validated by every declaration
that can reach the destination. That covers a value a hook put on `state.argv`
itself, and one whose writer a hook has since replaced: without it, writing or
replacing from a hook would be a way around `choices`.

Declaring `negate: false` on the flag opts out of all of this: the `no-` is
then part of the name, so it keeps its own `noCheese` destination and reads as
present rather than inverted.

### Short option groups

Groups are expanded against the schema, not by shape, because whether a
character is a flag or the start of a value depends on how it was declared:

| Input       | Given                        | Result           |
| ----------- | ---------------------------- | ---------------- |
| `-abc`      | all flags                    | `-a -b -c`       |
| `-n5`       | `-n` takes a value           | `-n 5`           |
| `-abcvalue` | `-a`, `-b` flags, `-c` value | `-a -b -c value` |
| `-ab val`   | `-a` flag, `-b` value        | `-a -b val`      |

A group that cannot be resolved in the current context is left alone and
retried once more contexts are known.

### Option properties

| Property    | Type                    | Notes                                        |
| ----------- | ----------------------- | -------------------------------------------- |
| `alias`     | `string \| string[]`    | Extra short or long names                    |
| `choices`   | `unknown[]`             | Allowed values; implies the option takes one |
| `default`   | `unknown`               | Used when absent                             |
| `desc`      | `string`                | Description for help                         |
| `env`       | `string \| string[]`    | Environment fallback; first defined wins     |
| `hidden`    | `boolean`               | Omit from help                               |
| `hint`      | `string`                | Value placeholder                            |
| `multiple`  | `boolean`               | Repeatable; collects into an array           |
| `negate`    | `boolean`               | Force or suppress negation                   |
| `required`  | `boolean`               | Option must be present                       |
| `transform` | `(value, state) => any` | Runs before type coercion                    |
| `type`      | `OptionDataType`        | Defaults to `bool` for flags, else `string`  |

## Data types

| Type     | Accepts                                      | Produces  |
| -------- | -------------------------------------------- | --------- |
| `string` | anything                                     | `string`  |
| `bool`   | `true`/`t`/`yes`/`y`/`on`/`1` and negations  | `boolean` |
| `yesno`  | `y`, `yes`, `n`, `no` (case-insensitive)     | `boolean` |
| `int`    | `-?\d+` or `0x…`, within the safe range      | `number`  |
| `number` | anything `Number()` accepts but blank        | `number`  |
| `date`   | `YYYY-MM-DD`, ISO 8601, or 13-digit epoch ms | `Date`    |
| `json`   | valid JSON                                   | `unknown` |
| `count`  | flags only; counts occurrences               | `number`  |
| `auto`   | guesses bool, then date, then number, JSON   | varies    |

`string` is the default. `auto` is opt-in because its guesses are lossy —
it turns `007` into `7` — and because it makes static types unusable.

Flags accept only `bool`, `count`, `yesno`, and `auto`; the last two are
normalized to `bool`. `count` is rejected on non-flags, and with `multiple`. A
string value that reaches a counter — from the environment, or from a string
`default` — is coerced like an `int`, and an empty one is `0`, the same way `bool`
reads an empty value as false. `int` rejects an empty value, and so does
`number`: `Number('')` and `Number(' ')` are both `0`, and neither is a number
somebody wrote. Only `string` and the two flag types have a reading of empty. A counter reached with an explicit value — `-v=3` — is **set** to it
rather than incremented, the way an explicit `--flag=false` beats the name a
bool flag was reached by, so `-v -v=5 -v` is `6`. A counter is never wrapped in
an array. What a counter does not escape is what no type escapes: a non-string
`default` passes through untouched, and a negated twin sharing the destination
writes `false`. Normalizing `yesno` to `bool` loses nothing, since `bool`
accepts `yes` and `no` too.

An `int` outside the safe integer range throws rather than returning a value
that is not the one written: `Number('9007199254740993')` is `...992`, and an
id that comes back as a different id is the one failure a caller cannot see.
Space around a real number is still that number, since `Number()` trims — only
a value with nothing else in it is empty.

A `date` has its calendar checked before the `Date` is built, because `Date`
overflows rather than refusing: `2024-02-30` used to come back as March 1st. A
day that does not exist now throws `Invalid date`, the same as `9999-99-99`
always did. The check is arithmetic, so it does not depend on the time zone the
process is running in.

`bool` accepts `true`, `t`, `yes`, `y`, `on`, and `1` as true, and `false`,
`f`, `no`, `n`, `off`, `0`, and the empty string as false. Case is ignored.
Anything else throws `Invalid boolean: "…"` rather than guessing — `0` and
`no` are far more likely to mean false than to be a value someone wants
coerced to true, and a typo such as `--flag=ture` should not silently read
as true.

## Value precedence

For each option and argument, the first defined source wins:

1. A value parsed from `argv`
2. `env`
3. `default`

String values from `argv`, `env`, and string `default`s are all coerced to the
declared type. Non-string defaults are passed through untouched, so
`default: 8080` stays a number regardless of `type`. A `multiple` option whose
value comes from a default or the environment is wrapped in an array.

A user `transform` runs before type coercion, and only on values parsed from
`argv` — not on defaults or environment fallbacks.

## Terminator and leftovers

`--` ends parsing. Everything after it is collected verbatim as _extra_
arguments and requires `settings.allowExtraArguments`, or parsing throws.
Verbatim means each token whole: `-- --foo=bar` is the one extra argument
`--foo=bar`, never the two the parser would have split it into.

Positional values with no matching argument definition throw unless
`settings.allowUnexpectedArguments` is set. All positional values, matched or
not, are also pushed onto `state._`. Option-like tokens are never positional
values — see [Undeclared options](#undeclared-options).

## Settings

| Setting                    | Default | Effect                                                      |
| -------------------------- | ------- | ----------------------------------------------------------- |
| `allowExtraArguments`      | `false` | Permit arguments after `--`                                 |
| `allowUnexpectedArguments` | `false` | Permit undeclared positional arguments                      |
| `allowUnknownOptions`      | `true`  | Collect undeclared options instead of throwing              |
| `assertCwd`                | `true`  | Fail early if the working directory is gone                 |
| `errorHandler`             | —       | `false` to rethrow, or a function to render errors yourself |
| `helpExitCode`             | `0`     | Exit code `main2()` sets after printing help                |

## Sharing options between commands

Options resolve across the whole context chain, so a child command already sees
everything its parents declared — nothing has to say so, and nothing has to be
copied. A `--verbose` on the schema is the `--verbose` every subcommand reaches.

`options()` hoists a set of options out into a value, for the cases where the same
set belongs in more than one place:

```js
import main2, { options } from 'main2';

const global = options({
	'-v, --verbose': 'Say more',
	'--port [n]': { type: 'int', default: 8080 },
});

await main2({
	schema: {
		options: global,
		commands: {
			build: {
				options: { '-w, --watch': 'Rebuild on change' },
				run({ argv }) {
					// argv.watch, and argv.verbose and argv.port from the schema above
				},
			},
		},
	},
});
```

`options()` hands back exactly what it was given. It exists for one type-level
reason: a `const` type parameter keeps `type: 'int'` from widening to `string`,
which is what makes `--port` a number rather than a string wherever the group ends
up.

### Typed argv

`command()` derives what `run()` sees from what the command declared:

```js
import main2, { command, options } from 'main2';

const global = options({ '-v, --verbose': 'Say more' });

await main2({
	schema: {
		options: global,
		commands: {
			build: command({
				args: ['<entry>', '[extras]...'],
				options: {
					'--target [name]': { choices: ['node', 'browser'] },
					'--port [n]': { type: 'int', default: 8080 },
					'--tag [t]': { multiple: true },
					'--no-color': 'Turn color off',
				},
				run({ argv }) {
					argv.entry; // string
					argv.extras; // string[] | undefined
					argv.target; // 'node' | 'browser' | undefined
					argv.port; // number
					argv.tag; // string[] | undefined
					argv.color; // boolean
					argv.verbose; // unknown -- declared by the schema, not by `build`
				},
			}),
		},
	},
});
```

Everything the format string and the declaration say is read: the destination
after camelCase, a negated flag sharing its twin's key, `choices` as a literal
union, the data type, `multiple` as an array, and whether the key can be absent at
all. A flag is always there, and so is an option with a default or one whose
`<value>` made it required — the same rules the parser follows, because the types
are those rules written a second time.

`command()` hands back exactly what it was given, like `options()`.

### The types stop at the command that declared them

Resolution walks the chain; inference cannot. A command is typed at its own
`command()` call, and nothing at that call knows where in the tree the command will
be mounted — so what a command declares is typed, and every other key in `argv` is
`unknown`:

```js
build: command({
	options: { '-w, --watch': 'Rebuild on change' },
	run({ argv }) {
		argv.watch; // boolean
		argv.verbose; // unknown -- the schema declares it, not this command
	},
});
```

`unknown` rather than an error, because the value is genuinely there: a key this
command did not declare is one a command above it may well have. It is also not an
index signature over the declared keys — those keep their types — so the narrow
half stays narrow.

A command that wants the shared options typed declares them, by spreading the group
into its own:

```js
options: { ...global, '-w, --watch': 'Rebuild on change' }
```

which makes `argv.verbose` a `boolean`. The cost is that the command now owns a
declaration of its own: it shadows the one above it, and help lists it among the
command's options rather than under `Global options`.

### Why it is a call

A nested object literal is checked against the declared type of the property it
sits on, and checking does not re-infer that type's parameters. Only a generic
_call_ infers. So a command written as a bare literal inside `commands` keeps the
`argv` it always had — `Record<string, unknown>`, readable with no guard — and one
written through `command()` gets the narrow one.

Wrapping is optional and per command. A command with no `run`, or one whose `argv`
nobody reads, can stay a plain object.

### What inference cannot see

A command loaded lazily from a directory or a package is not known until runtime,
so it is invisible to inference by construction. An inline schema gets full
types; a lazily loaded command gets the base type. That is a property of where the
command lives rather than something to work around.

## Help

A schema gets `--help` and a `help` command for free. Both go on the root
context, because options resolve across the whole context chain: one `--help`
there answers everywhere, and `mycli build --help` describes `build` rather than
the program.

```js
await main2({
	schema: {
		name: 'mycli',
		commands: {
			build: { args: ['<entry>'], desc: 'Compile the project', run: build },
		},
	},
});
```

```
$ mycli build --help
Usage: mycli build <entry>

Compile the project

Arguments:
  <entry>

Global options:
  -h, --help  Show help for a command
```

`help [command...]` answers the same question from the other direction, and takes
a path: `mycli help build targets` describes `targets` with the chain above it
intact, so the options it inherits are the ones that actually reach it. A name it
cannot find throws `Unknown command "…"`.

### What gets added, and what does not

Nothing is added over the top of a declaration.

| The app declares | What it gets                                             |
| ---------------- | -------------------------------------------------------- |
| nothing          | `-h, --help` and a `help` command                        |
| `-h` for its own | `--help` with no short form; the app keeps `-h`          |
| `--help`         | neither the flag nor the short-circuit — the app owns it |
| a `help` command | no `help` command from here; the app's runs              |
| `help: false`    | nothing at all                                           |

An app that declares `--help` itself is responsible for what `--help` does, which
is the only reading of a declaration that means anything. Its value reaches
`argv` like any other option's.

The added flag's value does not. A flag always has a value, so an added `--help`
would put `help: false` on the parsed values of every app that never asked for
it; the parser reads the flag off `state.$` instead.

## Help wins over what is missing

`parse()` decides whether help was asked for after walking argv and before
validating anything, so:

```
$ mycli build --help
```

prints `build`'s help rather than `Missing required arguments: <entry>`. Asking
what a command needs and being told that you did not provide it is not an answer.

That covers a missing required option and a missing required argument, and
nothing else. A value that will not coerce still throws, because it failed while
argv was being read — before there was a question to answer.

`--help` with no command named describes the program even when a default command
would have run. The default is in the context chain without argv having named it,
and answering with its screen would hide every other command there is.

### Reading the request yourself

`parse()` sets `state.help` and runs no command; it never writes anything. A
caller using `parse()` on its own decides what to do with it:

```js
const state = await parse({ argv, schema });

if (state.help) {
	const { resolveHelp } = await import('main2/help');
	process.stdout.write(`${await resolveHelp(state)}\n`);
	return;
}
```

`main2()` does exactly that, and then sets `process.exitCode` from
`settings.helpExitCode` — `0` unless the app says otherwise, since being asked
what a command does and answering is not a failure. A value that is not an exit
code is ignored rather than assigned, because assigning it would turn printing
help into a crash.

### Option groups

An option declaring a `group` is listed under a heading of its own. The group is a
noun and help appends the word, so it reads as an options list like every other
section:

```js
options: {
  '--verbose': 'Say more',
  '--sdk [version]': { desc: 'Which SDK to build with', group: 'Advanced' },
  '--trace': { desc: 'Dump the resolution tree', group: 'Advanced' },
}
```

```
Options:
  --verbose         Say more

Advanced options:
  --sdk [version]   Which SDK to build with
  --trace           Dump the resolution tree
```

Groups appear in the order they are first seen, which is the order the schema
declared them in. A group whose every option is `hidden` is not a heading with
nothing under it.

### Contributing help sections

Some options are not the command's to own. A `build` command with per-platform
options has to describe all of them, while only the platform that was named
should actually parse — putting every platform's options in the registry would
make `--ios-version` accepted for an Android build.

A `help` hook contributes titled sections for exactly that. It is handed the
command, its registries, and the parse state, and adds sections that are _shown
and not parsed_:

```js
const platforms = {
  android: {
    title: 'Android',
    args: [{ name: '[avd]', desc: 'The AVD to launch' }],
    options: { '--device-id [id]': 'Which device or emulator' },
  },
  ios: {
    title: 'iOS',
    options: { '--pp-uuid [uuid]': 'The provisioning profile' },
  },
};

export default {
  name: 'build',
  desc: 'Builds a project',
  options: {
    '-p, --platform [name]': { choices: Object.keys(platforms), desc: 'The target' },
  },
  hooks: {
    // what help describes: every platform, or only the one that was named
    help: [
      async ({ sections, state }) => {
        for (const [name, conf] of Object.entries(platforms)) {
          if (!state.argv.platform || state.argv.platform === name) {
            await sections.add(conf);
          }
        }
      },
    ],
    // what actually parses: the platform that was named, and nothing else
    parse: [
      async ({ options }) => {
        const conf = platforms[/* the platform */];
        for (const [format, opt] of Object.entries(conf?.options ?? {})) {
          await options.add(typeof opt === 'string' ? { desc: opt, format } : { ...opt, format });
        }
      },
    ],
  },
};
```

```
$ ti build --help
Usage: ti build [options]

Builds a project

Options:
  -p, --platform [name]  The target (choices: android, ios)

Android arguments:
  [avd]                  The AVD to launch

Android options:
  --device-id [id]       Which device or emulator

iOS options:
  --pp-uuid [uuid]       The provisioning profile

Global options:
  -h, --help             Show help for a command
```

`sections.add({ title, args, options })` reads its declarations exactly the way
`Command.options` and `Command.args` are read — a string is the description,
`null` is a format and nothing else — and runs them through the same
initialization, so a contributed option is described exactly as a declared one:
spellings shortest first, hints, defaults, choices, `hidden`, and a negated flag
sharing its pair's row.

Handing the hook the state is the point of it being a function rather than a list
on the declaration. `ti build --help` and `ti build --platform ios --help` can
describe different things, and which is a decision for the command.

A title used twice is one section rather than two headings saying the same thing,
so two platforms that share one add to it. `Global` is not available as a title or
a group, because help writes `Global options` itself.

Sections are listed after the command's own options and groups, and before what
it inherited, in the order they were added. Only the command being described is
asked: an ancestor's sections would appear under a command that has nothing to do
with them. A contributed option shadows nothing, because nothing resolves to it.

`resolveHelp()` is what fires the hooks — `renderHelp()` is synchronous and takes
built sections as an option, so a caller doing its own rendering supplies its own
or none.

### Writing your own help for one command

`Command.help` replaces the generated screen. A string is printed as it is:

```js
{ name: 'notes', help: 'Read the manual: https://example.com/docs' }
```

A function is handed the generated screen, the command, and the state, so one
that only wants to add something does not have to rebuild the rest:

```js
{
  name: 'build',
  help: ({ generated }) => `${generated}\n\nSee the docs for the full list.`,
}
```

It may be async. Returning anything but a string leaves the generated screen
alone, which is how a function that only wants to look declines to replace it.

## Errors

`parse()` throws. `main2()` catches — from the working directory check, from
`parse()`, and from the matched command's `run()`, synchronously or as a
rejected promise — and hands the thrown value to `errorHandler()`, the single
place an error becomes output:

```
$ mycli build
Error: Missing required options: --target
$ echo $?
1
```

The message and nothing else. Parser errors are plain `Error`s whose messages
are written for the person running the CLI, so a stack trace would only bury
them. The whole error is logged through the debug logger, so
`DEBUG=main2:error` brings the stack back when you want it.

`errorHandler()` sets `process.exitCode` rather than calling `process.exit()`,
so buffered stdout still flushes. The code is `1`, unless the thrown value
carries an `exitCode` that is an integer from 0 to 255 — an explicit `0`
included, which is how a future `--help` short-circuit will exit cleanly.
Anything that is not an `Error` renders too: a thrown string, an object with a
`message`, even `null`.

After an error is handled, `main2()` resolves with `undefined`. It does not
reject: its caller is a bin script, and an unhandled rejection printing a
stack is exactly what the handler exists to avoid.

### The `beforeError` hook

Every error passes through the `beforeError` hooks on its way out, whatever
threw it: a missing required option, an invalid choice, a value that will not
coerce, an unknown option, a command module that will not load, a `transform`
or a `beforeParse` hook of your own that threw, an invalid schema, and an error
from the command's `run()`. They fire inside `parse()` for everything `parse()`
throws — so calling `parse()` without `main2()` gets the same error path — and
inside `main2()`'s catch for everything else. Either way they fire once.

They run before the error is rendered, before a custom `errorHandler`, and
before the `errorHandler: false` opt-out, so the error that leaves is the error
the hooks made of it, whichever way it goes out.

**A hook may observe the error, mutate it, or replace it. It may never suppress
it.**

| The hook        | Effect                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| returns nothing | The error is unchanged — this is the observing case                                   |
| returns a value | That value is the error from there on, for the hooks after it too                     |
| mutates `err`   | The change sticks; it is the same object                                              |
| throws          | Logged under `DEBUG=main2:error` and skipped; the error it was handed stays in flight |

Suppression is deliberately not on that list. It would have to mean something
different at every throw site — what does `parse()` return when the argv it was
given is unusable, does the command still run, what is the exit code — and a
rule that cannot hold everywhere is worse than no rule. An error that has been
raised gets reported. What a hook gets to change is _which_ error that is:

```js
await main2({
	schema: {
		hooks: {
			beforeError: [
				(err, state) => {
					if (err?.code === 'ENOENT') {
						return new Error(`${state?.cmd?.name ?? 'cli'}: no such file or directory`);
					}
				},
			],
		},
	},
});
```

A replacement carries the parse state along with it, under the same
`ErrorState` symbol, so swapping the error out does not cost the renderer its
usage line. That is a reason to replace an error with an `Error`: a string, or
anything else that cannot carry a property, arrives at the handler with no
state and so with no usage line.

Commands declare `beforeError` hooks too. They fire innermost command first,
then outward along the context chain, and the schema's own hooks last — the
direction the error itself travels — and each hook is handed whatever the hook
before it made of the error. A hook listed twice, which is what the schema's
hooks would be if the context chain were walked naively, still fires once.

Both arguments are as wide as the truth: anything at all can be thrown, and an
error raised before parsing produced a state arrives without one.

```ts
type BeforeErrorHook = (err: unknown, state: ParseState | undefined) => unknown;
```

### Handling errors yourself

| `settings.errorHandler` | Effect                                                 |
| ----------------------- | ------------------------------------------------------ |
| unset                   | Built-in handler renders and sets `process.exitCode`   |
| `false`                 | `main2()` rethrows; nothing is written, no code is set |
| a function              | Replaces the handler; it owns output and the exit code |

A custom handler that throws rejects `main2()`. That is a bug in the handler,
and swallowing it would leave nothing at all reporting the original error.

```js
await main2({
	schema,
	settings: {
		errorHandler(err, { state }) {
			console.error(`${state?.cmd?.name ?? 'cli'}: ${err.message}`);
			process.exitCode = 2;
		},
	},
});
```

### Rendering more than the message

`errorHandler(err, opts)` takes a `render` function — this is the seam the
Phase 3 help and ANSI work plugs into, once there is a usage line to print and
color to print it in:

```js
import { errorHandler, renderError } from 'main2/error-handler';

errorHandler(err, {
	render: (err, { state }) => `${renderError(err)}\n\n${usageFor(state?.cmd)}`,
});
```

The renderer is handed the `ParseState` on `ctx` whenever there is one, which
is where the matched command — and therefore the usage line — comes from. That
includes a parse error: the errors that most want a usage line are exactly the
ones that stop `parse()` from returning, so `parse()` stashes its in-flight
state on the error it throws, under the exported `ErrorState` symbol and
non-enumerably, and `main2()` reads it back. Only an error thrown before there
is a state at all — invalid parse options, an invalid schema — arrives without
one. A renderer that throws falls back to the default one,
so a broken renderer cannot swallow the error it was given. `opts.stderr`
redirects the output, which is mostly there for tests. A `write` that throws
is swallowed — rendering an error must not raise a second, worse one — but an
asynchronous `EPIPE` still arrives as an `error` event on the stream, and
handling that belongs to the terminal wrapper that Phase 3 brings back.

## Differences from Commander and yargs

Much of this parser's test suite is a port of Commander's and yargs-parser's,
so the places they disagree are known and deliberate. If you are coming from
Commander, these are the ones that will bite:

| Behavior                        | Commander                        | Here                                     |
| ------------------------------- | -------------------------------- | ---------------------------------------- |
| `<value>` in an option format   | value required when option used  | **option itself** is required            |
| Unspecified flag                | `undefined`                      | `false` (`true` when negated)            |
| `--opt` with no value           | `true`                           | `''`, coerced by the data type           |
| `--opt` when option required    | error                            | error                                    |
| Bare positional name `foo`      | required                         | optional                                 |
| Value that looks like an option | error                            | taken, unless it is a declared option    |
| Negative numbers                | number-shaped check              | just a value nobody declared             |
| Undeclared option               | error                            | collected onto `argv`                    |
| String `default`                | used as-is                       | coerced to the declared type             |
| Option format strictness        | one short, one long              | extras become aliases; bare word allowed |
| Repeatable option               | `<v...>` eats consecutive values | `multiple` collects repeated uses        |
| `...` in an option hint         | makes the option variadic        | rejected; only arguments are variadic    |
| `-p=value`                      | value is `=value`                | value is `value`                         |
| `-0`                            | negative zero                    | undeclared short option `0`              |

Coming from yargs-parser, the difference that matters most is that this parser
is schema-driven and yargs-parser is not — it infers everything from argv:

| Behavior               | yargs-parser              | Here                              |
| ---------------------- | ------------------------- | --------------------------------- |
| Short group `-cats`    | always expanded           | expanded only against a schema    |
| `--no-moo`             | `moo: false`              | `noMoo: true` unless declared     |
| `--n1 -33`             | `n1: -33`                 | `n1: true`, `-33` left positional |
| Destinations           | every spelling and alias  | one camelCase destination         |
| `state._`              | values are type-guessed   | raw strings                       |
| `--foo` with a default | falls back to the default | `''`, coerced by the data type    |
| Repeated `--multi`     | collects into an array    | last wins, unless `multiple`      |

The reasoning for each is in the deliberate-decisions list in `AGENTS.md`.

## Hooks

Schema-level hooks are arrays of functions on `schema.hooks`:

| Hook          | When                                                |
| ------------- | --------------------------------------------------- |
| `beforeParse` | Before argv is walked                               |
| `afterParse`  | After argv is walked                                |
| `beforeError` | On the way out of any error — see [Errors](#errors) |

Command-level hooks live on `command.hooks`:

| Hook          | When                                                       |
| ------------- | ---------------------------------------------------------- |
| `init`        | When the command is initialized                            |
| `parse`       | When the command is matched during parsing                 |
| `beforeError` | On the way out of any error, before the schema's own hooks |

A command hook is called with `{ cmd, ...cmd[Internal] }`, so it is handed the
initialized command along with the registries the parser reads — see below for
what it may change.

## Changing a command from a hook

A command is initialized once, and what the parser reads afterwards is the
`Internal` state, not the declaration. So a hook changes a command through the
registries it is handed, never through the command's own properties:

| To do this       | Use                                        |
| ---------------- | ------------------------------------------ |
| Add an option    | `await options.add({ format: '--x [v]' })` |
| Change an option | `options.get('x')!.choices = [...]`        |
| Add an argument  | `args.push(initArg('[entry]'))`            |
| Add a subcommand | `commands.add(await initCommand({ ... }))` |

Those take effect immediately: the registries are what a parse walks, and an
`init` hook runs before any argv is read, so an option it adds is matchable on
that same parse.

`cmd.args`, `cmd.commands`, and `cmd.options` are something else — they are the
declaration as it was given, copied so a consumer editing one is not editing
their own schema. The parser never looks at them again, and their shape differs
from the registries on purpose: an inline `<arg>` in the command name, a
subcommand still waiting on its module, and an option's parsed names, aliases,
and data type only exist on the internal side.

So those three properties are **read-only**. Assigning one, deleting one, or
adding an entry to one throws, rather than appearing to reconfigure a command
that has already been built:

```js
cmd.options = { '--extra [v]': null }; // throws
cmd.options['--extra [v]'] = null; // throws
delete cmd.args; // throws
```

Everything else about a command is a plain property. An option or an argument
the registry hands back is a plain object too, so editing one in place is a
supported way to reconfigure it — with one line drawn through its properties:

| Property                                                          | After init                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `choices`, `default`, `multiple`, `required`, `transform`, `type` | Read on every parse — editing one takes effect             |
| `desc`, `hidden`, `hint`                                          | Carried for the help screen; the parser does not read them |
| `alias`, `env`, `format`, `name`, `negate`                        | Read once, at init — **read-only**, assigning throws       |

The last row is everything the registry was built from: the spellings an option
answers to, its camelCase destination, and the environment variables it falls
back to are all resolved by the time `init*()` returns. Moving one afterwards
could only mislead, so it throws and names the way through — declare another
option or argument and `add()` or `push()` it.

One thing the first row does not cover: whether `choices` is present at all is
read once, because an option with choices is not a flag. Editing the values in
a `choices` array is live; adding a `choices` array to an option that did not
declare one does not turn it into an option that takes a value.

Nor does it cover a negated twin's `default`. When an option and its negated
twin share a destination the valued twin owns the default, and which one owns
it is settled when the registry links the pair — before any `init` hook runs.
So editing `default` on the valued twin is live as the table says, while
editing it on the negated twin has no effect. Declare the default on the
valued twin instead.

## Parse state

`parse()` resolves to a `ParseState`:

| Field      | Description                                      |
| ---------- | ------------------------------------------------ |
| `argv`     | Resolved values, keyed by camelCase destination  |
| `_`        | Every positional value, in order                 |
| `$`        | The classified token stream — see below          |
| `$orig`    | The original argv                                |
| `cmd`      | The innermost matched or default command, if any |
| `contexts` | The context chain, innermost first               |
| `env`      | The environment used for fallbacks               |
| `schema`   | The schema, exactly as it was given              |
| `settings` | The settings in effect                           |

Each entry in `$` is classified as one of `Command`, `Option`, `UnknownOption`,
`Extra`, or `Unknown`, the last being a positional value.

## The schema is read, never written

`parse()` never writes to the schema it is given. The parsed command name, the
`hidden` flag, normalized arguments, the data type an option format implies,
and the `Internal` state all land on objects the parser builds for itself, so:

- The same schema object can be parsed any number of times, with different
  argv each time, and every parse sees what the first one saw.
- A schema can be frozen — `Object.freeze`, deeply — and still parse.
- A schema can be shared between CLIs, or exported as a module constant,
  without one consumer's parse changing what another one sees.
- A lazily loaded command module is merged into a copy. The ESM loader hands
  the same object to every importer, so writing the placeholder's name and
  aliases into it would outlive the parse.

`state.schema` is therefore the caller's own object, unchanged. The
initialized form of it is the outermost entry of `state.contexts`, whose
`Internal` state carries the built registries.

Every array a declaration carries is copied with it — `alias`, `args`,
`choices`, `default`, `env`, the hook lists, and anything custom — as is an
array `default` on its way to `argv`. So nothing the parser hands back can be
appended to and have that reach the declaration, whether it is reached from an
`init` hook or from the parse state afterwards.

The copy is shallow beyond that. A `run` handler, a `transform`, an object used
as a `default`, and the argument and option declarations sitting inside
`cmd.args` and `cmd.options` are the very ones that were declared; cloning a
function is not something a library can do. The parser never writes to any of
them, but a consumer who reaches into one and mutates it is mutating their own
schema — and is not changing the parse either, since the parser reads the
normalized copies in the registries. The containers holding them are frozen, so
replacing an entry throws instead; see "Changing a command from a hook".
