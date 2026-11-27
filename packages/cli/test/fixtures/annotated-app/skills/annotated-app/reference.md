# `annotated-app`

## Usage

```
annotated-app <command>
```

Lists the commands under it and takes no action of its own.

## Subcommands

| Command | Description |
| --- | --- |
| `annotated-app plain` | Declares nothing about what it does |
| `annotated-app status` | Show the status |
| `annotated-app wipe` | Delete everything |

---

# `annotated-app plain`

Declares nothing about what it does

## Usage

```
annotated-app plain
```

---

# `annotated-app status`

Show the status

## Usage

```
annotated-app status
```

Read-only: it changes nothing. Idempotent: running it again with the same input changes nothing more.

---

# `annotated-app wipe`

Delete everything

## Usage

```
annotated-app wipe
```

Destructive: it may delete or overwrite data.
