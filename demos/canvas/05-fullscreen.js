/**
 * A canvas that is the whole screen, and gives it back.
 *
 *   node demos/canvas/05-fullscreen.js
 *
 * The alternate screen buffer has no scrollback of its own, so a full-screen app
 * costs the user nothing: what was in the terminal before is still there
 * afterwards, exactly as it was. That only holds if the switch back is
 * guaranteed -- a CLI that dies on the alternate buffer and never comes back has
 * eaten the terminal -- so leaving it is `Terminal.restore()`'s, next to the
 * cursor and raw mode, and it runs on a signal, on `exit`, and on the way out of
 * an uncaught throw. Press Ctrl-C and see.
 *
 * `write()` has nowhere to go here: there is no log above a screen with no
 * scrollback. The line is held and written to the main screen on the way out,
 * which is where its reader is.
 */
import { createFullscreenCanvas, palette, rgb } from '@ttylabs/sigil/canvas';

const backend = createFullscreenCanvas();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

backend.write('this was written while the app was full screen');

for (let frame = 0; frame < 40; frame++) {
	backend.render((p, canvas) => {
		p.text(1, 1, 'a full-screen canvas', { fg: palette(6) });
		p.text(1, 2, `${canvas.width}x${canvas.height} — resize the window and watch`, {
			fg: palette(8),
		});

		for (let x = 0; x < canvas.width; x++) {
			const t = (x + frame) / 6;
			const y = Math.round((Math.sin(t) * 0.5 + 0.5) * (canvas.height - 6)) + 4;
			// the ramp is a fraction of the width rather than `200 - x`, which went
			// negative past column 200 -- and `rgb()` refuses a channel out of range
			// rather than clamping it, which is the right answer and was a crash on
			// any terminal wider than that
			const fade = Math.round(255 * (1 - x / Math.max(1, canvas.width - 1)));
			p.text(x, y, '•', { fg: rgb(120, fade, 255) });
		}

		p.text(1, canvas.height - 1, 'Ctrl-C, or wait, and your log comes back', { fg: palette(8) });
	});

	await sleep(80);
}

backend.done();
console.log('and here is your terminal, exactly as you left it');
