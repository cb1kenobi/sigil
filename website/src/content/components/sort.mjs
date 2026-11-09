import { sort } from '@ttylabs/sigil/components/sort';

const order = await sort({
  message: 'Release order',
  choices: ['parser', 'renderer', 'prompts', 'toolchain'],
});

console.log(order.join(' -> '));
