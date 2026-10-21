---
title: "sigil reference"
path: ["reference"]
description: "Write a markdown command reference, or a snapshot of the command surface"
---

# `sigil reference`

Write a markdown command reference, or a snapshot of the command surface

## Usage

```
sigil reference [options] [dir]
```

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
| `--out [path]` | `string` | Where it goes: a directory for the pages, a file for --json. Overrides sigil.json |

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
