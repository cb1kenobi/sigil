interface Target {
	name: string;
}

const target: Target = { name: 'prod' };

export default {
	desc: 'deploy the app',
	run: (): void => {
		process.stdout.write(`deployed to ${target.name}\n`);
	},
};
