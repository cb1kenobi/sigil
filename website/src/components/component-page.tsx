import { Breadcrumb } from '@/components/breadcrumb';
import { CodeBlock } from '@/components/code-block';
import { AccessibleBadge } from '@/components/component-card';
import { ComponentOutput, type OutputView } from '@/components/component-output';
import { DocsPageLinks } from '@/components/docs-page-links';
import { DocsRail } from '@/components/docs-rail';
import { TerminalBlock, TerminalRows } from '@/components/terminal-block';
import {
  componentCapture,
  describeComponent,
  exampleSource,
  hasLineForm,
  takesSignal,
  viewRows,
  type KeyRow,
  type OptionDoc,
  type View,
} from '@/lib/component-data';
import {
  OPTIONS_INTRO,
  SHARED_OPTIONS,
  cap,
  keyLines,
  keysNote,
  relatedOf,
  viewLabels,
} from '@/lib/component-text';
import {
  COMPONENTS_HREF,
  componentEntry,
  componentHref,
  family,
  familyHref,
  type ComponentEntry,
  type ViewId,
} from '@/lib/components';
import type { Heading } from '@/lib/markdown-doc';
import { newIssueUrl } from '@/lib/report';
import { absoluteUrl, repoFileUrl } from '@/lib/site';
import { commandRow } from '@/lib/terminal-rows';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Text with `code` in backticks, as a JSDoc comment writes it. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, at) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
          <code
            className="rounded-kbd border border-line-panel bg-surface-2 px-[5px] py-px font-mono text-[0.88em] text-fg-code"
            // keyed by position, which is stable: the text never reorders
            key={at}
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  );
}

