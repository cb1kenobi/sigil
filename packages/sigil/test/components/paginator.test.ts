import { strip } from '../../src/ansi/index.js';
import {
  clampPage,
  createPaginator,
  pageBounds,
  pageCount,
  pageIndicator,
  type PageIndicatorOptions,
  paginatorState,
  paginatorView,
} from '../../src/components/paginator.js';
import { renderToString } from '../../src/element/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { createEffects, Computed } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * An indicator read as the text it prints.
 *
 * `env` is pinned to an empty one on linux so that what a developer's own `TERM`
 * says cannot decide between `●` and `*`, and the colour level to none so the
 * text is plain unless a test asks for colour.
 */
const plain = { colorLevel: 0 as const, env: {}, platform: 'linux' };

function indicator(page: number, pages: number, opts: PageIndicatorOptions = {}): string {
  return pageIndicator(page, pages, { ...plain, ...opts });
}

const ESC = String.fromCharCode(0x1b);

describe('pageCount()', () => {
  it('should round up, so a partial page is a page', () => {
    expect(pageCount(23, 5)).to.equal(5);
    expect(pageCount(25, 5)).to.equal(5);
    expect(pageCount(26, 5)).to.equal(6);
  });

  it('should be one page when there is nothing to show, not none', () => {
    expect(pageCount(0, 5)).to.equal(1);
  });

  it('should read a page size under one as one rather than dividing by zero', () => {
    expect(pageCount(3, 0)).to.equal(3);
    expect(pageCount(3, -4)).to.equal(3);
    expect(pageCount(3, Number.NaN)).to.equal(3);
  });

  it('should read a total that is not a count as nothing', () => {
    expect(pageCount(-9, 5)).to.equal(1);
    expect(pageCount(Number.NaN, 5)).to.equal(1);
    expect(pageCount(Number.POSITIVE_INFINITY, 5)).to.equal(1);
  });
});

describe('clampPage()', () => {
  it('should hold a page between the first and the last', () => {
    expect(clampPage(-3, 5)).to.equal(0);
    expect(clampPage(2, 5)).to.equal(2);
    expect(clampPage(9, 5)).to.equal(4);
  });

  it('should treat a page that is not a number as the first', () => {
    expect(clampPage(Number.NaN, 5)).to.equal(0);
  });
});

describe('pageBounds()', () => {
  it('should be where a page sits among the items, with an exclusive end', () => {
    expect(pageBounds(0, 5, 23)).to.deep.equal({ end: 5, start: 0 });
    expect(pageBounds(2, 5, 23)).to.deep.equal({ end: 15, start: 10 });
  });

  it('should end the last page at the total rather than a full page on', () => {
    expect(pageBounds(4, 5, 23)).to.deep.equal({ end: 23, start: 20 });
  });

  it('should be empty when there is nothing, and not start past it', () => {
    expect(pageBounds(0, 5, 0)).to.deep.equal({ end: 0, start: 0 });
    expect(pageBounds(3, 5, 0)).to.deep.equal({ end: 0, start: 0 });
  });
});

