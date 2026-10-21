---
title: "sigil build"
path: ["build"]
description: "Build an app into a bundle that depends on nothing"
---

# `sigil build`

Build an app into a bundle that depends on nothing

## Usage

```
sigil build [options] [dir]
```

## Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `[dir]` | `string` | The app's root, defaulting to the working directory |

## Options

| Option | Type | Description |
| --- | --- | --- |
| `--bin [file]` | `string` | An executable of your own, bundled instead of a generated one |
| `--commands [dir]` | `string` | The app's command directory, when its entry does not say |
| `--entry [file]` | `string` | The module declaring the app's schema, when the conventions find the wrong one |
| `--external [pkg]` | `string` | A package to import rather than inline, for one carrying a native binding (may be repeated) |
| `--name [name]` | `string` | What the built executable is called. Defaults to the name in package.json |
| `--no-clean` | `bool` | Keep what is already in the output directory |
| `--no-shake` | `bool` | Keep every utility rule, rather than only the ones the source can name |
| `--no-sourcemap` | `bool` | Skip the sourcemaps, which are several times the size of the code |
| `--out [dir]` | `string` | Where the bundle goes, relative to the app (default: dist) |
