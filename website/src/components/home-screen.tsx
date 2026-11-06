import { TerminalBlock, TerminalRows } from '@/components/terminal-block';
import { homeRows, type HomeScreenId } from '@/lib/home';

export interface HomeScreenProps {
  /** The title bar's left side. Cosmetic: what a prompt was drawn in is not part of the capture. */
  readonly cwd?: string;
  /** What Copy puts on the clipboard, for a screen whose commands are not what to paste. */
  readonly copy?: string;
  readonly id: HomeScreenId;
  readonly label: string;
  /** `hero` is the heavy shadow of a terminal that is the subject of a section. */
  readonly shadow?: boolean;
  /** The shell named in the title bar, which is not part of the capture either. */
  readonly shell?: string;
  readonly size?: 'default' | 'hero';
  /** Wrap long rows rather than scroll them. */
  readonly wrap?: boolean;
}

/**
 * A terminal block drawing one of the home page's captured screens.
 *
 * The rows come from `src/transcripts/home/screens.json` by name, so a page
 * never holds output of its own to go stale. The size in the title bar is the
 * width the screen was captured at.
 */
export function HomeScreen({
  copy,
  cwd,
  id,
  label,
  shadow = false,
  shell = 'zsh',
  size = 'default',
  wrap = false,
}: HomeScreenProps) {
  const { columns, rows } = homeRows(id);

  return (
    // `mt-0` because the block's own top margin is for a block in a flow of prose
    <div
      className={`min-w-0 [&>figure]:mt-0 ${
        shadow ? '[&>figure]:shadow-[0_32px_64px_-32px_rgba(0,0,0,0.7)]' : ''
      }`}
    >
      <TerminalBlock
        copy={copy}
        cwd={cwd}
        label={label}
        rows={rows}
        shell={`${shell} · ${columns}×24`}
        size={size}
        wrap={wrap}
      />
    </div>
  );
}

/**
 * A screen without a title bar, cut off at the height it is given: the preview
 * on a component card.
 *
 * `aria-hidden`, because the card is a link that already says what it is, and a
 * reader of the screen gets nothing from four lines of a table read out one
 * cell at a time. It is real output, not decoration, so it stays in the page for
 * everyone who can see it.
 */
export function ScreenPreview({ id }: { id: HomeScreenId }) {
  const { rows } = homeRows(id);

  return (
    <div
      aria-hidden="true"
      className="h-[124px] overflow-hidden border-b border-line-term bg-terminal px-5 py-4 font-mono text-term-card text-fg-term"
    >
      <TerminalRows rows={rows} />
    </div>
  );
}