describe('createPaginator()', () => {
  it('should start on the first page of nothing', () => {
    const pager = createPaginator();

    expect(pager.page).to.equal(0);
    expect(pager.pages).to.equal(1);
    expect(pager.perPage).to.equal(10);
    expect(pager.total).to.equal(0);
    expect(pager.onFirstPage).to.equal(true);
    expect(pager.onLastPage).to.equal(true);
  });

  it('should work its pages out from the total and the page size', () => {
    const pager = createPaginator({ perPage: 5, total: 23 });

    expect(pager.pages).to.equal(5);
    expect(pager.start).to.equal(0);
    expect(pager.end).to.equal(5);
  });

  it('should start where it was told, in range', () => {
    expect(createPaginator({ page: 2, perPage: 5, total: 23 }).page).to.equal(2);
    expect(createPaginator({ page: 99, perPage: 5, total: 23 }).page).to.equal(4);
    expect(createPaginator({ page: -1, perPage: 5, total: 23 }).page).to.equal(0);
  });

  describe('moving', () => {
    it('should step forward and back, and say whether it moved', () => {
      const pager = createPaginator({ perPage: 5, total: 12 });

      expect(pager.next()).to.equal(true);
      expect(pager.page).to.equal(1);
      expect(pager.next()).to.equal(true);
      expect(pager.page).to.equal(2);
      expect(pager.previous()).to.equal(true);
      expect(pager.page).to.equal(1);
    });

    it('should stay on the last page when asked for the next, and say it did not move', () => {
      const pager = createPaginator({ page: 2, perPage: 5, total: 12 });

      expect(pager.onLastPage).to.equal(true);
      expect(pager.next()).to.equal(false);
      expect(pager.page).to.equal(2);
    });

    it('should stay on the first page when asked for the previous', () => {
      const pager = createPaginator({ perPage: 5, total: 12 });

      expect(pager.previous()).to.equal(false);
      expect(pager.page).to.equal(0);
    });

    it('should jump to either end', () => {
      const pager = createPaginator({ perPage: 5, total: 23 });

      expect(pager.last()).to.equal(true);
      expect(pager.page).to.equal(4);
      expect(pager.last()).to.equal(false);
      expect(pager.first()).to.equal(true);
      expect(pager.page).to.equal(0);
      expect(pager.first()).to.equal(false);
    });

    it('should clamp a page it is sent to rather than refuse it', () => {
      const pager = createPaginator({ perPage: 5, total: 23 });

      expect(pager.goTo(40)).to.equal(true);
      expect(pager.page).to.equal(4);
      expect(pager.goTo(-40)).to.equal(true);
      expect(pager.page).to.equal(0);
    });

    it('should clamp a page that is assigned', () => {
      const pager = createPaginator({ perPage: 5, total: 23 });

      pager.page = 99;
      expect(pager.page).to.equal(4);
    });

    it('should never move on a single page', () => {
      const pager = createPaginator({ perPage: 5, total: 3 });

      expect(pager.next()).to.equal(false);
      expect(pager.previous()).to.equal(false);
      expect(pager.onFirstPage && pager.onLastPage).to.equal(true);
    });
  });

  describe('slice()', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);

    it('should be the items on the current page', () => {
      const pager = createPaginator({ perPage: 5, total: items.length });

      expect(pager.slice(items)).to.deep.equal([0, 1, 2, 3, 4]);
      pager.next();
      expect(pager.slice(items)).to.deep.equal([5, 6, 7, 8, 9]);
    });

    it('should be what is left on the last page', () => {
      const pager = createPaginator({ perPage: 5, total: items.length });
      pager.last();

      expect(pager.slice(items)).to.deep.equal([20, 21, 22]);
    });

    it('should be nothing when there is nothing', () => {
      expect(createPaginator({ perPage: 5 }).slice([])).to.deep.equal([]);
    });
  });

  describe('when the total changes', () => {
    it('should bring the page back into range when it shrinks', () => {
      const pager = createPaginator({ page: 4, perPage: 5, total: 23 });

      pager.total = 8;
      expect(pager.pages).to.equal(2);
      expect(pager.page).to.equal(1);
    });

    it('should not spring back to the old page when it grows again', () => {
      const pager = createPaginator({ page: 4, perPage: 5, total: 23 });

      pager.total = 8;
      pager.total = 23;
      expect(pager.page).to.equal(1);
    });

    it('should leave the page alone when it grows', () => {
      const pager = createPaginator({ page: 1, perPage: 5, total: 8 });

      pager.total = 23;
      expect(pager.page).to.equal(1);
    });

    it('should land on the one page that is left when it goes to nothing', () => {
      const pager = createPaginator({ page: 3, perPage: 5, total: 23 });

      pager.total = 0;
      expect(pager.page).to.equal(0);
      expect(pager.pages).to.equal(1);
    });
  });

  describe('when the page size changes', () => {
    it('should keep the first item on the page on screen', () => {
      const pager = createPaginator({ page: 2, perPage: 5, total: 23 });

      // item 10 was first, and is on page 1 of tens
      pager.perPage = 10;
      expect(pager.page).to.equal(1);
      expect(pager.start).to.equal(10);
    });

    it('should land on the page that holds it when the pages get smaller', () => {
      const pager = createPaginator({ page: 1, perPage: 10, total: 23 });

      pager.perPage = 5;
      expect(pager.page).to.equal(2);
      expect(pager.start).to.equal(10);
    });

    it('should read a size under one as one', () => {
      const pager = createPaginator({ perPage: 5, total: 3 });

      pager.perPage = 0;
      expect(pager.perPage).to.equal(1);
      expect(pager.pages).to.equal(3);
    });
  });

  describe('as a signal', () => {
    it('should be tracked by a computed that reads it', () => {
      const pager = createPaginator({ perPage: 5, total: 23 });
      const label = new Computed(() => `${pager.page + 1}/${pager.pages}`);

      expect(label.get()).to.equal('1/5');
      pager.next();
      expect(label.get()).to.equal('2/5');
      pager.total = 6;
      pager.last();
      expect(label.get()).to.equal('2/2');
    });

    it('should read a page that was written to the state past the end as the last', () => {
      const pager = createPaginator({ perPage: 5, total: 12 });

      pager.state.page.set(40);
      expect(pager.page).to.equal(2);
    });

    it('should share its state with a view built from it', () => {
      const state = paginatorState({ perPage: 5, total: 23 });

      expect(state.page.get()).to.equal(0);
      expect(state.perPage.get()).to.equal(5);
      expect(state.total.get()).to.equal(23);
    });
  });
});

