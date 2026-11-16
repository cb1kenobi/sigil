import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A manifest `name` that is not a string is refused in sigil's words, under the
 * Node that loads the module, whatever the entry is called (SIG-389).
 *
 * Node's own package reader throws `ERR_INVALID_PACKAGE_CONFIG` for any present
 * `name` that is not a string -- `null` included -- but only when it reads the
 * format from the manifest, which is a `.js` or `.ts` entry and not a `.mjs`,
 * `.cjs` or `.mts`. Inside the suite that is invisible: vite transforms whatever a
 * test imports, so a `.js` entry loads without Node ever reading the manifest, and
 * a test there proves the routing and not the loading. A spawned node with no
 * flags is the only thing that answers it, which is the reason
 * `typescript.test.ts` is spawned and the reason this is here.
 */
const sigil = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../sigil/dist/index.mjs')
).href;

/** Runs `main()` over a commands declaration in a node that is told nothing. */
function run(commands: string, ...argv: string[]) {
  const dir = tempDir('sigil-manifest-name-');
  const script = join(dir, 'run.mjs');
  writeFileSync(
    script,
    `import { main } from ${JSON.stringify(sigil)};
try {
  await main({ argv: ${JSON.stringify(argv)}, schema: { name: 'x', commands: ${commands} }, settings: { errorHandler: false } });
} catch (err) {
  process.stderr.write(err.code + ' | ' + err.message + '\\n');
  process.exitCode = 1;
}
`
  );

  return { dir, ...spawnSync(process.execPath, [script], { encoding: 'utf-8' }) };
}

/** A directory holding one package, written as the test says. */
function pkg(entry: string, name: string, module: string): string {
  const dir = tempDir('sigil-manifest-pkg-');
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'pkg', entry), module);
  writeFileSync(
    join(dir, 'pkg', 'package.json'),
    `{ "main": "${entry}", "name": ${name}, "type": "module" }`
  );
  return dir;
}

describe('a package manifest name that is not a string', () => {
  const refusal =
    /Cannot route the package ".*pkg": its package\.json name is .*, which is not a string/;

  it.each([
    ['null', ''],
    ['42', ''],
    ['null', "name: 'mine', "],
    ['42', "name: 'mine', "],
  ])('should be refused in sigil’s words for a .js entry, name %s, module %j', (json, own) => {
    const dir = pkg('index.js', json, `export default { ${own}run() {} };\n`);

    for (const commands of [JSON.stringify(dir), JSON.stringify({ x: join(dir, 'pkg') })]) {
      const { status, stderr } = run(commands);
      expect(stderr, commands).toMatch(refusal);
      // Node's own refusal is what said so before, and it said it in its words
      expect(stderr, commands).not.toContain('ERR_INVALID_PACKAGE_CONFIG');
      expect(stderr, commands).not.toContain('Invalid package config');
      expect(status).toBe(1);
    }
  });

  it('should be refused for a .ts entry too, which Node reads the manifest for', () => {
    const dir = pkg('index.ts', 'null', 'export default { run() {} };\n');
    const { stderr } = run(JSON.stringify(dir));
    expect(stderr).toMatch(refusal);
    expect(stderr).not.toContain('ERR_INVALID_PACKAGE_CONFIG');
  });

  it('should be refused for a .mjs entry, which Node never checked', () => {
    const dir = pkg('index.mjs', '42', 'export default { run() {} };\n');
    expect(run(JSON.stringify(dir)).stderr).toMatch(refusal);
  });

  it('should leave a package with a string name running, so the above is the name and not the harness', () => {
    const dir = pkg(
      'index.js',
      '"@acme/deploy"',
      "export default { run() { console.log('deployed'); } };\n"
    );
    const { status, stderr, stdout } = run(JSON.stringify(dir), 'deploy');
    expect(stderr).toBe('');
    expect(stdout).toBe('deployed\n');
    expect(status).toBe(0);
  });
});
