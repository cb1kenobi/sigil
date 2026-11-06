import { group, intro, outro, select, text } from '@ttylabs/sigil/components';

intro('create-app');

const answers = await group({
  name: () => text({ message: 'Project name' }),
  template: ({ name }) =>
    select({ message: `Template for ${name}`, choices: ['cli', 'full-screen', 'prompts only'] }),
});

outro(`Created ${answers.name} from ${answers.template}`);
