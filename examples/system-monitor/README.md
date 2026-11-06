# System monitor

A full-screen system monitor in the shape of btop and htop: a sparkline per
CPU core, memory and network over time, and a process table that refreshes
every second.

```
pnpm build
node examples/system-monitor/src/ui.js
```

Or `pnpm start` from this directory. It is written in the `ui` tag, so nothing
compiles it; `pnpm build` is for `@ttylabs/sigil` itself, which it imports by
name. `q` exits 0 and Ctrl-C exits 130. Without a terminal on both ends,
`runApp()` refuses: one line on stderr, exit 1.

It reads the system with no dependencies: `os` for cores and memory,
`vm_stat`, `ps` and `netstat` on macOS, `/proc` on Linux. Windows is not
supported.

| Key          | Does                                                         |
| ------------ | ------------------------------------------------------------ |
| ↑ ↓, `j` `k` | Move the selection                                           |
| PgUp PgDn    | Move by a page                                               |
| Home End     | First and last process                                       |
| `s`          | Cycle the sort column: CPU, memory, pid, name                |
| `/`          | Filter by name, user or pid; Enter keeps it, Escape drops it |
| `x`          | Send SIGTERM to the selected process, after a confirm        |
| `t`          | Cycle the themes `@ttylabs/sigil/themes` ships               |
| `q`          | Quit, with 0                                                 |
| Ctrl-C       | Quit, with 130                                               |

The selection follows its process, not its row: when a refresh re-sorts the
table, the process you were about to kill stays selected.

`x` refuses pid 1, which is init (`launchd`, `systemd`), and the monitor's own
pid, without asking. The table keeps refreshing while the confirm is open, so
when you answer yes the signal is sent only if the latest sample still lists
that pid with the same name and user; a process that exited, or whose pid was
handed to something else, gets `has exited: nothing sent` in the footer. That
check is as good as the latest sample, which is up to a second old.

Process memory on Linux is `/proc/<pid>/stat`'s rss, which is counted in pages.
The page size is a kernel setting (4 KiB on x86-64, 16 or 64 KiB on many arm64
and ppc64 kernels), so it comes from `getconf PAGESIZE`, asked once, with 4 KiB
only if `getconf` cannot answer.

A reading that takes longer than the one-second interval is not overlapped:
the tick that arrives while one is in flight is skipped. Quitting kills any
`ps`, `netstat` or `vm_stat` still running, so the shell comes back at once.

## Layout

| File               | What it is                                                                    |
| ------------------ | ----------------------------------------------------------------------------- |
| `src/ui.js`        | The entry: `main()` for `--help` and `--version`, and `runApp()` as its `run` |
| `src/root.js`      | `App`, the whole screen, and `stylesheet`                                     |
| `src/system.js`    | `SystemContext`: the sampler, the clock and the kill, replaceable in tests    |
| `src/stand-ins.js` | Components sigil does not have yet (below)                                    |
| `src/sampler.js`   | Reads the system once a tick and turns two readings into rates                |
| `src/data.js`      | Pure parsers and helpers, tested against fixtures                             |
| `test/`            | The parsers, the sampler over a fake machine, the app over a fake terminal    |

`App` takes no props. It reaches the router and `exit()` through `useApp()`,
and the machine through `SystemContext`, so `test/app.test.js` runs it with
`runApp()` over `createTestTerminal()`, behind a fake sampler, clock and kill,
and asserts the code it exits with.

## Themes

`t` moves a class on the app's host. Every theme is in `stylesheet` from the
start, each scoped under its own class (`.theme-mono .sigil-accent ...`), the
way a web app puts `.dark` on `<html>`. The class goes on the host rather than
on `App`'s root so that a dialog, which is appended beside the root, follows
the theme too. Switching by adding the theme's sheet to the cascade instead
would mean restating every role so the last theme cannot leak through, because
a cascade has no way to take a sheet back out: SIG-307.

## What is a stand-in

This example was written before the components it wants, on purpose: it is
the caller those tickets are waiting for. Each stand-in is marked in the source
and is the least that works.

- **`Panel`** stands in for SIG-277. The title in the border is a
  `position: absolute` child at `top: -1`. Clipping has to go on an inner box,
  because `overflow: hidden` on the panel itself clips the title away.
- **`LiveChart`** stands in for SIG-284. The charts take an array and a width
  when they are built, so this builds a new chart on every tick for every chart
  on screen, and learns its size through `onResize`.
- **`ProcessTable`** stands in for SIG-281. Its columns are padded strings and
  its rows are a pool of text elements that it rewrites in place.

The stand-ins are built with `box()` and `text()` rather than the `ui` tag for
a reason that is a gap of its own: a template has no way to put a handler on a
node inside it. The props a template knows besides style are `class`,
`focusable`, `id`, `key`, `selectable` and `tabindex` (`ReservedProps` in
`packages/sigil/src/template/props.ts`), and there is no `ref`. Measured,
`` ui`<box onKey=${fn} onResize=${fn}></box>` `` builds without complaint and
attaches neither. A handler goes on an element you already hold: the root a
template returns, which is how `App` takes its keys (`root.onKey = ...`), or a
node built with `box()`. `ProcessTable` needs `onResize` and `onMouse` on its
body, which is inside it, so it is built by hand.

The app's own keys are on `App`'s root `onKey` rather than router bindings: a
binding sees every key before a focused field does, so `q` typed into the
filter would quit. A layer of app keys a focused field outranks is SIG-308.

## Not yet

- A JSX version, which waits for SIG-275's build. It will sit beside this one
  so the two frontends can be compared on a real app.
- Per-process detail, a tree view, and disks.
- Windows.
