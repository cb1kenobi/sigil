import posthog from 'posthog-js';

/**
 * Browser analytics (SIG-269, ported from titaniumsdk.com's TI-50).
 *
 * This file runs after the document loads and before React hydrates, which is
 * what makes it the right place to start analytics: it is early enough to catch
 * the first pageview without a component having to own the lifecycle.
 *
 * Unconfigured is a supported state, not an error. This is a public repository
 * and nobody needs a PostHog project to work on the site, so a missing token
 * means analytics is off and everything else behaves normally. Next's own
 * guidance for this file is to keep instrumentation failures away from the
 * application, which is why nothing here throws and the init is wrapped.
 *
 * The counterpart to that leniency belongs in the build, not here. A production
 * deploy with these variables unset is silently unmeasured, and a dev-only
 * throw - which is what the PostHog wizard generates - cannot catch it: it is
 * loud in the one environment where missing analytics costs nothing and absent
 * from the one where it costs data. `next.config.ts` is where that is enforced,
 * through `src/lib/analytics-env.ts`.
 *
 * `persistence` is left at its default (a cookie plus localStorage), so a
 * returning visitor is counted as one. `'memory'` would make the site cookieless
 * at the cost of exactly that count, and is a one-line change here if a consent
 * stance ever calls for it. The site is also not proxied through its own domain,
 * so an ad blocker that drops PostHog's host drops these events too.
 */
const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (projectToken && apiHost) {
  try {
    posthog.init(projectToken, {
      api_host: apiHost,
      defaults: '2026-01-30',
      capture_exceptions: true,
      debug: process.env.NODE_ENV === 'development',
    });
  } catch (error) {
    console.error('[posthog] init failed, continuing without analytics', error);
  }
} else if (process.env.NODE_ENV === 'development') {
  // Named individually: "one of these is missing" sends you to check both.
  const missing = [
    !projectToken && 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
    !apiHost && 'NEXT_PUBLIC_POSTHOG_HOST',
  ].filter(Boolean);

  console.info(`[posthog] analytics disabled, ${missing.join(' and ')} not set`);
}
