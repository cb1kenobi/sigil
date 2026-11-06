import Link from 'next/link';

/** One step of the path to a page. The last has no `href` and is the page. */
export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The path to a page, in the mono face, the page itself last and not a link.
 *
 * The docs pages, the reference and the components index all open with one, so
 * it is drawn here once.
 */
export function Breadcrumb({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-muted">
        {crumbs.map((crumb, index) => (
          <li key={crumb.label} className="flex items-center gap-x-1.5">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.href ? (
              <Link href={crumb.href} className="hover:text-white">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
