type Mode = 'on' | 'off';
const mode: Mode = 'on';
export default {
	desc: 'settings',
	run: (): void => {
		process.stdout.write(`settings are ${mode}\n`);
	},
};
