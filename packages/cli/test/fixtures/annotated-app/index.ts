// What each command does is declared in its module, which is what reaches a
// built app: a placeholder's annotations are not carried by the build (SIG-718).
import type { Schema } from '@ttylabs/sigil';

const schema: Schema = {
  name: 'annotated-app',
  baseDir: import.meta.dirname,
  commands: './commands',
};

export default schema;
