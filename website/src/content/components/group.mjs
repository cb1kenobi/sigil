import { group, intro, outro } from '@ttylabs/sigil/components/group';
import { select, text } from '@ttylabs/sigil/components/prompt';

intro('create-app');

const answers = await group({
  name: () => text({ message: 'Project name' }),
  template: ({ name }) =>
    select({ message: `Template for ${name}`, choices: ['cli', 'full-screen', 'prompts only'] }),
});

outro(`Created ${answers.name} from ${answers.template}`);
