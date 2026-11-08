import { runApp } from '@ttylabs/sigil/app';
import { attachTooltip } from '@ttylabs/sigil/components/tooltip';
import { box, text } from '@ttylabs/sigil/element';

const deploy = text(' Deploy ', { focusable: true, class: 'button' });
const app = runApp(() => box({ 'flex-direction': 'column', height: 6 }, deploy), {
  sheets: ['.button:focus { inverse: true }'],
});

attachTooltip(deploy, { input: app.input, text: 'Ships the main branch to staging' });

process.exitCode = await app.exited;
