/**
 * Printing a resolved tree as the schema literal a built app carries.
 *
 * What comes out is a `commands` object, nested as deep as the tree goes, with
 * a `load` where the unbundled tree had a directory to walk:
 *
 * ```js
 * export const commands = {
 *   build: {
 *     desc: "build the app",
 *     load: () => import("./commands/build.js"),
 *   },
 *   db: {
 *     commands: {
 *       migrate: {
 *         desc: "run migrations",
 *         load: () => import("./commands/db/migrate.js"),
 *       },
 *     },
 *   },
 * };
 * ```
 *
 * ## Why a `load` and not a `path`
 *
 * A `path` is a file to `stat` and a URL to build, and a bundled app has
 * neither: its command modules are chunks a bundler named. A dynamic `import()`
 * with a literal specifier is the one thing a bundler can see, follow, and
 * rewrite -- so the deferral that makes `mycli --help` fast survives bundling
 * instead of being flattened into the entry chunk.
 *
 * ## The specifier is a specifier, not a path
 *
 * `relative()` answers with the platform's separator, and a backslash in an
 * import specifier is not a path separator -- it is an escape, so a Windows
 * build would emit `import("./commands\build.js")` and fail at run time on the
 * machine that built it. Every specifier is written with forward slashes and
 * carries an explicit `./`, since a bare `commands/build.js` is a *package*
 * specifier to every resolver there is.
 *
 * ## It prints what the tree says and decides nothing
 *
 * No `name` is emitted, because the key a command is declared under names it
 * and a `name` beside it would be a second answer. Nothing is emitted for a
 * command the tree gave no module -- a namespace directory -- so it keeps the
 * runtime's behaviour of matching, listing, and having nothing to run. And a
 * `desc` or `hidden` the extractor could not read is simply absent, which
 * leaves the command exactly where an unbundled one is: described once its
 * module loads. An `alias` or a `default` is the exception to that, and is
 * printed whenever the placeholder wrote one: it is read when the command is
 * registered, so there is no later moment at which the module could supply it.
 *
 * ## A translated description is emitted as a thunk
 *
 * A `` desc: __`Build the app` `` is lifted as its catalog *key*, and what is
 * printed here is `` desc: () => __`Build the app` `` over an import of the
 * tag. The thunk is what `Command.desc` takes for exactly this: a value in an
 * object literal is evaluated when the module is imported, which for the tree
 * this prints is before `main()` has loaded a catalog, so the string form would
 * bake the English in. The import is emitted only when something in the tree
 * needs it, since a tree with no translated description should not name a
 * module it never reads.
 */

import { escapeUnseen, quote } from '../template/emit.ts';
import { RUNTIME } from './discover.ts';
import { TAG_EXPORT } from './i18n.ts';
import type { ResolvedCommand, ResolvedTree } from './tree.ts';
import { relative, sep } from 'node:path';

/** How to print a tree. */
export interface GenerateOptions {
  /**
   * The directory the generated module will sit in.
   *
   * Every `import()` specifier is written relative to it, because that is what
   * a specifier in that module means.
   */
  readonly from: string;
  /**
   * How the binding is declared.
   *
   * `export const` by default, since the tree is usually a module of its own.
   * The generated executable wants a plain `const`, because there it is a
   * local that `main()` is handed rather than something anybody imports.
   */
  readonly declare?: string;
  /**
   * What to call the binding.
   *
   * Defaults to `commands`, which is the shape a schema wants it in:
   * `schema: { commands }`.
   */
  readonly name?: string;
  /**
   * Where the runtime comes from, for the `__` import a translated
   * description needs. `@ttylabs/sigil` by default, which is the only thing an
   * app depends on; `generateBin()` passes whatever it was told.
   */
  readonly runtime?: string;
}

/** Two spaces, since the repo's formatter uses them. */
const INDENT = '  ';

/**
 * The tag a translated description is printed over.
 *
 * Read from `i18n.ts` rather than spelled again, so the name the lift matched
 * and the name the emitter prints cannot come apart.
 */
const TAG = TAG_EXPORT;

/**
 * Prints a resolved tree as a module.
 *
 * @param tree - The tree.
 * @param options - Where the module lands, and what to call the export.
 * @returns The module's source, newline-terminated.
 */
