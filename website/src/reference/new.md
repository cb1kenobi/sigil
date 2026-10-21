---
title: "sigil new"
path: ["new"]
description: "Create a new app"
---

# `sigil new`

Create a new app

## Usage

```
sigil new [options] [project-name]
```

## Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `[project-name]` | `string` | The directory to create, which is also the app name |

## Options

| Option | Type | Description |
| --- | --- | --- |
| `--cwd [dir]` | `string` | Where to create it, defaulting to the working directory |
| `--js` | `bool` | Generate JavaScript files instead of TypeScript |
| `--lint [oxlint\|eslint\|biome\|none]` | `string` | Which linter to set up |
| `--no-git` | `bool` | Do not run git init |
| `--pm [pnpm\|vlt\|npm]` | `string` | Which package manager to set the app up with |
| `--no-install` | `bool` | Do not install dependencies |
| `--single` | `bool` | One command rather than a commands directory |
| `-y, --yes` | `bool` | Take the defaults for anything not passed |
