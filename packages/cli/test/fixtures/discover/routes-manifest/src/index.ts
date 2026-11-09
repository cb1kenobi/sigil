// a routed directory's commands.json describes and aliases its commands
// without loading a module, and the build bakes what it says (SIG-324)
export default {
  name: 'routes-manifest',
  baseDir: import.meta.dirname,
  commands: './commands',
};