export function generateCommands(tree: ResolvedTree, options: GenerateOptions): string {
  const name = options.name ?? 'commands';
  const keyword = options.declare ?? 'export const';

  // the tag, when and only when a description in the tree is a catalog key.
  // Emitted here rather than left to the caller, because this is what knows
  // whether the literal it just printed names `__` -- a caller deciding would
  // be a second reading of the same tree, and the one that got it wrong would
  // print a module with an undefined tag in it
  const tag = translated(tree.commands)
    ? `import { ${TAG} } from ${quote(`${options.runtime ?? RUNTIME}/i18n`)};\n`
    : '';

  return `${tag}${keyword} ${name} = ${printCommands(tree.commands, options.from, 0)};\n`;
}

/**
 * Whether anything in a tree carries a catalog key rather than a description.
 *
 * @param commands - The level to look at, and everything under it.
 * @returns Whether the `__` import is needed.
 */
function translated(commands: readonly ResolvedCommand[]): boolean {
  return commands.some(
    (command) => command.descTranslated === true || translated(command.commands)
  );
}

/**
 * Prints one level of commands as an object literal.
 *
 * @param commands - The commands.
 * @param from - The directory specifiers are relative to.
 * @param depth - How far in, for the indentation.
 * @returns The literal.
 */
function printCommands(commands: readonly ResolvedCommand[], from: string, depth: number): string {
  if (!commands.length) {
    return '{}';
  }

  const pad = INDENT.repeat(depth + 1);
  const body = commands
    .map((command) => `${pad}${quoteKey(command.name)}: ${printCommand(command, from, depth + 1)},`)
    .join('\n');

  return `{\n${body}\n${INDENT.repeat(depth)}}`;
}

/**
 * Prints one command as an object literal.
 *
 * @param command - The command.
 * @param from - The directory specifiers are relative to.
 * @param depth - How far in, for the indentation.
 * @returns The literal.
 */
function printCommand(command: ResolvedCommand, from: string, depth: number): string {
  const pad = INDENT.repeat(depth + 1);
  const fields: string[] = [];

  // the keys are written in the order a reader wants them: what it is, then how
  // to get it, then what is under it -- so a nested tree reads top-down rather
  // than opening with a subtree and mentioning the command afterwards
  if (command.desc !== undefined) {
    // a key is printed as a thunk over the tag rather than as the string,
    // because the catalog is loaded after this module is evaluated
    const desc = command.descTranslated
      ? `() => ${TAG}${backtick(command.desc)}`
      : quote(command.desc);
    fields.push(`${pad}desc: ${desc},`);
  }

  // routing a placeholder declares, which a built app has no other source for:
  // the runtime reads both when the command is registered, before its module
  // could be loaded
  if (command.alias?.length) {
    fields.push(`${pad}alias: [${command.alias.map(quote).join(', ')}],`);
  }

  if (command.default !== undefined) {
    fields.push(`${pad}default: ${command.default},`);
  }

  if (command.hidden !== undefined) {
    fields.push(`${pad}hidden: ${command.hidden},`);
  }

  if (command.module) {
    fields.push(`${pad}load: () => import(${quote(specifier(from, command.module))}),`);
  }

  if (command.commands.length) {
    fields.push(`${pad}commands: ${printCommands(command.commands, from, depth + 1)},`);
  }

  if (!fields.length) {
    // a directory with nothing in it that this could say anything about. The
    // runtime still registers it, so an empty literal is the honest print
    return '{}';
  }

  return `{\n${fields.join('\n')}\n${INDENT.repeat(depth)}}`;
}

/**
 * The import specifier that reaches a module from the generated one.
 *
 * @param from - The directory the generated module sits in.
 * @param module - The module, as an absolute path.
 * @returns The specifier, with forward slashes and an explicit `./`.
 */
export function specifier(from: string, module: string): string {
  // `sep` rather than a literal backslash, so the swap is the running
  // platform's separator rather than a guess about which one it was
  const parts = relative(from, module).split(sep).join('/');

  // a specifier with no leading `./` is a package specifier to every resolver
  // there is, so `commands/build.js` would be looked for in `node_modules`
  return parts.startsWith('.') ? parts : `./${parts}`;
}

