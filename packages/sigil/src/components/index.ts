// `@ttylabs/sigil/components`: the union of the component subpaths, and the
// theme the components are drawn with.
//
// What each subpath exports is written once, in `subpaths/<name>.ts`, and is
// what the barrel exports from that module -- no more, since a module's other
// exports are what its siblings share and are not published. This file says
// only that the barrel is all of them, so the two cannot disagree about a
// name; a name two subpaths both export is a type error here rather than one
// that silently drops out of the barrel. `test/component-subpaths.test.ts`
// holds the list to the directory. See "A subpath per component" in AGENTS.md.
export * from './subpaths/catalog.js';
export * from './subpaths/fuzzy.js';
export * from './subpaths/autocomplete.js';
export * from './subpaths/palette.js';
export * from './subpaths/calendar.js';
export * from './subpaths/color-level.js';
export * from './subpaths/date.js';
export * from './subpaths/editor.js';
export * from './subpaths/group.js';
export * from './subpaths/group-multiselect.js';
export * from './subpaths/list.js';
export * from './subpaths/masked-text.js';
export * from './subpaths/number.js';
export * from './subpaths/outline.js';
export * from './subpaths/paginator.js';
export * from './subpaths/sort.js';
export * from './subpaths/toggle.js';
export * from './subpaths/tree.js';
export * from './subpaths/select-key.js';
export * from './subpaths/path.js';
export * from './subpaths/file-picker.js';
export * from './subpaths/prompt.js';
export * from './subpaths/key-help.js';
export * from './subpaths/mount.js';
export * from './subpaths/progress.js';
export * from './subpaths/log-stream.js';
export * from './subpaths/chart.js';
export * from './subpaths/clock.js';
export * from './subpaths/multi-progress.js';
export * from './subpaths/log.js';
export * from './subpaths/spinner.js';
export * from './subpaths/tasks.js';
export * from './subpaths/keys.js';
export * from './subpaths/owned-hooks.js';
export * from './subpaths/qrcode.js';
export * from './subpaths/image.js';
export * from './subpaths/console-capture.js';
export * from './subpaths/debug-overlay.js';
export * from './subpaths/editing.js';
export * from './subpaths/decrypt.js';
export * from './subpaths/collapsible.js';
export * from './subpaths/tabs.js';
export * from './subpaths/modal.js';
export * from './subpaths/text-field.js';
export * from './subpaths/toast.js';
export * from './subpaths/tooltip.js';
export * from './subpaths/scroll-box.js';
export * from './subpaths/list-view.js';
export * from './subpaths/pager.js';
export * from './subpaths/typewriter.js';
export * from './subpaths/large-text.js';
export * from './subpaths/badge.js';
export * from './subpaths/table.js';
export * from './subpaths/select-row.js';
export * from './subpaths/border-label.js';
export * from './subpaths/pane.js';
export * from './subpaths/panel.js';
export * from './subpaths/note.js';
export * from './subpaths/diff.js';
export * from './subpaths/rule.js';
export * from './subpaths/markdown-parse.js';
export * from './subpaths/markdown.js';
export * from './subpaths/control.js';
export * from './subpaths/button.js';
export * from './subpaths/checkbox.js';
export * from './subpaths/radio-set.js';
export * from './subpaths/slider.js';
export * from './subpaths/switch.js';
export {
  FRAMEWORK_CSS,
  frameworkSheet,
  parseTheme,
  type StyledOptions,
  type ThemeOptions,
  themedCascade,
} from '../theme/index.js';
