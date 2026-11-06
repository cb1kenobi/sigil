import { diff } from '@ttylabs/sigil/components';

console.log(
  diff({
    old: 'const retries = 3;\nrun(env);\n',
    new: 'const retries = 5;\nrun(env);\n',
  })
);
