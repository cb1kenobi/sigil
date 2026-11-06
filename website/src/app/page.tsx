import { CellGrid } from '@/components/cell-grid';
import { CodeBlock } from '@/components/code-block';
import { Glow } from '@/components/glow';
import { HomeScreen, ScreenPreview } from '@/components/home-screen';
import { InstallCommand } from '@/components/install-command';
import { Seal } from '@/components/seal';
import {
  ACCESSIBLE_MODE_HREF,
  COMPONENT_CARDS,
  HOME_LEDE,
  TODO_FILE,
  componentHref,
  todoSource,
  WRITING_CARD,
} from '@/lib/home';
import { jsonLd, pageMetadata, softwareSourceCode } from '@/lib/seo';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = pageMetadata({ path: '/', description: HOME_LEDE });

/** The four tags over the hero's heading. */
const TAGS = ['TypeScript', 'Zero dependencies', 'Batteries included', 'Open source'];

/** Inline code in a lede, drawn the way the docs draw it. */
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-kbd border border-line-panel bg-surface-2 px-[5px] py-px font-mono text-[0.88em] text-fg-code">
      {children}
    </code>
  );
}

/** The small line over a section's heading. */
function Eyebrow({ children, link = false }: { children: ReactNode; link?: boolean }) {
  return <p className={link ? 'eyebrow text-link' : 'eyebrow'}>{children}</p>;
}

/** The eyebrow, heading and lede that open a section below the heroes. */
function SectionIntro({
  children,
  eyebrow,
  id,
  title,
}: {
  children?: ReactNode;
  eyebrow: string;
  id: string;
  title: string;
}) {
  return (
    <div className="flex max-w-[720px] min-w-0 flex-col gap-4">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="text-section" id={id}>
        {title}
      </h2>
      {children}
    </div>
  );
}

/** An arrow that is part of a link's look and not of its name. */
function Arrow() {
  return <span aria-hidden="true">→</span>;
}

/** The outlined button: a second action beside a primary one, or a section's one action. */
const OUTLINE_BUTTON =
  'flex items-center gap-2 rounded-control border border-line-strong px-5 text-[15px] font-semibold text-fg hover:border-fg-body hover:text-fg-strong';

/** A card in the Agents section. */
const AGENT_CARD =
  'flex min-w-0 flex-[1_1_420px] flex-col gap-4 rounded-panel border border-line-panel bg-surface p-7';

/**
 * The home page, in six sections.
 *
 * Every terminal and sample on it is something the repository produced: the
 * screens are captures (`src/transcripts/home/screens.json`, written by
 * `scripts/capture-transcripts.ts`) and the source is `src/content/home/todo.mjs`,
 * the very file the parser, completion and agent screens were captured from.
 * Nothing here is typed output. The page renders inside the layout's `<main>`.
 */
