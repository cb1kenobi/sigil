import {
  assertAnalyticsConfigured,
  isProductionDeploy,
  missingAnalyticsVariables,
} from '../src/lib/analytics-env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const configured = {
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test',
  NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
};

describe('the production build check', () => {
  it('passes a build that is not a production deploy, with nothing set', () => {
    assert.doesNotThrow(() => assertAnalyticsConfigured({}));
    assert.doesNotThrow(() => assertAnalyticsConfigured({ VERCEL_ENV: 'preview' }));
    assert.doesNotThrow(() => assertAnalyticsConfigured({ VERCEL_ENV: 'development' }));
  });

  it('does not take NODE_ENV for a production deploy, because every build sets it', () => {
    assert.equal(isProductionDeploy({ NODE_ENV: 'production' }), false);
    assert.doesNotThrow(() => assertAnalyticsConfigured({ NODE_ENV: 'production' }));
  });

  it('fails a production deploy with nothing set, naming both variables', () => {
    assert.throws(
      () => assertAnalyticsConfigured({ VERCEL_ENV: 'production' }),
      /NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN and NEXT_PUBLIC_POSTHOG_HOST are not set/
    );
  });

  it('names only the variable that is missing', () => {
    const [token, host] = Object.entries(configured);

    assert.throws(
      () => assertAnalyticsConfigured({ VERCEL_ENV: 'production', [token[0]]: token[1] }),
      /NEXT_PUBLIC_POSTHOG_HOST is not set/
    );
    assert.throws(
      () => assertAnalyticsConfigured({ VERCEL_ENV: 'production', [host[0]]: host[1] }),
      /NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not set/
    );
  });

  it('reads a variable set to the empty string as missing', () => {
    assert.deepEqual(missingAnalyticsVariables({ ...configured, NEXT_PUBLIC_POSTHOG_HOST: '' }), [
      'NEXT_PUBLIC_POSTHOG_HOST',
    ]);
  });

  it('passes a production deploy that has both', () => {
    assert.doesNotThrow(() =>
      assertAnalyticsConfigured({ VERCEL_ENV: 'production', ...configured })
    );
  });
});
