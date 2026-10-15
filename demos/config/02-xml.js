/**
 * A config store from another package, in the same stack as the built-in ones.
 *
 *   node demos/config/02-xml.js
 *   PORT=3000 node demos/config/02-xml.js   # the environment still wins
 *
 * `ConfigStore` is public API so that a store nobody in the sigil repository
 * wrote can be *correct* rather than merely compile, and `@ttylabs/config-xml`
 * is the first one from outside. It needed no change to that interface -- what
 * it needed was the store kit, the six exports `@ttylabs/sigil/config` publishes
 * for exactly this.
 *
 * XML is the vehicle rather than the point. The thing to watch is that nothing
 * past the layer list asks which format a layer is.
 *
 * Needs no terminal: every line is `console.log`, so this is the same output
 * piped as it is on a screen.
 */
import { xml } from '@ttylabs/config-xml';
import { createConfig, json } from '@ttylabs/sigil/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sigil-config-xml-demo-'));
const system = join(root, 'system.xml');
const user = join(root, 'config.json');

/** Print a file the way an operator would see it. */
function show(label, path) {
  console.log(label);
  for (const line of readFileSync(path, 'utf8').trimEnd().split('\n')) {
    console.log(`  ${line}`);
  }
  console.log();
}

// an operator's file: a declaration, a comment, an attribute and an element
// setting a value each, and a list. Written here so the demo is self-contained
// -- an app's would be `/etc/myapp/config.xml`
writeFileSync(
  system,
  `<?xml version="1.0" encoding="UTF-8"?>
<config mode="production">
  <!-- raised for the load test on the 3rd; put it back afterwards -->
  <server port="8080">
    <host>0.0.0.0</host>
  </server>
  <editor theme="light" tabWidth="4"/>
  <plugins>
    <plugin>core</plugin>
    <plugin>audit</plugin>
  </plugins>
</config>
`
);

writeFileSync(
  user,
  `{
  // the one thing I changed
  "editor": { "theme": "dark" },
}`
);

// the same object both `createConfig()` and the store are handed, so there is
// one schema with two readers rather than an XML-shaped restatement of it. The
// store reads exactly one field of it -- `multiple` -- because an XML list with
// a single occurrence is a scalar, and a `multiple` setting that meets `'a'`
// where it wants `['a']` throws on the first load
const schema = {
  mode: { type: 'string', choices: ['production', 'staging'] },
  'editor.tabWidth': { type: 'int', default: 2 },
  'editor.theme': { type: 'string', choices: ['light', 'dark'], default: 'light' },
  'plugins.plugin': { type: 'string', multiple: true },
  'server.host': { type: 'string', default: '127.0.0.1' },
  'server.port': { type: 'int', default: 8080, env: 'PORT' },
};

