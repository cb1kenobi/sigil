# What is sigil?

sigil is a batteries-included CLI framework that provides everything you need to build the best
command line application. It is the product of analyzing dozens of CLI frameworks, libraries, and
toolkits from the Node.js, Rust, C++, Python, and Go ecosystems, then packaging the best parts into
a single, cohesive framework.

## The story of sigil

In the early days of Node.js-based CLIs, there were a few different libraries for parsing command
line arguments, printing colors to the terminal, spinners, and prompts. Often, developers combined
these libraries, and sometimes rolled their own solution, to create a CLI. As time would
tell, the Node.js ecosystem would be hit multiple times by rogue package maintainers and supply
chain attacks.

Back in 2015, [Chris Barber](https://github.com/cb1kenobi) wrote a CLI framework called `cli-kit`.
It was essentially only a command line parser with support for commands, subcommands, and automatic
help generation. The breakthrough was it could parse arguments dynamically and out-of-order thanks
to a multi-pass parser that descends a tree of commands and subcommands.

In 2017, Chris wrote `snooplogg`, the world's best debug logging library, followed in 2020 by
`config-kit` for configuration and `check-kit` for update checks.

However, none of these formed a single cohesive framework. In 2023, Chris started reimagining the
next-generation version of `cli-kit`, written in TypeScript, with a hierarchical parser, dynamic
commands, ANSI helpers, a terminal interface, paths, and a hook system. It was called `main2`.

Progress on `main2` stalled, but the dream was still alive. Then in 2026, with the help of
AI-assisted engineering, the project was resurrected and renamed to `sigil`. The mission changed
from being a framework to being the Next.js for CLIs where an optimized CLI is compiled and packaged
into a single binary for distribution.
