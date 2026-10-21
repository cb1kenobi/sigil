---
title: "sigil check"
path: ["check"]
description: "Check an app without building it"
---

# `sigil check`

Check an app without building it

## Usage

```
sigil check [options] [dir]
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
| `--tree` | `bool` | Print the command tree as it resolved |
