/**
 * The log browser's root component, in JSX.
 *
 * `root.ui.ts` beside it is the same component in the `ui` tag -- the same
 * elements, signals and handlers in the same order, though not the same lines --
 * and the smoke test asserts that the two draw the same screen. JSX is what an
 * editor can check, every prop of `DataTable` and `ListView` included, and what
 * it costs is a build: this file only ever runs as `sigil build` wrote it.
 * Everything but the markup is `browser.ts`'s, which both twins call.
 */

import { type Browser, LEVEL_ROLE, resourceKey, useBrowser, type View } from './browser.ts';
import type { Kind } from './cluster.ts';
import { type LogLine, matchRuns } from './logs.ts';
import { DataTable, keyHelp, ListView, Panel, TextField } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';

export { stylesheet } from './common.ts';

/**
 * One log line, coloured by its level, with what the search matched drawn
 * reversed. Built when the line scrolls into view, and again for every line on
 * screen when the search changes, which `browser.ts` asks the list for.
 */
function LogRow(props: { line: LogLine; query: string }): Element {
  const { line, query } = props;
  return (
    <box class={`log-line ${LEVEL_ROLE[line.level]}`}>
      {matchRuns(line.text, query).map((run) => (
        <text class={run.match ? 'match' : undefined}>{run.text}</text>
      ))}
    </box>
  );
}

/** A table of one kind of resource, keyed by namespace and name so a reading keeps its row. */
function ResourceTable(props: { browser: Browser; kind: Kind }): Element {
  const { browser, kind } = props;
  return (
    <DataTable
      columns={browser.columns[kind]}
      key={resourceKey}
      onActivate={browser.open(kind)}
      props={{ class: 'grow' }}
      rows={browser.rows[kind]}
    />
  );
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
    deployments: <ResourceTable browser={browser} kind="deployments" />,
    pods: <ResourceTable browser={browser} kind="pods" />,
    services: <ResourceTable browser={browser} kind="services" />,
  };

  const log = (
    <ListView
      current={logs.current}
      empty="No lines match"
      items={logs.shown}
      key={(line: LogLine) => line.id}
      props={{ class: 'grow' }}
      row={(line: LogLine) => <LogRow line={line} query={logs.query.get()} />}
    />
  );

  const field = (
    <TextField
      onChange={browser.field.change}
      onSubmit={browser.field.submit}
      props={{ 'flex-grow': 1 }}
      value={browser.draft}
    />
  );

  const prompt = (
    <box class="prompt">
      <text class="prompt-label sigil-accent">{browser.promptLabel}</text>
      {field}
      <text class="hint sigil-muted">{browser.hint}</text>
    </box>
  );

  const panel = (view: View, body: Element): Element => (
    <Panel
      annotation={() => labels.annotation(view)}
      class="view"
      footer={() => labels.footer(view)}
      title={() => labels.title(view)}
    >
      {body}
    </Panel>
  );

  const describe = <box class="grow"></box>;
  const views = {
    deployments: panel('deployments', tables.deployments),
    describe: panel('describe', describe),
    logs: panel('logs', log),
    pods: panel('pods', tables.pods),
    services: panel('services', tables.services),
  };

  const root = (
    <box class="app">
      <box class="header">
        <text class="brand sigil-accent">log-browser</text>
        <text class="context sigil-muted">{browser.context}</text>
        <box class="spacer" />
        <text class="sigil-muted">{browser.clock}</text>
      </box>
      {prompt}
      {views.pods}
      {views.services}
      {views.deployments}
      {views.logs}
      {views.describe}
      <box class="footer">
        <text class="status sigil-accent">{() => browser.status.get()}</text>
        {keyHelp(browser.input)}
      </box>
    </box>
  );

  browser.attach({ describe, field, log, prompt, tables, views });
  return root;
}