describe('pageIndicator()', () => {
  describe('dots', () => {
    it('should be one per page with the current one filled', () => {
      expect(indicator(0, 3)).to.equal('● ○ ○');
      expect(indicator(1, 3)).to.equal('○ ● ○');
      expect(indicator(2, 3)).to.equal('○ ○ ●');
    });

    it('should be the default', () => {
      expect(indicator(1, 4)).to.equal(indicator(1, 4, { style: 'dots' }));
    });

    it('should be a single dot for a single page', () => {
      expect(indicator(0, 1)).to.equal('●');
    });

    it('should draw ASCII where the terminal cannot be trusted with the rest', () => {
      expect(indicator(1, 3, { ascii: true })).to.equal('. * .');
      expect(indicator(1, 3, { env: { TERM: 'linux' } })).to.equal('. * .');
      expect(indicator(1, 3, { env: { TERM: 'dumb' } })).to.equal('. * .');
    });

    it('should take the glyphs it is given', () => {
      expect(indicator(1, 3, { active: '#', inactive: '-' })).to.equal('- # -');
    });

    it('should clamp a page past the end onto the last dot', () => {
      expect(indicator(9, 3)).to.equal('○ ○ ●');
      expect(indicator(-2, 3)).to.equal('● ○ ○');
    });
  });

  describe('numeric', () => {
    it('should count pages from one', () => {
      expect(indicator(0, 5, { style: 'numeric' })).to.equal('1/5');
      expect(indicator(4, 5, { style: 'numeric' })).to.equal('5/5');
    });

    it('should be worded by a format when there is one', () => {
      expect(
        indicator(1, 5, { format: (n, of) => `Page ${n} of ${of}`, style: 'numeric' })
      ).to.equal('Page 2 of 5');
    });

    it('should say 1/1 for a result set with nothing in it', () => {
      expect(indicator(0, 0, { style: 'numeric' })).to.equal('1/1');
    });
  });

  describe('both', () => {
    it('should be the dots and then the number', () => {
      expect(indicator(1, 3, { style: 'both' })).to.equal('○ ● ○ 2/3');
    });

    it('should use the format for the number', () => {
      expect(indicator(0, 2, { format: (n) => `#${n}`, style: 'both' })).to.equal('● ○ #1');
    });
  });

  describe('too many pages for dots', () => {
    it('should fall back to the number by default after ten', () => {
      expect(indicator(0, 10)).to.equal('● ○ ○ ○ ○ ○ ○ ○ ○ ○');
      expect(indicator(2, 11)).to.equal('3/11');
    });

    it('should be the number alone for both, rather than a row of dots and the number', () => {
      expect(indicator(2, 11, { style: 'both' })).to.equal('3/11');
    });

    it('should draw dots up to the limit it is given', () => {
      expect(indicator(0, 4, { maxDots: 3 })).to.equal('1/4');
      expect(indicator(0, 3, { maxDots: 3 })).to.equal('● ○ ○');
      expect(indicator(0, 20, { maxDots: 20 })).to.equal(`●${' ○'.repeat(19)}`);
    });

    it('should format the fallback the way the numeric form is', () => {
      expect(indicator(0, 40, { format: (n, of) => `${n} of ${of}` })).to.equal('1 of 40');
    });
  });

  describe('colour', () => {
    it('should write nothing but the text at colour level 0', () => {
      expect(indicator(1, 3, { style: 'both' })).not.to.contain(ESC);
    });

    it('should draw the current dot in the accent and the others muted', () => {
      const out = pageIndicator(1, 3, { ...plain, colorLevel: 1 });

      expect(out).to.contain(ESC);
      // the three dots are three runs of two roles: removing the colour leaves the text
      expect(strip(out)).to.equal('○ ● ○');
      const [before, active, after] = [out.indexOf('○'), out.indexOf('●'), out.lastIndexOf('○')];
      expect(before).to.be.lessThan(active);
      expect(active).to.be.lessThan(after);
      // the filled dot is not in the style of the hollow ones around it
      expect(out.slice(before, active)).not.to.equal(out.slice(active, after));
    });

    it('should let a theme restyle the dots by their class', () => {
      const out = pageIndicator(1, 3, {
        ...plain,
        colorLevel: 1,
        theme: '.sigil-paginator-active { color: magenta }',
      });
      const base = pageIndicator(1, 3, { ...plain, colorLevel: 1 });

      expect(out).not.to.equal(base);
      expect(strip(out)).to.equal('○ ● ○');
    });
  });
});

