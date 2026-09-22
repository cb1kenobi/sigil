// A `_index` is a helper that happens to be called index, not the directory's
// own command: the prefix takes it the same way it takes any other route.
export default { desc: 'not the directory', run: () => 'nope' };
