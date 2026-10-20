/**
 * The second config store from another package, and the one that writes.
 *
 *   node demos/config/03-yaml.js
 *   PORT=3000 node demos/config/03-yaml.js   # the environment still wins
 *
 * `ConfigStore` is public API so that a store nobody in the sigil repository
 * wrote can be *correct* rather than merely compile. `@ttylabs/config-xml` was
 * the first from outside; this is the second, and that matters more than either
 * format: one implementation proves an interface is writable, two prove it is
 * not shaped around the first one. Neither needed a line of `@ttylabs/sigil` to
 * change.
 *
 * What is worth watching is the three things only YAML has -- a version that
 * changes what a scalar means, anchors, and merge keys -- and that nothing past
 * the layer list asks which format a layer is.
 *
 * Needs no terminal: every line is `console.log`, so this is the same output
 * piped as it is on a screen.
 */
import { yaml } from '@ttylabs/config-yaml';
import { createConfig, json } from '@ttylabs/sigil/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sigil-config-yaml-demo-'));
const system = join(root, 'system.yaml');
const user = join(root, 'config.json');

/** Print a file the way an operator would see it. */
function show(label, path) {
  console.log(label);
  for (const line of readFileSync(path, 'utf8').trimEnd().split('\n')) {
    console.log(`  ${line}`);
  }
  console.log();
}

// an operator's file, written the way somebody would actually write one: two
// comments, an anchor, a merge key, an alias, a block scalar, a four-space
// indent and a trailing comment. Self-contained so the demo is -- an app's
// would be `/etc/myapp/config.yaml`
writeFileSync(
  system,
  `# raised for the load test on the 3rd; put it back afterwards
mode: production
defaults: &d
    retries: 3
    timeout: 30
server:
    <<: *d
    port: 8080
    host: 0.0.0.0
worker: *d
plugins:
    - core
    - audit
motd: |
    the service is up
    ask #ops before restarting
`
);

writeFileSync(
  user,
  `{
  // the one thing I changed
  "mode": "staging",
}`
);

const schema = {
  mode: { type: 'string', choices: ['production', 'staging'] },
  motd: { type: 'string' },
  plugins: { type: 'string', multiple: true },
  'server.host': { type: 'string', default: '127.0.0.1' },
  'server.port': { type: 'int', default: 8080, env: 'PORT' },
  'server.retries': { type: 'int' },
  'worker.timeout': { type: 'int' },
};