export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(softwareSourceCode()) }}
      />

      {/* 1. The framework */}
      <section aria-labelledby="hero-title" className="relative overflow-hidden">
        <CellGrid at="68% 45%" size="75% 90%" variant="radial" />
        <Glow at="76% 50%" size="42% 55%" variant="radial" />
        <Seal
          className="pointer-events-none absolute -top-[70px] -right-[150px] text-brand/14 max-sm:opacity-60"
          size={784}
        />
        <div className="layout-page relative flex flex-wrap items-center gap-16 pt-16 pb-20 sm:pt-[104px] sm:pb-28">
          <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-7">
            <ul aria-label="Highlights" className="flex flex-wrap gap-2">
              {TAGS.map((tag) => (
                <li
                  className="flex items-center gap-2 rounded-tag border border-line-tag bg-chip px-[11px] py-[5px] font-mono text-xs text-fg-body"
                  key={tag}
                >
                  <span aria-hidden="true" className="size-1.5 bg-link" />
                  {tag}
                </li>
              ))}
            </ul>
            <h1
              className="text-[44px] leading-[1.05] tracking-[-0.035em] sm:text-display sm:leading-none"
              id="hero-title"
            >
              Command-line apps in TypeScript, with nothing else to install.
            </h1>
            <p className="lede-hero max-w-[32em]">{HOME_LEDE}</p>
            <div className="flex flex-wrap items-center gap-3">
              <InstallCommand location="home-hero" package="framework" />
              <Link
                className="flex h-[50px] items-center rounded-control bg-brand px-[22px] text-[15px] font-semibold text-brand-fg hover:brightness-110"
                href="/docs/getting-started"
              >
                Read the docs
              </Link>
            </div>
          </div>
          <div className="min-w-0 flex-[1_1_520px]">
            <HomeScreen
              cwd="~/shop"
              id="hero"
              label="A prompt part of the way through being answered"
              shadow
              size="hero"
            />
          </div>
        </div>
      </section>

      {/* 2. The CLI */}
      <section
        aria-labelledby="cli-title"
        className="relative overflow-hidden border-t border-line bg-band"
      >
        <CellGrid alpha={0.1} at="25% 50%" size="60% 85%" stops={[15, 75]} variant="radial" />
        <Glow at="24% 50%" size="38% 55%" variant="radial" />
        <div className="layout-page relative flex flex-wrap-reverse items-center gap-16 py-16 sm:py-[104px]">
          <div className="min-w-0 flex-[1_1_520px]">
            <HomeScreen
              cwd="~"
              id="cli"
              label="The sigil command's help screen"
              shadow
              size="hero"
            />
          </div>
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-6">
            <Eyebrow link>The sigil CLI</Eyebrow>
            <h2
              className="text-[34px] leading-[1.05] tracking-[-0.03em] sm:text-headline"
              id="cli-title"
            >
              Create, build and package from the terminal.
            </h2>
            <p className="lede max-w-[30em] text-[18px]">
              The sigil command creates an app, copies components into it so you own them, checks
              it, builds it into a bundle that depends on nothing, and packages it as a single
              executable.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <InstallCommand location="home-cli" package="cli" />
              <Link className={`h-[50px] ${OUTLINE_BUTTON}`} href="/reference">
                CLI reference <Arrow />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 3. The parser */}
      <section aria-labelledby="parser-title" className="border-t border-line">
        <div className="layout-page flex flex-col gap-10 py-16 sm:py-24">
          <SectionIntro
            eyebrow="The parser"
            id="parser-title"
            title="Write the commands once. Help and completion follow."
          >
            <p className="lede">
              An alias in the name, like <Code>'list, ls'</Code>, shows in help and completion. One
              in the <Code>alias</Code> property still runs the command but stays out of both.
            </p>
          </SectionIntro>
          <div className="flex flex-wrap items-start gap-6">
            <div className="min-w-0 flex-[1_1_480px] [&>figure]:mt-0">
              <CodeBlock code={todoSource()} lang="javascript" title={TODO_FILE} />
            </div>
            <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-6">
              <HomeScreen cwd="~/todo" id="parser" label="todo --help" />
              <HomeScreen
                copy="todo completion bash"
                cwd="~/todo"
                id="completion"
                label="Shell completion for todo"
                shell="bash"
              />
            </div>
          </div>
        </div>
      </section>

      {/* 4. Components */}
      <section aria-labelledby="components-title" className="border-t border-line">
        <div className="layout-page flex flex-col gap-10 py-16 sm:py-24">
          <div className="flex flex-wrap items-end gap-6">
            <div className="min-w-0 flex-[1_1_520px]">
              <SectionIntro
                eyebrow="Components"
                id="components-title"
                title="From one question to a full-screen app."
              >
                <p className="lede">
                  Prompts, status output and full-screen elements share a layout engine and a style
                  sheet, so a theme restyles all of them, help included.
                </p>
              </SectionIntro>
            </div>
            <Link className={`h-11 ${OUTLINE_BUTTON}`} href="/docs/components">
              All components <Arrow />
            </Link>
          </div>
          <ul className="flex flex-wrap gap-5">
            {COMPONENT_CARDS.map((card) => (
              <li className="flex min-w-0 flex-[1_1_360px]" key={card.slug}>
                <Link
                  className="flex w-full min-w-0 flex-col overflow-hidden rounded-panel border border-line-panel bg-surface hover:border-line-strong"
                  href={componentHref(card.slug)}
                >
                  <ScreenPreview id={card.screen} />
                  <span className="flex flex-col gap-1.5 px-5 pt-4 pb-5">
                    <span className="font-mono text-sm font-bold text-fg-strong">{card.name}</span>
                    <span className="text-small text-muted">{card.description}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 5. Agents */}
      <section aria-labelledby="agents-title" className="border-t border-line bg-band">
        <div className="layout-page flex flex-col gap-10 py-16 sm:py-24">
          <SectionIntro
            eyebrow="Agents"
            id="agents-title"
            title="Easy for an agent to write, safe for an agent to run."
          />
          <div className="flex flex-wrap items-stretch gap-6">
            <div className={AGENT_CARD}>
              <h3>Writing sigil code</h3>
              <p className="text-base leading-[1.65] text-fg-body">{WRITING_CARD.body}</p>
              <Link
                className="mt-auto self-start pt-2 text-[15px] font-semibold text-link hover:text-fg-strong"
                href={WRITING_CARD.href}
              >
                {WRITING_CARD.link} <Arrow />
              </Link>
            </div>
            <div className={AGENT_CARD}>
              <h3>Running a sigil CLI</h3>
              <p className="text-base leading-[1.65] text-fg-body">
                A prompt with no terminal to read from fails at once with a message, instead of
                waiting for a key that never comes. An agent running your CLI gets an error it can
                act on, not a hang.
              </p>
              <HomeScreen cwd="~/todo" id="agent" label="A prompt failing with no terminal" wrap />
            </div>
          </div>
        </div>
      </section>

      {/* 6. Accessible mode */}
      <section aria-labelledby="a11y-title" className="border-t border-line">
        <div className="layout-page flex flex-wrap items-center gap-14 pt-16 pb-20 sm:pt-24 sm:pb-28">
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-4">
            <Eyebrow>Accessible mode</Eyebrow>
            <h2 className="text-section" id="a11y-title">
              Every prompt has a form a screen reader can follow.
            </h2>
            <p className="lede">
              A screen reader can't make sense of a region that redraws. With accessible mode on,
              each prompt asks on plain lines instead: the question, the choices, then one line of
              input. It's opt-in, never guessed from the terminal.
            </p>
            <a
              className="self-start text-[15px] font-semibold text-link hover:text-fg-strong"
              href={ACCESSIBLE_MODE_HREF}
            >
              Read about accessible mode <Arrow />
            </a>
          </div>
          <div className="flex min-w-0 flex-[1.4_1_560px] flex-wrap gap-5">
            <div
              aria-labelledby="a11y-rendered"
              className="flex min-w-0 flex-[1_1_260px] flex-col gap-2.5"
              role="group"
            >
              <p className="font-mono text-xs text-muted" id="a11y-rendered">
                Rendered
              </p>
              <HomeScreen cwd="~" id="rendered" label="The prompt, rendered" wrap />
            </div>
            <div
              aria-labelledby="a11y-accessible"
              className="flex min-w-0 flex-[1_1_260px] flex-col gap-2.5"
              role="group"
            >
              <p className="font-mono text-xs text-muted" id="a11y-accessible">
                Accessible
              </p>
              <HomeScreen cwd="~" id="accessible" label="The prompt, in accessible mode" wrap />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
