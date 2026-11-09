/**
 * The templates the two emitters are held against.
 *
 * SIG-72's actual risk is not that either emitter is wrong today, it is that
 * they drift -- so this is data rather than two sets of hand-written fixtures.
 * Both paths are generated from every entry here, which means neither can be
 * quietly updated to match the other: a template is written once and read three
 * ways.
 *
 * An entry is a template with its interpolations written out as `${0}`, `${1}`
 * and so on, and the expressions those stand for as source. That is exactly
 * what a compiler has of a tagged template -- the quasis it read and the text
 * between them -- and it is what lets the runtime path be generated too: the
 * same expression source is printed into a `parse()` call and into the compiled
 * module, so the two cannot be given different expressions to evaluate.
 *
 * Every expression reads `scope`, which `emitters.test.ts` builds fresh per
 * render, because the comparison is worth nothing unless both trees are wired
 * to signals that move.
 */

export interface CorpusEntry {
  /** The expressions, by the index the template names them with. */
  readonly exprs: readonly string[];
  /** What the template is here to pin. */
  readonly name: string;
  /**
   * Whether to build this one with every name the emitter imports shadowed by a
   * local.
   *
   * The one thing a corpus of templates cannot say on its own, and it is about
   * the compiled path only: its output is spliced into a module this compiler
   * has never seen, so a component whose prop is called `text` puts a `text` in
   * scope and `const e = text("")` calls it. The interpreted path cannot have
   * the problem -- it holds the function rather than a name -- which is exactly
   * why the generated side has to be made to face it.
   *
   * Which names those are is read off the compiled module's own imports rather
   * than listed here. Listed, it went stale immediately: the first version
   * named `raw`, which the emitter never imports, and missed `rawElement` and
   * `rootElement`, which it does -- so the entry shadowed a name nothing used
   * and left two real ones uncovered. A helper the emitter starts importing
   * tomorrow is shadowed by this the same day.
   */
  readonly shadow?: boolean;
  /** The template, with `${N}` where an interpolation goes. */
  readonly template: string;
}

