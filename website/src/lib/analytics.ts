import posthog from 'posthog-js';

/**
 * The one place that knows whether analytics is configured.
 *
 * Every call site used to carry its own `if (TOKEN && HOST)` guard in the site
 * this was ported from, which meant eight copies of the same condition and no
 * way to add a third variable without editing eight files. The guard lives here
 * instead and the components call blind.
 *
 * Both variables are `NEXT_PUBLIC_`, so these reads are inlined at build time -
 * `configured` is a constant by the time it reaches a browser, and the capture
 * calls fold away entirely in a build that has no PostHog credentials.
 */
const configured = Boolean(
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST
);

/** The install box's tabs (SIG-259), in the order it shows them. */
export type PackageManager = 'vlt' | 'pnpm' | 'npm';

/**
 * Every event this site sends, and the properties each one carries.
 *
 * A map rather than a bare list of names because these are the schema: a typo
 * is not a bug that shows up in review, it is a second event in PostHog that
 * nobody notices until a chart is wrong, and a property left off is a chart
 * that silently undercounts. Adding one here is the deliberate step that adding
 * an event should be. snake_case, past tense.
 *
 * Properties are strings where the set of values belongs to the component that
 * fires the event, and narrowed here only where it is already known.
 */
export interface AnalyticsEvents {
  /**
   * Sent by PostHog on every navigation (`defaults: '2026-01-30'` turns on
   * history-change capture). Listed so the union is the whole schema; nothing
   * should call `capture('$pageview')`, which would count a page twice.
   */
  $pageview: undefined;
  /** Copy on the install boxes and on code blocks. */
  command_copied: {
    location: string;
    manager?: PackageManager;
    package?: string;
    language?: string;
  };
  /** The install box's package manager tabs. */
  package_manager_selected: { manager: PackageManager; location: string };
  /** Getting started's AGENTS.md block. */
  agent_instructions_copied: { version: string };
  /** The Rendered / Accessible / 40 columns tabs on a component. */
  component_output_viewed: { component: string; view: string };
  /** The header, the footer and the About page. Send with `captureBeforeLeaving`. */
  github_link_clicked: { location: string };
  /** Site search (SIG-254); the property is the kind of result, as on titaniumsdk.com. */
  site_search_result_selected: { result_kind: string };
  /** The 404 page. */
  page_not_found: { path: string; suggestion: string | null; referrer: string | null };
}

export type AnalyticsEvent = keyof AnalyticsEvents;

/** An event with no properties takes none; every other event has to supply them. */
type Args<E extends AnalyticsEvent> = AnalyticsEvents[E] extends undefined
  ? [properties?: undefined]
  : [properties: AnalyticsEvents[E]];

/**
 * Records an event, or does nothing if analytics is not configured.
 *
 * The try/catch is not defensive padding. These calls sit in `onClick` and
 * `onChange` handlers, so an exception from the SDK would take the interaction
 * down with it - a copy button that does not copy, a tab that does not switch.
 * Analytics failing is never worth breaking the page over.
 */
export function capture<E extends AnalyticsEvent>(event: E, ...[properties]: Args<E>) {
  if (!configured) {
    return;
  }

  try {
    posthog.capture(event, properties);
  } catch {
    // Nothing to do and nowhere useful to report it: the SDK is what would
    // have reported it.
  }
}

/**
 * Records an event that is immediately followed by leaving the page.
 *
 * PostHog batches captures and drains the queue with `sendBeacon` when the page
 * hides, so the default path mostly survives a navigation on the next line.
 * Mostly is the problem - the SDK documents that drain as best effort, and a
 * request can still be cancelled mid-flight. A beacon is the one transport the
 * browser guarantees it will finish after the document is gone.
 *
 * The tradeoff, per the SDK: an accepted beacon cannot report a server failure
 * back for a retry. That is the right trade for these - a dropped retry costs
 * one event, and the alternative costs the same event more often.
 */
export function captureBeforeLeaving<E extends AnalyticsEvent>(event: E, ...[properties]: Args<E>) {
  if (!configured) {
    return;
  }

  try {
    posthog.capture(event, properties, { transport: 'sendBeacon' });
  } catch {
    // As above.
  }
}

/**
 * Reports an exception an error boundary caught.
 *
 * `capture_exceptions: true` in `instrumentation-client.ts` records what
 * reaches `window.onerror` and unhandled rejections. React stops an error at
 * the nearest boundary, so a render error that `error.tsx` or
 * `global-error.tsx` handles never gets there; this is how the boundary hands it
 * over. Same contract as `capture()`: a no-op when unconfigured, and it never
 * throws, because it runs inside the code that is already handling a failure.
 */
export function captureException(error: unknown, properties?: Record<string, unknown>) {
  if (!configured) {
    return;
  }

  try {
    posthog.captureException(error, properties);
  } catch {
    // As above.
  }
}
