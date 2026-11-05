import { assertAnalyticsConfigured } from './src/lib/analytics-env.ts';
import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
};

/**
 * The function form is what lets the analytics check run for a build and for
 * nothing else: `next dev` and `next start` evaluate this file too, and a
 * contributor with no PostHog project must be able to run both. See
 * `src/lib/analytics-env.ts` for why the check is here and what a production
 * deploy is.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    assertAnalyticsConfigured();
  }

  return nextConfig;
}
