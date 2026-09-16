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

const { allow, ignore } = enable(process.env.DEBUG);

/**
 * Generates regular expressions to match and allow or ignore log namespaces.
 * @param pattern - A pattern or list of patterns to generate matchers from.
 * @returns A map of allow and ignore matchers.
 */
function enable(pattern: string | RegExp = '') {
	let allow: RegExp | string | null = null;
	let ignore: RegExp | null = null;

	if (pattern === '*') {
		allow = '*';
	} else if (pattern instanceof RegExp) {
		allow = pattern;
	} else if (pattern) {
		const a: string[] = [];
		const i: string[] = [];

		for (let p of pattern.split(/[\s,]+/)) {
			if (p) {
				p = p.replace(/\*/g, '.*?');
				if (p[0] === '-') {
					i.push(p.slice(1));
				} else {
					a.push(p);
				}
			}
		}

		if (a.length) {
			allow = new RegExp(`^(${a.join('|')})$`);
		} else {
			allow = /./;
		}

		if (i.length) {
			ignore = new RegExp(`^(${i.join('|')})$`);
		}
	}

	return { allow, ignore };
}

function isEnabled(ns: string | undefined): boolean {
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
