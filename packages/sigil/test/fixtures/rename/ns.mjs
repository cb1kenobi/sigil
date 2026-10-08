/**
 * A deferred command whose module renames it.
 *
 * Legal and documented -- a loaded module's `name` wins over the placeholder's
 * -- and the registry stays keyed by the placeholder's, so `ns` is what routes
 * and `renamed-ns` is what the command calls itself. The one fixture that makes
 * the catalog's display name and its dispatch name part company.
 */
export default {
	name: 'renamed-ns',
	desc: 'A namespace that renamed itself',
	commands: { inner: { desc: 'Inner command', run: () => undefined } },
};
