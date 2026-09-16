export default {
	hooks: {
		init: [
			() => {
				throw new Error('init hook blew up');
			},
		],
	},
};
