// A routed module that takes an `alias` from a const it spreads (SIG-726). The module
// is read only after argv has matched the name it is routed by, so `ay` routes
// nothing from source or from a build, and the build says so at the spread.
const base = { alias: 'ay' };
export default {
  ...base,
  run() {
    process.stdout.write('a ran\n');
  },
};
