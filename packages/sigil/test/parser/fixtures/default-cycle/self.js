import { bound } from './bound.js';

export default {
  commands: { again: { default: true, load: () => import('./self.js') } },
  hooks: bound,
};
