const dashCharRegExp = /[-_ ]+(\w)/g;

export function camelCase(str = ''): string {
	return str.replace(dashCharRegExp, (s, m) => m.toLocaleUpperCase());
}
