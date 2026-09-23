// deliberately missing `baseDir`: the build resolves './commands' against this
// file and the runtime resolves it against the working directory, so this app
// builds and then throws the moment anybody runs it from source
export default {
	name: 'no-basedir',
	commands: './commands',
};
