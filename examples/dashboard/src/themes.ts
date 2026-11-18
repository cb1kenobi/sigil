/**
 * Light and dark, and the terminal's own.
 *
 * `System` is no theme sheet at all: the framework's roles over whatever the
 * terminal draws with, light or dark as it reports. `Light` and `Dark` are the
 * app saying which it is, so they paint their own background rather than
 * trusting the terminal's -- a light theme over a black terminal is what the
 * user asked for, and the only way to get it is to fill the screen. Painting a
 * background is what makes the choice the app's to state, which is the reason
 * `@media (prefers-color-scheme)` is not used here: that asks what the
 * *terminal* is, and these sheets are an answer that does not depend on it.
 *
 * Each sheet sets every role, because a role it left out would fall back to the
 * framework's default for whatever scheme the terminal reported -- a dim grey
 * meant for a black background, drawn on a white one. And each fills the
 * overlays: a menu, a toast or a dialog is drawn on the root with blank cells in
 * the terminal's own colours, which would punch a black hole in a white screen.
 *
 * Truecolor throughout, since an app's own theme may use it and a terminal with
 * fewer colours gets the nearest the degradation finds. Swapped with
 * `app.setTheme()`, which replaces the sheet in place, so neither has to undo
 * what the other set.
 */

/** A theme the menu and `t` offer: its name, and the sheet, or none for the terminal's own. */
export interface ThemeChoice {
  readonly css: string | undefined;
  readonly id: 'dark' | 'light' | 'system';
  readonly label: string;
}

/** One palette, as the rules a theme sheet needs. */
interface Palette {
  readonly accent: string;
  readonly background: string;
  readonly border: string;
  readonly error: string;
  readonly field: string;
  readonly foreground: string;
  readonly info: string;
  readonly muted: string;
  readonly raised: string;
  readonly success: string;
  readonly warn: string;
}

/**
 * The sheet for a palette.
 *
 * `.sigil-app` is the runner's root, so its colours reach every element and every
 * overlay, which are drawn on that root too. A panel's border is the one colour
 * here that is not a role: a border is chrome, and a role on the panel would
 * colour what is inside it.
 *
 * @param p - The palette.
 * @returns The theme's source.
 */
function sheet(p: Palette): string {
  return `
.sigil-app { background-color: ${p.background}; color: ${p.foreground} }
.sigil-accent { color: ${p.accent} }
.sigil-muted { color: ${p.muted}; dim: false }
.sigil-heading { color: ${p.foreground}; font-weight: bold }
.sigil-success { color: ${p.success}; border-color: ${p.success} }
.sigil-error { color: ${p.error}; border-color: ${p.error} }
.sigil-warn { color: ${p.warn}; border-color: ${p.warn} }
.sigil-info { color: ${p.info}; border-color: ${p.info} }
.sigil-panel { border-color: ${p.border} }
.sigil-text-field { background-color: ${p.field} }
.sigil-scroll-track { color: ${p.border} }
.sigil-menu-fill { background-color: ${p.raised} }
.sigil-modal-fill { background-color: ${p.raised} }
.sigil-toast-fill { background-color: ${p.raised} }
.sigil-tooltip-fill { background-color: ${p.raised} }
.sigil-menu { border-color: ${p.border} }
.sigil-modal { border-color: ${p.border} }
`;
}

/** Ink on paper: a white page, near-black text, and the roles darkened to read on it. */
export const LIGHT: string = sheet({
  accent: '#0f766e',
  background: '#ffffff',
  border: '#d4d4d8',
  error: '#dc2626',
  field: '#f4f4f5',
  foreground: '#18181b',
  info: '#2563eb',
  muted: '#71717a',
  raised: '#fafafa',
  success: '#15803d',
  warn: '#b45309',
});

/** The same, inverted: near-black, off-white text, and the roles lightened. */
export const DARK: string = sheet({
  accent: '#2dd4bf',
  background: '#09090b',
  border: '#3f3f46',
  error: '#f87171',
  field: '#27272a',
  foreground: '#fafafa',
  info: '#60a5fa',
  muted: '#a1a1aa',
  raised: '#18181b',
  success: '#4ade80',
  warn: '#fbbf24',
});

/** What `t` cycles through and the menu lists, in that order. */
export const THEMES: readonly ThemeChoice[] = [
  { css: undefined, id: 'system', label: 'System' },
  { css: LIGHT, id: 'light', label: 'Light' },
  { css: DARK, id: 'dark', label: 'Dark' },
];
