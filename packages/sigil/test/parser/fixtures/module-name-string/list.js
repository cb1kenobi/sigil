// a route whose module gives itself a second spelling in its own name string.
// The module is read only once argv has matched `list`, so `ls` routes nothing
export default { name: 'list, ls', desc: 'List things', run: () => 'listed' };