try {
  show('the XML file', system);
  show('the JSON file above it', user);

  // an attribute and a child element are the SAME setting at the same path.
  // The obvious alternative is a reserved key -- `_attributes`, `$`, `@_`, which
  // xml2js and fast-xml-parser both use -- and it is wrong here for a reason
  // with nothing to do with spelling: a sentinel puts one setting at two paths
  // depending on the FORMAT of the layer it came from, so the XML default below
  // would stop being shadowed by the JSON file above it
  const raw = xml(system, { schema }).readSync().value;

  console.log('attributes and child elements share one path space');
  for (const [path, how] of [
    ['mode', 'an attribute on the root'],
    ['server.port', 'an attribute'],
    ['server.host', 'a child element'],
    ['editor.theme', 'an attribute'],
    ['plugins.plugin', 'a repeated element'],
  ]) {
    const at = path.split('.').reduce((value, key) => value?.[key], raw);
    console.log(`  ${path.padEnd(15)} ${JSON.stringify(at).padEnd(20)} -- ${how}`);
  }
  console.log();

  const config = await createConfig({
    schema,
    // bottom first, so the last entry is on top. Two formats, two packages, one
    // stack -- and nothing past this list asks which is which
    layers: [
      { name: 'system', store: xml(system, { schema }) },
      { name: 'user', store: json(user) },
    ],
  });

  // XML has no scalar kinds at all, so every value above is text and the schema
  // is what turns `"8080"` into `8080`. It goes through the parser's own
  // `transformValue()`, which is why `--port=off`, `PORT=off` and an XML `off`
  // cannot come to mean three different things
  console.log('the merged view, with the schema having coerced every value');
  console.log(JSON.stringify(config.get(), null, 2));
  console.log();

  console.log('where each value came from');
  for (const [path, why] of [
    ['mode', 'the XML root attribute'],
    ['editor.theme', 'the JSON file, shadowing the XML attribute'],
    ['editor.tabWidth', 'the XML file, nothing above it'],
    ['server.host', 'the XML file, as an element'],
    ['server.port', process.env.PORT ? 'PORT, over both files' : 'the XML file, as an attribute'],
    ['plugins.plugin', 'the XML file, a repeated element read as a list'],
  ]) {
    const value = JSON.stringify(config.get(path));
    console.log(`  ${path.padEnd(15)} ${value.padEnd(20)} -- ${why}`);
  }
  console.log();

  // the store walks the DOM and writes back only what changed, so the comment,
  // the declaration, the indentation and the self-closing tag all survive -- the
  // same promise `json()` keeps by editing spans, kept a different way
  config.set('mode', 'staging', 'system');
  config.set('server.port', 9090, 'system');
  await config.save('system');

  show('after writing two settings into the XML layer', system);

  // `canRepresent()` is the store saying what the FORMAT cannot hold, asked
  // where the value was written rather than discovered by a `save()` in an exit
  // handler. It is synchronous for that reason
  console.log('what this format cannot hold');
  const store = xml(system, { schema });
  for (const [label, value, path] of [
    ['a padded string', '  two spaces  ', 'server.host'],
    ['null', null, 'server.host'],
    ['Infinity', Number.POSITIVE_INFINITY, 'server.timeout'],
    ['an empty object', {}, 'server.limits'],
    ['a name no element can have', 'x', '1bad'],
  ]) {
    console.log(`  ${label}`);
    console.log(`    ${store.canRepresent(value, path)}`);
  }
  console.log();

  // the other refusal, and the one only a store from outside can show: the
  // built-in stores never report a loss, so nothing in sigil itself trips this.
  // A write either preserves everything it was not asked to change or it names
  // what it would lose and refuses -- comments are the visible casualty and
  // every other one is silent in exactly the same way
  const odd = join(root, 'odd.xml');
  writeFileSync(odd, `<config>\n  <a mode = 'dev'></a>\n  <b>&#65;</b>\n</config>\n`);
  show('a file this parser cannot reproduce byte for byte', odd);

  const second = await createConfig({ layers: [{ name: 'odd', store: xml(odd) }] });

  // `wouldLose` is **absent** where nothing is lost rather than empty, so this
  // is the one shape that tells "it reported nothing" from "it reported an
  // empty list" -- and a demo whose heading printed with nothing under it is
  // the vacuous kind this repository keeps deleting
  const losses = second.layers[0].wouldLose;
  if (!losses?.length) {
    throw new Error('the odd file was expected to report a loss');
  }

  console.log('what the layer says it would lose');
  for (const loss of losses) {
    console.log(`  ${loss.kind}:${loss.line}  ${loss.detail}`);
  }
  console.log();

  second.set('a.mode', 'prod');

  // caught narrowly because the refusal is the point, and *asserted* rather
  // than merely caught: a save that stopped refusing would otherwise print
  // this heading with nothing under it and still exit 0
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
  // prose on stdout with exit 0, which is how a renamed import once went
  // unnoticed through a green suite
  rmSync(root, { force: true, recursive: true });
}
