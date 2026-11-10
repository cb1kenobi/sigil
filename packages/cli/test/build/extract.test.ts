import { extractCommand } from '../../src/build/extract.js';
import { describe, it, expect } from 'vitest';

/**
 * What `sigil build` can read out of a command module without importing it.
 *
 * The whole reason this exists is that a lazily loaded command appears in help
 * by name alone, because its `desc` is inside the module and reading it means
 * importing it. Filesystem routing makes that the common case rather than a
 * rare one, so the build reads each module statically and bakes the answer in.
 *
 * Every case here is one of three things: a spelling of a literal that has to
 * be read, a spelling of a computed value that has to be *reported* rather
 * than guessed at, and the handful where guessing would be silently wrong.
 */
describe('extracting a command module', () => {
  describe('a literal', () => {
    it('should lift a description and a hidden flag', () => {
      const { diagnostics, facts } = extractCommand(
        'build.js',
        `export default { desc: 'build the app', hidden: true, run: () => {} };`
      );
      expect(facts).to.deep.equal({ desc: 'build the app', hidden: true });
      expect(diagnostics).to.deep.equal([]);
    });

    it('should read a template literal with nothing in it', () => {
      // `\`build the app\`` is a string somebody wrote, and refusing it would
      // make the two spellings of one thing disagree
      const { diagnostics, facts } = extractCommand(
        'build.ts',
        'export default { desc: `build the app` };'
      );
      expect(facts.desc).to.equal('build the app');
      expect(diagnostics).to.deep.equal([]);
    });

    it('should read a quoted key', () => {
      const { facts } = extractCommand('build.js', `export default { 'desc': 'quoted' };`);
      expect(facts.desc).to.equal('quoted');
    });

    it('should read false as a hidden flag rather than as nothing', () => {
      // `undefined` and `false` are different answers: one is "the module said
      // nothing" and the other is "the module said no"
      const { facts } = extractCommand('a.js', `export default { hidden: false };`);
      expect(facts.hidden).to.equal(false);
    });

    it('should leave a module that declares neither with no facts and no complaints', () => {
      const { diagnostics, facts } = extractCommand('a.js', `export default { run: () => {} };`);
      expect(facts).to.deep.equal({});
      expect(diagnostics).to.deep.equal([]);
    });
  });

  describe('a translated description', () => {
    /** A module that imports the tag and describes itself with it. */
    const mod = (body: string, importer = `import { __ } from '@ttylabs/sigil/i18n';`) =>
      `${importer}\nexport default { ${body} };`;

    it('should lift the catalog key and say that it is one', () => {
      // a tagged template is not a string literal, so this was reported as
      // computed and the command was listed by name alone -- with the key
      // sitting right there in the source. What the generated tree then
      // carries is `() => __\`...\``, so the built app renders it through its
      // own catalog rather than baking the English in
      const { diagnostics, facts } = extractCommand(
        'build.js',
        mod('desc: __`build the app`, run: () => {}')
      );
      expect(facts).to.deep.equal({ desc: 'build the app', descTranslated: true });
      expect(diagnostics).to.deep.equal([]);
    });

    it('should lift it under whatever name the import was given', () => {
      const { facts } = extractCommand(
        'build.js',
        mod('desc: L`build the app`', `import { __ as L } from '@ttylabs/sigil/i18n';`)
      );
      expect(facts).to.deep.equal({ desc: 'build the app', descTranslated: true });
    });

    it('should lift it through a namespace import', () => {
      const { facts } = extractCommand(
        'build.js',
        mod('desc: t.__`build the app`', `import * as t from '@ttylabs/sigil/i18n';`)
      );
      expect(facts).to.deep.equal({ desc: 'build the app', descTranslated: true });
    });

    it('should lift it through parentheses around the tag', () => {
      // `(__)` is a `ParenthesizedExpression` where the tag goes, which is the
      // shape `bindingName()` unwraps
      const { facts } = extractCommand('build.js', mod('desc: (__)`build the app`'));
      expect(facts).to.deep.equal({ desc: 'build the app', descTranslated: true });
    });

    it('should lift it through parentheses around the whole tagged template', () => {
      // and this is the other one: here the *value* is the
      // `ParenthesizedExpression`, so it is `translatedKey()`'s own unwrap that
      // reaches it. Two shapes rather than one, because a test that used only
      // the first passed with the second unwrap deleted
      const { facts } = extractCommand('build.js', mod('desc: (__`build the app`)'));
      expect(facts).to.deep.equal({ desc: 'build the app', descTranslated: true });
    });

    it('should report an interpolated one as the interpolation rather than as computed', () => {
      // said separately on purpose: "computed rather than a string literal"
      // about a `__` tag whose neighbour lifted perfectly well names nothing
      // the author can act on
      const { diagnostics, facts } = extractCommand('build.js', mod('desc: __`build ${target}`'));
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.message).to.contain('translated string with a value interpolated');
    });

    it('should leave a tag the module did not import alone', () => {
      // a local `__` is not the import, which is the rule `findTemplates()`
      // already keeps: the binding is the question, not the spelling
      const { diagnostics, facts } = extractCommand(
        'build.js',
        'const __ = (s) => s.raw[0];\nexport default { desc: __`build the app` };'
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should leave a tag imported from somewhere else alone', () => {
      const { facts, diagnostics } = extractCommand(
        'build.js',
        mod('desc: __`build the app`', `import { __ } from 'some-other-i18n';`)
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should leave a name the module rebinds alone', () => {
      // `reboundNames()` is module-wide, which is the whole reason the tag is
      // called `__` rather than `t`
      const { facts, diagnostics } = extractCommand(
        'build.js',
        `import { __ } from '@ttylabs/sigil/i18n';
        function f(__) { return __; }
        export default { desc: __\`build the app\` };`
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should not mark a plain string as translated', () => {
      const { facts } = extractCommand('build.js', mod(`desc: 'build the app'`));
      expect(facts).to.deep.equal({ desc: 'build the app' });
    });
  });

  describe('the wrappers that change nothing', () => {
    it('should look through command()', () => {
      // `command()` is documented as the identity function and exists only so
      // inference reaches a nested literal, so what it wraps says exactly what
      // the bare literal says
      const { facts } = extractCommand(
        'a.ts',
        `import { command } from '@ttylabs/sigil';
         export default command({ desc: 'wrapped' });`
      );
      expect(facts.desc).to.equal('wrapped');
    });

    it('should look through satisfies and as', () => {
      expect(
        extractCommand('a.ts', `export default { desc: 'sat' } satisfies Command;`).facts.desc
      ).to.equal('sat');
      expect(
        extractCommand('a.ts', `export default { desc: 'as' } as Command;`).facts.desc
      ).to.equal('as');
    });

    it('should look through parentheses', () => {
      expect(extractCommand('a.js', `export default ({ desc: 'paren' });`).facts.desc).to.equal(
        'paren'
      );
    });

    it('should not step into a call that takes more than the object', () => {
      // a wrapper doing anything more interesting than passing its argument
      // through almost always takes something else too, and reading the literal
      // out of one that transforms it is a wrong answer with no warning on it
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `export default withDefaults({ desc: 'inner' }, { desc: 'outer' });`
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.severity).to.equal('warning');
    });
  });

  describe('a computed value', () => {
    it('should report a computed description rather than guess at it', () => {
      const { diagnostics, facts } = extractCommand(
        'deploy.js',
        `export default { desc: describe() };`
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]).to.include({ file: 'deploy.js', line: 1, severity: 'warning' });
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should report a concatenation, which is computed however simple it looks', () => {
      const { diagnostics, facts } = extractCommand('a.js', `export default { desc: 'a' + 'b' };`);
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should report a template literal that interpolates', () => {
      const { facts, diagnostics } = extractCommand(
        'a.js',
        'export default { desc: `build ${target}` };'
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should report a shorthand, which names a binding rather than a value', () => {
      const { facts, diagnostics } = extractCommand(
        'a.js',
        `const desc = 'x';
        export default { desc };`
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"desc" is computed');
    });

    it('should report a computed key even when it happens to hold a string', () => {
      // `['desc']` and `[key]` are the same syntax and only one of them is
      // readable; a pass that reads the easy half is worse than one that skips
      // both, because the half it skipped is silent
      const { facts } = extractCommand('a.js', `export default { ['desc']: 'sneaky' };`);
      expect(facts.desc).to.equal(undefined);
    });

    it('should report an accessor', () => {
      const { facts, diagnostics } = extractCommand(
        'a.js',
        `export default { get desc() { return 'x'; } };`
      );
      expect(facts.desc).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('accessor');
    });

    it('should refuse a non-boolean hidden rather than read it as truthy', () => {
      // the runtime throws on a non-boolean `hidden` rather than coercing it,
      // so reading this as `true` would bake a value the app refuses to start
      // with
      const { facts, diagnostics } = extractCommand('a.js', `export default { hidden: 1 };`);
      expect(facts.hidden).to.equal(undefined);
      expect(diagnostics[0]!.message).to.contain('"hidden" is computed');
    });

    it('should carry a line and a column to the value rather than to the file', () => {
      const { diagnostics } = extractCommand('a.js', `export default {\n\tdesc: compute(),\n};`);
      expect(diagnostics[0]).to.include({ line: 2 });
      expect(diagnostics[0]!.column).to.be.greaterThan(1);
    });
  });

  describe('a default export that is a reference', () => {
    // not a style anybody chose: `--isolatedDeclarations` refuses to infer a
    // default export, so an app that has it on cannot write the literal
    // inline -- and this toolchain is one of those apps, so a lift that
    // stopped at the reference reported "help will list this command by name
    // alone" about every one of its own commands
    it('should follow `export default cmd` to the const it names', () => {
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `const cmd = { desc: 'x' };\nexport default cmd;`
      );
      expect(facts).to.deep.equal({ desc: 'x' });
      expect(diagnostics).to.have.lengthOf(0);
    });

    it.each(['cmd as Command', 'cmd satisfies Command', '(cmd)', 'cmd!'])(
      'should follow `export default %s`, which is the same statement with syntax on it',
      (written) => {
        // the reference was checked raw, so a type assertion on it declined a
        // command the bare form read
        const { diagnostics, facts } = extractCommand(
          'a.ts',
          `const cmd = { desc: 'x' };\nexport default ${written};`
        );
        expect(facts).to.deep.equal({ desc: 'x' });
        expect(diagnostics).to.have.lengthOf(0);
      }
    );

    it('should follow `export { cmd as default }` the same way', () => {
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `const cmd = { desc: 'x' };\nexport { cmd as default };`
      );
      expect(facts).to.deep.equal({ desc: 'x' });
      expect(diagnostics).to.have.lengthOf(0);
    });

    it('should follow one through the wrappers that change nothing', () => {
      // `command()` is the identity function, and it is what every command
      // module in this repo is written with
      const { facts } = extractCommand(
        'a.js',
        `const cmd = command({ desc: 'x' });\nexport default cmd;`
      );
      expect(facts).to.deep.equal({ desc: 'x' });
    });

    it('should follow one the const exports in place', () => {
      const { facts } = extractCommand(
        'a.js',
        `export const cmd = { desc: 'x' };\nexport default cmd;`
      );
      expect(facts).to.deep.equal({ desc: 'x' });
    });

    it('should refuse a `let`, which can be reassigned before the module runs', () => {
      // what the binding held when the file was read is not what it holds
      // when the module runs, and a lift that guessed would bake a
      // description the app does not have
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `let cmd = { desc: 'x' };\ncmd = { desc: 'y' };\nexport default cmd;`
      );
      expect(facts).to.deep.equal({});
      expect(diagnostics[0]!.severity).to.equal('warning');
    });

    it('should warn when the reference does not resolve to a literal', () => {
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `const cmd = build();\nexport default cmd;`
      );
      expect(facts).to.deep.equal({});
      expect(diagnostics[0]!.severity).to.equal('warning');
    });

    it('should warn when the reference names nothing in the module', () => {
      const { diagnostics } = extractCommand(
        'a.js',
        `import cmd from './x.js';\nexport default cmd;`
      );
      expect(diagnostics[0]!.severity).to.equal('warning');
    });
  });

  describe('a default export it cannot read', () => {
    it('should report no default export at all as an error', () => {
      // a module the runtime would refuse too; the build is finding out first
      const { diagnostics } = extractCommand('a.js', `export const nope = 1;`);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.severity).to.equal('error');
      expect(diagnostics[0]!.message).to.contain('no default export');
    });

    it('should report a function export as a warning', () => {
      const { diagnostics } = extractCommand('a.js', `export default function build() {}`);
      expect(diagnostics[0]!.severity).to.equal('warning');
      expect(diagnostics[0]!.message).to.contain('not an object literal');
    });
  });

  describe('a spread', () => {
    it('should report an absent description beside one as unknown rather than absent', () => {
      // the spread may well carry a `desc`, and nothing here can see it -- which
      // is the difference between a description the build missed and one nobody
      // wrote
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `export default { ...base, hidden: true };`
      );
      expect(facts.hidden).to.equal(true);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.message).to.contain('spreads another object');
    });

    it('should say nothing when the object writes its own description anyway', () => {
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `export default { ...base, desc: 'mine' };`
      );
      expect(facts.desc).to.equal('mine');
      expect(diagnostics).to.deep.equal([]);
    });

    it('a desc or hidden written before a spread was lifted with no warning, though the spread wins at run time', () => {
      // SIG-352. Object-literal order is what the module runs with, so in
      // `{ desc: 'early', hidden: false, ...base }` both values are whatever
      // `base` carries -- and the build baked `early` and `false`
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `const base = { desc: 'from base', hidden: true };
         export default { desc: 'early', hidden: false, ...base, run() {} };`
      );

      // nothing baked for either key, which leaves the command where an
      // unbundled one is until its module loads
      expect(facts).to.deep.equal({});
      expect(diagnostics.map((d) => d.message)).to.deep.equal([
        '"desc" is written before a spread, which may replace it when the module runs, so it cannot be read at build time; write "desc" after the last spread to have it appear in help',
        '"hidden" is written before a spread, which may replace it when the module runs, so it cannot be read at build time; write "hidden" after the last spread, or this command will be listed in help until its module loads',
      ]);
      expect(diagnostics.map((d) => [d.severity, d.line])).to.deep.equal([
        ['warning', 2],
        ['warning', 2],
      ]);
    });

    it('should read a key written after the last spread, wherever the others are', () => {
      // the *last* spread is the one that matters: a key between two spreads
      // is as unknown as one before both
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `export default { hidden: true, ...a, desc: 'between', ...b, hidden: false };`
      );

      expect(facts).to.deep.equal({ hidden: false });
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.message).to.contain('"desc" is written before a spread');
    });

    it('should say nothing about a key before a spread that is written again after it', () => {
      // the later spelling wins whatever the spread carried, so the earlier one
      // is dead code rather than an unknown
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `export default { desc: 'first', ...base, desc: 'second' };`
      );

      expect(facts.desc).to.equal('second');
      expect(diagnostics).to.deep.equal([]);
    });

    it('should not lift a translated desc written before a spread', () => {
      const { diagnostics, facts } = extractCommand(
        'a.js',
        `import { __ } from '@ttylabs/sigil/i18n';
         export default { desc: __\`early\`, ...base };`
      );

      expect(facts).to.deep.equal({});
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.message).to.contain('"desc" is written before a spread');
    });
  });

  describe('TypeScript', () => {
    it('should read a .ts module with types in it', () => {
      const { diagnostics, facts } = extractCommand(
        'deploy.ts',
        `import type { Command } from '@ttylabs/sigil';
         const target: string = 'prod';
         export default { desc: 'deploy', run: (): void => { void target; } } satisfies Command;`
      );
      expect(facts.desc).to.equal('deploy');
      expect(diagnostics).to.deep.equal([]);
    });

    it('should read a .cts module, which is CommonJS syntax with types', () => {
      // a `.cts` is CommonJS and exports with `module.exports`, so there is no
      // ESM default export to find -- which is a warning rather than a wrong
      // description
      const { diagnostics } = extractCommand(
        'edit.cts',
        `const cmd: unknown = { desc: 'edit' };\nmodule.exports = cmd;`
      );
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0]!.severity).to.equal('error');
    });
  });

  it('should throw on a module that does not parse rather than warn about it', () => {
    // guessing past a syntax error is how a build reports a missing description
    // for a file whose real problem is a missing brace
    expect(() => extractCommand('broken.js', `export default { desc:`)).to.throw(
      /Failed to parse broken\.js:1:/
    );
  });

  describe("a routed module's name, alias and default", () => {
    // SIG-316. A module is read after argv matched the name it is routed by,
    // so none of these can route anything. Only said when the caller knows the
    // module is routed, and only for what differs from the route
    const routing = (
      body: string,
      route = 'list',
      rest: { default?: boolean; index?: boolean } = {}
    ) => extractCommand('list.js', `export default { ${body} };`, { name: route, ...rest }).routing;

    it('should say nothing when it was not told what routes to the module', () => {
      const { routing: none } = extractCommand('a.js', `export default { name: 'a, b' };`);
      expect(none).to.deep.equal([]);
    });

    it('should warn about a spelling in the name string that the route does not have', () => {
      const [warning, ...rest] = routing(`name: 'list, ls'`);
      expect(rest).to.deep.equal([]);
      expect(warning?.severity).to.equal('warning');
      expect(warning?.message).toContain('"name" declares "ls", which does not route');
      expect(warning?.message).toContain("commands: { 'list, ls': ");
    });

    it('should warn about a rename, which is a spelling the route does not have', () => {
      expect(routing(`name: 'show'`)[0]?.message).toContain('"name" declares "show"');
    });

    it('should say nothing where the name repeats the route, in any prefix', () => {
      expect(routing(`name: 'list'`)).to.deep.equal([]);
      expect(routing(`name: 'list <dir>'`)).to.deep.equal([]);
      expect(routing(`name: 'list, ls'`, 'list, ls')).to.deep.equal([]);
      expect(routing(`name: '@ls, list'`, 'list, ls')).to.deep.equal([]);
    });

    it('should warn about a name it cannot read', () => {
      expect(routing(`name: spelling()`)[0]?.message).toContain('"name" is computed');
    });

    it('should warn about an alias, written either way', () => {
      expect(routing(`alias: 'ls'`)[0]?.message).toContain('"alias" declares "ls"');
      expect(routing(`alias: ['ls', 'l']`)[0]?.message).toContain('"alias" declares "ls", "l"');
      expect(routing(`alias: names`)[0]?.message).toContain('"alias" is not a list');
      expect(routing(`alias: 'ls'`, 'list, ls')).to.deep.equal([]);
    });

    it('should warn about a default that is not false, and name where to say it', () => {
      expect(routing(`default: true`)[0]?.message).toContain('"default" has no effect here');
      expect(routing(`default: true`)[0]?.message).toContain(
        "commands: { 'list': { default: true, path: "
      );
      expect(routing(`default: flag`)).to.have.lengthOf(1);
      expect(routing(`default: false`)).to.deep.equal([]);
    });

    it('should point each warning at the property it is about', () => {
      const [alias] = routing(`desc: 'x', alias: 'ls'`);
      expect(alias).to.include({ line: 1 });
      expect(alias?.column).to.equal(`export default { desc: 'x', `.length + 1);
    });

    it('should keep them out of the diagnostics a placeholder description silences', () => {
      const result = extractCommand('a.js', `export default { alias: 'ls' };`, { name: 'a' });
      expect(result.diagnostics).to.deep.equal([]);
      expect(result.routing).to.have.lengthOf(1);
    });

    it('should treat an explicit undefined as not declared, the way the runtime does', () => {
      // `placeholderRouting()` reads these as absent, and a warning about a
      // declaration the runtime does not see is a false one
      expect(routing(`name: undefined`)).to.deep.equal([]);
      expect(routing(`alias: undefined`)).to.deep.equal([]);
      expect(routing(`default: undefined`)).to.deep.equal([]);
      expect(routing(`name: void 0, alias: void 0`)).to.deep.equal([]);
    });

    it('should say nothing when the placeholder declares the default too', () => {
      expect(routing(`default: true`, 'list', { default: true })).to.deep.equal([]);
      expect(routing(`default: true`, 'list', { default: false })).to.have.lengthOf(1);
      // a value this cannot read does not repeat anything
      expect(routing(`default: flag`, 'list', { default: true })).to.have.lengthOf(1);
    });

    it('should say a spelling written twice once, in the message and in the example', () => {
      const [alias] = routing(`alias: ['ls', 'ls']`);
      expect(alias?.message).toContain('declares "ls", which');
      expect(alias?.message).toContain("commands: { 'list, ls': ");
      const [name] = routing(`name: 'list, ls, ls'`);
      expect(name?.message).toContain('declares "ls", which');
    });

    it('should name the directory in the advice for an index module', () => {
      // a key pointed at `db/index.ts` is one command with no subcommands, so
      // `database migrate` stops working; pointed at `./db` it keeps them
      const [first, second] = routing(`alias: 'database', default: true`, 'db', { index: true });
      expect(first?.message).toContain("commands: { 'db, database': './path/to/this-directory' }");
      // and `default` has nowhere to go: a key's string value is the only thing
      // that walks a directory and it cannot carry `default`, while an object's
      // `path` is imported as a file and a directory there crashes from source
      expect(second?.message).toContain('cannot be made the default from the schema');
      expect(second?.message).not.toContain('path:');
      expect(routing(`alias: 'database'`, 'db')[0]?.message).toContain('./path/to/this-file');
    });

    describe('in a walked directory', () => {
      // SIG-324. A walked route has no schema key to put a spelling on, and the
      // `commands.json` beside it is the place that routes one -- so that is
      // what the advice names, with the entry that says it
      const walked = (body: string, rest: { index?: boolean; name?: string } = {}) =>
        extractCommand('list.js', `export default { ${body} };`, {
          manifest: { file: 'commands.json', key: 'list' },
          name: rest.name ?? 'list',
          ...(rest.index ? { index: true } : {}),
        }).routing;

      it("should point a name's extra spelling at the commands.json beside the module", () => {
        const [name] = walked(`name: 'list, ls'`);
        expect(name?.message).toContain('"name" declares "ls", which does not route');
        expect(name?.message).toContain(
          'declare it in the commands.json beside this module instead, such as `{ "list": { "alias": ["ls"] } }`'
        );
        expect(name?.message).not.toContain('commands: {');
      });

      it('should point an alias there too, and a default', () => {
        expect(walked(`alias: ['ls', 'l']`)[0]?.message).toContain(
          '`{ "list": { "alias": ["ls", "l"] } }`'
        );
        expect(walked(`default: true`)[0]?.message).toContain('`{ "list": { "default": true } }`');
      });

      it('should say nothing about a spelling the commands.json already routes', () => {
        // the walk joins the entry's alias onto the name it is routed by
        expect(walked(`alias: 'ls'`, { name: 'list, ls' })).to.deep.equal([]);
      });

      it("should give a directory's index the file beside the directory, default and all", () => {
        // which is what a walk can say and a schema key cannot
        const [alias, fallback] = walked(`alias: 'database', default: true`, { index: true });
        expect(alias?.message).toContain('the commands.json beside this directory');
        expect(fallback?.message).toContain('`{ "list": { "default": true } }`');
        expect(fallback?.message).not.toContain('can only be removed');
      });

      it('should name the spelling of the file the level has', () => {
        const [alias] = extractCommand('list.js', `export default { alias: 'ls' };`, {
          manifest: { file: 'commands.jsonc', key: 'list' },
          name: 'list',
        }).routing;
        expect(alias?.message).toContain('the commands.jsonc beside this module');
      });
    });
  });
});
