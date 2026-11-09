import { select } from '@ttylabs/sigil/components/prompt';

const template = await select({
  message: 'Template',
  choices: [
    { label: 'cli', value: 'cli', hint: 'a parser and two commands' },
    { label: 'full-screen', value: 'app', hint: 'layout, focus and input' },
    { label: 'prompts only', value: 'prompts' },
  ],
});

console.log(`Scaffolding the ${template} template`);
