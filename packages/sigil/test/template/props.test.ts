import { COLOR_PROPERTIES } from '../../src/style/index.js';
import { COLOR_PROP_NAMES } from '../../src/template/props.js';
import { describe, expect, it } from 'vitest';

describe('the host prop types', () => {
	it('should name the same colour properties the table does', () => {
		// the one list in `props.ts` that is written rather than derived, because
		// `Color` is `number` and a conditional type cannot tell a colour from a
		// padding. Written means it can drift, so this is what says it has not:
		// a fourth colour property would otherwise take `number | string` and
		// `color={39}` would type-check while `parseColor()` refuses it
		expect([...COLOR_PROP_NAMES].sort()).toEqual([...COLOR_PROPERTIES].sort());
	});
});
