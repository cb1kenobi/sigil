const label: string = 'edited';
module.exports = {
	desc: 'edit a setting',
	run: (): void => {
		process.stdout.write(`${label}\n`);
	},
};
