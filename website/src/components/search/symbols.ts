import { nearMiss } from '@ttylabs/sigil/suggest';

/**
 * Exact-and-near name matching over every command and option (SIG-254).
 *
 * Ported from titaniumsdk.com's `symbols.ts`, for the two things Pagefind gets
 * wrong there and here alike. It has no typo tolerance, so `--singel` finds
 * nothing. And it ranks pages, so a name on several of them has no clear top
 * result: `--out` is an option of `build` and of `package`, and `--name` of
 * three commands. This runs first and answers the name questions; Pagefind
 * keeps the prose ones.
 *
 * Four rules, tried in order, each stronger evidence than the next:
 *
 *   exact    the query is the whole name: `sigil package`
 *   segment  the query is the last word: `package`, `--out`, `out`
 *   tokens   every word of the query begins a word of the name: `build out`
 *   fuzzy    the last word is a near miss for a name's last word: `--singel`
 *
 * Within a rule the shorter name wins, which is a decent proxy for how central
 * it is: `sigil build --out` before `sigil package --out`.
 *
 * ## The fourth rule is the CLI's own
 *
 * titaniumsdk.com wrote a bounded Levenshtein with a tolerance by length. This
 * asks `nearMiss()` from `@ttylabs/sigil/suggest` instead, which is what the
 * parser answers `Unknown option "--singel"` with -- so the site and the CLI
 * correct a typo the same way, by one definition:
 *
 * - **Damerau-Levenshtein**, so `--singel` is one slip from `--single`, where
 *   Levenshtein counts a swap as two.
 * - **The tolerance** is its rate: one slip per three characters of the shorter
 *   name, at least one, and the two must share something. That replaces
 *   titaniumsdk.com's 0 / 1 / 2 by length, and lets a three-letter `nwe` find
 *   `new`, which the CLI also does.
 * - **A tie is no answer.** `nearMiss()` picks one *name*, then every entry with
 *   that last word is listed, shortest first: `--uot` is `--out`, which is two
 *   entries and one answer. Two names equally near is no match, which is the
 *   CLI's rule that a wrong suggestion is worse than none.
 * - **Dashes are not compared**, which is the key the parser uses for an
 *   option: `out` and `--out` are one word to every rule here.
 *
 * The bound titaniumsdk.com needed for speed is the fast path inside
 * `nearMiss()`, over a list of distinct last words rather than every entry.
 */

/** `[name, url, summary?]` per entry, as `scripts/generate-symbol-index.ts` writes it. */
export type SymbolPayload = { s: [name: string, url: string, summary?: string][] };

export type SymbolRule = 'exact' | 'segment' | 'tokens' | 'fuzzy';

export type SymbolHit = {
  /** The name, as shown. */
  title: string;
  url: string;
  /** What the command or option is for. */
  summary?: string;
  /** Which rule matched, for ordering and for tests. */
  rule: SymbolRule;
};

type Entry = {
  title: string;
  lower: string;
  /** The last word without its dashes, lowercased: the part people actually type. */
  segment: string;
  /** Every word, the same way, for the token rule. */
  segments: string[];
  url: string;
  summary?: string;
};

export type SymbolTable = {
  entries: Entry[];
  /** Each distinct last word once: what `nearMiss()` chooses between. */
  segments: string[];
};

/** A word as every rule compares it: without the dashes an option is typed with. */
function bare(word: string): string {
  return word.replace(/^-+/u, '');
}

/** The words of a name or a query, compared as `bare()` says, empty ones dropped. */
function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/u).map(bare).filter(Boolean);
}

/** Flattens the payload once, at load, so each query is a scan over strings. */
export function buildSymbolTable(payload: SymbolPayload): SymbolTable {
  const entries = payload.s.map(([title, url, summary]): Entry => {
    const segments = words(title);
    return {
      title,
      lower: title.toLowerCase(),
      segment: segments.at(-1) ?? '',
      segments,
      url,
      ...(summary ? { summary } : {}),
    };
  });

  return { entries, segments: [...new Set(entries.map((entry) => entry.segment))] };
}

/** Each token must begin a word, not merely occur in one: `ti` is not in `util`. */
function beginsAWord(entry: Entry, tokens: readonly string[]): boolean {
  return tokens.every((token) => entry.segments.some((segment) => segment.startsWith(token)));
}

export function lookupSymbols(table: SymbolTable, query: string, limit = 8): SymbolHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/gu, ' ');
  const tokens = words(q);
  const last = tokens.at(-1);
  if (last === undefined) {
    return [];
  }
  const rest = tokens.slice(0, -1);
  // nearMiss() folds case itself; `bare` is the parser's key for an option
  const near = nearMiss(last, table.segments, bare);

  const buckets: Record<SymbolRule, Entry[]> = { exact: [], segment: [], tokens: [], fuzzy: [] };

  for (const entry of table.entries) {
    if (entry.lower === q) buckets.exact.push(entry);
    else if (tokens.length === 1 && entry.segment === last) buckets.segment.push(entry);
    else if (tokens.length > 1 && beginsAWord(entry, tokens)) buckets.tokens.push(entry);
    // the other words still have to fit, so `package --uot` is not `sigil build --out`
    else if (near !== undefined && entry.segment === near && beginsAWord(entry, rest))
      buckets.fuzzy.push(entry);
  }

  // by code unit rather than `localeCompare`, so the order is the same everywhere
  const byCentrality = (a: Entry, b: Entry) =>
    a.title.length - b.title.length || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

  const hits: SymbolHit[] = [];
  for (const rule of ['exact', 'segment', 'tokens', 'fuzzy'] as const) {
    for (const entry of buckets[rule].sort(byCentrality)) {
      if (hits.length >= limit) return hits;
      hits.push({
        title: entry.title,
        url: entry.url,
        ...(entry.summary ? { summary: entry.summary } : {}),
        rule,
      });
    }
  }
  return hits;
}
