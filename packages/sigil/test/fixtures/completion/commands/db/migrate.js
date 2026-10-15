export default {
  desc: 'migrate the database',
  options: { '--to [rev]': { choices: ['head', 'base'], desc: 'which revision' } },
  run: () => 'migrated',
};
