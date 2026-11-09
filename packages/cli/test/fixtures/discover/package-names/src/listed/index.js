const extra = ['ls'];

// the name is in the source, but one alias is not
export default { name: 'listed', alias: ['li', ...extra], run() {} };
