// a routed module's own `name`, `alias` and `default` route nothing, because
// the module is read only after argv has matched the name it is routed by
export default {
  name: 'module-routing',
  baseDir: import.meta.dirname,
  commands: './commands',
};
