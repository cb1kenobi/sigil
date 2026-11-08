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

The selection keeps its row, not its process: when a refresh re-sorts the
table, the highlight stays where you left it and the processes move under it.
`x` names the process on that row when you press it, and that is the process a
Yes is checked against, wherever it has moved by then.

`x` refuses pid 1, which is init (`launchd`, `systemd`), and the monitor's own
pid, without asking. While the confirm is open the process may exit and its pid
go to another, so Yes waits for any reading in flight, takes a fresh one, and
sends the signal only if that reading has the same process under the pid: the
same pid and start time, which is `starttime` from `/proc/<pid>/stat` on Linux
and `ps`'s `lstart` on macOS. Otherwise the footer says `has exited: nothing
sent`, and if the fresh reading fails it says `not checked, nothing sent`. `x`
does nothing while the footer says `checking pid ...`. Two gaps are left. `lstart` is to the second, so on macOS a pid reused
within the second its last owner started is not caught. And a reuse in the
milliseconds between that fresh reading and the signal cannot be caught without
a pidfd, which Node does not offer.

Process memory on Linux is `/proc/<pid>/stat`'s rss, which is counted in pages.
The page size is a kernel setting (4 KiB on x86-64, 16 or 64 KiB on many arm64
and ppc64 kernels), so it comes from `getconf PAGESIZE`, asked once, with 4 KiB
only if `getconf` cannot answer.

A reading that takes longer than the one-second interval is not overlapped:
the tick that arrives while one is in flight is skipped. A reading whose process
list cannot be read (`ps` or the `/proc` walk failed) is reported in the footer
until the next one lands, and the table keeps what it had rather than showing
no processes. A failed `netstat`, `/proc/net/dev` or `vm_stat` is not an
error: the rates read zero and memory falls back to `os.freemem()`. Quitting
ends a reading in flight, and a kill waiting on one: on macOS it kills the
`ps`, `netstat` or `vm_stat` still running, and on Linux the `/proc` walk stops
at the next file, so the shell comes back at once.

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

`t` calls `app.setTheme()` with the next theme `@ttylabs/sigil/themes` ships, and
`sigil` -- the framework's own colours -- is `setTheme(undefined)`. The runner
replaces its theme sheet in place and the screen follows, so a dialog, which is
appended beside the root, takes the theme too, and nothing is scoped under a
class or restated to keep the last theme from leaking through: what the old theme
set and the new one does not is gone with its sheet.

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
node inside it. Besides style, a template knows `class`, `focusable`, `id`,
`key`, `selectable` and `tabindex` (`ReservedProps` in
`packages/sigil/src/template/props.ts`), and it has no `ref`. A function in any
other prop is a reactive getter: the template calls it while it builds and
takes what it returns as a style value. So `onKey=${(e) => e.stop()}` throws a
`TypeError` during the build, a function returning a string throws
`StyleError: Unknown property "onKey"`, and one returning nothing is called and
dropped. A handler goes on an element you already hold: the root a template
returns, which is how `App` takes its keys (`root.onKey = ...`), or a node built
with `box()`. `ProcessTable` needs `onResize` and `onMouse` on its body, which
is inside it, so it is built by hand.

The app's own keys are on `App`'s root `onKey` rather than router bindings: a
binding sees every key before a focused field does, so `q` typed into the
filter would quit. A layer of app keys a focused field outranks is SIG-308.

## Not yet

- A JSX version, which waits for SIG-275's build. It will sit beside this one
  so the two frontends can be compared on a real app.
- Per-process detail, a tree view, and disks.
- Windows.
