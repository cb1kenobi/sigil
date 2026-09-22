// Next-style: the app exports its schema and `sigil build` supplies the bin.
export default {
	desc: 'A fixture app that builds',
	name: 'buildable',
	options: { '-v, --verbose': 'Say more' },
	commands: './commands',
};
