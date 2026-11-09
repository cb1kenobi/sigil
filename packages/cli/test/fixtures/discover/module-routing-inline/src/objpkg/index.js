// the same package, but reached by an object's `path` property, which the
// runtime imports as a file (and refuses a directory there): it is not
// registered as a package, so it is checked like any other module
export default { name: 'obj, ob', desc: 'A package by path property', run() {} };