/** A section of the page, with an `h2` the rail links to. */
function Section({ children, id, title }: { children: ReactNode; id: string; title: string }) {
  return (
    <section aria-labelledby={id} className="mt-14">
      <h2 className="scroll-mt-24 text-docs-h2 text-fg-strong" id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A badge beside the title: the family, or a property the component has. */
function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-kbd border border-line-panel bg-surface-2 px-[7px] py-0.5 font-mono text-[11px] text-fg-body">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// the example

/** Each view of the output as a tab, with the words `viewLabels()` gives it. */
function outputViews(entry: ComponentEntry, views: Partial<Record<ViewId, View>>): OutputView[] {
  return viewLabels(entry, views).map(({ view, ...label }) => {
    const rows = <TerminalRows rows={viewRows(view)} />;
    return {
      ...label,
      panel:
        label.id === 'narrow' ? (
          // the 40th column, drawn: what is past it is not part of this screen
          <div className="w-[40ch] max-w-full border-r border-dashed border-line-strong">
            {rows}
          </div>
        ) : (
          rows
        ),
    };
  });
}

// ---------------------------------------------------------------------------
// options

function OptionsTable({ options }: { options: readonly OptionDoc[] }) {
  return (
    <div
      className="mt-4 overflow-x-auto rounded-panel border border-line-panel bg-surface"
      // scrolls sideways on a phone, so it has to be reachable by keyboard
      tabIndex={0}
    >
      <table className="w-full min-w-[640px] border-collapse text-left text-[14px] leading-[1.55]">
        <thead className="bg-table-head font-mono text-xs text-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium" scope="col">
              Option
            </th>
            <th className="px-4 py-2.5 font-medium" scope="col">
              Type
            </th>
            <th className="px-4 py-2.5 font-medium" scope="col">
              Default
            </th>
            <th className="px-4 py-2.5 font-medium" scope="col">
              What it does
            </th>
          </tr>
        </thead>
        <tbody>
          {options.map((option) => (
            <tr className="border-t border-line align-top" key={option.name}>
              <th className="px-4 py-3 font-mono text-[13px] font-bold text-fg-strong" scope="row">
                {option.name}
              </th>
              <td className="max-w-[16em] px-4 py-3 font-mono text-[13px] text-syn-keyword">
                {option.type}
              </td>
              <td className="px-4 py-3 text-fg-body">
                {option.optional ? (
                  option.default ? (
                    <Prose text={option.default} />
                  ) : (
                    <span className="text-dim">none</span>
                  )
                ) : (
                  <span className="text-muted">required</span>
                )}
              </td>
              <td className="px-4 py-3 text-fg-body">
                <Prose text={option.description} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// keys

function KeysList({ entry, rows }: { entry: ComponentEntry; rows: readonly KeyRow[] }) {
  return (
    <>
      <dl className="mt-4 flex flex-col gap-2.5">
        {keyLines(entry, rows).map((line) => (
          <div
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5"
            key={line.keys.join(' ')}
          >
            <dt className="flex min-w-[9rem] flex-wrap gap-1.5">
              {line.keys.map((key) => (
                <kbd
                  className="rounded-kbd border border-b-2 border-line-strong bg-surface-2 px-1.5 py-px font-mono text-xs text-fg-strong"
                  key={key}
                >
                  {cap(key)}
                </kbd>
              ))}
            </dt>
            <dd className="text-[15px] text-fg-body">
              <Prose text={line.does} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-[14px] leading-[1.55] text-muted">{keysNote(entry, rows)}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// the page

/**
 * A component's reference page: what it is for, its example with what it drew
 * three ways, its options, its keys, recipes, and its siblings.
 *
 * Everything that describes the component's behaviour is generated: the example
 * is the file that was run and the output is what it drew
 * (`src/transcripts/components/`), the options are its declaration's, and the
 * keys are what its footer lists and what pressing each key did. What is written
 * by hand is in `src/lib/components.ts`: the family, the description where
 * `sigil add` has none, and for the components that have them, a lede, recipes
 * and the related list. A component with none of those has the same page without
 * them, which is the short page the ticket falls back to.
 *
 * Renders inside the `(sidebar)` layout, as the content and rail columns.
 */
export function ComponentPage({ slug }: { slug: string }) {
  const entry = componentEntry(slug)!;
  const captured = componentCapture(slug);
  const { api } = captured;
  const home = family(entry.family);
  const related = relatedOf(entry);

  const headings: Heading[] = [
    ...(api.options.length > 0 ? [{ depth: 2, id: 'options', text: 'Options' }] : []),
    ...(captured.keys && captured.keys.length > 0 ? [{ depth: 2, id: 'keys', text: 'Keys' }] : []),
    ...(entry.recipes ?? []).map((recipe) => ({ depth: 2, id: recipe.id, text: recipe.title })),
    { depth: 2, id: 'related', text: 'Related' },
  ];

  const sourceHref = repoFileUrl(captured.source);
  const reportHref = newIssueUrl({
    title: `Docs: ${entry.name}`,
    body: `On ${absoluteUrl(componentHref(slug))}:\n\n`,
  });

  return (
    <>
      <div className="min-w-0 max-w-[760px] flex-1 pt-8 pb-24 md:pt-12">
        <Breadcrumb
          crumbs={[
            { label: 'Components', href: COMPONENTS_HREF },
            { label: home.title, href: familyHref(entry.family) },
            { label: entry.name },
          ]}
        />

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
          <h1 className="font-mono text-[30px] leading-[1.1] font-bold tracking-[-0.02em] text-fg-strong sm:text-[44px]">
            {entry.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{home.title.replace(/s$/, '')}</Badge>
            {hasLineForm(slug) ? <AccessibleBadge /> : null}
            {takesSignal(slug) ? <Badge>AbortSignal</Badge> : null}
          </div>
        </div>

        <p className="lede-docs mt-5 max-w-[40em]">
          <Prose text={describeComponent(entry)} />
          {entry.lede ? (
            <>
              {' '}
              <Prose text={entry.lede} />
            </>
          ) : null}
        </p>

        <div className="mt-8 [&>figure]:mt-0 [&>figure]:rounded-b-none">
          <CodeBlock code={exampleSource(slug)} lang="javascript" title={`${slug}.mjs`} />
          <ComponentOutput component={slug} views={outputViews(entry, captured.views)} />
        </div>

        {api.options.length > 0 ? (
          <Section id="options" title="Options">
            <p className="mt-3 text-[15px] leading-[1.6] text-fg-body">{OPTIONS_INTRO}</p>
            <div className="[&>figure]:mt-3">
              <CodeBlock code={api.signature} lang="typescript" title="components.d.mts" />
            </div>
            <OptionsTable options={api.options} />
            {api.shared.length > 0 ? (
              <p className="mt-3 text-[14px] leading-[1.55] text-muted">
                {SHARED_OPTIONS}{' '}
                {api.shared.map((name, at) => (
                  <span key={name}>
                    {at > 0 ? ', ' : null}
                    <Prose text={`\`${name}\``} />
                  </span>
                ))}
                .
              </p>
            ) : null}
          </Section>
        ) : null}

        {captured.keys && captured.keys.length > 0 ? (
          <Section id="keys" title="Keys">
            <KeysList entry={entry} rows={captured.keys} />
          </Section>
        ) : null}

        {(entry.recipes ?? []).map((recipe) => {
          const output = captured.recipes?.[recipe.id];
          return (
            <Section id={recipe.id} key={recipe.id} title={recipe.title}>
              <p className="mt-3 text-[16px] leading-[1.7] text-fg-body">
                <Prose text={recipe.body} />
              </p>
              <div className="mt-4 flex flex-wrap items-start gap-4 [&>*>figure]:mt-0">
                <div className="min-w-0 flex-[1_1_440px]">
                  <CodeBlock
                    code={exampleSource(recipe.file)}
                    lang="javascript"
                    title={`${recipe.file}.mjs`}
                  />
                </div>
                {output ? (
                  <div className="min-w-0 flex-[1_1_240px]">
                    <TerminalBlock
                      copy={recipe.command}
                      cwd="~/my-app"
                      label={`What ${recipe.command} printed`}
                      rows={[commandRow(recipe.command), ...viewRows(output)]}
                      shell={`zsh · ${output.columns}×24`}
                      wrap
                    />
                  </div>
                ) : null}
              </div>
            </Section>
          );
        })}

        <Section id="related" title="Related">
          <ul className="mt-4 grid gap-4 sm:grid-cols-3">
            {related.map((it) => (
              <li className="flex min-w-0" key={it.slug}>
                <Link
                  className="flex w-full flex-col gap-1.5 rounded-panel border border-line-panel bg-surface px-4 py-3.5 hover:border-line-strong"
                  href={componentHref(it.slug)}
                >
                  <span className="font-mono text-sm font-bold text-fg-strong">{it.name}</span>
                  <span className="text-[13.5px] leading-[1.5] text-muted">
                    {describeComponent(it)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>

        {/* the rail's own two links, for the widths with no rail */}
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-[13px] min-[1100px]:hidden">
          <DocsPageLinks editHref={sourceHref} reportHref={reportHref} source />
        </div>
      </div>

      <DocsRail editHref={sourceHref} headings={headings} reportHref={reportHref} source />
    </>
  );
}