describe('paginatorView()', () => {
  /** Builds a view that redraws as it is written to, and reads it as text. */
  function drive(
    state: ReturnType<typeof paginatorState>,
    opts: PageIndicatorOptions = {}
  ): { dispose: () => void; read: () => string } {
    const scope = createEffects();
    scope.setScheduler((run) => run());
    const cascade = themedCascade({ colorLevel: 0 });
    let element!: ReturnType<typeof paginatorView>;
    const dispose = createRoot(
      (release) => {
        element = paginatorView(state, { ascii: false, ...opts });
        return release;
      },
      scope.effect,
      (error) => {
        throw error;
      }
    );

    return {
      dispose,
      read: () => renderToString(element, { cascade, colorLevel: 0, width: 40 }),
    };
  }

  it('should draw the page the state is on', () => {
    const state = paginatorState({ page: 1, perPage: 5, total: 15 });
    const it = drive(state);

    expect(it.read()).to.equal('○ ● ○');
    it.dispose();
  });

  it('should redraw when the page turns', () => {
    const state = paginatorState({ perPage: 5, total: 15 });
    const it = drive(state);

    expect(it.read()).to.equal('● ○ ○');
    state.page.set(1);
    expect(it.read()).to.equal('○ ● ○');
    state.page.set(2);
    expect(it.read()).to.equal('○ ○ ●');
    it.dispose();
  });

  it('should redraw with more dots when the total grows, and fewer when it shrinks', () => {
    const state = paginatorState({ perPage: 5, total: 10 });
    const it = drive(state);

    expect(it.read()).to.equal('● ○');
    state.total.set(20);
    expect(it.read()).to.equal('● ○ ○ ○');
    state.total.set(5);
    expect(it.read()).to.equal('●');
    it.dispose();
  });

  it('should redraw when the page size changes the number of pages', () => {
    const state = paginatorState({ perPage: 5, total: 10 });
    const it = drive(state);

    state.perPage.set(2);
    expect(it.read()).to.equal('● ○ ○ ○ ○');
    it.dispose();
  });

  it('should show the last page rather than one that is not there', () => {
    const state = paginatorState({ perPage: 5, total: 10 });
    const it = drive(state);

    state.page.set(40);
    expect(it.read()).to.equal('○ ●');
    it.dispose();
  });

  it('should switch to the number when the dots stop fitting, and back', () => {
    const state = paginatorState({ perPage: 1, total: 4 });
    const it = drive(state);

    expect(it.read()).to.equal('● ○ ○ ○');
    state.total.set(30);
    expect(it.read()).to.equal('1/30');
    state.total.set(4);
    expect(it.read()).to.equal('● ○ ○ ○');
    it.dispose();
  });

  it('should draw both when asked, and keep the number current', () => {
    const state = paginatorState({ perPage: 5, total: 15 });
    const it = drive(state, { style: 'both' });

    expect(it.read()).to.equal('● ○ ○ 1/3');
    state.page.set(2);
    expect(it.read()).to.equal('○ ○ ● 3/3');
    it.dispose();
  });

  it('should read the same as the string for the same page', () => {
    const state = paginatorState({ page: 2, perPage: 5, total: 20 });
    const it = drive(state, { style: 'both' });

    expect(it.read()).to.equal(indicator(2, 4, { style: 'both' }));
    it.dispose();
  });

  it('should stop redrawing once it is disposed', () => {
    const state = paginatorState({ perPage: 5, total: 15 });
    const it = drive(state);

    it.dispose();
    state.page.set(2);
    expect(it.read()).to.equal('● ○ ○');
  });
});
