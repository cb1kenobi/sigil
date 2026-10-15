/**
 * A command in its own file. Nothing is read until the command is matched, so a
 * CLI with fifty of these starts as fast as one with none.
 */
export default {
  desc: 'Deploy the app',
  args: ['[target]'],
  options: { '--dry-run': 'Say what would happen, do nothing' },
  run({ argv }) {
    console.log(`${argv.dryRun ? 'would deploy' : 'deploying'} to ${argv.target ?? 'production'}`);
  },
};
