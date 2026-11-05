# System monitor

A full-screen system monitor in the shape of btop and htop: a sparkline per
CPU core, memory and network over time, and a process table that refreshes
every second.

```
node examples/system-monitor/src/main.js
```

It needs a terminal on both ends (stdin and stdout), and `pnpm build` first,
since it imports `@ttylabs/sigil` by name. It reads the system with no
dependencies: `os` for cores and memory, `vm_stat`, `ps` and `netstat` on
macOS, `/proc` on Linux. Windows is not supported.

| Key          | Does                                                         |
| ------------ | ------------------------------------------------------------ |
| ↑ ↓, `j` `k` | Move the selection                                           |
| PgUp PgDn    | Move by a page                                               |
| Home End     | First and last process                                       |
| `s`          | Cycle the sort column: CPU, memory, pid, name                |
| `/`          | Filter by name, user or pid; Enter keeps it, Escape drops it |
| `x`          | Send SIGTERM to the selected process, after a confirm        |
| `t`          | Cycle the themes `@ttylabs/sigil/themes` ships               |
| `q`, Ctrl-C  | Quit                                                         |

The selection follows its process, not its row: when a refresh re-sorts the
table, the process you were about to kill stays selected.

## Layout

| File               | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `src/main.js`      | The wiring: TTY check, full-screen backend, renderer, router, quit         |
| `src/app.js`       | `App`, the whole screen, written in the `ui` tag                           |
| `src/stand-ins.js` | Components sigil does not have yet (below)                                 |
| `src/sampler.js`   | Reads the system once a tick and turns two readings into rates             |
| `src/data.js`      | Pure parsers and helpers, tested against fixtures                          |
| `test/`            | The parsers, the sampler over a fake machine, the app over a fake terminal |

`App` knows nothing about where it is drawn, so `test/app.test.js` mounts it
over `createTestTerminal()` with a sampler and a clock the test drives, and
presses keys at it. `pnpm test` from this directory runs those tests.

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
- **The shell** stands in for SIG-276. The router is created after the tree it
  routes, so `App` takes it later through a signal (`shell`), and `main.js` is
  wiring that a runner should replace.

## Not yet

- A JSX version, which waits for SIG-275's build. It will sit beside this one
  so the two frontends can be compared on a real app.
- Per-process detail, a tree view, and disks.
- Windows.
