---
title: "sigil add"
path: ["add"]
description: "Copy a component into your app, so you own it"
---

# `sigil add`

Copy a component into your app, so you own it

## Usage

```
sigil add [options] [components...]
```

## Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `[components...]` | `string...` | The components to copy in. With none, lists what the registry has |

## Options

| Option | Type | Description |
| --- | --- | --- |
| `--dir [path]` | `string` | Where they land, overriding sigil.json and the convention |
| `--force` | `bool` | Overwrite a file that is already there |
| `-y, --yes` | `bool` | Write without asking |
