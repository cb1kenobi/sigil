// CommonJS, like any `.cts`: type stripping erases the annotations and does not
// rewrite the module syntax, so this exports the way a `.cjs` command does
const label: string = 'edit a setting';
module.exports = { desc: label };
