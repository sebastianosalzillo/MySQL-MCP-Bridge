# AI Prompt Manager + Scheduler (preview)

The standalone Database MCP Bridge has an **optional**, **independent** AI scheduler.

## Three AI engines

Each task can select \`opencode\`, \`claude\` (Claude Code CLI) or \`codex\` (Codex CLI).
Each engine must be installed and authenticated under the **Windows service account**.
The scheduler runs processes without launching shells, records results in the
protected \`automation.stateDir/reports\` folder and maintains its history and
task definitions in local JSON files.

## Pass shared instructions: ON or OFF

The dashboard has a per-task \`includeInstructions\` checkbox.
- **ON**: launch the selected AI engine from the managed \`workspaces/with-instructions\`
  folder, containing current \`AGENTS.md\` (OpenCode/Codex) and \`CLAUDE.md\` (Claude Code).
- **OFF**: launch it from sibling \`workspaces/without-instructions\` which has **neither**
  managed project instruction file. The MCP connections remain configured in both folders.

This controls **only the dashboard-managed project instructions**. It does not override
system prompts, organization policies, home-directory / global instructions,
user-level tool permissions, or any configuration that the external AI app loads.
If you open Claude Code or Codex manually in an unrelated folder, the project
instructions are not injected automatically merely by connecting to the MCP.

The AI dashboard exposes both absolute workspace paths. Launch any engine manually
from the desired folder to select the policy:
\`\`\`powershell
cd "C:\ProgramData\DatabaseMCPBridge\ai\workspaces\with-instructions"
codex
# OR:
cd "C:\ProgramData\DatabaseMCPBridge\ai\workspaces\without-instructions"
claude
\`\`\`

Do not copy any password or token into project configuration. Provide
\`MCP_BEARER_TOKEN\` to the service identity for the MCP connection.

## Enable in the standalone config

See \`config/automation.example.json\`, which includes:
\`\`\`json
"automation": {
  "enabled": true,
  "stateDir": "C:\\ProgramData\\DatabaseMCPBridge\\automation",
  "adminPort": 3002,
  "adminToken": "\${MCP_AI_ADMIN_TOKEN}",
  "timeZone": "Europe/Rome",
  "runTimeoutMs": 300000
}
\`\`\`

The standalone service creates \`127.0.0.1:3002\` admin endpoints for
instructions, tasks, run-now and history. This API is **not** exposed through
ngrok and needs the separate \`MCP_AI_ADMIN_TOKEN\` (minimum 24 characters).
In Electron select **AI Agents + Scheduler** and type the admin token locally
(the UI does not persist it).

The scheduler supports hourly, daily and weekly schedules, with one task at a
time and a maximum of 100 tasks. Newly added tasks are disabled until enabled.
Executions use the current shared instructions, and are logged in history.
No tasks or passwords are published to the MCP protocol.

**Safety:** the MySQL account must still be SELECT-only. The AI CLI restrictions
are defense in depth, not an OS sandbox for every provider. Validate all three
CLI integrations, Access file snapshots, local token authentication and
Windows service restart with test data before enabling unattended production.
