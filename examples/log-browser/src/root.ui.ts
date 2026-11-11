/**
 * The log browser's root component, in the `ui` tag.
 *
 * The same component as `root.tsx` -- the same elements, signals and handlers in
 * the same order, though not the same lines -- and the smoke test asserts that the
 * two draw the same screen. This one runs as it is: `node src/ui.ts`, with Node
 * stripping the types and nothing else in between. Everything but the markup is
 * `browser.ts`'s, which both twins call.
 *
 * A component is interpolated rather than named (`<${DataTable} />`), because a
 * tag has no scope to look a name up in; host elements stay bare.
 */

import { type Browser, LEVEL_ROLE, resourceKey, useBrowser, type View } from './browser.ts';
import type { Kind } from './cluster.ts';
import { type LogLine, matchRuns } from './logs.ts';
import { DataTable, keyHelp, ListView, Panel, TextField } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';
import { ui } from '@ttylabs/sigil/template';

export { stylesheet } from './common.ts';

/**
 * One log line, coloured by its level, with what the search matched drawn
 * reversed. Built when the line scrolls into view, and again for every line on
 * screen when the search changes, which `browser.ts` asks the list for.
 */
function LogRow(props: { line: LogLine; query: string }): Element {
  const { line, query } = props;
  return ui`<box class=${`log-line ${LEVEL_ROLE[line.level]}`}>${matchRuns(line.text, query).map(
    (run) => ui`<text class=${run.match ? 'match' : undefined}>${run.text}</text>`
  )}</box>`;
}

/** A table of one kind of resource, keyed by namespace and name so a reading keeps its row. */
function ResourceTable(props: { browser: Browser; kind: Kind }): Element {
  const { browser, kind } = props;
  return ui`<${DataTable}
    columns=${browser.columns[kind]}
    key=${resourceKey}
    onActivate=${browser.open(kind)}
    props=${{ class: 'grow' }}
    rows=${browser.rows[kind]}
  />`;
}

/**
 * The browser: a header, the line the prompt opens on, the view that is up, and a
 * footer of the keys that apply to it.
 *
 * @returns The screen.
 */
export function App(): Element {
  const browser = useBrowser();
  const { labels, logs } = browser;

  const tables: Record<Kind, Element> = {
    deployments: ui`<${ResourceTable} browser=${browser} kind="deployments" />`,
    pods: ui`<${ResourceTable} browser=${browser} kind="pods" />`,
    services: ui`<${ResourceTable} browser=${browser} kind="services" />`,
  };

  const log = ui`<${ListView}
    current=${logs.current}
    empty="No lines match"
    items=${logs.shown}
    key=${(line: LogLine) => line.id}
    props=${{ class: 'grow' }}
    row=${(line: LogLine) => ui`<${LogRow} line=${line} query=${logs.query.get()} />`}
  />`;

  const field = ui`<${TextField}
    onChange=${browser.field.change}
    onSubmit=${browser.field.submit}
    props=${{ 'flex-grow': 1 }}
    value=${browser.draft}
  />`;

  const prompt = ui`<box class="prompt">
    <text class="prompt-label sigil-accent">${browser.promptLabel}</text>
    ${field}
    <text class="hint sigil-muted">${browser.hint}</text>
  </box>`;

  const panel = (view: View, body: Element): Element =>
    ui`<${Panel}
      annotation=${() => labels.annotation(view)}
      class="view"
      footer=${() => labels.footer(view)}
      title=${() => labels.title(view)}
    >${body}</>`;

  const describe = ui`<box class="grow"></box>`;
  const views = {
    deployments: panel('deployments', tables.deployments),
    describe: panel('describe', describe),
    logs: panel('logs', log),
    pods: panel('pods', tables.pods),
    services: panel('services', tables.services),
  };

  const root = ui`<box class="app">
    <box class="header">
      <text class="brand sigil-accent">log-browser</text>
      <text class="context sigil-muted">${browser.context}</text>
      <box class="spacer" />
      <text class="sigil-muted">${browser.clock}</text>
    </box>
    ${prompt}
    ${views.pods}${views.services}${views.deployments}${views.logs}${views.describe}
    <box class="footer">
      <text class="status sigil-accent">${() => browser.status.get()}</text>
      ${keyHelp(browser.input)}
    </box>
  </box>`;

  browser.attach({ describe, field, log, prompt, tables, views });
  return root;
}
