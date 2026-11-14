# `packages/sigil/src/wrap` — deliberate decisions

These are the entries that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root [AGENTS.md](../../../../AGENTS.md) holds the rules that apply
everywhere and still applies in full, and three of its entries touch this
directory: the styler's skip over an extended color's parameters, the five
or six parameters of its semicolon form, and a sequence the wrapper cannot
reopen travelling with its word.

## Deliberate decisions — do not "fix" these

### Indentation that leaves no room, and a width that holds nothing (SIG-405)

- **Indentation is dropped when it leaves no room for the first character of the
  word after it.** `wrap()` keeps the spaces at the start of an input line,
  because they are the text's own indentation, and it kept them whatever they
  cost: `wrap('          word', 5)` wrote the ten spaces, found no room beside
  them, and broke at once -- a first line of nothing but spaces, twice the width
  and against the rule that drops trailing whitespace from every line. Now the
  indentation is written only when the word's first cluster fits beside it, and
  otherwise the line starts with the word. So the threshold is exact: at a width
  of 5, four spaces before `word` are kept and the word is broken beside them
  (`'    w'`, `'ord'`, as before), and five spaces are dropped (`'word'`). It is
  measured in columns rather than characters, so four spaces before `日本` at 5
  are dropped too, since a two-column character does not fit in one.

  A tab is already one space here, so tabbed indentation follows the same rule.
  Styling among the dropped spaces is not lost: dropping it is the same
  `dropPending()` a break goes through, so an SGR takes effect on the state and
  reopens on the word, and a hyperlink, which nothing reopens, is written in
  front of the word. The room is what is left after `indent`, or after `indent`
  and `hangingIndent` on every line after the first, so a later paragraph's
  indentation is judged against the room its own line has.

  **With `hard: false` the whole word is what has to fit**, and that is a
  judgment the ticket did not settle in so many words. A word that may not be
  broken cannot have its first character beside the indentation and the rest on
  the next line, so "room for the first character" means room for the word: a
  word that fits beside its indentation was already kept with it, and one that
  does not now starts the line. `'    words'` at 5 used to be a nine-column line
  for a five-column word; it is `'words'`. The other reading, the first
  character alone, would leave that nine-column line in place, which is the
  defect this entry is about.

  Dropped rather than shortened to whatever fits: half the indentation says
  nothing about the structure the whole of it said, and this is for widths that
  have no room for that structure at all. `decrypt`'s `placeCells()` applies the
  same rule to its cells, and `should wrap where the wrapper does` now compares
  the two byte for byte, where it used to drop each line's trailing blanks to
  hide exactly this difference. Its indentation is `wrap()`'s too, which is the
  part that is easy to get wrong: `wrap()` breaks only at U+0020 and a tab, so
  those are all it can drop, while a non-breaking, ideographic or em space is an
  ordinary character there and stays. `placeCells()` breaks at those two blanks
  as well, through `isBreakSpace()`, which is the one definition of them
  (SIG-438): it used to group every blank `\s` matches into one gap, so it
  dropped only the spaces and tabs at a gap's front. `should drop only the
  indentation the wrapper drops` holds that a no-break run stays.

- **A width that is `NaN`, zero or negative wraps to the empty string, the way
  `truncate()` cuts to it.** `NaN` fails every comparison, so it walked straight
  through: the room came out as `NaN`, no word fit beside another and none was
  too long to break, and `wrap('hello world', NaN)` was a word a line. Zero and
  below were clamped to one column, which broke between every character and
  still wrote lines wider than the width asked for. `truncate()` already
  answers `!(width > 0)` with `''`, and two functions in one module disagreeing
  about what is a width is how a caller gets a different answer from each.
  `Infinity` passes the guard in both and means no limit in both: `wrap()`
  breaks nothing and `truncate()` cuts nothing. Nothing in the library hands
  `wrap()` such a width -- the text element asks only above zero, and the
  prompts and the tree clamp to one -- so this moves only a caller that was
  getting a wrong answer.

  A fractional width between zero and one passes the guard, and the two
  functions do not answer it alike. `wrap()` rounds the room up to one column,
  so `wrap('hello', 0.5)` puts one character on each line. `truncate()` uses the
  width as given: `truncate('hello', 0.5, 'clip')` keeps no column and is `''`,
  where at a width of 1 it is `'h'`, and the three ellipsis modes give `'…'`, the
  answer they give at 1. Neither is changed here.

  And `indent` is not part of the rule above: an `indent` as wide as the width
  still leaves one column, as `should leave one column when the indent takes the
  whole width` records, because that is the caller's own prefix rather than the
  text's.
