const base = { desc: 'from base', hidden: true };

// written after the spread, so these are what runs
export default {
  ...base,
  desc: 'late',
  hidden: false,
  run() {
    process.stdout.write('late ran\n');
  },
};
