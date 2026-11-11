// The settings screen's schema, which `sigil build` compiles into
// `dist/settings.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it. A `run` on the schema is what a
// single-command app does when argv names no command, so `settings` opens the
// screen and `settings --help` is still a CLI's help.
//
// The mouse is on, because a settings screen is clicked as often as it is
// typed at: a checkbox, a radio option, a section in the sidebar, a slider's
// track. `runApp()` leaves it off unless asked.
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';

export default {
  name: 'settings',
  desc: 'A settings screen and a login form',

  async run(): Promise<void> {
    process.exitCode = await runApp(App, { mouse: true, sheets: [stylesheet] }).exited;
  },
};
