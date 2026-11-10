import { runApp } from '@ttylabs/sigil/app';
import { Switch } from '@ttylabs/sigil/components/switch';

const app = runApp(() => Switch({ label: 'Notifications' }));

process.exitCode = await app.exited;
