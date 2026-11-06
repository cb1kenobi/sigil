/**
 * The pre-launch pass (SIG-273), made repeatable: loads the served site in a
 * headless Chrome at a phone, a tablet and a desktop width, and checks what can
 * only be checked in a browser.
 *
 *   pnpm --filter website build
 *   pnpm --filter website start -p 3273
 *   node scripts/check-pages.ts                    # the representative pages
 *   node scripts/check-pages.ts --all              # every prerendered page
 *   node scripts/check-pages.ts --shots <dir>      # and a full-page PNG of each
 *   node scripts/check-pages.ts --base <url> /docs/parser /reference/add
 *
 * Per page and width:
 *
 * - **Sideways scroll.** `scrollWidth` may not pass the viewport. When it does,
 *   the elements reaching past it, outside any scroll box of their own, are named.
 * - **Landmarks.** One banner, one `main`, one contentinfo, and every visible
 *   `nav` labelled, with no two sharing a label.
 * - **The skip link** is the first stop and lands on `#main`.
 * - **Keyboard.** Tab is pressed until focus comes back round, and every stop
 *   must be visible, carry the 2px `link` ring, and not have that ring cut off
 *   by an ancestor's `overflow`. No positive `tabindex`.
 * - **Names.** A link, button or tab with no text must have a label.
 * - **Touch targets**, at the phone width: every button, tab, input and
 *   block-level link is at least 44px on each side. A link inside a sentence is
 *   exempt, as WCAG 2.5.5 exempts it.
 * - **Reduced motion.** With `prefers-reduced-motion: reduce` emulated, nothing
 *   is animating and nothing transitions.
 *
 * Contrast is not here: `scripts/check-contrast.ts` checks every token pairing,
 * and Lighthouse's audit (axe) checks what is actually painted.
 *
 * It needs a Chrome (see `scripts/lib/chrome.ts`) and exits 1 on any finding.
 */
import { Browser, findChrome, type Page } from './lib/chrome.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES = [
  '/',
  '/docs/getting-started',
  '/docs/parser',
  '/docs/components',
  '/docs/components/select',
  '/reference',
  '/reference/add',
  '/this-page-does-not-exist',
];

const WIDTHS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'desktop', width: 1280, height: 800, mobile: false },
] as const;

/** The focus ring `globals.css` gives every interactive element: 2px of `--color-link`. */
const RING = { color: 'rgb(183, 162, 255)', width: 2 };

/** The smallest touch target, in CSS pixels, on each side. */
const TOUCH = 44;

/** How many Tab presses before a page is taken to have no end to its tab order. */
const MAX_STOPS = 400;

function args() {
  const argv = process.argv.slice(2);
  let base = 'http://localhost:3273';
  let shots: string | undefined;
  let all = false;
  const pages: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--base') base = argv[++i]!;
    else if (arg === '--shots') shots = argv[++i]!;
    else if (arg === '--all') all = true;
    else pages.push(arg);
  }
  return { base: base.replace(/\/$/, ''), shots, all, pages };
}

/** Every page `next build` prerendered, which is every page there is. */
function prerendered(): string[] {
  const manifest = fileURLToPath(new URL('../.next/prerender-manifest.json', import.meta.url));
  const { routes } = JSON.parse(readFileSync(manifest, 'utf8')) as { routes: object };
  return Object.keys(routes)
    .filter((route) => !/opengraph-image|icon|manifest|sitemap|robots|^\/_/.test(route))
    .concat('/this-page-does-not-exist')
    .sort();
}

/*
 * What runs in the page. It is serialised with `toString()`, so it can use
 * nothing from this module and has to be plain JavaScript once types are gone.
 */

