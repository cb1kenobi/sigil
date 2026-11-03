// a route whose module aliases itself with a sibling route's name, which is
// only known once this module loads
export default { alias: 'build', desc: 'deploy the app', run: () => 'deployed' };
