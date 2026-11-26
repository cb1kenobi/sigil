---
name: annotated-app
description: The annotated-app command-line tool. Use it to run annotated-app from an agent: which commands it has, what each one takes and whether it changes anything, and what its errors mean.
---

# `annotated-app`

This skill was written by `sigil reference --skill` from annotated-app's own command declarations, so it describes the version it was generated from. Every option of every command is in [reference.md](reference.md).

## Commands

| Command | What it does | Running it |
| --- | --- | --- |
| `annotated-app plain` | Declares nothing about what it does | -- |
| `annotated-app status` | Show the status | read-only, idempotent |
| `annotated-app wipe` | Delete everything | **destructive** |

"Read-only" changes nothing, "destructive" may delete or overwrite data, and "idempotent" can be run again with the same input safely. A dash is a command that declares none of the three, which says nothing either way: ask before running it where a mistake would cost something.

## Calling it

- **Read the input before guessing it.** `annotated-app schema` prints every command's input as JSON Schema, keyed by the option's destination, with what each command declares about running it as MCP tool annotations; `annotated-app schema <command>` prints one. `annotated-app <command> --help` is the same thing for a person.
- **Pass every value on the command line.** A command that would ask a question on a terminal fails without one instead of waiting, so give it what it would have asked for.
- **Read the exit code.** `0` is success, `2` is a usage error -- the command line was wrong -- and `1` is any other failure. A usage error carries a `code` naming what was wrong: `extra-arguments`, `invalid-value`, `missing-argument`, `missing-option`, `missing-value`, `unexpected-argument`, `unknown-command`, `unknown-option`, `unsupported-format`.
