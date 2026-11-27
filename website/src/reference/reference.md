---
title: "sigil reference"
path: ["reference"]
description: "Write a markdown command reference, a snapshot of the command surface, or its input schemas"
---

# `sigil reference`

Write a markdown command reference, a snapshot of the command surface, or its input schemas

## Usage

```
sigil reference [options] [dir]
```

Idempotent: running it again with the same input changes nothing more.

## Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `[dir]` | `string` | The app's root, defaulting to the working directory |

## Options

| Option | Type | Description |
| --- | --- | --- |
| `--check` | `bool` | Compare rather than write, and exit non-zero if anything moved |
| `--entry [file]` | `string` | The module declaring the app's schema, when the conventions find the wrong one |
| `--json` | `bool` | Print a stable snapshot of the command surface rather than markdown |
| `--json-schema` | `bool` | Print each runnable command's input as JSON Schema, for a tool that calls the app |
| `--out [path]` | `string` | Where it goes: a directory for the pages or the skill, a file for --json or --json-schema. Overrides sigil.json |
| `--skill` | `bool` | Write an agent skill for the app: a SKILL.md and its reference, in skills/\<name\> unless --out says |

## Examples

Print the whole reference as one document

```
sigil reference
```

Write a page per command

```
sigil reference --out docs/reference
```

Fail when the committed snapshot is not what the app's surface says

```
sigil reference --json --out command-surface.json --check
```

Print what each command takes, for an agent or a tool definition

```
sigil reference --json-schema
```

Write the app's own agent skill

```
sigil reference --skill
```
