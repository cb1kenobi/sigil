# The story of sigil

TODO(Chris): the lede, one or two sentences on who makes sigil and why it exists. This paragraph is also the page's description in search results and on its social card.

## Where it came from

**TODO(Chris):** sigil is the successor to cli-kit. Say when cli-kit started, what it was for, and what years of it taught. The Titanium CLI was the acceptance test for sigil's parser; for 1.0 the `sigil` CLI itself is written in sigil and takes over that role. The mockup's "Its first real program is the Titanium CLI" is not right, so do not carry it over.

## Timeline

**TODO(Chris):** a date for each row, in whatever form suits it (a year, a month and a year), and reword, add or drop rows as the story needs. The rows are the ticket's placeholders. Check the third: the root `AGENTS.md` says the Titanium port follows the toolchain rather than leading it, so it may not have happened yet.

<!-- as timeline -->

- **TODO(Chris)** cli-kit's first release
- **TODO(Chris)** Work on sigil starts
- **TODO(Chris)** The Titanium CLI runs on sigil
- **TODO(Chris)** The `sigil` CLI is written in sigil
- **TODO(Chris)** The first public release

## How it's made

**TODO(Chris):** a draft from what the repository shows today, for you to rewrite in your own words. Each point links to where it can be checked.

<!-- as points -->

- **Decisions are recorded.** The root [`AGENTS.md`](../AGENTS.md#deliberate-decisions--do-not-fix-these) keeps a list of deliberate decisions, behaviour that looks like a bug and is not, each one covered by a test, and an `AGENTS.md` beside each subsystem keeps that subsystem's. [`docs/history/`](history/) holds the write-up behind each major feature: 24 records today, from the faked TTY to `sigil package`.
- **Changes are reviewed.** Work is planned as an issue and lands through a pull request whose title names it. The [pull requests](https://github.com/cb1kenobi/sigil/pulls?q=is%3Apr+is%3Amerged) are public on GitHub.
- **The docs are tested.** [`packages/cli/test/guides.test.ts`](../packages/cli/test/guides.test.ts) replays [Getting started](../packages/sigil/docs/getting-started.md): it writes each file the guide shows, runs the app's commands, and fails when the output is not what the page prints, so an example cannot drift from the code. [`markdown-links.test.ts`](../packages/sigil/test/markdown-links.test.ts) follows every relative link in the repository's markdown, this page's included.
- **Accessibility is designed.** Every built-in prompt but `editor()` and the command palette's list has a line form for screen readers: the question written once, what is typed echoed, nothing redrawn. Each was worked out for its prompt, [the first six](../packages/sigil/src/components/AGENTS.md#accessible-mode-the-prompts-as-lines-in-and-lines-out) in SIG-177 and the rest in SIG-227 and SIG-228.

## Where AI fits

**TODO(Chris):** say plainly how AI tools are used to build sigil: which work they do, and what a person always decides or reviews. Being specific here is more convincing than leaving it out.

## TTY Labs

**TODO(Chris):** who TTY Labs is.

<!-- as github -->

[github.com/cb1kenobi/sigil](https://github.com/cb1kenobi/sigil)
