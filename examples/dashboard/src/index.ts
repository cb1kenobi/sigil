// The dashboard's schema, which `sigil build` compiles into `dist/dashboard.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it. A `run` on the schema is what a
// single-command app does when argv names no command, so `dashboard` opens the
// screen and `dashboard --help` is still a CLI's help.
//
// The mouse is on, because a dashboard is clicked as often as it is typed at: a
// page in the sidebar, a range, a heading to sort by, a row to tick, a button.
// `runApp()` leaves it off unless asked. With motion, so the chart's crosshair
// can follow the pointer with no button held, which costs a report for every
// cell the pointer crosses.
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';

export default {
  name: 'dashboard',
  desc: 'A dashboard: cards, a chart over a range, and a table of projects',

  async run(): Promise<void> {
    process.exitCode = await runApp(App, { mouse: { motion: true }, sheets: [stylesheet] }).exited;
  },
};
