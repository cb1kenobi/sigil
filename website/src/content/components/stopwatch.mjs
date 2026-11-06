import { mountLive, stopwatch } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';

const watch = stopwatch().start();
const frame = mountLive(() => box({}, text('Installing', { 'margin-right': 1 }), watch.view()));

await new Promise((resolve) => setTimeout(resolve, 5_000));
frame.stop();
