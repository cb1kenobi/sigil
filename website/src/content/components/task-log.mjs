import { taskLog } from '@ttylabs/sigil/components/tasks';

const log = taskLog({ title: 'npm test', limit: 4 });

for (const line of ['parser: 212 passed', 'renderer: 96 passed', 'prompts: running']) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  log.message(line);
}
