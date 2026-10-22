/** A command one level down, with an argument and a valued option of its own. */
export default {
  args: ['<what>'],
  desc: 'A nested command',
  options: { '--deep [how]': { desc: 'How deep' } },
  run: () => undefined,
};
