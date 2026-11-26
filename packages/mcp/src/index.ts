/**
 * `@ttylabs/mcp`: a sigil app's commands as MCP tools, served over stdio
 * (SIG-721).
 *
 * An app adds one command and an agent can then call every other one as a tool:
 *
 * ```js
 * import { mcpCommand } from '@ttylabs/mcp';
 *
 * export default {
 *   name: 'mycli',
 *   commands: { mcp: mcpCommand(), ...commands },
 * };
 * ```
 *
 * `mycli mcp` is the server an MCP client starts. Each runnable command is a tool
 * whose `inputSchema` is `inputSchemas()`'s and whose `annotations` are what the
 * command declares (`readOnly`, `destructive`, `idempotent`). Each call runs in a
 * child process -- the app's own entry, re-run with the hidden `--mcp-call` flag
 * -- which takes the call over an IPC channel and hands the arguments to `main()`
 * as `input`, never as rebuilt argv.
 *
 * A package of its own rather than a part of `@ttylabs/sigil` because that one
 * has no dependencies and MCP's specification moves: keeping the protocol here
 * keeps its churn out of every app that does not serve one.
 */

import { answerCall } from './child.js';
import { CALL_FLAG, serve, type McpOptions } from './server.js';
import type { AnyCommand } from '@ttylabs/sigil';

export { PROTOCOL_VERSIONS, toolName, type McpOptions } from './server.js';

/**
 * The command that serves an app over MCP. Add it to the schema under the name a
 * client will be told to run -- `mcp` is the usual one.
 *
 * Every runnable command but this one, and anything under it, is a tool. A
 * hidden command is not, because hiding a command is the author saying it is not
 * offered; `exclude` leaves out others by their path.
 *
 * @param opts - What to leave out, and the version to report.
 * @returns The command declaration.
 */
export function mcpCommand(opts: McpOptions = {}): AnyCommand {
  return {
    desc: "Serve this app's commands to an agent as MCP tools, over stdin and stdout",
    options: {
      // what the server starts each call's child with. Hidden, because nobody
      // types it: run by hand it waits for a call that never comes over a
      // channel that is not there, and is refused for saying so
      [CALL_FLAG]: { desc: 'Run one tool call handed over by the server', hidden: true },
    },
    async run(state) {
      if (state.argv.mcpCall === true) {
        await answerCall(state);
        return;
      }
      await serve(state, opts);
    },
  };
}
