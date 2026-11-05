/**
 * Whether a production deploy has the analytics variables it needs.
 *
 * `instrumentation-client.ts` and `analytics.ts` treat a missing variable as
 * "analytics is off" so that nobody needs a PostHog project to work on the
 * site. That leniency is only safe if something refuses the one build where it
 * costs data, and a check inside the app cannot be that thing: it would run in
 * every environment, and the only one it could fail in without hurting anybody
 * is the one that does not matter. So the check is here, called from
 * `next.config.ts`, which runs at build time and only for a production build.
 *
 * "Production deploy" is `VERCEL_ENV === 'production'`, not `NODE_ENV`.
 * `next build` sets `NODE_ENV` to `production` for every build, preview
 * deployments and a contributor's `pnpm build` included, so keying on it would
 * fail all of them. `VERCEL_ENV` is `production`, `preview` or `development` on
 * Vercel and absent everywhere else, which is the distinction wanted: CI, a
 * local build and a preview all pass with nothing set.
 *
 * The two names are spelled out in `analytics.ts` and `instrumentation-client.ts`
 * as well, because `NEXT_PUBLIC_` variables are inlined by a literal
 * `process.env.NAME` read and a lookup through this list would not be.
 */
export const analyticsVariables = [
  'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'NEXT_PUBLIC_POSTHOG_HOST',
] as const;

type Env = Record<string, string | undefined>;

export function isProductionDeploy(env: Env = process.env): boolean {
  return env.VERCEL_ENV === 'production';
}

export function missingAnalyticsVariables(env: Env = process.env): string[] {
  return analyticsVariables.filter((name) => !env[name]);
}

/** Throws, naming each missing variable, if this is a production deploy without them. */
export function assertAnalyticsConfigured(env: Env = process.env): void {
  if (!isProductionDeploy(env)) {
    return;
  }

  const missing = missingAnalyticsVariables(env);

  if (missing.length > 0) {
    throw new Error(
      `A production deploy needs analytics configured, and ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Set ` +
        `${missing.length === 1 ? 'it' : 'them'} in the Vercel project's production ` +
        'environment variables. Preview deploys and local builds do not need them.'
    );
  }
}
