// an index module declaring a command beside the routes the walk found, aliased
// with one of their names
export default {
  commands: { seed: { alias: 'migrate', run: () => 'seeded' } },
  desc: 'database commands',
};
