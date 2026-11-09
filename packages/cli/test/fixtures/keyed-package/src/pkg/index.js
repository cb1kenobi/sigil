// a package names itself: its module's `name` beats the manifest's and the
// schema key, so this answers to `lazy`, `lz` and `pk`, and not to `foo`
export default {
  name: 'lazy, lz',
  alias: 'pk',
  desc: 'A package that names itself',
  run() {
    console.log('lazy');
  },
};
