// a route whose module publishes an alias in its own name string, which is
// only known once this module loads -- and `ship.js` beside it publishes the
// same one
export default { name: 'build, go', run: () => 'built' };
