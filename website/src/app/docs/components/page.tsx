import { Breadcrumb } from '@/components/breadcrumb';
import { ComponentCard } from '@/components/component-card';
import { FamilyFilter } from '@/components/family-filter';
import { Glow } from '@/components/glow';
import { COMPONENTS_LEDE } from '@/lib/component-data';
import { COMPONENTS_HREF, FAMILIES, componentsOf, familyHref } from '@/lib/components';
import { guideHref } from '@/lib/nav';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
  path: COMPONENTS_HREF,
  title: 'Components',
  description: COMPONENTS_LEDE,
});

/**
 * `/docs/components`: every component, by family, each with a few lines of what
 * it really draws.
 *
 * Outside the `(sidebar)` group, because the index is a page of its own rather
 * than one in the docs' reading order: 1280px wide, the header at the same width
 * (`isDocsPath()`), and the family filter where a sidebar would be. The list is
 * `src/lib/components.ts`, which `test/components.test.ts` holds to the barrel,
 * and every preview is that component's example as it was run.
 *
 * The glow is the top 460px, from the top left.
 */
export default function ComponentsIndex() {
  const segments = FAMILIES.map((family) => ({
    count: componentsOf(family.id).length,
    href: familyHref(family.id),
    id: family.id,
    title: family.title,
  }));

  return (
    <div className="relative flex flex-1 flex-col">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[460px]">
        <Glow alpha={0.24} at="20% 0%" size="40% 70%" variant="radial" />
      </div>

      <div className="layout-page relative flex flex-col gap-14 pt-16 pb-24">
        <div className="flex flex-col gap-5">
          <Breadcrumb
            crumbs={[
              { label: 'Docs', href: guideHref('getting-started') },
              { label: 'Components' },
            ]}
          />
          <h1 className="text-[40px] leading-[1.05] tracking-[-0.03em] sm:text-page-wide">
            Components
          </h1>
          <p className="lede max-w-[40em] text-[18px]">{COMPONENTS_LEDE}</p>
          <FamilyFilter segments={segments} />
        </div>

        {FAMILIES.map((family) => (
          <section
            aria-labelledby={`${family.id}-title`}
            className="flex scroll-mt-24 flex-col gap-5"
            id={family.id}
            key={family.id}
          >
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-3.5">
              <h2 className="text-docs-h2" id={`${family.id}-title`}>
                {family.title}
              </h2>
              <p className="text-[15px] text-muted">{family.blurb}</p>
            </div>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
              {componentsOf(family.id).map((entry) => (
                <li className="flex min-w-0" key={entry.slug}>
                  <ComponentCard size="index" slug={entry.slug} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
