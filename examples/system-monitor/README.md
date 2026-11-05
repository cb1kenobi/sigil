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

## Layout

| File               | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `src/ui.js`        | The entry: `process.exitCode = await runApp(App, ...).exited`              |
| `src/root.js`      | `App`, the whole screen, and `stylesheet`                                  |
| `src/system.js`    | `SystemContext`: the sampler, the clock and the kill, replaceable in tests |
| `src/stand-ins.js` | Components sigil does not have yet (below)                                 |
| `src/sampler.js`   | Reads the system once a tick and turns two readings into rates             |
| `src/data.js`      | Pure parsers and helpers, tested against fixtures                          |
| `test/`            | The parsers, the sampler over a fake machine, the app over a fake terminal |

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

The app's own keys are on `App`'s root `onKey` rather than router bindings: a
binding sees every key before a focused field does, so `q` typed into the
filter would quit. A layer of app keys a focused field outranks is SIG-308.

## Not yet

- A JSX version, which waits for SIG-275's build. It will sit beside this one
  so the two frontends can be compared on a real app.
- Per-process detail, a tree view, and disks.
- Windows.
