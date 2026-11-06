import { CopyButton, type CopyEvent } from '@/components/copy-button';
import { highlight } from '@/lib/highlight';

export interface CodeBlockProps {
  /** The code, exactly as it is copied. */
  readonly code: string;
  /** What copying it sends, when it is not `command_copied`. */
  readonly event?: CopyEvent;
  /** The fence's language, which decides the highlighting. */
  readonly lang?: string;
  /** What the title bar names: `src/index.ts`. Defaults to the language. */
  readonly title?: string;
}

/**
 * A file: source code, highlighted at build time, with its name and a Copy
 * button in a title bar.
 *
 * Deliberately unlike a `TerminalBlock` -- `surface` rather than `terminal`, a
 * file name rather than a working directory, `fg-code` rather than `fg-term` --
 * because the site is mostly these two and a reader should never have to work
 * out which one they are reading.
 *
 * The body is a `<pre>` with newlines, which is what a file is; it is the
 * terminal that needs one element per row. It scrolls sideways **inside** the
 * block and is focusable, so a keyboard can scroll it too, and the page never
 * does.
 */
export function CodeBlock({ code, event, lang, title }: CodeBlockProps) {
  const lines = highlight(code, lang);
  const name = title ?? lang;

  return (
    <figure
      aria-label={name ?? 'Code'}
      className="mt-4 overflow-hidden rounded-panel border border-line-panel bg-surface"
      data-copy-block=""
    >
      <div className="flex items-center gap-3 border-b border-line py-2 pr-2 pl-[18px] font-mono text-xs text-muted">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <CopyButton
          event={event}
          label={title ? `Copy ${title}` : 'Copy the code'}
          language={lang}
          location="code_block"
          text={code}
        />
      </div>
      <pre
        // a region that scrolls is reachable by keyboard only if it can be
        // focused; the figure's label is what names it
        className="overflow-x-auto px-5 pt-[18px] pb-[22px] font-mono text-code text-fg-code focus-visible:-outline-offset-2"
        data-copy-body=""
        tabIndex={0}
      >
        <code>
          {lines
            ? lines.map((line, at) => (
                // keyed by position, which is stable: the lines never reorder
                <span key={at}>
                  {line.map((token, index) =>
                    token.color || token.italic ? (
                      <span
                        className={token.italic ? 'italic' : undefined}
                        key={index}
                        style={token.color ? { color: token.color } : undefined}
                      >
                        {token.text}
                      </span>
                    ) : (
                      token.text
                    )
                  )}
                  {at < lines.length - 1 ? '\n' : null}
                </span>
              ))
            : code}
        </code>
      </pre>
    </figure>
  );
}
