/**
 * `node:zlib`, asked for when the codec first needs it rather than when it loads.
 *
 * Every zlib call in the codec is inside a function, and the codec is on the
 * components entry's static graph because `imageView()` decodes the bytes it is
 * handed -- so a static `import` made every app that imported any component
 * load zlib, measured at about 0.7 ms of a fresh node's import, whether or not
 * it ever drew a picture. `process.getBuiltinModule()` is synchronous, so
 * `decodePng()` and `encodePng()` keep their signatures and nothing has to be
 * awaited. It is core on the `engines` floor (node >=22.19, added in 22.3) and
 * in every bun `sigil package` fetches, 1.2.23 included. SIG-328.
 *
 * What moved is when zlib loads, and nothing else: it is the same module object
 * a static import would have bound, so a spy on one of its functions still sees
 * the codec's call. `test/dist.test.ts` fails if a static import comes back.
 *
 * @returns The module.
 */
export function zlib(): typeof import('node:zlib') {
  return process.getBuiltinModule('node:zlib');
}
