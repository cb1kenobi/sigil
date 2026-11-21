import {
  check,
  customChecker,
  githubChecker,
  npmChecker,
  versionFrom,
  type UpdateChecker,
} from '../src/updates/index.js';
import { cacheFileName, distTagsURL } from '../src/updates/registry.js';
import { workerSource } from '../src/updates/worker-source.js';
import { fetchJSON, MAX_BODY_BYTES, WORKER_ARGV, WORKER_ENTRY } from '../src/updates/worker.js';
import { tempDir } from './temp.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, expect, vi } from 'vitest';

/**
 * A cache directory of the test's own, removed once the file has finished.
 *
 * It used to be a path under a shared `test-sigil/` in tmpdir that nothing ever
 * removed, so every run added five more to it. A fire-and-forget check's worker
 * can still be writing when the file finishes, and that is safe: the worker
 * does not create the directory, so a write that lands after the removal fails
 * in the worker and leaves nothing behind.
 */
async function generateTmpDir() {
  return tempDir('sigil-updates-');
}

/**
 * Runs the worker the way `check()` does -- the module's own source piped into
 * `node -` with a call appended -- so a test can watch it fail on its own
 * rather than through the parent's timer.
 */
function runWorker(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const { NODE_OPTIONS: _ignored, ...parentEnv } = process.env;
  const worker = spawn(process.execPath, [...WORKER_ARGV], {
    env: { ...parentEnv, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker.stdin.write(workerSource() + WORKER_ENTRY);
  worker.stdin.end();

  let stderr = '';
  worker.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  return new Promise((resolve) => {
    worker.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('updates', () => {
  describe('Error Handling', () => {
    it('should error if cache directory is invalid', async () => {
      await expect(check(undefined as any)).rejects.toThrowError(
        'Update check options must be an object'
      );
    });
  });

  // `wait: false` is the default, and it called `worker.disconnect()` on a child
  // spawned with three pipes and no IPC channel -- where `disconnect` is not
  // defined -- so an ordinary fire-and-forget update check threw instead of
  // returning
  describe('Fire and forget', () => {
    it('should return without waiting on the worker', async () => {
      const result = await check({
        cacheDir: await generateTmpDir(),
        packageName: 'snooplogg',
        packageVersion: '1.0.0',
      });

      // the worker is still running, so there is nothing to report but what
      // this call already had -- which is the point of the default path
      expect(result.current).to.equal('1.0.0');
      expect(result.latest).to.equal(undefined);
    });
  });

  describe('Check Latest', () => {
    it('should check latest version', async () => {
      const result = await check({
        cacheDir: await generateTmpDir(),
        packageName: 'snooplogg',
        packageVersion: '1.0.0',
        wait: true,
      });

      // assert the shape, not a specific version: `latest` is whatever
      // the registry currently serves and will change without notice
      expect(result.current).to.equal('1.0.0');
      expect(result.latest).to.match(/^\d+\.\d+\.\d+/);
    });
  });

  // `--input-type module` is a spelling only node accepts: bun reads the
  // space-separated form as a script path and fails with
  // `Script not found "module"`, so the default update check could not run on
  // one of the two runtimes this framework packages apps with. A bare `-`
  // reads a module from stdin on both.
  describe('The worker is piped as a bare script', () => {
    it('should not pass a node-only input-type flag', () => {
      // asserted on the constant the spawn uses rather than on the source,
      // because the first version of this grepped `index.ts` and matched the
      // comment that explains the flag
      expect([...WORKER_ARGV]).to.deep.equal(['-']);
    });

    it('should really run a module piped that way', async () => {
      // the constant above is only worth asserting because this proves the
      // spelling works: a real spawn, a real module on stdin, a real exit
      const { code, stderr } = await runWorker({
        CHECK_URL: 'http://example.invalid/x',
      });
      expect(code).to.equal(1);
      expect(stderr).to.contain('CHECK_URL must use https');
    });

    it('should pipe a module that exports rather than one that runs', async () => {
      // the in-process path imports this same file, which is what stops there
      // being two fetchers -- so the source has exports and no entry point,
      // and the call the parent appends is the whole of the spawned one
      const source = workerSource();
      expect(source).to.contain('export async function main(');
      expect(source).to.not.contain('\nawait main(');

      // and it has no relative import, because a piped script cannot resolve
      // one. A type-only import erases, so it does not count.
      // split on either ending: `.gitattributes` forces LF for a `.js` and
      // says nothing about a `.ts`, so this file is CRLF on Windows and a
      // `$` anchor after a `\r` matches nothing
      for (const line of source.split(/\r?\n/)) {
        if (/^import\s/.test(line) && !/^import type\s/.test(line)) {
          expect(line).to.match(/from 'node:[a-z]+';$/);
        }
      }
    });
  });

  describe('Checkers', () => {
    it('should ask npm for a dist tag', () => {
      const checker = npmChecker({ packageName: '@ttylabs/sigil' });
      expect(checker.type).to.equal('npm');
      expect(checker.url).to.equal(
        'https://registry.npmjs.org/-/package/%40ttylabs%2Fsigil/dist-tags'
      );
      expect(versionFrom({ latest: '1.2.3', next: '2.0.0' }, checker)).to.equal('1.2.3');
    });

    it('should read a dist tag that holds a dot', () => {
      // the path is a list of keys rather than a dotted string precisely so a
      // tag like `v1.x` is one key and not two
      const checker = npmChecker({ distTag: 'v1.x', packageName: 'a' });
      expect(versionFrom({ 'v1.x': '1.9.0' }, checker)).to.equal('1.9.0');
    });

    // SIG-545: `encodeURIComponent()` takes anything, so a missing name was a
    // request for the package called `undefined`
    it('should refuse a package name or a dist tag that is not a non-empty string', () => {
      for (const packageName of [undefined, null, 42, {}, '']) {
        expect(() => npmChecker({ packageName } as never), String(packageName)).to.throw(
          TypeError,
          `Update check package name must be a non-empty string, got "${String(packageName)}"`
        );
      }
      for (const distTag of [null, 42, {}, '']) {
        expect(() => npmChecker({ distTag, packageName: 'a' } as never), String(distTag)).to.throw(
          TypeError,
          /Update check dist tag must be a non-empty string/
        );
      }
      expect(() => npmChecker({ packageName: 'x\nforged' })).to.not.throw();
      expect(() => npmChecker({ packageName: { toString: () => 'x\nforged' } } as never)).to.throw(
        'got "x\\x0Aforged"'
      );
    });

    // SIG-544: `registryURL` is reachable from `sigil.json` as `registry`, and
    // was joined to the path exactly as written
    it('should refuse a registry that is not an absolute https URL', () => {
      for (const registryURL of [
        'https://npm.example.com/\n x',
        'not a url',
        'ftp://npm.example.com',
        'http://npm.example.com',
        '',
        'https://user:pass@npm.example.com',
        'https://npm.example.com/?x=1',
        'https://npm.example.com/#x',
        null,
        42,
      ]) {
        expect(
          () => npmChecker({ packageName: 'a', registryURL } as never),
          JSON.stringify(registryURL)
        ).to.throw(TypeError, /Update check registryURL must be an absolute https:\/\/ URL/);
      }
      expect(
        npmChecker({ packageName: 'a', registryURL: 'https://npm.example.com/registry//' }).url
      ).to.equal('https://npm.example.com/registry/-/package/a/dist-tags');
      expect(npmChecker({ packageName: 'a', registryURL: undefined }).url).to.equal(
        'https://registry.npmjs.org/-/package/a/dist-tags'
      );
    });

    it('should ask GitHub for the latest release', () => {
      const checker = githubChecker({ repo: 'acme/mycli' });
      expect(checker.type).to.equal('github');
      expect(checker.url).to.equal('https://api.github.com/repos/acme/mycli/releases/latest');
      expect(checker.headers?.['user-agent']).to.be.a('string');
    });

    it('should strip the tag prefix a release carries', () => {
      // `v1.2.3` against an app version of `1.2.3` would report an update
      // forever, which is the one way this is worse than not checking
      const checker = githubChecker({ repo: 'acme/mycli' });
      expect(versionFrom({ tag_name: 'v1.2.3' }, checker)).to.equal('1.2.3');
      // and a tag that does not carry it is left exactly as it is
      expect(versionFrom({ tag_name: '1.2.3' }, checker)).to.equal('1.2.3');
    });

    it('should take a prefix of its own, and none at all', () => {
      expect(
        versionFrom({ tag_name: 'bun-v1.4.4' }, githubChecker({ prefix: 'bun-v', repo: 'a/b' }))
      ).to.equal('1.4.4');
      expect(
        versionFrom({ tag_name: 'v1.2.3' }, githubChecker({ prefix: '', repo: 'a/b' }))
      ).to.equal('v1.2.3');
    });

    it('should refuse a repo that is not owner/name', () => {
      // a bad repo produces a request to a path that is not the one meant,
      // whose answer is a 404 the check swallows rather than an error anybody
      // sees -- so it is refused where a test can reach it
      for (const repo of ['mycli', 'acme/', '/mycli', 'a/b/c', '']) {
        expect(() => githubChecker({ repo })).to.throw(/must be "owner\/name"/);
      }
    });

    // SIG-541: the count of parts was the whole of the check, so a name GitHub
    // could never have given reached the request path and came back a 404 the
    // check swallows
    it('should refuse a repo with a character GitHub does not allow in a name', () => {
      for (const repo of [
        'o/n\nx',
        'o\n/n',
        'o /n',
        ' o/n',
        'o/ n',
        '\no/n',
        'o/n x',
        'o/n\t',
        'my org/my repo',
        'o/n?x=1',
        'o/n#x',
        'o/n%2Fx',
        'o@x/n',
        'o.x/n',
        'ö/n',
        'o/ñ',
        'o/n\u200b',
        'o/n\n',
      ]) {
        expect(() => githubChecker({ repo }), JSON.stringify(repo)).to.throw(
          /must be "owner\/name"/
        );
      }
    });

    it('should refuse a repository named . or .., which are path segments and not names', () => {
      for (const repo of ['o/.', 'o/..']) {
        expect(() => githubChecker({ repo }), repo).to.throw(/must be "owner\/name"/);
      }
    });

    it('should take every name the class allows, including the odd shapes real ones have', () => {
      for (const repo of [
        'a/b',
        'acme/mycli',
        'Some-Org/my.repo_1',
        'octocat_acme/tool',
        '0xabc/9',
        'o/.github',
        'o/-x',
        'o/a..b',
        'o/...',
        'o/x.git',
      ]) {
        const [owner, name] = repo.split('/');
        expect(githubChecker({ repo }).url, repo).to.equal(
          `https://api.github.com/repos/${owner}/${name}/releases/latest`
        );
      }
    });

    it('should not quote a repo with a control character in it as it was written', () => {
      // `repo` comes from `sigil.json`, and the refusal is printed as it stands:
      // an escape sequence would rename the window, a newline forge a line
      let message = '';
      try {
        githubChecker({ repo: 'o/n/a\u001b]0;PWNED\u0007\nforged: error: forged' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).to.contain('got "o/n/a\\x1B]0;PWNED\\x07\\x0Aforged: error: forged"');
      expect(message).to.not.match(/\p{Cc}/u);
    });

    // SIG-545: a `repo` that is not a string reached `repo.split()`, so the
    // documented message was Node's own `repo.split is not a function`
    it('should refuse a repo that is not a string with the documented message', () => {
      for (const repo of [undefined, null, 42, {}, ['o', 'n'], true]) {
        expect(() => githubChecker({ repo } as never), String(repo)).to.throw(
          TypeError,
          `Update check repo must be "owner/name", got "${String(repo)}"`
        );
      }
      // and an object does not get to print its own text through the message
      expect(() => githubChecker({ repo: { toString: () => 'x\nforged' } } as never)).to.throw(
        'got "x\\x0Aforged"'
      );
    });

    // SIG-544: `apiURL` was joined into the request as given, so a newline, a
    // missing scheme or another protocol was a request that failed in the
    // worker, where the check swallows it
    describe('apiURL', () => {
      const refused = [
        'https://h/api/v3/\n x',
        'https://h/api/v3/\n',
        'https://h/\tapi',
        'not a url',
        'github.example.com/api/v3',
        '//github.example.com/api/v3',
        'ftp://h',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ssh://git@h/x',
        // the worker refuses `http:`, so accepting it only moves the failure
        'http://h',
        'HTTP://h/api',
        '',
        ' ',
        ' https://h',
        'https://h ',
        'https://h/a b',
        'https:h',
        'https:/h',
        'https:///h',
        'https://',
        'https://h:99999',
        'https://h:abc',
        'https://h/api?x=1',
        'https://h/api#frag',
        'https://h/api?',
        'https://h/api#',
        'https://user@h/api',
        'https://user:pass@h/api',
        'https://:pass@h/api',
        'https://h\u0000/api',
        'https://h/\u001b[31m',
        'https://h/\u007f',
        'https://h/\u0085',
      ];

      it('should refuse a URL that is not an absolute https one with a plain path', () => {
        for (const apiURL of refused) {
          expect(() => githubChecker({ apiURL, repo: 'o/n' }), JSON.stringify(apiURL)).to.throw(
            TypeError,
            /Update check apiURL must be an absolute https:\/\/ URL/
          );
        }
      });

      it('should refuse a value that is not a string', () => {
        for (const apiURL of [null, 42, {}, ['https://h'], true]) {
          expect(() => githubChecker({ apiURL, repo: 'o/n' } as never), String(apiURL)).to.throw(
            TypeError,
            /Update check apiURL must be an absolute https:\/\/ URL/
          );
        }
      });

      it('should take the default and a normal enterprise root, keeping its path', () => {
        expect(githubChecker({ repo: 'o/n' }).url).to.equal(
          'https://api.github.com/repos/o/n/releases/latest'
        );
        expect(githubChecker({ apiURL: undefined, repo: 'o/n' }).url).to.equal(
          'https://api.github.com/repos/o/n/releases/latest'
        );
        for (const [apiURL, root] of [
          ['https://github.example.com/api/v3', 'https://github.example.com/api/v3'],
          ['https://github.example.com/api/v3/', 'https://github.example.com/api/v3'],
          ['https://github.example.com/api/v3///', 'https://github.example.com/api/v3'],
          ['https://github.example.com', 'https://github.example.com'],
          ['https://github.example.com/', 'https://github.example.com'],
          ['HTTPS://GitHub.Example.com:8443/api/v3', 'https://github.example.com:8443/api/v3'],
          ['https://127.0.0.1:8443/api/v3', 'https://127.0.0.1:8443/api/v3'],
          ['https://[::1]/api/v3', 'https://[::1]/api/v3'],
          ['https://h/a%20b/c', 'https://h/a%20b/c'],
        ] as const) {
          expect(githubChecker({ apiURL, repo: 'o/n' }).url, apiURL).to.equal(
            `${root}/repos/o/n/releases/latest`
          );
        }
      });

      it('should build the request on what the parser wrote, so what was checked is what is used', () => {
        // a backslash is a separator to the parser and a dot segment is
        // resolved away; the URL used is the normalized one, not the raw string
        expect(githubChecker({ apiURL: 'https://h\\api\\v3', repo: 'o/n' }).url).to.equal(
          'https://h/api/v3/repos/o/n/releases/latest'
        );
        expect(githubChecker({ apiURL: 'https://h/x/../api', repo: 'o/n' }).url).to.equal(
          'https://h/api/repos/o/n/releases/latest'
        );
      });

      it('should not quote a control character, or a password, as it was written', () => {
        const messageOf = (apiURL: unknown): string => {
          try {
            githubChecker({ apiURL, repo: 'o/n' } as never);
          } catch (error) {
            return (error as Error).message;
          }
          return '';
        };

        const newline = messageOf('https://h/a\u001b]0;PWNED\u0007\nforged: error: forged');
        expect(newline).to.contain('got "https://h/a\\x1B]0;PWNED\\x07\\x0Aforged: error: forged"');
        expect(newline).to.not.match(/\p{Cc}/u);

        // refused for the credentials, and for a URL the parser refuses outright
        for (const apiURL of [
          'https://user:hunter2@h/api',
          'https://:hunter2@h/api',
          'https://user:hunter2@h:99999/api',
          'https://user:hunter2@h/api?x=1',
          'https:\\\\user:hunter2@h\\api',
          'user:hunter2@h/api',
          'ht\ttps://user:hunter2@h/api',
          // a separator inside the password: the parser reads the userinfo as a host
          'https://u:hun/ter2@h/',
          'https://u:hunter2@h/\u0000',
          'https://u:hun?ter2@h/',
          'https://u:hun#ter2@h/',
          // no colon before it, and no scheme
          'hunter2@github.example.com/api/v3',
          '//u:hunter2@h/',
          '\\\\u:hunter2@h',
          'https://u@x:hunter2@h/',
          // a secret in the query or the fragment
          'https://npm.example.com/?_authToken=hunter2',
          'https://npm.example.com/#hunter2',
          'https://npm.example.com/?a=1@b#hunter2',
          // the secret wholly in front of the separator that would cut it
          'https://u:hunter2#x@h/',
          'https://u:hunter2?x@h/',
          'https://u:hunter2@h?x@h2/',
          // and behind a newline, which `.` would not cross
          'x\nhttps://u:hunter2@h',
          'x\nhttps://h/?token=hunter2',
        ]) {
          const message = messageOf(apiURL);
          expect(message, JSON.stringify(apiURL)).to.contain('must be an absolute https:// URL');
          expect(message, JSON.stringify(apiURL)).to.not.contain('hunter2');
          expect(message, JSON.stringify(apiURL)).to.not.match(/\p{Cc}/u);
        }
        // and what is left of it is still enough to find the value by
        expect(messageOf('https://user:hunter2@h/api')).to.contain('got "***@h/api"');
        expect(messageOf('https://h/api?token=hunter2')).to.contain('got "https://h/api?***"');
      });
    });

    it('should answer undefined rather than throw on an answer with no version', () => {
      const checker = npmChecker({ packageName: 'a' });
      for (const body of [undefined, null, {}, { latest: 1 }, { latest: '' }, 'nope']) {
        expect(versionFrom(body, checker)).to.equal(undefined);
      }
    });

    // `isNewer()` trims what it compares and the notice printed what this
    // returned, so a carriage return in the answer was newer than `1.0.0` and
    // landed in the middle of the line the notice wrote
    it('should not hand back the whitespace around a registry version', () => {
      const npm = npmChecker({ packageName: 'a' });
      expect(versionFrom({ latest: '\r1.0.1' }, npm)).to.equal('1.0.1');
      expect(versionFrom({ latest: ' 1.0.1\n' }, npm)).to.equal('1.0.1');
      expect(versionFrom({ latest: ' \t ' }, npm)).to.equal(undefined);
      // and before the prefix, which a leading space would otherwise hide
      expect(versionFrom({ tag_name: '\rv1.2.3' }, githubChecker({ repo: 'a/b' }))).to.equal(
        '1.2.3'
      );
    });

    // SIG-546: a `custom` check's `url` was copied across as written, so
    // `ftp://h` and a URL with a newline in it were baked into a worker that
    // refuses them, where the check swallows the failure
    describe('customChecker', () => {
      const url = 'https://example.com/latest.json';
      const path = ['data', 'version'];

      it('should build the checker `sigil.json` declares', () => {
        expect(customChecker({ path, url })).to.deep.equal({ path, type: 'custom', url });
      });

      it('should keep a query, which a custom endpoint may need', () => {
        expect(
          customChecker({ path, url: 'https://h/api/latest?channel=stable&x=1' }).url
        ).to.equal('https://h/api/latest?channel=stable&x=1');
        // and a trailing slash, which is part of the path of a request and not a root
        expect(customChecker({ path, url: 'https://h/api/latest/' }).url).to.equal(
          'https://h/api/latest/'
        );
        expect(customChecker({ path, url: 'https://h:8443/v.json' }).url).to.equal(
          'https://h:8443/v.json'
        );
      });

      it('should use the URL as the parser wrote it, which is what the worker will test', () => {
        // the worker's check is a case-sensitive `startsWith('https:')`, so the
        // scheme has to leave here lower-cased: the raw value passes the gate
        expect(customChecker({ path, url: 'HTTPS://H/x' }).url).to.equal('https://h/x');
        expect(customChecker({ path, url: 'https://h\\x' }).url).to.equal('https://h/x');
        expect(customChecker({ path, url: 'https://h' }).url).to.equal('https://h/');
      });

      it('should refuse a path with a hole in it', () => {
        const holey: string[] = [];
        holey.length = 2;
        expect(() => customChecker({ path: holey, url })).to.throw(TypeError);
      });

      it('should hold what it was given in a copy, so a later edit cannot move it', () => {
        const keys = ['a', 'b'];
        const checker = customChecker({ path: keys, url });
        keys.push('c');
        expect(checker.path).to.deep.equal(['a', 'b']);
      });

      it('should refuse a URL that is not an absolute https one', () => {
        for (const bad of [
          'ftp://h/latest.json',
          'http://h/latest.json',
          'https://h/\nx',
          'https://h/a b',
          'https://h/a\tb',
          ' https://h/x',
          'https://h/x ',
          '\nhttps://h/x',
          'https://h/\u001b[31m',
          'https://h/\u007f',
          'https://h/\u0085',
          'not a url',
          'h/latest.json',
          '//h/latest.json',
          '',
          'https://',
          'https:///x',
          'https://?x=1',
          'https://:443/x',
          'https://h:99999/x',
          'https://user@h/x',
          'https://user:pass@h/x',
          'https://:pass@h/x',
          'https://h/x#frag',
          'https://h/x?a=1#frag',
          'https://h/x#',
        ]) {
          expect(() => customChecker({ path, url: bad }), JSON.stringify(bad)).to.throw(
            TypeError,
            /Update check url must be an absolute https:\/\/ URL with no credentials or fragment/
          );
        }
        for (const bad of [undefined, null, 42, {}, ['https://h']]) {
          expect(() => customChecker({ path, url: bad } as never), String(bad)).to.throw(
            TypeError,
            /Update check url must be an absolute https:\/\/ URL/
          );
        }
      });

      it('should not quote a control character, a password or a query as written', () => {
        const messageOf = (value: string): string => {
          try {
            customChecker({ path, url: value });
          } catch (error) {
            return (error as Error).message;
          }
          return '';
        };

        const forged = messageOf('https://h/a\u001b]0;PWNED\u0007\nforged: error: forged');
        expect(forged).to.contain('got "https://h/a\\x1B]0;PWNED\\x07\\x0Aforged: error: forged"');
        expect(forged).to.not.match(/\p{Cc}/u);

        for (const bad of [
          'https://user:hunter2@h/x',
          'https://:hunter2@h/x',
          'https://u:hun?ter2@h/',
          'https://u:hunter2#x@h/',
          // a token in the query of a URL refused for another reason
          'ftp://h/x?token=hunter2',
          'https://h/x\n?token=hunter2',
          'https://h/x?token=hunter2#frag',
        ]) {
          const message = messageOf(bad);
          expect(message, JSON.stringify(bad)).to.contain('must be an absolute https:// URL');
          expect(message, JSON.stringify(bad)).to.not.contain('hunter2');
          expect(message, JSON.stringify(bad)).to.not.match(/\p{Cc}/u);
        }
      });

      // SIG-556: `redact()` hid everything from the first `?`, so a refused
      // endpoint with a legitimate query read `https://h/x?***` and the reader
      // could not see which query they had written
      describe('a refused endpoint with a query', () => {
        const messageOf = (value: string): string => {
          try {
            customChecker({ path, url: value });
          } catch (error) {
            return (error as Error).message;
          }
          return '';
        };
        const quoted = (value: string): string =>
          /got "([\s\S]*)"$/.exec(messageOf(value))?.[1] ?? '';

        it('should quote each parameter name and hide each value', () => {
          expect(quoted('https://h/latest json?channel=stable')).to.equal(
            'https://h/latest json?channel=***'
          );
          expect(quoted('https://h/latest json?channel=stable&token=hunter2')).to.equal(
            'https://h/latest json?channel=***&token=***'
          );
        });

        it('should say what a parameter with no value, an empty name and a double separator are', () => {
          // no `=` is a name with no value and is quoted as it is; `a=` has a value that is empty and is still hidden
          expect(quoted('ftp://h/x?a=&b')).to.equal('ftp://h/x?a=***&b');
          expect(quoted('ftp://h/x?=hunter2')).to.equal('ftp://h/x?=***');
          // an empty parameter says nothing and is dropped
          expect(quoted('ftp://h/x?&&a=1&&b=2&')).to.equal('ftp://h/x?a=***&b=***');
          expect(quoted('ftp://h/x?&')).to.equal('ftp://h/x?');
          expect(quoted('ftp://h/x?')).to.equal('ftp://h/x?');
          // the first `=` ends the name: a value may hold another, and a `?`
          expect(quoted('ftp://h/x?a=b=c&d=e?f=g')).to.equal('ftp://h/x?a=***&d=***');
          // only `&` separates, so a `;` and its tail are part of a value
          expect(quoted('ftp://h/x?a=1;token=hunter2')).to.equal('ftp://h/x?a=***');
        });

        it('should keep hiding everything after a fragment', () => {
          expect(quoted('https://h/x?a=1#hunter2')).to.equal('https://h/x?a=***#***');
          expect(quoted('https://h/x?a=1&b=2#c=3&d=4')).to.equal('https://h/x?a=***&b=***#***');
          // a `#` before the `?` makes the whole of it the fragment
          expect(quoted('https://h/x#hunter2?a=1')).to.equal('https://h/x#***');
          expect(quoted('https://h/x#')).to.equal('https://h/x#***');
        });

        it('should cut a name that is long, and a list of names that is, rather than echo them', () => {
          expect(quoted(`ftp://h/x?${'n'.repeat(40)}=hunter2`)).to.equal(
            `ftp://h/x?${'n'.repeat(32)}...=***`
          );
          expect(quoted(`ftp://h/x?${'n'.repeat(40)}`)).to.equal(`ftp://h/x?${'n'.repeat(32)}...`);
          const many = Array.from({ length: 12 }, (_, i) => `p${i}=hunter2`).join('&');
          expect(quoted(`ftp://h/x?${many}`)).to.equal(
            `ftp://h/x?${Array.from({ length: 8 }, (_, i) => `p${i}=***`).join('&')}&...`
          );
        });

        it('should escape a name, which is what the reader typed', () => {
          const message = messageOf('https://h/x?a\nforged: error=1&\u001b]0;PWNED\u0007=2');
          expect(message).to.contain('?a\\x0Aforged: error=***&\\x1B]0;PWNED\\x07=***"');
          expect(message).to.not.match(/\p{Cc}/u);
        });

        // the cut order: a `@` is cut before anything else, so the query is not
        // quoted after one. Before SIG-556 what was left of a query after its
        // `@` was cut was echoed whole -- `***@b&token=hunter2` -- since the
        // `?` that would have cut it had gone with the `@`
        it('should not quote a query after an @, and not leak what follows one', () => {
          expect(quoted('ftp://h/x?email=a@b&token=hunter2')).to.equal('***@b&***');
          expect(quoted('ftp://h/x?email=a@b=hunter2')).to.equal('***@b=***');
          expect(quoted('ftp://h/x?email=a@b?token=hunter2')).to.equal('***@b?***');
          expect(quoted('https://h/x?a=1@b#hunter2')).to.equal('***@b#***');
          // and a credential still goes first, with the query behind it hidden
          expect(quoted('https://user:hunter2@h/x?a=1&token=2')).to.equal('***@h/x?***');
          expect(quoted('https://user:hunter2@h/api')).to.equal('***@h/api');
          expect(quoted('https://u:hunter2?x@h/')).to.equal('***@h/');
          expect(quoted('https://u:hunter2&x=1@h/')).to.equal('***@h/');
        });

        it('should show no value, password or token, whatever order they come in', () => {
          for (const bad of [
            'ftp://h/x?token=hunter2',
            'ftp://h/x?a=1&token=hunter2&b=2',
            'ftp://h/x?token=hunter2&token=hunter2',
            'ftp://h/x?a=b@c&token=hunter2',
            'ftp://h/x?a=1#token=hunter2',
            'ftp://h/x?a=1;token=hunter2',
            'ftp://h/x?a=%68unter2&b=hunter2',
            'ftp://u:hunter2@h/x?token=hunter2',
            'ftp://h/x?a=1&&=hunter2&b',
            'ftp://h/x\n?token=hunter2',
            'ftp://h/x\t?a=1&token=hunter2',
            'https://h/x?a=1&token=hunter2#hunter2',
            'https://h/x?token=hunter2#',
          ]) {
            const message = messageOf(bad);
            expect(message, JSON.stringify(bad)).to.contain('must be an absolute https:// URL');
            expect(message, JSON.stringify(bad)).to.not.contain('hunter2');
            expect(message, JSON.stringify(bad)).to.not.match(/\p{Cc}/u);
          }
        });

        it('should leave a root URL as it was, which may not carry a query at all', () => {
          const rootMessage = (apiURL: string): string => {
            try {
              githubChecker({ apiURL, repo: 'o/n' });
            } catch (error) {
              return (error as Error).message;
            }
            return '';
          };
          expect(rootMessage('https://h/api?channel=stable&token=hunter2')).to.contain(
            'got "https://h/api?***"'
          );
          expect(rootMessage('https://h/api#channel=stable')).to.contain('got "https://h/api#***"');
          // and the cut order reaches it too
          expect(rootMessage('https://h/api?a=b@c&token=hunter2')).to.contain('got "***@c&***"');
          expect(rootMessage('https://h/api?a=b@c&token=hunter2')).to.not.contain('hunter2');
        });
      });

      // SIG-555: an `UpdateChecker` can carry `headers` and a `prefix`, and the
      // builder took neither, so an app that needed one wrote the object by
      // hand and nothing it held was checked
      describe('headers and prefix', () => {
        const refusal = (opts: object): string => {
          try {
            customChecker({ path, url, ...opts } as never);
          } catch (error) {
            expect(error).to.be.instanceOf(TypeError);
            return (error as Error).message;
          }
          return '';
        };

        it('should build a checker carrying both', () => {
          const headers = { Accept: 'application/json', 'X-Api-Key': 'abc' };
          const checker = customChecker({ headers, path, prefix: 'v', url });
          expect(checker).to.deep.equal({ headers, path, prefix: 'v', type: 'custom', url });
          expect(versionFrom({ data: { version: 'v1.2.3' } }, checker)).to.equal('1.2.3');
        });

        it('should leave both out of a checker that was not given them', () => {
          expect(customChecker({ path, url })).to.deep.equal({ path, type: 'custom', url });
          expect(customChecker({ headers: undefined, path, prefix: undefined, url })).to.deep.equal(
            { path, type: 'custom', url }
          );
          expect(Object.keys(customChecker({ path, url }))).to.not.include.members([
            'headers',
            'prefix',
          ]);
          // an empty object is a set of no headers, and is kept as given
          expect(customChecker({ headers: {}, path, url }).headers).to.deep.equal({});
        });

        it('should hold its own copy of the headers', () => {
          const headers: Record<string, string> = { a: 'b' };
          const checker = customChecker({ headers, path, url });
          headers.a = 'changed';
          headers.c = 'd';
          expect(checker.headers).to.deep.equal({ a: 'b' });
        });

        it('should take a header whose value is empty, tabbed or Latin-1, and a null-prototype object', () => {
          expect(customChecker({ headers: { a: '' }, path, url }).headers).to.deep.equal({ a: '' });
          expect(
            customChecker({ headers: { a: 'x\ty z\u00e9' }, path, url }).headers
          ).to.deep.equal({
            a: 'x\ty z\u00e9',
          });
          const bare = Object.assign(Object.create(null) as object, { a: 'b' });
          expect(customChecker({ headers: bare, path, url }).headers).to.deep.equal({ a: 'b' });
        });

        it('should refuse a header name that is not an HTTP token, naming it', () => {
          for (const name of [
            '',
            'a b',
            'a:b',
            'a\nb',
            'a\rb',
            'a(b',
            'a/b',
            '\u00e9',
            'a\u0000b',
          ]) {
            const message = refusal({ headers: { [name]: 'x' } });
            expect(message, JSON.stringify(name)).to.contain(
              'Update check header name must be an HTTP token, got "'
            );
            expect(message, JSON.stringify(name)).to.not.match(/\p{Cc}/u);
          }
          expect(refusal({ headers: { 'bad name': 'secret-token' } })).to.equal(
            'Update check header name must be an HTTP token, got "bad name"'
          );
          // a name is escaped like everything else a message quotes
          expect(refusal({ headers: { 'a\nforged: error': 'x' } })).to.contain(
            'got "a\\x0Aforged: error"'
          );
        });

        it('should refuse a value with a line break or another control character, and never quote it', () => {
          for (const value of [
            'Bearer hunter2\r\nX-Injected: 1',
            'Bearer hunter2\n',
            'hunter2\r',
            'hunter2\u0000',
            'hunter2\u001b[31m',
            'hunter2\u007f',
            'hunter2\u0085',
            'hunter2\u009f',
            'hunter2\u2028',
            'hunter2\u0100',
            'hunter2\u{1f600}',
          ]) {
            const message = refusal({ headers: { Authorization: value } });
            expect(message, JSON.stringify(value)).to.equal(
              'Update check header "Authorization" must not contain a control character or a character past U+00FF'
            );
            expect(message, JSON.stringify(value)).to.not.contain('hunter2');
          }
        });

        it('should refuse a value that is not a string, naming the header and not the value', () => {
          for (const value of [undefined, null, 42, true, {}, ['hunter2'], 1n]) {
            const message = refusal({ headers: { Authorization: value } });
            expect(message, String(value)).to.match(
              /^Update check header "Authorization" must be a string, got a /
            );
            expect(message, String(value)).to.not.contain('hunter2');
          }
        });

        it('should refuse headers that are not a plain object, without quoting them', () => {
          for (const headers of [
            null,
            'hunter2',
            42,
            true,
            ['hunter2'],
            new Map([['a', 'hunter2']]),
            () => 1,
          ]) {
            const message = refusal({ headers });
            expect(message, String(headers)).to.equal(
              'Update check headers must be an object of header names to string values'
            );
          }
        });

        it('should hold the rule to what Node itself would refuse to send', () => {
          // the rule is written as a regular expression so that this module does
          // not load `node:http`, and this is what keeps it from drifting
          // from `http.validateHeaderName()` and `http.validateHeaderValue()`
          const accepts = (check: () => void): boolean => {
            try {
              check();
              return true;
            } catch {
              return false;
            }
          };
          for (let code = 0; code < 0x300; code++) {
            const char = String.fromCharCode(code);
            const nodeName = accepts(() => http.validateHeaderName(`a${char}b`));
            const ours = accepts(() =>
              customChecker({ headers: { [`a${char}b`]: 'x' }, path, url })
            );
            expect(ours, `name U+${code.toString(16)}`).to.equal(nodeName);

            const nodeValue = accepts(() => http.validateHeaderValue('a', `x${char}y`));
            const oursValue = accepts(() =>
              customChecker({ headers: { a: `x${char}y` }, path, url })
            );
            // the one difference is deliberate: the C1 controls, which Node lets through
            const c1 = code >= 0x80 && code <= 0x9f;
            expect(oursValue, `value U+${code.toString(16)}`).to.equal(c1 ? false : nodeValue);
          }
        });

        it('should refuse an empty prefix, and one that is not a string', () => {
          for (const prefix of ['', null, 42, true, ['v'], {}]) {
            expect(refusal({ prefix }), String(prefix)).to.match(
              /^Update check prefix must be a non-empty string, got "/
            );
          }
          expect(refusal({ prefix: '' })).to.equal(
            'Update check prefix must be a non-empty string, got ""'
          );
          expect(refusal({ prefix: 42 })).to.equal(
            'Update check prefix must be a non-empty string, got "42"'
          );
        });

        it('should reach the worker as the request headers it sends', () => {
          const checker = customChecker({
            headers: { Authorization: 'Bearer x' },
            path,
            url,
          });
          // `CHECK_HEADERS` is this object, serialized, and the worker parses it back
          expect(JSON.parse(JSON.stringify(checker.headers))).to.deep.equal({
            Authorization: 'Bearer x',
          });
        });
      });

      it('should refuse a path that is not a non-empty list of non-empty strings', () => {
        for (const bad of [
          undefined,
          null,
          'version',
          [],
          [''],
          ['a', ''],
          [1],
          [null],
          [['a']],
          {},
        ]) {
          expect(() => customChecker({ path: bad, url } as never), JSON.stringify(bad)).to.throw(
            TypeError,
            /Update check path must be a non-empty list of non-empty strings/
          );
        }
        // and what it prints is escaped like everything else it quotes, and
        // is not asked to serialize a value JSON cannot hold
        expect(() => customChecker({ path: [1, 'a\nforged'], url } as never)).to.throw(
          'got "1,a\\x0Aforged"'
        );
        expect(() => customChecker({ path: [1n], url } as never)).to.throw(
          /Update check path must be a non-empty list/
        );
      });

      it('should read a version out of what it asked for', () => {
        expect(versionFrom({ data: { version: '2.0.0' } }, customChecker({ path, url }))).to.equal(
          '2.0.0'
        );
      });
    });

    it('should let a custom checker name its own url and path', () => {
      const checker: UpdateChecker = {
        headers: { authorization: 'token' },
        path: ['data', 'releases', 'stable'],
        type: 'custom',
        url: 'https://example.com/versions.json',
      };
      expect(versionFrom({ data: { releases: { stable: '3.1.4' } } }, checker)).to.equal('3.1.4');
    });
  });

  // `@ttylabs/sigil` is this framework's own name, and it was the one name the
  // check could not handle: the slash split the registry path and nested the
  // cache file in a directory nothing created. Every test above uses an
  // unscoped name, which is why the suite was green
  describe('Scoped package names', () => {
    it('should encode the package name into one path segment', () => {
      expect(distTagsURL('@ttylabs/sigil')).to.equal(
        'https://registry.npmjs.org/-/package/%40ttylabs%2Fsigil/dist-tags'
      );
    });

    it('should leave an unscoped package name alone', () => {
      expect(distTagsURL('snooplogg')).to.equal(
        'https://registry.npmjs.org/-/package/snooplogg/dist-tags'
      );
    });

    it('should strip a trailing slash from the registry URL', () => {
      expect(distTagsURL('@ttylabs/sigil', 'https://npm.example.com/')).to.equal(
        'https://npm.example.com/-/package/%40ttylabs%2Fsigil/dist-tags'
      );
    });

    it('should not let a package name escape the cache directory', () => {
      for (const name of ['@ttylabs/sigil', '../../etc/passwd', 'a\\b']) {
        const file = cacheFileName(name, 'latest');
        expect(file).to.not.match(/[/\\]/);
        expect(dirname(join('cache', file))).to.equal('cache');
      }
    });

    it('should not share a cache file between two packages', () => {
      // a `/` swapped for a `-` collides both ways, and two packages sharing
      // a cache file share a version
      expect(cacheFileName('@a/b-c', 'latest')).to.not.equal(cacheFileName('@a-b/c', 'latest'));
      expect(cacheFileName('a-b', 'c')).to.not.equal(cacheFileName('a', 'b-c'));
      expect(cacheFileName('@a/b', 'latest')).to.not.equal(cacheFileName('@a/b@latest', ''));
    });

    it('should read the cache file a scoped package name writes', async () => {
      // a cache entry that is not stale is the whole answer, so this pins the
      // path `check()` reads without spawning a worker or leaving the machine
      const cacheDir = await generateTmpDir();
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, cacheFileName('@ttylabs/sigil', 'latest')),
        JSON.stringify({ body: { latest: '9.9.9' }, ts: Date.now() })
      );

      const result = await check({
        cacheDir,
        packageName: '@ttylabs/sigil',
        packageVersion: '1.0.0',
      });

      expect(result.latest).to.equal('9.9.9');
      // nothing was nested: the scope did not become a directory
      expect(readdirSync(cacheDir)).to.deep.equal([cacheFileName('@ttylabs/sigil', 'latest')]);
    });
  });

  // the cache holds the response rather than the version read out of it, so
  // that the reading happens in the parent where a test can reach it. A cache
  // written before that change is fresh and unreadable, which would answer
  // `undefined` for a whole interval while looking current
  describe('A cache from before the response was cached', () => {
    it('should be refreshed rather than read as having no version', async () => {
      const cacheDir = await generateTmpDir();
      mkdirSync(cacheDir, { recursive: true });
      const file = join(cacheDir, cacheFileName('snooplogg', 'latest'));
      writeFileSync(file, JSON.stringify({ ts: Date.now(), version: '9.9.9' }));

      const result = await check({
        cacheDir,
        packageName: 'snooplogg',
        packageVersion: '1.0.0',
        wait: true,
      });

      expect(result.latest).to.match(/^\d+\.\d+\.\d+/);
      expect(JSON.parse(readFileSync(file, 'utf-8')).body).to.be.an('object');
    });

    it('should be refreshed when the checker changed under it', async () => {
      // the cache file is keyed by package name and dist tag, not by
      // checker -- so an app that moved from npm to GitHub finds yesterday's
      // dist-tags sitting where a release should be, and `versionFrom()`
      // reads nothing at `tag_name`. Fresh and unreadable is the same
      // failure as the legacy cache above, arriving a different way
      const cacheDir = await generateTmpDir();
      mkdirSync(cacheDir, { recursive: true });
      const file = join(cacheDir, cacheFileName('snooplogg', 'latest'));
      writeFileSync(file, JSON.stringify({ body: { tag_name: 'v9.9.9' }, ts: Date.now() }));

      const result = await check({
        cacheDir,
        packageName: 'snooplogg',
        packageVersion: '1.0.0',
        wait: true,
      });

      // it went and asked rather than answering `undefined` for a day
      expect(result.latest).to.match(/^\d+\.\d+\.\d+/);
    });
  });

  // only "too old" was asked, so a cache stamped while the clock was ahead --
  // a bad RTC, a VM resumed from a snapshot, a restored home directory -- was
  // fresh until real time caught up with `ts + checkInterval`, and every check
  // in between answered from it without asking. `force` was the only way out
  describe('A cache stamped in the future', () => {
    /**
     * Seeds a cache stamped `ts` and checks against a local listener that drops
     * every connection, so a fetch shows up as a connection and a rejection and
     * nothing leaves the machine.
     */
    async function checkWith(ts: unknown): Promise<{ connections: number; latest?: string }> {
      const cacheDir = await generateTmpDir();
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, cacheFileName('stamped', 'latest')),
        // spliced in as text so a test can write what JSON.stringify() cannot
        `{"body":{"latest":"0.0.1"},"ts":${String(ts)}}`
      );

      let connections = 0;
      const server = createServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;

      try {
        const result = await check({
          cacheDir,
          checker: { path: ['latest'], type: 'custom', url: `https://127.0.0.1:${port}/none` },
          packageName: 'stamped',
          packageVersion: '1.0.0',
          timeout: 5000,
          wait: true,
        }).catch(() => undefined);
        return { connections, latest: result?.latest };
      } finally {
        server.close();
      }
    }

    it('should refetch a cache stamped a year ahead', async () => {
      const { connections, latest } = await checkWith(Date.now() + 400 * 86400000);
      expect(connections).to.equal(1);
      expect(latest).to.equal(undefined);
    });

    it('should refetch a cache stamped just past the minute of tolerance', async () => {
      const { connections } = await checkWith(Date.now() + 2 * 60000);
      expect(connections).to.equal(1);
    });

    it('should still read a cache stamped within the minute of tolerance', async () => {
      // the jitter of a clock NTP nudged back between two runs is not a clock
      // that was wrong, and refetching over it would be a check per run
      const { connections, latest } = await checkWith(Date.now() + 30000);
      expect(connections).to.equal(0);
      expect(latest).to.equal('0.0.1');
    });

    it('should refetch a cache whose stamp is not a finite number', async () => {
      // `1e999` parses to Infinity, and a string of digits is added to by
      // concatenation: the one stamped now passes `ts <= now` as a number and
      // then `ts + checkInterval` is twenty-odd digits long, so only asking
      // for a number catches it
      for (const ts of ['1e999', `"${Date.now()}"`, '"99999999999999"', 'null', '"nope"']) {
        const { connections, latest } = await checkWith(ts);
        expect(connections, ts).to.equal(1);
        expect(latest, ts).to.equal(undefined);
      }
    });
  });

  // the body was appended to a string for as long as the registry kept sending,
  // so an endless answer grew it until the runtime ran out of memory -- in a
  // process nobody is watching. `https.get()` is faked rather than served,
  // because serving TLS means a certificate and the bound is about bytes
  describe('Response size', () => {
    /** Answers the next `https.get()` with these chunks, and records a destroy. */
    function answer(chunks: Buffer[]): { destroyed: () => boolean } {
      let destroyed = false;
      vi.spyOn(https, 'get').mockImplementation(((
        _url: string,
        _opts: unknown,
        cb: (res: PassThrough) => void
      ) => {
        const req = Object.assign(new EventEmitter(), {
          destroy: () => {
            destroyed = true;
          },
          end: () => {
            const res = Object.assign(new PassThrough(), { statusCode: 200 });
            cb(res);
            for (const chunk of chunks) {
              if (!destroyed) {
                res.write(chunk);
              }
            }
            res.end();
          },
          setTimeout: () => req,
        });
        return req;
      }) as never);
      return { destroyed: () => destroyed };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should not buffer an unbounded response body', async () => {
      const half = Buffer.alloc(MAX_BODY_BYTES / 2 + 1, 0x20);
      const req = answer([Buffer.from('{"latest":"1.0.0"'), half, half, Buffer.from('}')]);

      await expect(fetchJSON({ timeout: 0, url: 'https://example.invalid/' })).rejects.toThrow(
        `Update check response exceeded ${MAX_BODY_BYTES} bytes`
      );
      expect(req.destroyed()).toBe(true);
    });

    // decoding chunk by chunk turned a character split across two of them into
    // two replacement characters, which is what keeping bytes until the end is for
    it('should read a body up to the bound, across chunk boundaries', async () => {
      const text = Buffer.from('{"latest":"1.0.0","note":"caf\u00e9"}');
      const at = text.indexOf(0xc3) + 1;
      answer([text.subarray(0, at), text.subarray(at)]);

      expect(await fetchJSON({ timeout: 0, url: 'https://example.invalid/' })).toEqual({
        latest: '1.0.0',
        note: 'caf\u00e9',
      });
    });
  });

  // the worker's `https.get()` had no timeout, and on the default path the
  // parent's timer is unreffed -- so a registry that accepted the connection
  // and then said nothing left a node process alive for as long as the socket
  // was, with the CLI that spawned it long gone
  describe('Request timeout', () => {
    it('should give up on a registry that never answers', async () => {
      // a plain TCP listener accepts the connection and never completes the
      // TLS handshake, which is a hang with nothing to read rather than a
      // refusal -- and it is local, so no test here touches the network
      const sockets: Socket[] = [];
      const server = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;

      try {
        const { code, stderr } = await runWorker({
          CHECK_URL: `https://127.0.0.1:${port}/-/package/sigil/dist-tags`,
          REQUEST_TIMEOUT: '500',
        });

        // it ended itself, rather than the test having to wait it out
        expect(code).to.equal(1);
        expect(stderr).to.contain('Update check timed out after 500ms');
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close();
      }
    });
  });
});
