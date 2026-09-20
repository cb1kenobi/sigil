interface Target {
	name: string;
}

// a type-only import is erased too, which is what a real command module does
const target: Target = { name: 'prod' };

export default {
	desc: 'deploy the app',
	run: (): string => `deployed to ${target.name}`,
};
