# @main2/cli

The main2 toolchain. It will compile templates and stylesheets, resolve the
command tree, and package a CLI app into something that ships with no
dependencies. Today it is a skeleton — see Status below.

This package may depend on whatever it needs — rollup and friends — because it
is a devDependency of the app, not part of what the app ships. The runtime it
compiles against, [`main2`](../main2), stays at zero dependencies.

There is no `main2 dev`. This is a resolver and a compiler, not a server.

## Status

Skeleton. The package exists, provides the `main2` bin, and answers `--version`
and `--help`; the commands are not written yet.

| Command       | Ticket |
| ------------- | ------ |
| `main2 build` | M2-73  |
| `main2 add`   | M2-75  |
| `main2 new`   | M2-75  |

Filesystem command routing is M2-74, and M2-78 rebuilds this package with
itself.

## Why it is written in main2

Dogfooding is the acceptance test. A framework whose own toolchain is not
written in it has not been tested by anyone who had to live with it, so this
package uses `main2()` for its own argument parsing from the first commit
rather than acquiring it later.