/** The framework's own vocabulary, so the corpus reads like an app would. */
export const CORPUS: readonly CorpusEntry[] = [
  {
    exprs: [],
    name: 'a wholly static tree',
    template: `<box border="round" padding="0 1" width="20">
      <text font-weight="bold">Counter</text>
    </box>`,
  },
  {
    exprs: ['() => scope.count.get()'],
    name: 'a reactive piece of text content',
    template: `<box><text>count: \${0}</text></box>`,
  },
  {
    exprs: ['() => (scope.count.get() > 2 ? "red" : "blue")'],
    name: 'a reactive prop',
    template: `<box><text color=\${0}>level</text></box>`,
  },
  {
    exprs: ['7', '"!"'],
    name: 'an interpolated constant, which the analyzer folds and the compiler cannot',
    template: `<box><text>n=\${0}\${1}</text></box>`,
  },
  {
    exprs: ['"loose"', 'scope.count.get()'],
    name: 'an interpolated value as a box child, which becomes a text element',
    template: `<box>\${0}\${1}</box>`,
  },
  {
    exprs: ['false', 'null', 'undefined'],
    name: 'a child that draws nothing',
    template: `<box><text>a</text>\${0}\${1}\${2}</box>`,
  },
  {
    exprs: ['() => "n" + scope.count.get()'],
    name: 'a reactive box child',
    template: `<box>\${0}</box>`,
  },
  {
    exprs: ['scope.made'],
    name: 'an element interpolated as a child',
    template: `<box><text>before</text>\${0}</box>`,
  },
  {
    exprs: ['["a", "b"]'],
    name: 'an array child, which is flattened',
    template: `<box>\${0}</box>`,
  },
  {
    exprs: [],
    name: 'the reserved props',
    template: `<box class="row panel" id="main" key="k"><text focusable>x</text></box>`,
  },
  {
    exprs: ['() => (scope.count.get() > 2 ? "green" : "yellow")'],
    name: 'one prop written twice, where order is the whole answer',
    // the literal is written *after* the interpolation on purpose: it wins
    // until the signal moves, and a compiler that lifted it into the
    // constructor would have the interpolation win from the first frame
    template: `<box><text color=\${0} color="red">x</text></box>`,
  },
  {
    exprs: [],
    name: 'prose the author broke over two lines',
    template: `<box><text>hello
      world</text></box>`,
  },
  {
    exprs: [],
    name: 'two elements whose props are the same object',
    template: `<box><text color="cyan">a</text><text color="cyan">b</text></box>`,
  },
  {
    exprs: ['() => ({ height: 1, width: 3 })', '() => {}', '"magenta"'],
    name: 'a raw element, whose measure and paint are options rather than props',
    template: `<box><raw measure=\${0} paint=\${1} color=\${2} /></box>`,
  },
  {
    exprs: ['() => scope.count.get()', '() => scope.items.get().length'],
    name: 'a text built from several pieces, as the root',
    template: `<text>\${0} of \${1}</text>`,
  },
  {
    exprs: [
      'scope.Show',
      '() => scope.items.get().length > 0',
      '() => scope.ui`<text font-style="italic">(nothing)</text>`',
      '({ "flex-direction": "column" })',
      '() => scope.ui`<text>some</text>`',
    ],
    name: 'a component, with its children handed over as a thunk',
    template: `<box><\${0} when=\${1} fallback=\${2} props=\${3}> \${4} </></box>`,
  },
  {
    exprs: ['scope.Show', '() => scope.count.get() > 2', '() => scope.ui`<text>high</text>`'],
    name: 'a component as the root, closed by the expression that opened it',
    template: `<\${0} when=\${1}>\${2}</\${0}>`,
  },
  {
    exprs: [
      'scope.Show',
      '() => scope.items.get().length > 0',
      '({ "flex-direction": "column" })',
      '() => scope.ui`<text font-style="italic">(nothing)</text>`',
      '() => scope.count.get()',
      '() => scope.For({ children: (item) => scope.ui`<text>- ${item}</text>`, each: () => scope.items.get(), props: { "flex-direction": "column" } })',
    ],
    name: 'the Counter, which is the shape an app actually writes',
    template: `<box border="round" flex-direction="column" padding="0 1" width="28">
      <text font-weight="bold">Counter</text>
      <text>count: \${4}</text>
      <\${0} when=\${1} props=\${2} fallback=\${3}>
        \${5}
      </>
    </box>`,
  },
  {
    exprs: ['() => scope.count.get()'],
    name: 'a template built where every imported name is shadowed',
    shadow: true,
    template: `<box><text>count: \${0}</text></box>`,
  },
  {
    exprs: ['scope.made'],
    name: 'a root that is an interpolated element',
    shadow: true,
    template: `\${0}`,
  },
  {
    exprs: ['scope.Kind', 'scope.made'],
    name: 'a component with several children rather than one thunk',
    template: `<\${0}><text>one</text>\${1}<text>three</text></>`,
  },
  {
    exprs: [
      '() => (scope.count.get() > 2 ? "wide" : "narrow")',
      '() => "row-" + scope.count.get()',
    ],
    name: 'a reactive class and a reactive id, which are reserved props',
    template: `<box class=\${0} id=\${1} tabindex="2"><text>x</text></box>`,
  },
  {
    exprs: ['() => ({ height: 1, width: 4 })', '() => {}'],
    name: 'a raw with static props beside its measure and its paint',
    shadow: true,
    template: `<box><raw measure=\${0} paint=\${1} color="green" font-weight="bold" /></box>`,
  },
  {
    exprs: ['["a", ["b", ["c"]], () => "d" + scope.count.get()]'],
    name: 'a nested array child with a thunk inside it',
    template: `<box>\${0}</box>`,
  },
  {
    exprs: ['() => scope.count.get() // the count, commented at the end'],
    name: 'an expression ending in a line comment, which would eat its own closing paren',
    template: `<box><text>n: \${0}</text></box>`,
  },
  {
    exprs: ['() => scope.count.get()'],
    name: 'a text with props of its own and content that moves',
    template: `<box><text color="cyan" font-weight="bold">n: \${0}</text></box>`,
  },
  {
    exprs: ['scope.Kind', '() => "ignored"'],
    // the tag children are written after the prop, and the last one written
    // is the one the component is handed -- which is the order `emit()` uses
    name: 'a component given both a children prop and children between its tags',
    template: `<\${0} children=\${1}><text>real</text></>`,
  },
  {
    exprs: ['scope.Kind'],
    name: 'a key on a component, which is a prop like any other',
    template: `<\${0} key="row-1"><text>keyed</text></>`,
  },
  {
    exprs: [
      '() => scope.log.push("onKey")',
      '() => scope.log.push("onMouse")',
      '() => scope.log.push("onPaste")',
      '() => scope.log.push("onFocusChange")',
      '() => scope.log.push("onScroll")',
      '() => { scope.log.push("onResize"); return false; }',
      '() => { scope.log.push("onLayout"); return false; }',
      '() => (scope.count.get() > 2 ? "wide" : "narrow")',
    ],
    name: 'all seven handlers, which are assigned and never called as thunks',
    // a handler is a function and so is a reactive prop; the handler names are
    // what keep the first from being read as the second, and `class` beside
    // them is what shows the thunk rule still applies to everything else
    template: `<box onKey=\${0} onMouse=\${1} onPaste=\${2} onFocusChange=\${3} onScroll=\${4}
      onResize=\${5} onLayout=\${6} class=\${7}><text>x</text></box>`,
  },
  {
    exprs: ['undefined', '() => scope.log.push("onKey")'],
    name: 'a handler that is undefined, which sets nothing, then one that does',
    template: `<box onKey=\${0}><text onKey=\${1}>x</text></box>`,
  },
  {
    exprs: [
      '(el) => scope.log.push(`box children=${el.children.length} parent=${!!el.parent}`)',
      '(el) => scope.log.push(`text parent=${!!el.parent} box=${!!el.box}`)',
      '() => ({ height: 1, width: 3 })',
      '() => {}',
      '(el) => scope.log.push(`raw parent=${!!el.parent}`)',
    ],
    name: 'a ref on each host type, called after the children and before the parent',
    shadow: true,
    template: `<box ref=\${0}>
      <text ref=\${1}>plain</text>
      <raw measure=\${2} paint=\${3} ref=\${4} />
    </box>`,
  },
  {
    exprs: [
      '(el) => scope.log.push(`first ${el.text}`)',
      '(el) => scope.log.push(`second ${el.text}`)',
      '() => scope.count.get()',
    ],
    name: 'two refs and a reactive text, where the order and the content at the call are the answer',
    template: `<text ref=\${0} color="red" ref=\${1}>n=\${2}</text>`,
  },
  {
    exprs: [],
    name: 'a prop named __proto__, which is not a key in an object literal',
    template: `<box><text __proto__="x">x</text></box>`,
  },
];