/**
 * A key, quoted only where it has to be.
 *
 * A command name is whatever a file was called, so it may be anything a file
 * name can be -- `my-command` is the ordinary case and is not an identifier.
 *
 * @param name - The key.
 * @returns It, bare or quoted.
 */
function quoteKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);
}

/**
 * A catalog key as the template literal a `__` tag reads.
 *
 * It has to be a template literal rather than a quoted string, because `__` is
 * a tag and there is no call form of it -- and the key it looks up is built
 * from the *cooked* quasis, so what is emitted has to cook back to exactly the
 * key that was lifted. Hence the escapes: a backtick would end the template, a
 * `${` would open an interpolation, and a backslash would consume whatever came
 * after it. The newlines are escaped for legibility rather than for
 * correctness, since a raw one in a template literal cooks to itself.
 *
 * The backslash goes first, or every escape this adds is then escaped again.
 *
 * @param value - The key.
 * @returns Its source, backticks included.
 */
function backtick(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');

  // every other control character and the two line separators, by the rule
  // `quote()` uses: the untranslated path escaped `ESC`, `DEL` and C1 while
  // this one wrote them raw into the module (SIG-353). `\uXXXX` cooks back to
  // the character, so the key the tag looks up is unchanged
  return `\`${escapeUnseen(escaped)}\``;
}

/**
 * Prints the executable a built app runs, which the app does not write.
 *
 * The Next.js answer to "where is the app's entry": there is not one. Routes
 * are a directory convention and the framework supplies the server -- and in
 * standalone mode it *generates* one. The same applies here. A sigil bin is a
 * shebang, an import, and a call to `main()`; nobody should have to write it,
 * and a build that has to go looking for it is a build that can pick the wrong
 * file.
 *
 * What the app supplies is its `commands/` and a module exporting its schema --
 * the name, the root options, the hooks. This composes the two, so there is no
 * source transform anywhere: the baked tree is passed *over* whatever the
 * schema said about `commands`, which is the one property the build knows
 * better than the app does.
 *
 * The schema export may be a function, because `packages/cli` writes one and
 * because a schema that reads the environment has to be built rather than
 * declared. It is called once, at startup, exactly where the app would have
 * called it -- and **awaited**, as is an export that is itself a Promise, so an
 * `async` schema is a schema rather than a Promise spread into nothing
 * (SIG-353). `sigil reference` awaits the same export, and two commands of one
 * toolchain disagreeing about what a valid schema export is was the defect. A
 * schema that throws or rejects is rendered by `errorHandler()` and sets the
 * exit code, as anything `main()` catches is, rather than reaching Node's
 * uncaught-error report with a stack and a line of minified source.
 *
 * @param options - Where the generated module lands, what it imports, and the
 *   tree it bakes in.
 * @returns The module's source, newline-terminated.
 */
