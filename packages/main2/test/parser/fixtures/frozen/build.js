// deeply frozen so any attempt to normalize the module object in place throws
// instead of quietly renaming the export every importer shares
export default Object.freeze({
	args: Object.freeze([Object.freeze({ name: '[entry]' })]),
	desc: 'build it',
	options: Object.freeze({ '--target [name]': null }),
});
