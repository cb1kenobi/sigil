// Run by `runOnTerminal({ run })`, which is the half `source` cannot cover: a
// real app is a file on disk, and what has to work is that node is handed a path
// rather than a `-e` string.
process.stdout.write(`tty=${process.stdout.isTTY === true}\n`);
