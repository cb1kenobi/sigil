import { GUIDES_DIR } from '../src/lib/guides.ts';
import { expandIncludes, fill, includesOf, sigilVersion } from '../src/lib/includes.ts';
import { SITE_URL } from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'sigil-includes-'));
after(() => rmSync(dir, { force: true, recursive: true }));

describe('the version the docs describe', () => {
  it("should be @ttylabs/sigil's own, read from its package.json", () => {
    const manifest = JSON.parse(readFileSync(join(GUIDES_DIR, '..', 'package.json'), 'utf-8')) as {
      name: string;
      version: string;
    };

    assert.equal(manifest.name, '@ttylabs/sigil');
    assert.equal(sigilVersion(), manifest.version);
  });
});

describe('fill()', () => {
  it('should fill the version and the address of the site', () => {
    assert.equal(
      fill('v{{version}} at {{site}}/llms.txt'),
      `v${sigilVersion()} at ${SITE_URL}/llms.txt`
    );
  });

  it('should refuse a placeholder it has no value for, rather than print it', () => {
    assert.throws(() => fill('{{nope}}'), /\{\{nope\}\} is no placeholder/);
  });
});

describe('expandIncludes()', () => {
  writeFileSync(
    join(dir, 'block.md'),
    '## A block\r\n\r\nWith `code` and ```` four ````, v{{version}}.\r\n\r\n'
  );

  it('should replace the directive, and what GitHub shows instead, with the file as a fence', () => {
    const guide = [
      'Before.',
      '',
      '<!-- include block.md title="B v{{version}}" event=agent_instructions_copied -->',
      '',
      'See [`block.md`](block.md).',
      '',
      '<!-- /include -->',
      '',
      'After.',
    ].join('\n');

    assert.deepEqual(includesOf(guide), ['block.md']);
    assert.equal(
      expandIncludes(guide, dir),
      [
        'Before.',
        '',
        `\`\`\`\`\`md title="B v${sigilVersion()}" event=agent_instructions_copied`,
        '## A block',
        '',
        `With \`code\` and \`\`\`\` four \`\`\`\`, v${sigilVersion()}.`,
        '`````',
        '',
        'After.',
      ].join('\n')
    );
  });

  it('should leave a guide with no include as it was', () => {
    assert.equal(expandIncludes('# Title\n\nText.\n', dir), '# Title\n\nText.\n');
  });

  it('should refuse a directive with no end, which would otherwise be dropped', () => {
    assert.throws(
      () => expandIncludes('<!-- include block.md -->\n\nText.\n', dir),
      /include of block\.md has no <!-- \/include -->/
    );
  });

  it('should refuse a file that is not there', () => {
    assert.throws(
      () => expandIncludes('<!-- include gone.md -->\n<!-- /include -->', dir),
      /ENOENT/
    );
  });
});
