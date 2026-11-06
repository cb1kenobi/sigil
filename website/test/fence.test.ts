import { readFence, readMeta } from '../src/lib/fence.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('readFence()', () => {
  it('should make a console fence a transcript and an sh fence a script', () => {
    assert.equal(readFence('console', undefined, '$ my-cli').kind, 'console');
    assert.equal(readFence('shell-session', undefined, '$ my-cli').kind, 'console');
    for (const lang of ['sh', 'bash', 'shell', 'zsh', 'SH']) {
      assert.equal(readFence(lang, undefined, 'npm test').kind, 'shell', lang);
    }
  });

  it('should make every other fence a file, untagged included', () => {
    assert.deepEqual(readFence('ts', undefined, 'let a = 1;'), {
      code: 'let a = 1;',
      kind: 'code',
      lang: 'ts',
    });
    assert.deepEqual(readFence(undefined, undefined, 'my-cli/'), { code: 'my-cli/', kind: 'code' });
  });

  it("should take a file's name from its path comment, and take the comment out of the body", () => {
    // the shape every complete file in the guides has, for guides.test.ts
    assert.deepEqual(readFence('ts', undefined, '// src/commands/hello.ts\nexport default {};'), {
      code: 'export default {};',
      kind: 'code',
      lang: 'ts',
      title: 'src/commands/hello.ts',
    });
  });

  it('should leave a comment that is not a path where it is', () => {
    const fence = readFence('ts', undefined, '// say hello\nhello();');
    assert.equal(fence.kind === 'code' && fence.code, '// say hello\nhello();');
  });

  it('should prefer a title the fence names, and then keep the body whole', () => {
    const fence = readFence('ts', 'title="cli.ts"', '// src/index.ts\nmain();');
    assert.deepEqual(fence, {
      code: '// src/index.ts\nmain();',
      kind: 'code',
      lang: 'ts',
      title: 'cli.ts',
    });
  });

  it("should read a transcript's working directory from the fence", () => {
    assert.deepEqual(readFence('console', 'cwd=~/my-cli', '$ my-cli'), {
      cwd: '~/my-cli',
      kind: 'console',
      text: '$ my-cli',
    });
  });

  it('should keep an empty working directory, which is a title bar with none', () => {
    // a command reference's usage line, which ran in no directory in particular
    assert.deepEqual(readFence('sh', 'cwd=""', 'sigil add'), {
      cwd: '',
      kind: 'shell',
      text: 'sigil add',
    });
    assert.equal('cwd' in readFence('sh', undefined, 'sigil add'), false);
  });
});

describe('a fence that asks for more on its line', () => {
  it('should make an install= script the install box, for the command it shows', () => {
    assert.deepEqual(
      readFence('sh', 'install=cli location=getting-started', 'npx @ttylabs/cli new my-cli'),
      { kind: 'install', location: 'getting-started', package: 'cli' }
    );
  });

  it('should refuse an install box whose guide shows a different command', () => {
    // the drift the box exists to make loud: GitHub would say one thing, the page another
    assert.throws(
      () => readFence('sh', 'install=cli location=x', 'npx @ttylabs/cli new other'),
      /has to show "npx @ttylabs\/cli new my-cli"/
    );
    assert.throws(() => readFence('sh', 'install=nope location=x', 'x'), /install=nope is not/);
    assert.throws(
      () => readFence('sh', 'install=cli', 'npx @ttylabs/cli new my-cli'),
      /needs a location=/
    );
  });

  it('should carry the event a copy sends, and refuse one that is not declared', () => {
    const fence = readFence('md', 'title="AGENTS.md" event=agent_instructions_copied', '## sigil');
    assert.equal(fence.kind === 'code' && fence.event, 'agent_instructions_copied');
    assert.equal(fence.kind === 'code' && fence.title, 'AGENTS.md');
    assert.throws(() => readFence('md', 'event=page_not_found', ''), /not one a copy can send/);
  });
});

describe('readMeta()', () => {
  it('should read quoted and bare values, and nothing else', () => {
    assert.deepEqual(readMeta('title="a b.ts" cwd=~/x stray'), { cwd: '~/x', title: 'a b.ts' });
    assert.deepEqual(readMeta(undefined), {});
  });
});
