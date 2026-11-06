import { groupMultiselect } from '@ttylabs/sigil/components';

const stack = await groupMultiselect({
  message: 'Stack',
  choices: {
    Frontend: ['React', 'Vue', 'Svelte'],
    Backend: ['Express', 'Fastify'],
    Tooling: ['CI', { label: 'Linting', hint: 'oxlint' }],
  },
});

console.log(`Using ${stack.join(', ')}`);