try {
  show('the YAML file', system);
  show('the JSON file above it', user);

  // the headline, and the one place a YAML store can silently disagree with the
  // rest of the library. The famous row is `yes` -- the Norway problem -- and it
  // is NOT the one that would bite a CLI config: `017` and `12:30` are, because
  // a file mode written the way every shell writes one and a time are both a
  // different number under YAML 1.1
  console.log('what a scalar means, which is why the version is pinned to 1.2 core');
  const probe = join(root, 'probe.yaml');
  for (const [body, under11] of [
    ['verbose: yes', 'boolean true'],
    ['verbose: no', 'boolean false'],
    ['mode: 017', 'number 15'],
    ['at: 12:30', 'number 750'],
    ['size: 1_000', 'number 1000'],
  ]) {
    writeFileSync(probe, `${body}\n`);
    const got = Object.values(yaml(probe).readSync().value)[0];
    console.log(
      `  ${body.padEnd(16)} 1.2 core: ${JSON.stringify(got).padEnd(10)} 1.1 would say: ${under11}`
    );
  }
  console.log();
  console.log('  on sigil’s own `bool` the two happen to agree, which is luck rather');
  console.log('  than design -- `transformValue()` takes yes/y/on/1 as well as true');
  console.log();

  const config = await createConfig({
    schema,
    // bottom first, so the last entry is on top. Two formats, two packages, one
    // stack -- and nothing past this list asks which is which
    layers: [
      { name: 'system', store: yaml(system) },
      { name: 'user', store: json(user) },
    ],
  });

  console.log('the merged view, with the schema having coerced every value');
  console.log(JSON.stringify(config.get(), null, 2));
  console.log();

  console.log('where each value came from');
  for (const [path, why] of [
    ['mode', 'the JSON file, shadowing the YAML scalar'],
    ['server.port', process.env.PORT ? 'PORT, over both files' : 'the YAML file'],
    ['server.retries', 'the `<<: *d` merge key, read through the anchor'],
    ['worker.timeout', 'the `*d` alias, which is the whole anchored map'],
    ['plugins', 'a YAML sequence, which needs no schema to be a list'],
  ]) {
    console.log(`  ${path.padEnd(15)} ${JSON.stringify(config.get(path)).padEnd(14)} -- ${why}`);
  }
  console.log();

  // unlike XML, YAML has scalar kinds -- so `8080` arrives as a number and
  // `true` as a boolean, and the schema goes through `checkValue()` rather than
  // `transformValue()`. Which is why both additions in `@ttylabs/sigil` are
  // needed: each sibling store exercises one of them
  console.log('scalars arrive already typed, which is the inverse of the XML store');
  const raw = yaml(system).readSync().value;
  for (const [path, at] of [
    ['server.port', raw.server.port],
    ['defaults.retries', raw.defaults.retries],
    ['mode', raw.mode],
  ]) {
    console.log(`  ${path.padEnd(18)} ${JSON.stringify(at).padEnd(14)} ${typeof at}`);
  }
  console.log();

  // the store diffs the value against the document and edits only what differs,
  // so both comments, the anchor, the merge key, the alias, the block scalar and
  // the four-space indent all survive -- the same promise `json()` keeps by
  // editing spans, kept through a document model instead
  config.set('server.port', 9090, 'system');
  config.set('server.host', '0.0.0.0', 'system');
  await config.save('system');

  show('after writing into the YAML layer', system);

  // the three things only YAML has, and a write that touched one would be wrong
  // in a different way each time. Each refusal names the path and the line
  console.log('what a write refuses, and why each is not merely a preference');
  for (const [label, act] of [
    ['through an alias -- setIn() throws an internal error', (c) => c.set('worker.timeout', 60)],
    [
      'on an aliased anchor -- it would move a path nobody claimed',
      (c) => c.set('defaults.retries', 9),
    ],
    [
      'removing a merged key -- deleteIn() answers false and does nothing',
      (c) => c.delete('server.retries'),
    ],
  ]) {
    const one = await createConfig({ layers: [{ name: 'system', store: yaml(system) }] });
    act(one);
    const refusal = await one.save().then(
      () => undefined,
      (e) => e.message
    );
    // asserted rather than merely caught: a save that stopped refusing would
    // print this heading with nothing under it and still exit 0
    if (refusal === undefined) {
      throw new Error(`the write "${label}" was expected to refuse`);
    }
    console.log(`  ${label}`);
    console.log(`    ${refusal.slice(refusal.indexOf(': ') + 2)}`);
  }
  console.log();

  // and the one exception, which is a measurement rather than a concession:
  // `yaml` writes the key into the map, shadowing the merge, the anchor is
  // untouched, and a re-read answers exactly what was written
  const shadow = await createConfig({ layers: [{ name: 'system', store: yaml(system) }] });
  shadow.set('server.retries', 9);
  await shadow.save();
  console.log('but SETTING a merged key is allowed, because shadowing round-trips');
  console.log(
    `  server.retries is now ${JSON.stringify(yaml(system).readSync().value.server.retries)}`
  );
  console.log(
    `  and defaults.retries is still ${JSON.stringify(yaml(system).readSync().value.defaults.retries)}`
  );
  console.log();

  // `canRepresent()` is the store saying what the FORMAT cannot hold, asked
  // where the value was written rather than discovered by a `save()` in an exit
  // handler. This store's answer is the WIDEST of the three, and in both
  // directions it is the format rather than a preference
  console.log('what this format can and cannot hold');
  const store = yaml(system);
  for (const [label, value] of [
    ['Infinity, which JSON rewrites as null', Number.POSITIVE_INFINITY],
    ['a padded string, which XML trims', '  two spaces  '],
    ['a control character, which XML writes raw', 'a\u0001b'],
    ['NaN, which no load accepts back', Number.NaN],
    ['a Map, which reads back as a plain mapping', new Map([['a', 1]])],
    ['a bigint, which no data type reads back', 10n],
  ]) {
    const answer = store.canRepresent(value, 'server.probe');
    console.log(`  ${label}`);
    console.log(`    ${answer === true ? 'held' : answer}`);
  }
  console.log();

  // the other refusal, and the one only a store from outside can show: the
  // built-in stores never report a loss, so nothing in sigil itself trips this.
  // A write either preserves everything it was not asked to change or it names
  // what it would lose and refuses
  const odd = join(root, 'odd.yaml');
  writeFileSync(odd, 'a: 1   # three spaces before this comment\nb: 2\n\n\nc: 3\n');
  show('a file this parser cannot reproduce byte for byte', odd);

  const second = await createConfig({ layers: [{ name: 'odd', store: yaml(odd) }] });

  // `wouldLose` is **absent** where nothing is lost rather than empty, so this
  // is the one shape that tells "it reported nothing" from "it reported an
  // empty list"
  const losses = second.layers[0].wouldLose;
  if (!losses?.length) {
    throw new Error('the odd file was expected to report a loss');
  }

  // each entry names a LINE, and that is exact rather than a guess: what is
  // compared is the two renderings line by line, so a line this points at is a
  // line where the file and a no-op write really do differ
  console.log('what the layer says it would lose, by line');
  for (const loss of losses) {
    console.log(`  ${loss.kind}:${loss.line}  ${loss.detail}`);
  }
  console.log();

  second.set('a', 2);

  const refusal = await second.save().then(
    () => undefined,
    (e) => e.message
  );
  if (refusal === undefined) {
    throw new Error('the lossy save was expected to refuse');
  }

  console.log('so the save refuses');
  for (const line of refusal.split('\n')) {
    console.log(`  ${line}`);
  }
  console.log();
  console.log(`  and the file is untouched: ${JSON.stringify(readFileSync(odd, 'utf8'))}`);
} finally {
  // a bare `try`/`finally`: anything that throws here is a broken demo and has
  // to exit non-zero with a stack, which is what `demos.test.ts` asserts. A
  // whole-body `catch` that logged would turn every such mistake into a line of
  // prose on stdout with exit 0
  rmSync(root, { force: true, recursive: true });
}
