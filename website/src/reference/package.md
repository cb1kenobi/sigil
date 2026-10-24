---
title: "sigil package"
path: ["package"]
description: "Build an app and compile it into a single executable"
---

# `sigil package`

Build an app and compile it into a single executable

## Usage

```
sigil package [options] [dir]
```

## Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `[dir]` | `string` | The app's root, defaulting to the working directory |

## Options

| Option | Type | Description |
| --- | --- | --- |
| `--commands [dir]` | `string` | The app's command directory, when its entry does not say |
| `--entry [file]` | `string` | The module declaring the app's schema, when the conventions find the wrong one |
| `--external [pkg]` | `string` | A package to import rather than inline, for one carrying a native binding (may be repeated) |
| `--name [name]` | `string` | What the binary is called. Defaults to the name in package.json |
| `--no-clean` | `bool` | Keep what is already in the output directory |
| `--no-shake` | `bool` | Keep every utility rule, rather than only the ones the source can name |
| `--out [dir]` | `string` | Where the binary goes, relative to the app (default: dist) |
| `--runtime [bun\|node]` | `string` | Which runtime the binary embeds. Required, here or in sigil.json |
| `--sign [identity]` | `string` | A codesigning identity for macOS. Ad-hoc by default, which is what makes it run |
| `--target [target]` | `string` | A <platform>-<arch> to build for, repeatable. Defaults to this machine (may be repeated) |
