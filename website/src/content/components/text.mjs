import { text } from '@ttylabs/sigil/components/prompt';

const name = await text({
  message: 'Project name',
  placeholder: 'my-app',
  validate: (value) => (/^[a-z][a-z0-9-]*$/.test(value) ? undefined : 'Use lower case and dashes'),
});

console.log(`Creating ${name}`);