function inPage(touch: number, ring: { color: string; width: number }) {
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const label = el.getAttribute('aria-label');
    const text = (label ?? (el as HTMLElement).innerText ?? el.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}>${text ? ` "${text}"` : ''}`;
  };

  const visible = (el: Element) =>
    el.checkVisibility({ opacityProperty: false, visibilityProperty: true }) &&
    el.getClientRects().length > 0;

  /** The scroll or clip box an element sits in, short of the page itself. */
  const clipper = (el: Element): Element | undefined => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return p;
    }
    return undefined;
  };

  /** The text a reader would hear for an element, short of ARIA's whole algorithm. */
  const name = (el: Element): string => {
    const label = el.getAttribute('aria-label') ?? el.getAttribute('title');
    if (label?.trim()) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      return by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
    }
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof Element)) return '';
      if (node.getAttribute('aria-hidden') === 'true') return '';
      if (node instanceof HTMLImageElement) return node.alt;
      return [...node.childNodes].map(walk).join('');
    };
    return walk(el).trim();
  };

  // Sideways scroll, and what causes it.
  const width = document.documentElement.clientWidth;
  const overflow =
    document.documentElement.scrollWidth > width
      ? [...document.body.querySelectorAll('*')]
          .filter((el) => visible(el) && el.getBoundingClientRect().right > width + 0.5)
          .filter((el) => !clipper(el))
          .filter(
            (el) =>
              !el.parentElement || el.parentElement.getBoundingClientRect().right <= width + 0.5
          )
          .slice(0, 8)
          .map(describe)
      : [];

  // Landmarks.
  const landmarks: string[] = [];
  const banners = [...document.querySelectorAll('header, [role=banner]')].filter(
    (el) => visible(el) && !el.closest('main, article, aside, nav, section')
  );
  const mains = [...document.querySelectorAll('main, [role=main]')].filter(visible);
  const footers = [...document.querySelectorAll('footer, [role=contentinfo]')].filter(
    (el) => visible(el) && !el.closest('main, article, aside, nav, section')
  );
  if (banners.length !== 1) landmarks.push(`${banners.length} banners`);
  if (mains.length !== 1) landmarks.push(`${mains.length} mains`);
  if (footers.length !== 1) landmarks.push(`${footers.length} contentinfos`);
  const navs = [...document.querySelectorAll('nav, [role=navigation]')].filter(visible);
  const labels = navs.map((nav) => name(nav) && nav.getAttribute('aria-label'));
  navs.forEach((nav, i) => {
    if (!labels[i]) landmarks.push(`unlabelled nav ${describe(nav)}`);
  });
  for (const label of new Set(labels.filter(Boolean))) {
    if (labels.filter((l) => l === label).length > 1)
      landmarks.push(`two navs labelled "${label}"`);
  }

  // Names.
  const unnamed = [...document.querySelectorAll('a[href], button, [role=tab], input, select')]
    .filter((el) => visible(el) && !name(el) && !(el as HTMLInputElement).labels?.length)
    .map(describe);

  const positive = [...document.querySelectorAll('[tabindex]')]
    .filter((el) => Number(el.getAttribute('tabindex')) > 0)
    .map(describe);

  /**
   * What a tap lands on: the element's box, grown by an absolutely positioned
   * `::before` or `::after`, which is how a control is given a bigger target
   * than it is drawn.
   */
  const hitBox = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.position !== 'absolute') continue;
      const px = (v: string) => (v.endsWith('px') ? parseFloat(v) : 0);
      // Insets are from the padding box, which is the border box less the border.
      const inner = {
        left: rect.left + el.clientLeft,
        top: rect.top + el.clientTop,
        right: rect.left + el.clientLeft + el.clientWidth,
        bottom: rect.top + el.clientTop + el.clientHeight,
      };
      box.left = Math.min(box.left, inner.left + px(ps.left));
      box.top = Math.min(box.top, inner.top + px(ps.top));
      box.right = Math.max(box.right, inner.right - px(ps.right));
      box.bottom = Math.max(box.bottom, inner.bottom - px(ps.bottom));
    }
    return box;
  };

  /*
   * Touch targets. A control -- a button, a tab, a field, and the links that are
   * drawn as controls: the header's, the menu's, the segmented control's -- is
   * held to 44px. Any other link that is not inside a sentence is held to WCAG
   * 2.5.8: 24px, or a 24px circle on its centre that touches no other target.
   */
  const small: string[] = [];
  if (touch) {
    const CONTROL =
      'button, [role=tab], input:not([type=hidden]), select, summary, header a[href], dialog a[href], nav[aria-label=Families] a[href]';
    const targets = [...document.querySelectorAll(`${CONTROL}, a[href]`)].filter(
      (el) =>
        visible(el) &&
        !el.matches('.sr-only') &&
        !el.closest('[aria-hidden=true]') &&
        !(el.tagName === 'A' && getComputedStyle(el).display === 'inline')
    );
    const boxes = targets.map(hitBox);
    targets.forEach((el, i) => {
      const box = boxes[i]!;
      const [w, h] = [Math.round(box.right - box.left), Math.round(box.bottom - box.top)];
      if (el.matches(CONTROL)) {
        if (w < touch || h < touch) small.push(`${describe(el)} ${w}×${h}`);
        return;
      }
      if (w >= 24 && h >= 24) return;
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const crowded = boxes.some((other, j) => {
        if (j === i) return false;
        const dx = Math.max(other.left - cx, 0, cx - other.right);
        const dy = Math.max(other.top - cy, 0, cy - other.bottom);
        return Math.hypot(dx, dy) < 12;
      });
      if (crowded) small.push(`${describe(el)} ${w}×${h}, under 24px and crowded`);
    });
  }

  // The focus check, which the script calls once per Tab press.
  (window as unknown as { __focus: () => unknown }).__focus = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return { body: true };
    // The ring is read as it ends up: `transition-colors` carries
    // `outline-color`, so straight after the press it is mid-fade.
    for (const animation of el.getAnimations()) animation.finish();
    const style = getComputedStyle(el);
    const problems: string[] = [];
    if (!visible(el)) problems.push('not visible');
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) problems.push('zero size');
    if (
      style.outlineStyle !== 'solid' ||
      Math.abs(parseFloat(style.outlineWidth) - ring.width) > 0.1 ||
      style.outlineColor !== ring.color
    ) {
      problems.push(`ring is ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`);
    } else {
      const out = parseFloat(style.outlineOffset) + ring.width;
      const ringBox = {
        left: rect.left - out,
        top: rect.top - out,
        right: rect.right + out,
        bottom: rect.bottom + out,
      };
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ps = getComputedStyle(p);
        const clipX = ps.overflowX !== 'visible';
        const clipY = ps.overflowY !== 'visible';
        if (!clipX && !clipY) continue;
        const box = p.getBoundingClientRect();
        const inner = {
          left: box.left + p.clientLeft,
          top: box.top + p.clientTop,
          right: box.left + p.clientLeft + p.clientWidth,
          bottom: box.top + p.clientTop + p.clientHeight,
        };
        const cut =
          (clipX && (ringBox.left < inner.left - 0.5 || ringBox.right > inner.right + 0.5)) ||
          (clipY && (ringBox.top < inner.top - 0.5 || ringBox.bottom > inner.bottom + 0.5));
        // A box that scrolls only cuts the ring where the element is at its edge,
        // which is the case this is looking for.
        if (cut) {
          problems.push(`ring cut by ${describe(p)}`);
          break;
        }
      }
    }
    return { id: describe(el), problems };
  };

  return { overflow, landmarks, unnamed, positive, small };
}

/** What is still moving under `prefers-reduced-motion: reduce`. */
function moving() {
  const found: string[] = [];
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    const animated = style.animationName !== 'none' && parseFloat(style.animationDuration) > 0;
    const transitions = style.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
    if (animated || transitions) {
      found.push(
        `<${el.tagName.toLowerCase()} class="${String(el.getAttribute('class')).slice(0, 60)}"> ${
          animated ? `animation ${style.animationName}` : `transition ${style.transitionProperty}`
        }`
      );
    }
  }
  return [...new Set(found)].slice(0, 8);
}

type Audit = ReturnType<typeof inPage>;

async function load(page: Page, url: string): Promise<void> {
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url });
  await loaded;
  await page.evaluate('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 150)))');
}

async function tab(page: Page): Promise<void> {
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

type Stop = { body?: true; id?: string; problems?: string[] };

async function walkTabs(page: Page): Promise<{ stops: string[]; findings: string[] }> {
  const stops: string[] = [];
  const findings: string[] = [];
  for (let i = 0; i < MAX_STOPS; i++) {
    await tab(page);
    const stop = await page.evaluate<Stop>('window.__focus()');
    if (stop.body) {
      if (stops.length) break;
      continue;
    }
    if (stops.length && stop.id === stops[0]) break;
    stops.push(stop.id!);
    for (const problem of stop.problems ?? []) findings.push(`${stop.id}: ${problem}`);
  }
  if (stops.length >= MAX_STOPS) findings.push(`no end to the tab order after ${MAX_STOPS} stops`);
  return { stops, findings };
}

async function main() {
  const { base, shots, all, pages: named } = args();
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome found. Set CHROME to the browser to drive.');
    process.exit(2);
  }
  const pages = named.length ? named : all ? prerendered() : PAGES;
  if (shots) mkdirSync(shots, { recursive: true });

  const browser = await Browser.launch(chrome);
  const page = await browser.newPage();
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  let failures = 0;
  try {
    for (const path of pages) {
      for (const viewport of WIDTHS) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: shots ? 2 : 1,
          mobile: viewport.mobile,
        });
        // A phone is a touch screen, which is what `pointer: coarse` asks about.
        await page.send('Emulation.setTouchEmulationEnabled', {
          enabled: viewport.mobile,
          maxTouchPoints: 5,
        });
        const pointer = viewport.mobile
          ? [
              { name: 'pointer', value: 'coarse' },
              { name: 'hover', value: 'none' },
            ]
          : [];
        await page.send('Emulation.setEmulatedMedia', { features: pointer });
        await load(page, `${base}${path}`);

        const audit = await page.evaluate<Audit>(
          `(${inPage.toString()})(${viewport.width < 640 ? TOUCH : 0}, ${JSON.stringify(RING)})`
        );
        const { stops, findings: focus } = await walkTabs(page);

        await page.send('Emulation.setEmulatedMedia', {
          features: [...pointer, { name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        const motion = await page.evaluate<string[]>(`(${moving.toString()})()`);

        const findings = [
          ...audit.overflow.map((el) => `sideways scroll: ${el}`),
          ...audit.landmarks.map((l) => `landmarks: ${l}`),
          ...audit.unnamed.map((el) => `no accessible name: ${el}`),
          ...audit.positive.map((el) => `positive tabindex: ${el}`),
          ...audit.small.map((el) => `touch target under ${TOUCH}px: ${el}`),
          ...(stops[0]?.includes('Skip to content') ? [] : [`first stop is ${stops[0]}`]),
          ...focus.map((f) => `focus: ${f}`),
          ...motion.map((m) => `moves under reduced motion: ${m}`),
        ];
        failures += findings.length;
        const verdict = findings.length ? 'FAIL' : 'pass';
        console.log(`${verdict}  ${path} @ ${viewport.width}px  (${stops.length} tab stops)`);
        for (const finding of findings) console.log(`        ${finding}`);

        if (shots) {
          const { data } = await page.send<{ data: string }>('Page.captureScreenshot', {
            captureBeyondViewport: true,
          });
          const file = `${path.replace(/^\//, '').replace(/\//g, '_') || 'home'}-${viewport.width}.png`;
          writeFileSync(join(shots, file), Buffer.from(data, 'base64'));
        }
      }
    }
  } finally {
    page.close();
    await browser.close();
  }

  console.log(failures ? `\n${failures} finding(s).` : '\nNo findings.');
  process.exit(failures ? 1 : 0);
}

await main();
