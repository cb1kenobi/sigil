// What importing each published entry costs: modules, bytes, builtins, time.
//
// Run by hand from inside packages/sigil, after a build:
//
//   node scripts/entry-cost.mjs [runs] [entry ...]
//
// The static half -- modules, bytes and the builtins imported at load -- is
// `staticGraph()` from `test/static-graph.ts`, the same one `test/dist.test.ts`
// sets its ceilings with, because a second implementation of "which modules
// does this entry pull in" is how two figures for one entry come to disagree.
//
// The runtime half is measured in a fresh node per run, since a module that is
// already loaded costs nothing to import again: the wall clock across one
// `await import()` of the built entry, and the node builtins that import
// actually loaded, read off `process.moduleLoadList` before and after -- which
// counts what a builtin pulls in behind it (`node:https` is `tls`, `net` and
// `http`), where the static list names only what the bundle asked for. The
// median of `runs` (default 15) is reported, because the first run pays for a
// cold disk cache and one run in ten pays for whatever else the machine was
// doing. SIG-328 is where the table this prints was first recorded.

import { dist, graphBytes, staticBuiltins, staticGraph } from '../test/static-graph.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runs = Number(process.argv[2] ?? 15);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const asked = process.argv.slice(3);
const entries = Object.keys(manifest.exports)
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? 'index' : key.slice(2)))
  .filter((name) => asked.length === 0 || asked.includes(name));

// the child: what was loaded before, the import, what was loaded after
const probe = `
performance.now();
const before = new Set(process.moduleLoadList);
const t0 = performance.now();
await import(process.argv[1]);
const ms = performance.now() - t0;
const loaded = process.moduleLoadList
  .filter((m) => !before.has(m) && m.startsWith('NativeModule '))
  .map((m) => m.slice('NativeModule '.length))
  .filter((m) => !m.startsWith('internal/'));
process.stdout.write(JSON.stringify({ ms, loaded }));
`;

/**
 * One fresh process importing one file.
 *
 * @param {string} file - The bundle to import, or a `data:` URL.
 * @returns {{ ms: number, loaded: string[] }} What it cost.
 */
function sample(file) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        probe,
        file.startsWith('data:') ? file : pathToFileURL(file).href,
      ],
      { encoding: 'utf8' }
    )
  );
}

/** @param {number[]} xs */
function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// the floor: an import of a module with nothing in it, so a figure below can
// be read as what the entry adds rather than what any import costs
const empty = Array.from({ length: runs }, () => sample('data:text/javascript,export{}'));
const rows = [
  {
    entry: '(empty module)',
    modules: 0,
    bytes: 0,
    builtins: '',
    ms: median(empty.map((s) => s.ms)).toFixed(2),
    loaded: empty[0].loaded.join(' '),
  },
];
for (const name of entries) {
  const file = `${name}.mjs`;
  const graph = staticGraph(file);
  const samples = Array.from({ length: runs }, () => sample(join(dist, file)));

  rows.push({
    entry: name,
    modules: graph.size,
    bytes: graphBytes(graph),
    builtins: staticBuiltins(graph)
      .map((b) => b.slice(5))
      .join(' '),
    ms: median(samples.map((s) => s.ms)).toFixed(2),
    loaded: samples[0].loaded.join(' '),
  });
}

console.log(`node ${process.version}, median of ${runs}\n`);
console.log('| entry | modules | bytes | static builtins | import ms | public builtins loaded |');
console.log('| --- | ---: | ---: | --- | ---: | --- |');
for (const r of rows) {
  console.log(
    `| ${r.entry} | ${r.modules} | ${r.bytes.toLocaleString('en-US')} | ${r.builtins || '-'} | ${r.ms} | ${r.loaded || '-'} |`
  );
}
