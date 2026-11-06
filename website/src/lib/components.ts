/**
 * The components: what `/docs/components` lists and what each page is about.
 *
 * ## What counts as a component
 *
 * **A component is an export of `@ttylabs/sigil/components` that a program calls
 * to ask something or to draw something**: a prompt, a function that returns or
 * prints styled text, a live object that draws while work runs (a spinner, a
 * bar), or an element for a full-screen app. Its other forms -- the `View` that
 * returns the same thing as an element, the `State` behind it, the companion
 * that wires its keys into a router -- are on the same page, and are listed in
 * its `exports`.
 *
 * Everything else the barrel exports is a **helper**: the pieces a prompt of
 * your own is built from, the line editor, fuzzy matching, the parsers and
 * encoders under a component, formatting, glyph sets and the theme. Those are
 * listed in `HELPERS` under the reason they are not components.
 *
 * `test/components.test.ts` holds the barrel to exactly those two lists: an
 * export that is in neither fails it, so a new component cannot ship without a
 * page and a new helper cannot ship without somebody deciding it is one. The
 * repository's own signal table (`prompt-signal.test.ts`) decides "is a prompt"
 * from the type instead, and could, because that is a property of a signature;
 * "draws something worth a page" is not, so here it is a list with a reason.
 *
 * ## What is not written here
 *
 * Anything the code already says. The options and their types are read from the
 * declarations; the output is captured by running the example; whether a
 * component has an accessible line form and takes an `AbortSignal` is whether
 * its options have `accessible` and `signal`; the description of a component
 * that is a file of its own is the one `sigil add` lists for that file. What is
 * here is the family, the example's keys, and the words for components that
 * share a file with others.
 *
 * Imported by the client (the sidebar), so nothing here reads a file.
 */

/** The three families, in the order the index shows them. */
export const FAMILIES = [
  { id: 'prompts', title: 'Prompts', blurb: 'Ask one question and resolve to the answer.' },
  { id: 'output', title: 'Output', blurb: 'Report what a command is doing.' },
  {
    id: 'fullscreen',
    title: 'Full-screen',
    blurb: 'Elements for apps that own the whole terminal.',
  },
] as const;

export type FamilyId = (typeof FAMILIES)[number]['id'];

/**
 * One thing an example's capture does once it has drawn: a key by its name in
 * `KEYS` from `@ttylabs/sigil/testing` (or `ctrlC`), text typed as one read, or
 * time let pass on the capture's clock.
 */
export type Step =
  | 'backspace'
  | 'ctrlC'
  | 'delete'
  | 'down'
  | 'end'
  | 'enter'
  | 'escape'
  | 'home'
  | 'left'
  | 'pageDown'
  | 'pageUp'
  | 'right'
  | 'shiftTab'
  | 'space'
  | 'tab'
  | 'up'
  | { readonly text: string }
  | { readonly wait: number };

/** How a component's example is run for its captures. */
export interface Example {
  /** What is done once it has drawn, for the rendered and 40-column views. */
  readonly steps?: readonly Step[];
  /** The same for the accessible view, which is answered by typing a line. */
  readonly accessibleSteps?: readonly Step[];
  /** What the caption under the views says the steps were, after "The prompt ...". */
  readonly caption?: string;
  /** Where it is run, from the repository root, when not the example project. */
  readonly cwd?: string;
  /** Rows of the screen, for an example taller than 24. */
  readonly rows?: number;
  /** `false` to list no keys, for an example whose keys hand the terminal to something else. */
  readonly probe?: false;
}

/** A recipe on a component's page: one more example, beside its output. */
export interface Recipe {
  /** The heading's anchor. */
  readonly id: string;
  readonly title: string;
  /** What it is for, a sentence or two. */
  readonly body: string;
  /** The example file in `src/content/components/`, without `.mjs`. */
  readonly file: string;
  /** What the shell line over its output says was run. */
  readonly command: string;
  readonly steps?: readonly Step[];
}

export interface ComponentEntry {
  /** The page's address under `/docs/components/`, and the example's file name. */
  readonly slug: string;
  /** What the card and the page call it: `select()`, `log`, `Tabs`. */
  readonly name: string;
  readonly family: FamilyId;
  /** The exports its page is about, the component itself first. */
  readonly exports: readonly string[];
  /** The `sigil add` entry it is copied in with, when it has one. */
  readonly registry?: string;
  /**
   * One sentence. Left out for a component that is the whole of its `sigil add`
   * entry, whose description is that entry's.
   */
  readonly description?: string;
  /** A sentence or two more for the page's lede, after the description. */
  readonly lede?: string;
  readonly example?: Example;
  readonly recipes?: readonly Recipe[];
  /** Siblings to link from the page, by slug; the rest of the family by default. */
  readonly related?: readonly string[];
}

