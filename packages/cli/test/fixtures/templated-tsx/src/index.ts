export default {
	commands: {
		show: {
			desc: 'Print a template that was written in a .tsx',
			load: () => import('./commands/show.js'),
		},
	},
	name: 'templated-tsx',
};
