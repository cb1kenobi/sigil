// the const is handed to a call, which may do anything to it (SIG-440): the app
// runs `b.js`
const pathed = { path: './commands/a.js' };
Object.assign(pathed, { path: './commands/b.js' });
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...pathed, name: 'x' },
  },
};