/** Every component, by family, in the order each family lists them. */
export const COMPONENTS: readonly ComponentEntry[] = [
  // ---------------------------------------------------------------- prompts
  {
    slug: 'text',
    name: 'text()',
    family: 'prompts',
    exports: ['text'],
    registry: 'prompt',
    description: 'One line of text, with a default, a placeholder and validation.',
    example: { steps: [{ text: 'ledger' }], accessibleSteps: [{ text: 'ledger' }, 'enter'] },
  },
  {
    slug: 'password',
    name: 'password()',
    family: 'prompts',
    exports: ['password'],
    registry: 'prompt',
    description: 'Text that is never shown as it is typed, for a token or a passphrase.',
    example: { steps: [{ text: 'hunter22' }], accessibleSteps: [{ text: 'hunter22' }, 'enter'] },
  },
  {
    slug: 'number',
    name: 'number()',
    family: 'prompts',
    exports: ['number'],
    registry: 'number',
    example: { steps: ['up', 'up'], accessibleSteps: ['backspace', { text: '5' }, 'enter'] },
  },
  {
    slug: 'masked-text',
    name: 'maskedText()',
    family: 'prompts',
    exports: ['maskedText'],
    registry: 'masked-text',
    example: { steps: [{ text: '612555' }], accessibleSteps: [{ text: '6125550142' }, 'enter'] },
  },
  {
    slug: 'multiline',
    name: 'multiline()',
    family: 'prompts',
    exports: ['multiline'],
    registry: 'prompt',
    description: 'Several lines of text, for a commit message or anything longer than a line.',
    example: {
      steps: [{ text: 'Sort help by code unit' }, 'enter', { text: 'so it is stable' }],
      // Ctrl-D, which is what submits
      accessibleSteps: [{ text: 'Sort help by code unit' }, 'enter', { text: '\u0004' }],
    },
  },
  {
    slug: 'autocomplete',
    name: 'autocomplete()',
    family: 'prompts',
    exports: ['autocomplete'],
    registry: 'autocomplete',
    description: 'Type to narrow a list, or to search a source that answers as you type.',
    example: { steps: [{ text: 'eu' }], accessibleSteps: [{ text: 'eu' }, 'enter'] },
  },
  {
    slug: 'autocomplete-multiselect',
    name: 'autocompleteMultiselect()',
    family: 'prompts',
    exports: ['autocompleteMultiselect'],
    registry: 'autocomplete',
    description: 'Several choices from a list you filter by typing, ticks kept across filters.',
    example: {
      steps: [{ text: 're' }, 'space', 'down', 'space'],
      accessibleSteps: [{ text: 're' }, 'enter'],
    },
  },
  {
    slug: 'path',
    name: 'path()',
    family: 'prompts',
    exports: ['path'],
    registry: 'path',
    example: {
      steps: [{ text: 'src/c' }, 'tab'],
      accessibleSteps: [{ text: 'src/config.ts' }, 'enter'],
    },
  },
  {
    slug: 'file-picker',
    name: 'filePicker()',
    family: 'prompts',
    exports: ['filePicker'],
    registry: 'file-picker',
    example: { steps: ['enter', 'down'], accessibleSteps: [{ text: '1' }, 'enter'] },
  },
  {
    slug: 'date',
    name: 'date()',
    family: 'prompts',
    exports: ['date'],
    registry: 'date',
    example: { steps: ['right', 'up'], accessibleSteps: [{ text: '2026-11-20' }, 'enter'] },
  },
  {
    slug: 'pick-date',
    name: 'pickDate()',
    family: 'prompts',
    exports: ['pickDate'],
    description: 'A day picked from a month drawn as a calendar, with the arrows.',
    example: { steps: ['right', 'down'], accessibleSteps: [{ text: '2026-11-20' }, 'enter'] },
  },
  {
    slug: 'confirm',
    name: 'confirm()',
    family: 'prompts',
    exports: ['confirm'],
    registry: 'prompt',
    description: 'Yes or no, with the default in capitals.',
    example: { accessibleSteps: [{ text: 'y' }, 'enter'] },
  },
  {
    slug: 'toggle',
    name: 'toggle()',
    family: 'prompts',
    exports: ['toggle'],
    registry: 'toggle',
    example: { steps: ['right'], accessibleSteps: [{ text: 'on' }, 'enter'] },
  },
  {
    slug: 'select',
    name: 'select()',
    family: 'prompts',
    exports: ['select', 'separator'],
    registry: 'prompt',
    description: 'One choice from a list, answered with the arrow keys and Enter.',
    lede: 'The prompt resolves to the value of the choice, and settles to one line once it is answered.',
    example: {
      steps: ['down'],
      caption: 'after one press of the down arrow',
      accessibleSteps: [{ text: '2' }, 'enter'],
    },
    recipes: [
      {
        id: 'timeout',
        title: 'Use a default after a timeout',
        body: "A deploy script shouldn't wait forever for somebody who walked away. Give the prompt a signal, and fall back when it fires: the prompt rejects with the signal's own reason, a `TimeoutError`, and gives the screen back as a cancel does.",
        file: 'select-timeout',
        command: 'node deploy.mjs',
        steps: [{ wait: 10_000 }],
      },
    ],
    related: ['select-key', 'autocomplete', 'group'],
  },
  {
    slug: 'multiselect',
    name: 'multiselect()',
    family: 'prompts',
    exports: ['multiselect'],
    registry: 'prompt',
    description: 'Any number of choices from a list, ticked with Space.',
    example: {
      steps: ['space', 'down', 'down', 'space'],
      accessibleSteps: [{ text: '1, 3' }, 'enter'],
    },
  },
  {
    slug: 'group-multiselect',
    name: 'groupMultiselect()',
    family: 'prompts',
    exports: ['groupMultiselect'],
    registry: 'group-multiselect',
    example: { steps: ['down', 'space', 'down', 'down', 'down', 'space'] },
  },
  {
    slug: 'select-key',
    name: 'selectKey()',
    family: 'prompts',
    exports: ['selectKey'],
    registry: 'select-key',
    example: { accessibleSteps: [{ text: 's' }, 'enter'] },
  },
  {
    slug: 'select-row',
    name: 'selectRow()',
    family: 'prompts',
    exports: ['selectRow'],
    registry: 'select-row',
    example: { steps: ['down', 'down'] },
  },
  {
    slug: 'sort',
    name: 'sort()',
    family: 'prompts',
    exports: ['sort'],
    registry: 'sort',
    example: { steps: ['down', 'space', 'up'] },
  },
  {
    slug: 'list',
    name: 'list()',
    family: 'prompts',
    exports: ['list'],
    registry: 'list',
    example: {
      steps: [{ text: 'api, cli, docs' }],
      accessibleSteps: [{ text: 'api, cli' }, 'enter'],
    },
  },
  {
    slug: 'select-tree',
    name: 'selectTree()',
    family: 'prompts',
    exports: ['selectTree'],
    registry: 'tree',
    description: 'One item from a nested list whose branches open and close.',
    example: { steps: ['down', 'right', 'down'] },
  },
  {
    slug: 'directory-tree',
    name: 'directoryTree()',
    family: 'prompts',
    exports: ['directoryTree'],
    registry: 'tree',
    description: 'A file or a folder, from a tree of the file system read as it opens.',
    example: { steps: ['down', 'right', 'down'] },
  },
  {
    slug: 'command-palette',
    name: 'commandPalette()',
    family: 'prompts',
    exports: ['commandPalette'],
    registry: 'palette',
    example: { steps: [{ text: 'dep' }] },
  },
  {
    slug: 'editor',
    name: 'editor()',
    family: 'prompts',
    exports: ['editor'],
    registry: 'editor',
    // Enter hands the terminal to another program, which a capture cannot show
    example: { probe: false },
  },
  {
    slug: 'group',
    name: 'group()',
    family: 'prompts',
    exports: ['group', 'intro', 'outro', 'cancel'],
    registry: 'group',
    example: { steps: [{ text: 'ledger' }, 'enter'] },
  },

  // ----------------------------------------------------------------- output
  {
    slug: 'log',
    name: 'log',
    family: 'output',
    exports: ['log', 'createLog', 'logView'],
    registry: 'log',
  },
  {
    slug: 'spinner',
    name: 'createSpinner()',
    family: 'output',
    exports: ['createSpinner', 'spinnerView', 'spinnerState'],
    registry: 'spinner',
    example: { steps: [{ wait: 400 }] },
  },
  {
    slug: 'progress',
    name: 'createProgress()',
    family: 'output',
    exports: ['createProgress', 'progressView', 'progressState', 'trackProgress'],
    registry: 'progress',
    example: { steps: [{ wait: 1_200 }] },
  },
  {
    slug: 'multi-progress',
    name: 'createMultiProgress()',
    family: 'output',
    exports: ['createMultiProgress', 'multiProgressView'],
    registry: 'multi-progress',
    example: { steps: [{ wait: 1_000 }] },
  },
  {
    slug: 'tasks',
    name: 'tasks()',
    family: 'output',
    exports: ['tasks', 'skip'],
    registry: 'tasks',
    description: 'A list of work with a spinner on the running step and a line for each one done.',
    example: { steps: [{ wait: 1_500 }] },
  },
  {
    slug: 'task-log',
    name: 'taskLog()',
    family: 'output',
    exports: ['taskLog'],
    registry: 'tasks',
    description: "A subprocess's output in a window under a spinner, cleared when it succeeds.",
    example: { steps: [{ wait: 600 }] },
  },
  {
    slug: 'table',
    name: 'table()',
    family: 'output',
    exports: ['table', 'tableView', 'tableRowView'],
    registry: 'table',
  },
  {
    slug: 'badge',
    name: 'badge()',
    family: 'output',
    exports: ['badge', 'badgeView'],
    registry: 'badge',
  },
  {
    slug: 'note',
    name: 'note()',
    family: 'output',
    exports: ['note', 'noteView'],
    registry: 'note',
  },
  {
    slug: 'rule',
    name: 'rule()',
    family: 'output',
    exports: ['rule', 'ruleView'],
    registry: 'rule',
  },
  {
    slug: 'markdown',
    name: 'markdown()',
    family: 'output',
    exports: ['markdown', 'markdownView'],
    registry: 'markdown',
  },
  {
    slug: 'diff',
    name: 'diff()',
    family: 'output',
    exports: ['diff', 'diffView'],
    registry: 'diff',
  },
  {
    slug: 'outline',
    name: 'outline()',
    family: 'output',
    exports: ['outline', 'outlineView', 'createOutline'],
    registry: 'outline',
  },
  {
    slug: 'tree',
    name: 'tree()',
    family: 'output',
    exports: ['tree', 'treeView'],
    registry: 'tree',
    description: 'Nested data printed with ├── and └── guides, the way `tree` prints a folder.',
  },
  {
    slug: 'calendar',
    name: 'calendar()',
    family: 'output',
    exports: ['calendar', 'calendarView'],
    description: 'A month as a grid, with today, a selected day and highlighted days marked.',
  },
  {
    slug: 'sparkline',
    name: 'sparkline()',
    family: 'output',
    exports: ['sparkline', 'sparklineView'],
    registry: 'chart',
    description: 'A row of numbers as one line of block characters.',
  },
  {
    slug: 'bar-chart',
    name: 'barChart()',
    family: 'output',
    exports: ['barChart', 'barChartView'],
    registry: 'chart',
    description: 'Labelled values as horizontal or vertical bars.',
  },
  {
    slug: 'line-chart',
    name: 'lineChart()',
    family: 'output',
    exports: ['lineChart', 'lineChartView'],
    registry: 'chart',
    description: 'A series drawn in braille dots, with an axis.',
  },
  {
    slug: 'gauge',
    name: 'gauge()',
    family: 'output',
    exports: ['gauge', 'gaugeView'],
    registry: 'chart',
    description: 'One value against its range, coloured by the threshold it is past.',
  },
  {
    slug: 'page-indicator',
    name: 'pageIndicator()',
    family: 'output',
    exports: [
      'pageIndicator',
      'pageIndicatorView',
      'createPaginator',
      'paginatorView',
      'paginatorState',
    ],
    description: 'Which page of several this is, as dots or as numbers.',
  },
  {
    slug: 'stopwatch',
    name: 'stopwatch()',
    family: 'output',
    exports: ['stopwatch'],
    registry: 'clock',
    description: 'Time since a start, as a readout that ticks where it can draw.',
    example: { steps: [{ wait: 3_200 }] },
  },
  {
    slug: 'timer',
    name: 'timer()',
    family: 'output',
    exports: ['timer'],
    registry: 'clock',
    description: 'A countdown that resolves when it reaches zero, or says it was stopped.',
    example: { steps: [{ wait: 1_200 }] },
  },
  {
    slug: 'typewriter',
    name: 'createTypewriter()',
    family: 'output',
    exports: ['createTypewriter', 'typewriterView', 'typewriterReveal', 'typewriterState'],
    registry: 'typewriter',
    example: { steps: [{ wait: 600 }] },
  },
  {
    slug: 'decrypt',
    name: 'decrypt()',
    family: 'output',
    exports: ['decrypt', 'createDecrypt', 'decryptView', 'decryptReveal', 'decryptState'],
    registry: 'decrypt',
    example: { steps: [{ wait: 3_000 }] },
  },
  {
    slug: 'large-text',
    name: 'largeText()',
    family: 'output',
    exports: ['largeText', 'largeTextView'],
    registry: 'large-text',
    example: { cwd: 'demos/components/fonts' },
  },
  {
    slug: 'qrcode',
    name: 'qrcode()',
    family: 'output',
    exports: ['qrcode', 'qrcodeView'],
    registry: 'qrcode',
    example: { rows: 30 },
  },

  // ------------------------------------------------------------- fullscreen
  {
    slug: 'tabs',
    name: 'Tabs',
    family: 'fullscreen',
    exports: ['Tabs', 'describeTabs', 'tabRowView', 'tabsActive'],
    registry: 'tabs',
    example: { steps: ['tab', 'right'] },
  },
  {
    slug: 'scroll-box',
    name: 'ScrollBox',
    family: 'fullscreen',
    exports: ['ScrollBox', 'scrollControl'],
    registry: 'scroll-box',
    example: { steps: ['tab', 'pageDown'] },
  },
  {
    slug: 'collapsible',
    name: 'Collapsible',
    family: 'fullscreen',
    exports: ['Collapsible', 'collapsibleGroup', 'describeCollapsible'],
    registry: 'collapsible',
    example: { steps: ['tab', 'enter'] },
  },
  {
    slug: 'text-field',
    name: 'TextField',
    family: 'fullscreen',
    exports: ['TextField'],
    registry: 'text-field',
    example: { steps: ['tab', { text: 'ledger' }] },
  },
  {
    slug: 'modal',
    name: 'openModal()',
    family: 'fullscreen',
    exports: ['openModal', 'confirmModal'],
    registry: 'modal',
    example: { steps: ['tab'] },
  },
  {
    slug: 'toast',
    name: 'showToast()',
    family: 'fullscreen',
    exports: ['showToast'],
    registry: 'toast',
    // the only key an app with a toast in it has is the app's own quit key
    example: { probe: false },
  },
  {
    slug: 'tooltip',
    name: 'attachTooltip()',
    family: 'fullscreen',
    exports: ['attachTooltip', 'placeTooltip'],
    registry: 'tooltip',
    example: { steps: ['tab', { wait: 600 }] },
  },
  {
    slug: 'key-help',
    name: 'keyHelp()',
    family: 'fullscreen',
    exports: ['keyHelp'],
    registry: 'key-help',
    // its keys are the app's, which is the whole point of it: they are what it draws
    example: { probe: false },
  },
  {
    slug: 'pager',
    name: 'page()',
    family: 'fullscreen',
    exports: ['page', 'createPager'],
    registry: 'pager',
    example: { steps: ['pageDown'] },
  },
  {
    slug: 'debug-overlay',
    name: 'enableDebugOverlay()',
    family: 'fullscreen',
    exports: ['enableDebugOverlay', 'captureConsole', 'createLogRing'],
    registry: 'debug-overlay',
    example: { steps: [{ wait: 100 }], probe: false },
  },
];

