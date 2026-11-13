export default {
  run({ argv }) {
    // the root option, which only reaches a command if the schema did
    process.stdout.write(argv.loud ? 'HELLO\n' : 'hello\n');
  },
};
