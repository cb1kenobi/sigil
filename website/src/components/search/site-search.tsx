'use client';

import { type Detail, resultDetail } from './result-detail.ts';
import {
  buildSymbolTable,
  lookupSymbols,
  type SymbolPayload,
  type SymbolTable,
} from './symbols.ts';
import { capture, captureBeforeLeaving } from '@/lib/analytics';
import { registerSearch } from '@/lib/open-search';
import type { SearchKind } from '@/lib/search-records';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * Site search (SIG-254), over the Pagefind index built by
 * `scripts/generate-search-index.ts` and the name matcher's
 * `scripts/generate-symbol-index.ts`. Ported from titaniumsdk.com.
 *
 * A native `<dialog>` rather than a hand-built overlay: `showModal()` traps
 * focus, closes on Escape, makes the rest of the page inert and restores focus
 * to the trigger on close. All of that is the accessibility criterion, and all
 * of it is behaviour we would otherwise write and get subtly wrong.
 *
 * Mounted once, in the root layout. The triggers -- the header's, the phone
 * menu's, the 404's -- call `openSearch()`, which this registers itself with,
 * and the keyboard opens it from anywhere.
 *
 * The runtime is loaded on first open, not on page load: 116 KB that most
 * visitors never need.
 */

type Kind = 'symbol' | SearchKind;

type Hit = {
  url: string;
  title: string;
  kind: Kind;
  /** The guide a section is in. */
  page?: string;
  detail: Detail;
};

/**
 * Group order and labels. A source added to `search-records.ts` with a new
 * `kind` gets its label here.
 *
 * The first group is named for how its results matched rather than for what
 * they are: a name match crosses the sections below it, so `sigil package` and
 * `sigil build --out` arrive together. Calling it "Commands" would imply a
 * category that overlaps the one under it.
 */
const GROUPS: { kind: Kind; label: string }[] = [
  { kind: 'symbol', label: 'Top Matches' },
  { kind: 'command', label: 'Commands' },
  { kind: 'option', label: 'Options' },
  // Last: a name's record is a better answer than prose that mentions it, and
  // a phrase only the guides hold has nothing above it to wait behind.
  { kind: 'guide', label: 'Guides' },
];

/** Mono for what is typed at a prompt, the body face for prose. */
const MONO_KINDS: ReadonlySet<Kind> = new Set(['symbol', 'command', 'option']);

/**
 * The name table, fetched once on first open.
 *
 * It runs before Pagefind and answers the two queries Pagefind cannot: a name
 * several pages share, and a misspelt one. A failure here is not a failure of
 * search -- the Pagefind half still answers -- so this resolves to an empty
 * table rather than rejecting.
 */
let symbolTable: Promise<SymbolTable> | undefined;

function loadSymbols(): Promise<SymbolTable> {
  symbolTable ??= fetch('/symbols.json')
    .then((r) => (r.ok ? (r.json() as Promise<SymbolPayload>) : { s: [] }))
    .then(buildSymbolTable)
    .catch(() => buildSymbolTable({ s: [] }));
  return symbolTable;
}

type PagefindResult = {
  data: () => Promise<{
    url: string;
    excerpt: string;
    meta?: { title?: string; kind?: string; page?: string };
  }>;
};
type Pagefind = {
  init: () => Promise<void>;
  search: (term: string) => Promise<{ results: PagefindResult[] }>;
};

let runtime: Promise<Pagefind> | undefined;

/**
 * Loads `/_pagefind/pagefind.js` at runtime.
 *
 * The path is built at call time so the bundler cannot statically resolve it:
 * the file is a build artifact that does not exist when the app is compiled,
 * and a static import would fail the build.
 */
function loadPagefind(): Promise<Pagefind> {
  runtime ??= (async () => {
    const url = `${window.location.origin}/_pagefind/pagefind.js`;
    const mod = (await import(/* webpackIgnore: true */ url)) as Pagefind;
    await mod.init();
    return mod;
  })();
  // a failed load is not cached, so the next open tries again
  runtime.catch(() => {
    runtime = undefined;
  });
  return runtime;
}

