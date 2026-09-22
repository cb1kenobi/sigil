export default {
	desc: 'say hello',
	args: ['[who]'],
	run: ({ argv }: { argv: { who?: string } }) => {
		process.stdout.write(`hello ${argv.who ?? 'world'}\n`);
	},
};
