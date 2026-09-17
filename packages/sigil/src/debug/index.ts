import { Console } from 'node:console';
import { Writable } from 'node:stream';

export default function debug(ns: string | undefined): Console {
	return new Console(
		new StdioStream({ ns, stream: process.stdout }),
		new StdioStream({ ns, stream: process.stderr })
	);
}

interface StdioStreamOptions {
	ns: string | undefined;
	stream: Writable;
}

class StdioStream extends Writable {
	#ns: string | undefined;
	#stream: Writable;

	constructor({ ns, stream }: StdioStreamOptions) {
		super();
		this.#ns = ns;
		this.#stream = stream;
	}

	_write(data, _enc, cb) {
		if (isEnabled(this.#ns)) {
			const ts = new Date().toISOString();
			const ns = this.#ns ? ` ${this.#ns}` : '';
			const msg = data.toString().replace(/(\r\n|\n)$/, '');
			this.#stream.write(`[${ts}]${ns} ${msg}\n`);
		}
		cb();
	}
}

/**
 * Every character a regular expression reads as syntax except `*`, which this
 * pattern language keeps for itself as the wildcard. Declared above the call
 * below rather than beside `enable()`: the call runs at module load, and a
 * `const` it reads from further down the file is still in its temporal dead
 * zone -- which is the same dead import, one `ReferenceError` instead of one
 * `SyntaxError`.
 */
const metaRE = /[.+?^${}()|[\]\\]/g;

const matchers = enable(process.env.DEBUG);

export interface Matchers {
	allow: RegExp | string | null;
	ignore: RegExp | null;
}

/**
 * Generates regular expressions to match and allow or ignore log namespaces.
 * @param pattern - A pattern or list of patterns to generate matchers from.
 * @returns A map of allow and ignore matchers.
 */
export function enable(pattern: string | RegExp = ''): Matchers {
	let allow: RegExp | string | null = null;
	let ignore: RegExp | null = null;

	if (pattern === '*') {
		allow = '*';
	} else if (pattern instanceof RegExp) {
		allow = pattern;
	} else if (pattern) {
		const a: string[] = [];
		const i: string[] = [];

		for (const p of pattern.split(/[\s,]+/)) {
			const negated = p[0] === '-';
			const ns = negated ? p.slice(1) : p;
			if (ns) {
				// a namespace is a literal with `*` for a wildcard, so everything a
				// regular expression would have read as syntax is escaped before the
				// wildcard becomes one. `DEBUG='sigil.updates'` used to match
				// `sigilXupdates` as well, and `DEBUG='('` did not compile at all
				(negated ? i : a).push(ns.replace(metaRE, '\\$&').replace(/\*/g, '.*?'));
			}
		}

		try {
			if (a.length) {
				allow = new RegExp(`^(${a.join('|')})$`);
			} else if (i.length) {
				// nothing named but something excluded means everything else
				allow = /./;
			}

			if (i.length) {
				ignore = new RegExp(`^(${i.join('|')})$`);
			}
		} catch {
			// this runs at module load and every importer of the library is behind
			// it, so a pattern that will not compile has to end here rather than as a
			// `SyntaxError` thrown before `main()` exists to turn it into a message.
			// Escaping leaves little that can reach this -- a pattern too large to
			// compile is about all of it -- and logging off is the answer either way
			allow = null;
			ignore = null;
		}
	}

	return { allow, ignore };
}

/**
 * Determines whether a namespace should be logged.
 * @param ns - The namespace to test.
 * @param matchers - The allow and ignore matchers to test against; defaults to
 * the ones `DEBUG` produced, and is a parameter so the pattern language can be
 * exercised without reloading the module.
 * @returns `true` if the namespace is enabled.
 */
export function isEnabled(ns: string | undefined, { allow, ignore }: Matchers = matchers): boolean {
	if (allow === null) {
		// all logging is silenced
		return false;
	}

	if (!ns || allow === '*') {
		// nothing to filter
		return true;
	}

	if (allow instanceof RegExp && allow.test(ns) && (!ignore || !ignore.test(ns))) {
		return true;
	}

	return false;
}