/** Whether a key press is someone typing, where `/` is a character rather than a shortcut. */
function inField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
  );
}

export function SiteSearch() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const show = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      setOpen(true);
      setFailed(false);
      dialog.showModal();
    }
    inputRef.current?.focus();
    // Warm both while the reader is still typing the first character.
    void loadPagefind().catch(() => setFailed(true));
    void loadSymbols();
  }, []);

  const hide = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  useEffect(() => registerSearch(show), [show]);

  // ⌘K / Ctrl+K, and `/` the way most docs sites bind it -- but not while the
  // reader is typing in a field, where `/` is a character they meant.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey;
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !inField(e.target);
      if (k || slash) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show]);

  // Debounced query. Pagefind answers in single-digit milliseconds, so this is
  // about not firing a request per keystroke rather than about latency.
  useEffect(() => {
    const q = term.trim();
    if (!q) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // Names first and separately: an exact or near name match is a better
        // answer than anything ranked, and it does not wait on Pagefind.
        const symbols = lookupSymbols(await loadSymbols(), q, 6).map((hit): Hit => ({
          url: hit.url,
          title: hit.title,
          kind: 'symbol',
          detail: hit.summary ? { text: hit.summary } : null,
        }));
        if (cancelled) return;
        setHits(symbols);
        setActive(0);

        const pf = await loadPagefind();
        const res = await pf.search(q);
        const top = await Promise.all(res.results.slice(0, 30).map((r) => r.data()));
        if (cancelled) return;
        // A page already named above adds nothing as a prose result.
        const named = new Set(symbols.map((s) => s.url));
        setHits([
          ...symbols,
          ...top
            .filter((d) => !named.has(d.url))
            .map((d): Hit => ({
              url: d.url,
              title: d.meta?.title ?? d.url,
              kind: (d.meta?.kind as Kind | undefined) ?? 'guide',
              ...(d.meta?.page ? { page: d.meta.page } : {}),
              detail: resultDetail(d.meta?.title ?? '', d.excerpt),
            })),
        ]);
        setActive(0);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  // Flattened in group order, so arrow keys walk what the eye sees.
  const ordered = GROUPS.flatMap((g) => hits.filter((h) => h.kind === g.kind));

  // Keep the highlighted result in view as the arrow keys walk past the fold.
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  /**
   * Enter navigates with `window.location.assign` on the next line, so this one
   * goes out as a beacon. The anchor below is a normal link click and uses the
   * batched path, which the browser gives time to drain. The property is the
   * group the result was in: `symbol` says the name matcher answered.
   *
   * A real navigation rather than the router's, as on titaniumsdk.com, and here
   * it is load-bearing: a result is usually a fragment -- an option's row, a
   * guide's section -- and only a navigation sets `:target`, which is what
   * marks the row a result landed on. `history.pushState` does not, so the
   * router would land on a page too short to scroll the row to the top with
   * nothing to say which row was meant. The dialog closes first, because a
   * result on the page already open is a fragment navigation, which does not
   * unload it.
   */
  const choose = (hit: Hit, leaving = false) => {
    (leaving ? captureBeforeLeaving : capture)('site_search_result_selected', {
      result_kind: hit.kind,
    });
    hide();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!ordered.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % ordered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + ordered.length) % ordered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = ordered[active];
      if (hit) {
        choose(hit, true);
        window.location.assign(hit.url);
      }
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label="Search the docs"
      onClose={() => {
        setOpen(false);
        setTerm('');
        setHits([]);
        setActive(0);
      }}
      // Clicking the backdrop closes. The dialog element fills the viewport, so
      // the target is the dialog itself only when the click missed the panel.
      onClick={(e) => {
        if (e.target === dialogRef.current) hide();
      }}
      className="m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-black/60 open:flex open:items-start open:justify-center"
    >
      <div className="mx-4 mt-[10vh] flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-panel border border-line-panel bg-surface text-fg shadow-2xl has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-link sm:mt-[12vh]">
        {/* The divider only exists to separate the field from results. With
            nothing below it, it is a line under a lone input. */}
        <div
          className={`flex items-center gap-3 px-4 ${
            ordered.length || (term.trim() && open) ? 'border-b border-line' : ''
          }`}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="shrink-0 text-muted"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKeyDown}
            // `type="text"`, not `search`: browsers make Escape clear a search
            // field instead of reaching the dialog, so Escape stopped closing
            // the dialog -- verified on titaniumsdk.com, not theorised.
            type="text"
            placeholder="Search commands, options and guides"
            aria-label="Search query"
            role="combobox"
            aria-expanded={ordered.length > 0}
            aria-controls={listId}
            aria-activedescendant={ordered.length ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            // no ring of its own: it is flush with the panel, so the panel
            // draws it, through `has-[input:focus-visible]`
            className="w-full min-w-0 bg-transparent py-4 text-base text-fg outline-none placeholder:text-dim"
          />
          <kbd className="hidden shrink-0 rounded-kbd border border-line-input px-1.5 py-px font-mono text-xs text-muted sm:block">
            esc
          </kbd>
        </div>

        <div id={listId} role="listbox" aria-label="Search results" className="overflow-y-auto">
          {ordered.length > 0 &&
            GROUPS.map((group) => {
              const inGroup = hits.filter((h) => h.kind === group.kind);
              if (!inGroup.length) return null;
              return (
                <div key={group.kind} role="group" aria-label={group.label}>
                  <p className="sticky top-0 bg-surface px-4 pt-3 pb-1.5 font-mono text-xs tracking-wide text-dim uppercase">
                    {group.label}
                  </p>
                  {inGroup.map((hit) => {
                    const i = ordered.indexOf(hit);
                    return (
                      <a
                        key={hit.url}
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        href={hit.url}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(hit)}
                        className={`block border-l-2 px-4 py-2.5 focus-visible:-outline-offset-2 ${
                          i === active
                            ? 'border-brand bg-surface-2'
                            : 'border-transparent hover:bg-surface-2/60'
                        }`}
                      >
                        <span
                          className={`block truncate text-small text-fg-strong ${
                            MONO_KINDS.has(hit.kind) ? 'font-mono' : ''
                          }`}
                        >
                          {hit.page ? <span className="text-muted">{hit.page} › </span> : null}
                          {hit.title}
                        </span>
                        {hit.detail &&
                          ('text' in hit.detail ? (
                            <span className="mt-0.5 block truncate text-[13px] text-muted">
                              {hit.detail.text}
                            </span>
                          ) : (
                            <span
                              className="mt-0.5 block truncate text-[13px] text-muted [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-fg"
                              // Pagefind's excerpt is its own HTML: the text
                              // escaped, and <mark> around matched terms.
                              dangerouslySetInnerHTML={{ __html: hit.detail.html }}
                            />
                          ))}
                      </a>
                    );
                  })}
                </div>
              );
            })}

          {/* Nothing at all until something is typed, so an unused search is
              just a field: the panel has no advice to give before there is a
              query. Everything below needs a term to be worth saying. */}
          {open && !ordered.length && term.trim() && (
            <p className="px-4 py-8 text-center text-small text-muted">
              {failed ? (
                'Search is unavailable right now.'
              ) : busy ? (
                'Searching…'
              ) : (
                <>
                  Nothing matches <span className="font-mono text-fg">{term.trim()}</span>.
                  <span className="mt-1 block text-[13px] text-dim">
                    Search matches whole words, so check the spelling.
                  </span>
                </>
              )}
            </p>
          )}
        </div>

        {/* Announced, not shown: the visible list is the sighted feedback. */}
        <p aria-live="polite" className="sr-only">
          {term.trim() && !busy
            ? `${ordered.length} result${ordered.length === 1 ? '' : 's'} for ${term.trim()}`
            : ''}
        </p>
      </div>
    </dialog>
  );
}
