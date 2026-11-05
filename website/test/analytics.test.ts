import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
const names = ['NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'NEXT_PUBLIC_POSTHOG_HOST'] as const;
const saved = names.map((name) => [name, process.env[name]] as const);

type Analytics = typeof import('../src/lib/analytics.ts');

let loads = 0;

/**
 * The stand-in for PostHog's singleton. `posthog-js` is mocked rather than
 * spied on because Node resolves it to its CommonJS build, where the default
 * import is the whole `module.exports` and not the instance a bundler hands the
 * site - so there would be no `capture` on it to watch.
 */
const posthog = { capture: mock.fn(), captureException: mock.fn() };

/**
 * `configured` is read once, when the module loads, which is the behaviour
 * under test - so each state gets its own copy of the module. The query string
 * is what makes the loader treat it as a new one; `posthog-js` is not
 * re-evaluated, so the spy below is on the same object the module calls.
 */
async function load(env: Partial<Record<(typeof names)[number], string>>): Promise<Analytics> {
  for (const name of names) {
    delete process.env[name];
  }
  Object.assign(process.env, env);

  mock.module('posthog-js', { exports: { default: posthog } });

  const url = new URL('../src/lib/analytics.ts', import.meta.url);
  url.search = `?load=${loads++}`;

  return import(url.href);
}

afterEach(() => {
  mock.restoreAll();
  posthog.capture.mock.resetCalls();
  posthog.captureException.mock.resetCalls();
  posthog.capture.mock.mockImplementation(() => undefined);
  posthog.captureException.mock.mockImplementation(() => undefined);

  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('analytics when unconfigured', () => {
  it('does not call PostHog from any entry point, and does not throw', async () => {
    const analytics = await load({});
    const { capture, captureException } = posthog;

    assert.doesNotThrow(() => analytics.capture('github_link_clicked', { location: 'header' }));
    assert.doesNotThrow(() =>
      analytics.captureBeforeLeaving('github_link_clicked', { location: 'footer' })
    );
    assert.doesNotThrow(() => analytics.captureException(new Error('boom')));

    assert.equal(capture.mock.callCount(), 0);
    assert.equal(captureException.mock.callCount(), 0);
  });

  it('is off when only one of the two variables is set', async () => {
    const analytics = await load({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test' });
    const { capture } = posthog;

    analytics.capture('github_link_clicked', { location: 'header' });

    assert.equal(capture.mock.callCount(), 0);
  });
});

describe('analytics when configured', () => {
  const env = {
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test',
    NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
  };

  it('passes the event and its properties to PostHog', async () => {
    const analytics = await load(env);
    const { capture } = posthog;

    analytics.capture('package_manager_selected', { manager: 'pnpm', location: 'hero' });

    assert.deepEqual(capture.mock.calls[0].arguments, [
      'package_manager_selected',
      { manager: 'pnpm', location: 'hero' },
    ]);
  });

  it('sends captureBeforeLeaving as a beacon', async () => {
    const analytics = await load(env);
    const { capture } = posthog;

    analytics.captureBeforeLeaving('github_link_clicked', { location: 'footer' });

    assert.deepEqual(capture.mock.calls[0].arguments, [
      'github_link_clicked',
      { location: 'footer' },
      { transport: 'sendBeacon' },
    ]);
  });

  it('hands an exception to PostHog', async () => {
    const analytics = await load(env);
    const { captureException } = posthog;
    const error = new Error('boom');

    analytics.captureException(error, { boundary: 'error' });

    assert.deepEqual(captureException.mock.calls[0].arguments, [error, { boundary: 'error' }]);
  });

  it('does not let an SDK failure out of a click handler', async () => {
    const analytics = await load(env);
    const fail = () => {
      throw new Error('sdk failure');
    };
    posthog.capture.mock.mockImplementation(fail);
    posthog.captureException.mock.mockImplementation(fail);

    assert.doesNotThrow(() => analytics.capture('github_link_clicked', { location: 'header' }));
    assert.doesNotThrow(() =>
      analytics.captureBeforeLeaving('github_link_clicked', { location: 'header' })
    );
    assert.doesNotThrow(() => analytics.captureException(new Error('boom')));
  });
});
