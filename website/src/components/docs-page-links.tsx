/** Strokes a little larger than the text beside them. */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const LINK = 'flex items-center gap-1.5 text-muted hover:text-white';

/**
 * A docs page's two ways out: Edit on GitHub, which is the page's own source
 * file -- or View source, on a page about a component, which is its module --
 * and Report a problem, which opens a new issue.
 *
 * The rail carries them, and the rail is hidden below 1100px, so the page
 * draws them again at the foot of its content for the widths that have no rail.
 * One component for both, so the two cannot come to say different things.
 */
export function DocsPageLinks({
  editHref,
  reportHref,
  source = false,
}: {
  /** The page's source file on GitHub. */
  editHref: string;
  /** Where to open an issue. */
  reportHref: string;
  /**
   * The first link is the source of the thing the page documents -- a
   * component's module -- rather than of the page, so it says View source.
   */
  source?: boolean;
}) {
  return (
    <>
      <a href={editHref} className={LINK} target="_blank" rel="noreferrer">
        {source ? (
          <Icon>
            <path d="m8 7-5 5 5 5" />
            <path d="m16 7 5 5-5 5" />
          </Icon>
        ) : (
          <Icon>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </Icon>
        )}
        <span>{source ? 'View source' : 'Edit on GitHub'}</span>
      </a>
      <a href={reportHref} className={LINK} target="_blank" rel="noreferrer">
        <Icon>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" />
          <path d="M12 16.5v.01" />
        </Icon>
        <span>Report a problem</span>
      </a>
    </>
  );
}
