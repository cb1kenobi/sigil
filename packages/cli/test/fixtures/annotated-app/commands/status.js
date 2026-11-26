export default {
  desc: 'Show the status',
  idempotent: true,
  readOnly: true,
  run() {
    process.stdout.write('ok\n');
  },
};
