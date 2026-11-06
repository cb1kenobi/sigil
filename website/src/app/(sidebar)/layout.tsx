import { CellGrid } from '@/components/cell-grid';
import { DocsSidebar } from '@/components/docs-sidebar';
import { Glow } from '@/components/glow';
import { componentFamilies, docsSidebar } from '@/lib/docs-sidebar';

/**
 * The docs layout: the sidebar, and beside it whatever the page draws.
 *
 * A route group, so it adds nothing to an address and reaches the pages that
 * have a sidebar and none that do: `/docs/[slug]` and `/reference` are in it,
 * and the components index (SIG-263), which is a page with no sidebar of its
 * own, is not. The sidebar is here and not in each page so that it is one
 * element that survives from page to page, with its scroll and its disclosure
 * where the reader left them.
 *
 * Three columns inside the 1440px container: the sidebar here, and the content
 * and the rail from the page, as siblings of it. They wrap rather than squeeze:
 * the rail is gone below 1100px and the sidebar is a menu above the content
 * below 768px.
 *
 * The cell grid and the glow are the top 520px of every docs page, behind
 * everything and fading downward.
 *
 * A component's page (SIG-264) has the same sidebar scoped to its family, which
 * the sidebar works out from the path: `componentSidebar()` in `nav.ts`.
 */
export default function SidebarLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="relative flex flex-1 flex-col">
      <CellGrid variant="fade" />
      <Glow variant="top" />
      <div className="layout-docs relative flex flex-1 flex-col md:flex-row md:items-start md:gap-14">
        <DocsSidebar families={componentFamilies()} sections={docsSidebar()} />
        {children}
      </div>
    </div>
  );
}
