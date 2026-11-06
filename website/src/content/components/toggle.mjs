import { toggle } from '@ttylabs/sigil/components';

const telemetry = await toggle({ message: 'Telemetry', active: 'on', inactive: 'off' });

console.log(`Telemetry is ${telemetry ? 'on' : 'off'}`);
