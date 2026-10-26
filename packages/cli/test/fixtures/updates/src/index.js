// An app whose whole job is to check for updates, because that is the one
// thing nothing could test from source: `@ttylabs/sigil/updates` read its
// worker off a path relative to its own module URL, so it worked from
// `node_modules` and died with `ENOENT` in every bundle -- with the build
// reporting complete success.
//
// It points at a port nothing is listening on, so the check fails for a
// reason that *proves the worker ran*: a connection refused comes from the
// worker, an `ENOENT` comes from the parent failing to find it.
import { check } from '@ttylabs/sigil/updates';

export default {
  desc: 'A fixture app that checks for updates',
  name: 'fixture-updates',
  async run() {
    try {
      const result = await check({
        cacheDir: process.env.UPDATE_CACHE_DIR,
        packageName: 'fixture-updates',
        packageVersion: '1.0.0',
        registryURL: process.env.UPDATE_REGISTRY,
        timeout: 10000,
        wait: true,
      });
      process.stdout.write(`OK ${JSON.stringify(result)}\n`);
    } catch (err) {
      process.stdout.write(`FAILED ${err.message.replaceAll('\n', ' | ')}\n`);
    }
  },
};
