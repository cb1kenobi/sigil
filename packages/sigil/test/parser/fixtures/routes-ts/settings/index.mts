type Mode = 'on' | 'off';
const mode: Mode = 'on';
export default { desc: `settings are ${mode}`, run: (): string => 'settings' };
