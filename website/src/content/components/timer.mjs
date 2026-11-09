import { timer } from '@ttylabs/sigil/components/clock';
import { mountLive } from '@ttylabs/sigil/components/mount';
import { box, text } from '@ttylabs/sigil/element';

const countdown = timer(3_000, { format: 'clock' }).start();
const frame = mountLive(() =>
  box({}, text('Deploying in', { 'margin-right': 1 }), countdown.view())
);

const ran = await countdown.done;
frame.stop();
console.log(ran ? 'Deployed' : 'Cancelled');
