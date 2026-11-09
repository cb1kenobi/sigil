// Packages a schema key points at whose names the build cannot read. Each one
// names itself from source, so a build that baked the key instead would route
// differently, and every one of these fails the build.
export default {
  name: 'package-names',
  baseDir: import.meta.dirname,
  commands: {
    computed: './computed',
    listed: './listed',
    spread: './spread',
    getter: './getter',
    bracketed: './bracketed',
    unnamed: './unnamed',
    broken: './broken',
  },
};
