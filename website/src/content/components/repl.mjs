import { repl, wordCompleter } from '@ttylabs/sigil/components/repl';

const usage = {
  deploy: 'deploy <env> [--dry-run]',
  destroy: 'destroy <env> --force',
  status: 'status',
};

await repl({
  prompt: 'ops> ',
  completer: wordCompleter([
    { label: 'deploy', hint: 'ship a build' },
    { label: 'destroy', hint: 'tear it down' },
    { label: 'status', hint: 'what is running' },
  ]),
  // a function of the line: it says what the command the line starts with wants
  footer: (line) => usage[line.trim().split(/\s+/)[0]],
  onSubmit: (line, { exit }) => {
    if (line === 'quit') {
      exit();
    } else {
      console.log(`ran: ${line}`);
    }
  },
});