/**
 * The exports that are not components, by why not.
 *
 * Every other export of `@ttylabs/sigil/components` is in some entry's
 * `exports`; `test/components.test.ts` checks that the two lists between them
 * are the barrel, exactly.
 */
export const HELPERS: Readonly<Record<string, readonly string[]>> = {
  'The engine and the parts a prompt of your own is built from': [
    'ESCAPE_TIMEOUT',
    'PROMPT_SYMBOLS',
    'TOKEN_ROLE',
    'fieldLayers',
    'forcedAccessible',
    'layoutField',
    'listWindow',
    'mountLevel',
    'mountLive',
    'promptAnswerFits',
    'promptAnswerSlot',
    'promptAnswered',
    'promptAsLines',
    'promptChoice',
    'promptFooter',
    'promptHeadLine',
    'promptHeadWidths',
    'promptKeys',
    'promptLineChoice',
    'promptLineList',
    'promptLineNumbers',
    'promptLineQuestion',
    'promptListRows',
    'promptNote',
    'promptRowCap',
    'promptSameValue',
    'promptSummary',
    'promptTailFits',
    'promptUnderHead',
    'promptValue',
    'promptWindow',
    'refusePrompt',
    'runLinePrompt',
    'runPrompt',
    'setPromptNote',
    'tokensOf',
    'writeLine',
  ],
  'What a prompt answers with or rejects with': [
    'PromptBack',
    'PromptError',
    'isAbort',
    'isBack',
    'isCancel',
  ],
  'Editing a line of text, and reading keys': [
    'boundary',
    'decodeKeys',
    'deleteAfter',
    'deleteBefore',
    'deleteRange',
    'insertAt',
    'isControlChar',
    'isSpaceCluster',
    'pastedBlock',
    'pastedLine',
    'pendingLength',
    'snap',
    'typedText',
    'wordAfter',
    'wordBefore',
  ],
  'Matching, ranking and searching': [
    'MAX_MATCHES',
    'candidatesOf',
    'compareCells',
    'entryCache',
    'entryPath',
    'fuzzyMatch',
    'highlightRuns',
    'parentOf',
    'pathFoldCase',
    'rankBy',
    'searchLines',
  ],
  'Reading and encoding what a component draws': [
    'MASK_SLOTS',
    'addMonths',
    'applyMask',
    'calendarGrid',
    'checkSlotValue',
    'commandCatalog',
    'dayKey',
    'diffHunks',
    'diffInline',
    'diffLines',
    'diffSequence',
    'encodeQr',
    'joinList',
    'markdownText',
    'outlineEntries',
    'outlineMarkers',
    'pagerLines',
    'parseFlf',
    'parseMarkdown',
    'parsePatch',
    'qrLines',
    'renderFiglet',
    'resolveEditor',
    'slotTokens',
    'slotsFor',
    'softWrap',
    'splitList',
  ],
  'Measuring, pacing and formatting': [
    'byLine',
    'byWord',
    'clampPage',
    'clockView',
    'createRateEstimator',
    'createStreamWrapper',
    'decryptFrameAt',
    'decryptPlan',
    'decryptedFrame',
    'fitKeyHelp',
    'formatClock',
    'formatDuration',
    'formatLogFields',
    'formatRate',
    'keyHelpEntries',
    'keyLabel',
    'labelLine',
    'pageBounds',
    'pageCount',
    'renderBar',
    'resolveBarWidth',
    'revealSteps',
    'rowWindow',
    'seeded',
    'spinnerFrames',
    'tableCells',
    'tableValue',
    'tableWidths',
    'thumbExtent',
    'treeGlyphs',
    'unicodeSupported',
  ],
  'Glyph sets, frame sets and limits': [
    'ARC',
    'ARROW',
    'ASCII',
    'BOUNCING_BAR',
    'CIRCLE',
    'CP437',
    'DIFF_SIDE_BY_SIDE_MIN_WIDTH',
    'DOTS',
    'GROW',
    'LINE',
    'LOG_SYMBOLS',
    'LOG_SYMBOLS_ASCII',
    'OUTCOME_SYMBOLS',
    'SPARK_ASCII',
    'SPARK_BLOCKS',
  ],
  'The theme every component is drawn through': [
    'FRAMEWORK_CSS',
    'frameworkSheet',
    'parseTheme',
    'themedCascade',
  ],
};

/** The three ways a component page shows its example's output, in the order of its tabs. */
export const VIEW_IDS = ['rendered', 'accessible', 'narrow'] as const;

export type ViewId = (typeof VIEW_IDS)[number];

/** A family, by id. */
export function family(id: FamilyId): (typeof FAMILIES)[number] {
  return FAMILIES.find((it) => it.id === id)!;
}

/** The components of one family, in order. */
export function componentsOf(id: FamilyId): ComponentEntry[] {
  return COMPONENTS.filter((entry) => entry.family === id);
}

/** A component, by slug. */
export function componentEntry(slug: string): ComponentEntry | undefined {
  return COMPONENTS.find((entry) => entry.slug === slug);
}

/** The address of the index. */
export const COMPONENTS_HREF = '/docs/components';

/** The address of a component's page. */
export function componentHref(slug: string): string {
  return `${COMPONENTS_HREF}/${slug}`;
}

/** The address of a family's section on the index. */
export function familyHref(id: FamilyId): string {
  return `${COMPONENTS_HREF}#${id}`;
}
