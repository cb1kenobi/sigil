import { runApp } from '@ttylabs/sigil/app';
import { DataTable } from '@ttylabs/sigil/components/data-table';

const app = runApp(() =>
  DataTable({
    rows: [
      { pid: 1, user: 'root', cpu: 0.1, mem: 0.2, command: 'launchd' },
      { pid: 412, user: 'chris', cpu: 12.5, mem: 3.1, command: 'node server.js' },
      { pid: 907, user: 'postgres', cpu: 4.2, mem: 8.6, command: 'postgres: writer' },
      { pid: 1180, user: '_windowserver', cpu: 31.2, mem: 2.4, command: 'WindowServer' },
      { pid: 2216, user: 'chris', cpu: 0.3, mem: 0.1, command: 'zsh' },
    ],
    key: (p) => p.pid,
    columns: [
      { key: 'pid', header: 'PID', align: 'right' },
      { key: 'user', header: 'USER', priority: -1 },
      { key: 'cpu', header: 'CPU%', align: 'right', descendingFirst: true },
      { key: 'mem', header: 'MEM%', align: 'right', descendingFirst: true },
      { key: 'command', header: 'COMMAND', grow: 1, minWidth: 8 },
    ],
    sort: { column: 'cpu', descending: true },
  })
);

process.exitCode = await app.exited;
