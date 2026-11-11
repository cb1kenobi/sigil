const base = { desc: 'from base', hidden: true };

// what runs is `base`'s description and `base`'s hidden flag, whatever is
// written above the spread
export default {
  desc: 'early',
  hidden: false,
  ...base,
  run() {
    process.stdout.write('early ran\n');
  },
};