/**
 * Templates that must be refused, and refused with the same words on both paths.
 *
 * Apart from `CORPUS` because nothing here builds a tree to compare: the
 * interpreter throws while it builds, and the compiler throws either while it
 * compiles (what a build can know from the IR alone) or when the compiled
 * template first runs (what only the value can say). The claim is that it is the
 * same sentence either way, with the same position -- which is the near-miss
 * handler names SIG-305 refuses, because the thunk rule would otherwise have
 * called the function with no arguments and carried on.
 */
export interface RefusalEntry {
  readonly exprs: readonly string[];
  /** What the refusal says, exactly, on both paths. */
  readonly message: string;
  readonly name: string;
  readonly template: string;
}

export const REFUSALS: readonly RefusalEntry[] = [
  {
    exprs: ['() => scope.log.push("key")'],
    message:
      '`on-key` is not a handler name: write `onKey`. There is one spelling, and it is the camelCase one in both frontends (at line 1)',
    name: 'a kebab spelling of a handler',
    template: `<box on-key=\${0} />`,
  },
  {
    exprs: ['() => scope.log.push("key")'],
    message:
      '`onkey` is not a handler name: write `onKey`. There is one spelling, and it is the camelCase one in both frontends (at line 1)',
    name: 'a lower-case spelling of a handler',
    template: `<box onkey=\${0} />`,
  },
  {
    exprs: ['() => scope.log.push("focus")'],
    message:
      '`on-focus-change` is not a handler name: write `onFocusChange`. There is one spelling, and it is the camelCase one in both frontends (at line 1)',
    name: 'a kebab spelling on a text, whose handlers are the same seven',
    template: `<box><text on-focus-change=\${0}>x</text></box>`,
  },
  {
    exprs: ['() => scope.log.push("click")'],
    message:
      '`onClick` is not an event this element has. The handlers are onKey, onMouse, onPaste, onFocusChange, onScroll, onResize, onLayout (at line 1)',
    name: 'an event no element has, given a function',
    template: `<box onClick=\${0} />`,
  },
  {
    exprs: ['() => scope.log.push("bare")'],
    message:
      '`on` is not an event this element has. The handlers are onKey, onMouse, onPaste, onFocusChange, onScroll, onResize, onLayout (at line 1)',
    name: 'a prop named just on, which the length of the name used to let through',
    template: `<box on=\${0} />`,
  },
  {
    exprs: ['() => scope.log.push("click")'],
    message:
      '`on-click` is not an event this element has. The handlers are onKey, onMouse, onPaste, onFocusChange, onScroll, onResize, onLayout (at line 1)',
    name: 'a kebab event no element has, given a function',
    template: `<box on-click=\${0} />`,
  },
];
