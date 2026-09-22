// deliberately wrong: the build has to notice, and the suite has to not.
const port: number = 'not a number';
export default { desc: 'ship it', run: () => String(port) };
