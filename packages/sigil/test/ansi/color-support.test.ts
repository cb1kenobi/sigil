import { supportsColor } from '../../src/ansi/color-support.js';
import { describe, expect, it } from 'vitest';

/**
 * `supportsColor()` with nothing assumed: an empty environment, a stream that
 * is a terminal unless the test says otherwise, and a platform that is not
 * Windows.
 */
function detect(env: Record<string, string | undefined> = {}, isTTY = true) {
	return supportsColor({ env, isTTY, platform: 'linux' });
}

describe('FORCE_COLOR', () => {
	it('should force a level even without a terminal', () => {
		expect(detect({ FORCE_COLOR: '1' }, false)).toBe(1);
		expect(detect({ FORCE_COLOR: '2' }, false)).toBe(2);
		expect(detect({ FORCE_COLOR: '3' }, false)).toBe(3);
	});

	it('should read the word forms and the empty string', () => {
		expect(detect({ FORCE_COLOR: 'true' }, false)).toBe(1);
		expect(detect({ FORCE_COLOR: '' }, false)).toBe(1);
		expect(detect({ FORCE_COLOR: 'false' })).toBe(0);
		expect(detect({ FORCE_COLOR: '0' })).toBe(0);
	});

	it('should clamp a level above the highest', () => {
		expect(detect({ FORCE_COLOR: '9' }, false)).toBe(3);
	});

	it('should treat an unparseable value as a request for color', () => {
		expect(detect({ FORCE_COLOR: 'yes' }, false)).toBe(1);
	});

	// forcing color through a pipe is the whole point of the variable, and a
	// NO_COLOR exported once in a shell profile should not be unoverridable
	it('should win over NO_COLOR', () => {
		expect(detect({ FORCE_COLOR: '3', NO_COLOR: '1' }, false)).toBe(3);
		expect(detect({ FORCE_COLOR: '0', NO_COLOR: '1' })).toBe(0);
	});

	it('should win over TERM=dumb', () => {
		expect(detect({ FORCE_COLOR: '2', TERM: 'dumb' })).toBe(2);
	});
});

describe('NO_COLOR', () => {
	it('should disable color when set to anything but empty', () => {
		expect(detect({ NO_COLOR: '1', TERM: 'xterm-256color' })).toBe(0);
		expect(detect({ NO_COLOR: 'anything', TERM: 'xterm-256color' })).toBe(0);
	});

	// the convention is that an empty value is the same as unset, so that
	// `NO_COLOR=` can turn it back off
	it('should be ignored when set to the empty string', () => {
		expect(detect({ NO_COLOR: '', TERM: 'xterm-256color' })).toBe(2);
	});
});

describe('terminal detection', () => {
	it('should disable color when the destination is not a terminal', () => {
		expect(detect({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, false)).toBe(0);
	});

	it('should disable color for a dumb terminal', () => {
		expect(detect({ TERM: 'dumb', COLORTERM: 'truecolor' })).toBe(0);
	});

	it('should read COLORTERM for truecolor', () => {
		expect(detect({ COLORTERM: 'truecolor' })).toBe(3);
		expect(detect({ COLORTERM: '24bit' })).toBe(3);
		expect(detect({ COLORTERM: 'something' })).toBe(1);
	});

	it('should read TERM_PROGRAM', () => {
		expect(detect({ TERM_PROGRAM: 'iTerm.app' })).toBe(3);
		expect(detect({ TERM_PROGRAM: 'vscode' })).toBe(3);
		expect(detect({ TERM_PROGRAM: 'WezTerm' })).toBe(3);
		expect(detect({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(2);
	});

	it('should read TERM', () => {
		expect(detect({ TERM: 'xterm-256color' })).toBe(2);
		expect(detect({ TERM: 'screen-256color' })).toBe(2);
		expect(detect({ TERM: 'xterm' })).toBe(2);
		expect(detect({ TERM: 'alacritty' })).toBe(2);
		expect(detect({ TERM: 'rxvt-unicode' })).toBe(2);
		expect(detect({ TERM: 'ansi' })).toBe(1);
		expect(detect({ TERM: 'linux' })).toBe(1);
		expect(detect({ TERM: 'sun-color' })).toBe(1);
	});

	// the `-direct` terminfo entries are the direct-color ones
	it('should give a -direct terminal truecolor', () => {
		expect(detect({ TERM: 'xterm-direct' })).toBe(3);
		expect(detect({ TERM: 'xterm-direct2' })).toBe(3);
		expect(detect({ TERM: 'konsole-direct' })).toBe(3);
	});

	it('should give up on a terminal it does not recognize', () => {
		expect(detect({ TERM: 'nethack3000' })).toBe(0);
		expect(detect({})).toBe(0);
	});

	it('should assume Windows can do at least 256 colors', () => {
		expect(supportsColor({ env: {}, isTTY: true, platform: 'win32' })).toBe(2);
		expect(supportsColor({ env: { WT_SESSION: '1' }, isTTY: true, platform: 'win32' })).toBe(3);
		expect(supportsColor({ env: {}, isTTY: false, platform: 'win32' })).toBe(0);
	});
});

describe('CI', () => {
	it('should give GitHub Actions truecolor', () => {
		expect(detect({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(3);
		expect(detect({ CI: 'true', GITEA_ACTIONS: 'true' })).toBe(3);
	});

	it('should give any other CI the basic 16', () => {
		expect(detect({ CI: 'true' })).toBe(1);
		expect(detect({ TEAMCITY_VERSION: '2024.1' })).toBe(1);
	});

	it('should not read CI for something that is not a terminal', () => {
		expect(detect({ CI: 'true' }, false)).toBe(0);
	});
});

describe('defaults', () => {
	it('should read the stream rather than assume a terminal', () => {
		const env = { TERM: 'xterm-256color' };
		expect(supportsColor({ env, platform: 'linux', stream: { isTTY: true } })).toBe(2);
		expect(supportsColor({ env, platform: 'linux', stream: { isTTY: false } })).toBe(0);
		expect(supportsColor({ env, platform: 'linux', stream: undefined })).toBe(0);
	});

	it('should let isTTY override the stream', () => {
		expect(
			supportsColor({
				env: { TERM: 'xterm-256color' },
				isTTY: true,
				platform: 'linux',
				stream: { isTTY: false },
			})
		).toBe(2);
	});
});
