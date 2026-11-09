// Packages a schema key's string value points at. The runtime imports each one
// when the schema is built and registers it under its own name, so the key is
// not one of its spellings -- and a built app has to answer to the same names.
export default {
  name: 'keyed-package',
  baseDir: import.meta.dirname,
  commands: {
    // the module names itself, with an alias in the name string and one in the
    // `alias` property
    foo: './pkg',
    // the module names nothing, so the manifest's name is the name; its entry
    // is the manifest's `main`, not an `index` module
    bar: './bare',
  },
};
