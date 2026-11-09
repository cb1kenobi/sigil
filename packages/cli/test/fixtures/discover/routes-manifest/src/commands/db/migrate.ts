export default {
  // repeats what the commands.json beside it routes, so there is nothing to warn about
  alias: 'm',
  run(): void {
    process.stdout.write('migrated\n');
  },
};