export function generateBin(options: GenerateBinOptions): string {
  const { defaultLocale, from, runtime = RUNTIME, schemaModule, tree, version, wrap } = options;

  // baked, because a bundle has no `package.json` beside it: an app reading
  // its own version off `import.meta.url` is reading a path that points
  // wherever the bundle was written, which is a throw rather than a version.
  // The app keeps its own answer for the unbundled case and this replaces it,
  // the same way the tree replaces `commands`
  const bakedVersion = version === undefined ? '' : `\n  version: ${quote(version)},`;

  // baked for the reason the version is: the runtime cannot read `sigil.json`,
  // because reading a file at startup is what `locales` being a map rather than
  // a directory convention exists to avoid. It is the *bottom* of the locale
  // chain, so this says what the app ships in and every environment variable
  // still beats it
  const bakedLocale =
    defaultLocale === undefined ? '' : `\n  defaultLocale: ${quote(defaultLocale)},`;

  // The schema is resolved and then handed to `main()` in one chain, so that
  // both halves of what the app can export are one rule:
  //
  // - whatever was exported is awaited, a function's result or the export
  //   itself, so an `async` function, a sync one returning a Promise and a
  //   Promise exported outright are all a schema (SIG-353). Awaiting a plain
  //   object hands it straight back
  // - a schema that throws or rejects is rendered by `errorHandler()`, the
  //   message and no stack, with the exit code set the way `main()` sets it for
  //   anything it catches -- because there is no `main()` yet to catch it, and
  //   Node's own report prints a whole minified line of the bundle. The
  //   built-in handler and no other, since the settings that could name another
  //   are on the schema that just failed to arrive
  //
  // The second argument to `.then()` and not a `.catch()`, so that only the
  // schema's failure is routed there: `main()` handles its own errors, and
  // with `errorHandler: false` it rejects on purpose, which has to stay a
  // rejection the app asked for rather than be rendered here
  const run = `Promise.resolve()
  .then(() => (typeof declared === 'function' ? declared() : declared))
  .then(
    (schema) => main({ schema: {
  ...schema,
  commands,${bakedVersion}${bakedLocale}
} }),
    (err) => errorHandler(err),
  )`;

  // `await` at module scope is the ordinary shape and the one thing a CommonJS
  // bundle cannot hold: rolldown refuses it outright with
  // `Top-level await is currently not supported with the 'cjs' output format`,
  // so the entry a Node single executable is built from awaits the same chain
  // inside an async function instead -- the schema's resolution included, since
  // it is part of the chain. It is the *same* code either way: the IIFE is not
  // caught, so what the chain leaves rejected -- only `main()` with
  // `errorHandler: false` -- is an unhandled rejection exactly as a top-level
  // `await` leaves it
  const dispatch = wrap ? `void (async () => {\n  await ${run};\n})();` : `await ${run};`;

  return `#!/usr/bin/env node
// Generated by sigil build. Do not edit.
import { errorHandler, main } from ${quote(runtime)};
import * as app from ${quote(specifier(from, schemaModule))};

${generateCommands(tree, { declare: 'const', from, name: 'commands', runtime })}
// spread rather than \`app.default ?? app.schema\`, which is a *static*
// reference to a named export the module need not have -- a bundler resolves
// that at build time and warns that it will always be undefined. Copying the
// namespace asks at run time, which is when the answer is known
const exported = { ...app };
const declared = exported.default ?? exported.schema;

// the schema may be an object, a function (async or not) or a Promise, and is
// awaited whichever it is. One that throws is rendered the way \`main()\` renders
// an error, since there is no \`main()\` yet to catch it -- and only that one:
// what \`main()\` rejects with, which \`errorHandler: false\` asks for, stays a
// rejection.
//
// \`commands\` last, because the baked tree is the one property the build knows
// better than the app does -- everything else is the app's own
${dispatch}
`;
}

/** How to print the generated executable. */
export interface GenerateBinOptions {
  /**
   * The locale to fall back on, from `"locale"` in `sigil.json`.
   *
   * Written beside the version and the baked tree, and absent when the config
   * names none -- which leaves whatever the app's own schema said, the way the
   * version does.
   */
  readonly defaultLocale?: string;
  /**
   * The app's version, read from its manifest at build time.
   *
   * Baked because a bundle has no `package.json` beside it to read at run
   * time. Left out when the manifest names none, which leaves whatever the
   * app's own schema said.
   */
  readonly version?: string;
  /** The directory the generated module will sit in. */
  readonly from: string;
  /** Where `main` comes from. */
  readonly runtime?: string;
  /** The app module exporting its schema. */
  readonly schemaModule: string;
  /** The command tree to bake in. */
  readonly tree: ResolvedTree;
  /**
   * Whether to put the startup -- resolving the schema and the `main()` call
   * it feeds -- inside an async function.
   *
   * Off by default, which is the ordinary top-level `await` -- the shape every
   * built app has had and the one to leave alone. On is for a bundle that has
   * to come out as CommonJS, where a top-level `await` is not merely
   * discouraged but refused: rolldown answers
   * `Top-level await is currently not supported with the 'cjs' output format`,
   * and CommonJS has no way to express it.
   *
   * What asks for that is `sigil package --runtime node`, because a Node single
   * executable runs its embedded main script as CommonJS. See `compile.ts`.
   */
  readonly wrap?: boolean;
}
