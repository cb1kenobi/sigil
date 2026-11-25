// a function that closes over the const writes to it (SIG-440): the app runs `b.js`
const loaded = { load: () => import('./commands/a.js') };
function retarget() {
  loaded.load = () => import('./commands/b.js');
}
retarget();
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...loaded, name: 'x' },
  },
};
