import { decrypt, seeded } from '@ttylabs/sigil/components';

await decrypt('Setec Astronomy: too many secrets', { random: seeded(1989) });
