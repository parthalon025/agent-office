// The Agent Office adapter for Paperclip (#200, ADR 0010). Paperclip loads this folder as an external adapter plugin
// (adapter-plugin contract: the package entry exports createServerAdapter). It runs inside Paperclip; the office never imports it.
// When Paperclip wakes an employee whose adapter is `agent_office`, execute() hands the run to the office (run.js), which runs it with
// the employee's agent kind under the Security room, and reports result, usage, cost and transcript back.
//
// Install (docs/paperclip.md): as the board, POST /api/adapters on Paperclip with { "localPath": "<office folder>/src/integrations/paperclip-adapter" },
// and give the adapter the office token file: AGENT_OFFICE_TOKEN_FILE in Paperclip's environment (the office sets it when it starts
// Paperclip), or `tokenFile` in an agent's adapter config.
// Plain JavaScript with no imports from Paperclip, so nothing is installed for it (the OpenClaw plugin does the same).
import fs from 'node:fs/promises';
import { createRunner } from './run.js';

export const type = 'agent_office';
export const label = 'Agent Office';
export const models = [];
export const agentConfigurationDoc = `# agent_office configuration
Use when: the employee should run with Agent Office watching every call (Security room, Needs you, a room per agent).
Don't use when: Agent Office is not running on this computer. The run then fails at once and says so.
Core fields:
- agentKind (string, default claude-code): the office agent kind that runs the employee (claude-code, codex, gemini, ollama, ...).
- model (string, optional): the model for that kind.
- cwd (absolute path): the folder the employee works in. Default: the workspace Paperclip gives the run.
- isolation (same | worktree, default same): worktree opens the run in a new git worktree of its own.
- promptTemplate (string, optional): the run prompt. {{agent.name}} and {{agent.id}} are filled in.
- tokenFile (path, optional): the office token file. Default: the AGENT_OFFICE_TOKEN_FILE environment variable.
The office decides every call by its Security room rules. A call it asks the user about waits in Needs you, so a run can wait a long time.
`;

const runner = createRunner({ env: () => process.env, readFile: (file) => fs.readFile(file, 'utf8') });

export function createServerAdapter() {
  return {
    type, models, agentConfigurationDoc,
    execute: runner.execute,
    testEnvironment: runner.testEnvironment,
    supportsLocalAgentJwt: false,
  };
}
