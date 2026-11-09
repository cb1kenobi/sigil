// computed, so the build cannot read it -- and the commands.json entry says
// what help shows instead, which answers that
const describe = (): string => 'List things';

export default {
  desc: describe(),
  run(): void {
    process.stdout.write('listed\n');
  },
};
