import { log, select } from '@ttylabs/sigil/components';

const region = await select({
  message: 'Region',
  choices: ['us-east-1', 'eu-west-1', 'ap-south-1'],
  signal: AbortSignal.timeout(10_000),
}).catch((error) => {
  if (error.name !== 'TimeoutError') {
    throw error;
  }
  log.warn('No answer, using us-east-1');
  return 'us-east-1';
});

log.success(`Deploying to ${region}`);
