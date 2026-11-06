import { CopyButton } from '@/components/copy-button';
import { copiedText, type Row } from '@/lib/terminal-rows';

export interface TerminalBlockProps {
  /** What the terminal shows, a row at a time. */
  readonly rows: readonly Row[];
  /** What Copy puts on the clipboard. Defaults to the commands in `rows`. */
  readonly copy?: string;
  /** The working directory, on the left of the title bar. */
  readonly cwd?: string;
  /** What a screen reader calls it. Defaults to `Terminal, <cwd>`. */
  readonly label?: string;
  /** The fence's language, for `command_copied`. */
  readonly language?: string;
  /** The shell and the size, on the right of the title bar. */
  readonly shell?: string;
  /** `hero` is 14px, for a terminal that is the subject of a section. */
  readonly size?: 'default' | 'hero';
  /**
   * Wrap a row that is wider than the block, as a terminal narrower than the
   * output would, instead of scrolling it. For a screen whose last words are
   * the point. The text is the same either way, so selecting and Copy are too.
   */
  readonly wrap?: boolean;
}

/**
 * The default size, which is what the guides' transcripts were captured at:
 * `packages/cli/test/guides.ts` runs every command with `COLUMNS=80`.
 */
const SHELL = 'zsh · 80×24';

/**
 * A screen: what a terminal showed, drawn one element per row.
 *
 * **One block element per row, each `white-space: pre`.** The design canvas put
 * newlines inside a `<pre>` and lost them, and the seal's banner rows ran
 * together; a row that is its own element cannot be joined to the next, and it
 * is what lets a run of block characters take a line height of 1.1 so that the
 * rows meet (`tighten()` in `terminal-rows.ts` decides which). An empty row is
 * held open at one line's height by `min-height: 1lh`, since an element with
 * nothing in it is otherwise no height at all.
 *
 * Selecting across the rows copies plain text with a newline per row, because
 * every colour is a class on a span and a block between rows is a line break.
 * The Copy button copies the commands, which is what a reader copying a
 * transcript wants to paste into a shell.
 */
export function TerminalBlock({
  copy,
  cwd = '~',
  label,
  language,
  rows,
  shell = SHELL,
  size = 'default',
  wrap = false,
}: TerminalBlockProps) {
  const text = copy ?? copiedText(rows);
  const commands = copy !== undefined || rows.some((row) => row.command !== undefined);

  return (
    <figure
      aria-label={label ?? `Terminal, ${cwd}`}
      className="mt-4 overflow-hidden rounded-panel border border-line-panel bg-terminal"
      data-copy-block=""
    >
      <div className="flex items-center gap-3 border-b border-line-term py-2 pr-2 pl-[18px] font-mono text-xs text-dim">
        <span className="min-w-0 flex-1 truncate">{cwd}</span>
        <span className="shrink-0">{shell}</span>
        <CopyButton
          label={commands ? 'Copy the commands' : 'Copy the output'}
          language={language}
          location="terminal_block"
          text={text}
        />
      </div>
      <div
        className={`overflow-x-auto font-mono text-fg-term ${
          size === 'hero' ? 'px-[22px] pt-5 pb-6 text-term-hero' : 'px-5 pt-4 pb-5 text-term'
        }`}
        data-copy-body=""
        // scrolls sideways, so it has to be reachable by keyboard
        tabIndex={0}
      >
        <TerminalRows rows={rows} wrap={wrap} />
      </div>
    </figure>
  );
}

/**
 * The rows of a screen, one block element each.
 *
 * Shared by the block above and by anything that draws a screen without a title
 * bar -- the component cards on the home page -- so that the one rule about
 * rows, written in `TerminalBlock`'s comment, has one place to be kept.
 */
export function TerminalRows({
  rows,
  wrap = false,
}: {
  readonly rows: readonly Row[];
  readonly wrap?: boolean;
}) {
  return (
    <>
      {rows.map((row, at) => (
        <div
          className={`min-h-[1lh] ${wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'} ${
            row.tight ? 'leading-[1.1]' : ''
          }`}
          // keyed by position, which is stable: the rows never reorder
          key={at}
        >
          {row.spans.map((span, index) =>
            span.className || span.color || span.background ? (
              <span
                className={span.className}
                key={index}
                style={
                  span.color || span.background
                    ? { background: span.background, color: span.color }
                    : undefined
                }
              >
                {span.text}
              </span>
            ) : (
              span.text
            )
          )}
        </div>
      ))}
    </>
  );
}
