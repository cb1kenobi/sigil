import { main } from '@ttylabs/sigil';
await main({
	schema: {
		name: 'inline-app',
		commands: {
			// the `.js` specifier resolves to the `.ts` beside it
			build: { desc: 'build it', load: () => import('./commands/build.js') },
			db: {
				commands: { migrate: { load: () => import('./commands/migrate.js') } },
			},
			inline: { desc: 'declared here, no module', run: () => 'ran' },
			missing: { load: () => import('./commands/nope.js') },
		},
	},
});
