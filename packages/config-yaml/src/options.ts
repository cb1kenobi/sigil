import {
  isScalar,
  type DocumentOptions,
  type Node,
  type ParseOptions,
  type SchemaOptions,
} from 'yaml';

/**
 * The schema this store reads every file with, pinned rather than defaulted.
 *
 * ## YAML 1.1 and YAML 1.2 disagree about what a scalar means
 *
 * This is the one place a YAML store can silently disagree with the rest of the
 * library, so it is settled here rather than discovered in a bug report. Every
 * row below is measured against `yaml` 2.9.1 rather than read off a spec:
 *
 * | in the file | 1.2 core | 1.1 |
 * | -- | -- | -- |
 * | `verbose: yes` | string `'yes'` | boolean `true` |
 * | `verbose: no` | string `'no'` | boolean `false` |
 * | `verbose: on` / `off` | string | boolean |
 * | `mode: 017` | **number 17** | **number 15** |
 * | `at: 12:30` | string `'12:30'` | **number 750** |
 * | `at: 1:2:3` | string | **number 3723** |
 * | `size: 1_000` | string `'1_000'` | number 1000 |
 * | `when: 2026-10-19` | string | a `Date` |
 * | `a: 0o17` | number 15 | string `'0o17'` |
 *
 * The famous one is the first -- the Norway problem, `NO` for Norway becoming
 * `false` -- and it is **not** the one that would bite a CLI config here. The
 * two that would are `017` and `12:30`: a file mode written the way every shell
 * writes one is a different number under the two versions, and a time or a
 * version-ish string is a number under 1.1. Both are silent.
 *
 * ## On this library's own `bool` the two versions happen to agree
 *
 * `transformValue()`'s `bool` takes `true`/`t`/`yes`/`y`/`on`/`1` and their
 * negatives, so `verbose: yes` reaches a `bool` setting as `true` whether the
 * parser handed over the string `'yes'` or the boolean `true`. Measured through
 * a real `createConfigSync()`, under "what a scalar reaches a setting as" in
 * `test/options.test.ts` -- this used to cite a `test/version.test.ts` that has
 * never existed in this package, which is the dead-instruction class AGENTS.md
 * keeps an entry about: a comment naming a file a reader then goes looking for.
 *
 * That agreement is **luck rather than design**, which is the argument for
 * pinning rather than leaving it to the parser's default: the two vocabularies
 * were settled independently, and a narrower `bool` -- minimist's "anything but
 * `'false'`", or yargs-parser's "only `'true'`", both of which AGENTS.md records
 * refusing -- would have made the YAML version decide what `verbose: no` means.
 * Nothing stops a word being added to one of them and not the other.
 *
 * ## What the pin costs, which is nothing today
 *
 * `yaml` 2.9.1 already defaults to `version: '1.2'` with the core schema, so the
 * pin changes no answer -- measured. What it buys is that a `yaml` major that
 * moved its default would not move what a user's file means, which is the one
 * thing a store must not let a dependency decide.
 *
 * ## One thing is *not* 1.2 core, and it is deliberate
 *
 * `merge: true` enables the `<<` merge key, which the 1.2 core schema does not
 * have. Without it a `<<` is a literal key spelled `<<` -- a file that reads
 * **wrong** rather than a file that errors, which is the worst of the three
 * outcomes available. Reading it is the whole reason to enable it; writing
 * through one is refused in `write.ts`, with three measured reasons.
 */
const VERSION = '1.2';

/**
 * Whether two map keys name the same config path.
 *
 * `yaml` checks key uniqueness by comparing scalar values with `===`, which is
 * right for YAML and too narrow for a store whose paths are **strings**:
 * measured, `1: a` and `"1": b` are two distinct YAML keys that both resolve to
 * the path `1`, and `toJS()` silently keeps the second. One setting with two
 * answers and nothing said, which is the collision
 * `@ttylabs/config-xml` refuses for the same reason one
 * format along.
 *
 * So the comparator widens "unique" from "identical scalars" to "the same path
 * segment", which turns that file into `yaml`'s own `DUPLICATE_KEY` error with
 * a line in it -- the parser's machinery rather than a second walk of this
 * store's own, which is what makes the line free.
 *
 * A **symbol** key is the merge key, and two of them in one map are legal:
 * `yaml`'s own comparator special-cases that and a custom one replaces it, so
 * excluding a symbol here is what keeps `<<: *a` and `<<: *b` in one map from
 * reading as a duplicate. Measured both ways.
 */
function samePath(a: Node, b: Node): boolean {
  if (!isScalar(a) || !isScalar(b)) {
    return false;
  }
  if (typeof a.value === 'symbol' || typeof b.value === 'symbol') {
    return false;
  }
  // a **null** key is only ever a duplicate of another null key. `String(null)`
  // is `'null'`, so widening it made `null: a` beside `"null": b` a *false*
  // duplicate -- two different keys, and two different paths under the JSON
  // rule this comparator is written to, refused as one. `read.ts` refuses a
  // null key outright with a message that says why, and it can only get there
  // if this does not refuse it first
  if (a.value === null || b.value === null) {
    return a.value === b.value;
  }
  return String(a.value) === String(b.value);
}

/**
 * What every parse in this package reads with.
 *
 * `version` and `schema` were written down as a **declared sabotage survivor**
 * -- `yaml` 2.9.1 already defaults to 1.2 with the core schema, so removing
 * either was said to change no answer. That is false, and a review round
 * measured it: a document that names its **own** version is what separates
 * them. With `%YAML 1.1` at the top and `schema` removed, `Document.setSchema`
 * takes the directive and installs `yaml-1.1`, after which `yes` is `true`,
 * `017` is `15`, `12:30` is `750` and a date is a `Date` -- which is the whole
 * Norway family this pin exists to refuse, arriving through a door the pin
 * was thought not to need. So it is a real guard, `should keep 1.2 core over a
 * document that names its own version` is the test it had none of, and the
 * figure in AGENTS.md's sabotage tally moved with it.
 *
 * `version` on its own really is the default restated, and it stays for the
 * reason the entry above gives: a `yaml` major that moved its default would
 * move what a user's file means, which is the one thing a store must not let a
 * dependency decide.
 */
export const PARSE_OPTIONS: DocumentOptions & ParseOptions & SchemaOptions = {
  merge: true,
  schema: 'core',
  uniqueKeys: samePath,
  version: VERSION,
};
