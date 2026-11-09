import { log } from '@ttylabs/sigil/components/log';

log.step('Deploying to staging');
log.info('Using the lockfile from the last run', { packages: 42 });
log.success('Migrations applied');
log.warn('The cache is 3 days old');
log.error('eu-west-1 timed out', { after: '30s' });
