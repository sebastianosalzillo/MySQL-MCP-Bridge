# Windows standalone MCP server (read-only)

This is an additive first phase. The same `server/mcpBridge.mjs` can run without Electron. The existing Electron app still works and manages its own embedded MCP server; **Electron does not yet manage or configure a running standalone service**.

## PowerShell setup

1. Install Node.js 22+, clone the repository, run `npm ci`.
2. Copy `config/standalone.example.json` to `config/standalone.json` (ignored by Git). Set MySQL host/port/database and a dedicated **SELECT-only** MySQL user.
3. In the PowerShell process where you will start the bridge, set credentials and a bearer token:

```powershell
$secret = Read-Host "MySQL read-only password" -AsSecureString
$env:MCP_MYSQL_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:MCP_BEARER_TOKEN = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
npm run start:server -- --config config/standalone.json
```

4. Verify `http://127.0.0.1:3001/health` locally. Clients connect to `http://127.0.0.1:3001/mcp` with an `Authorization: Bearer` token.
5. Ctrl+C stops the standalone process. Closing Electron does not stop it. Only one server may bind port 3001 at a time.

## Running without a logged-in user

A Node.js process is **not** a native Windows service. To start automatically on boot, install a Windows service wrapper such as [WinSW](https://github.com/winsw/winsw), using a dedicated low-privilege account. Here is an *illustrative* WinSW XML for a source checkout installed at `C:\MySQL-MCP-Bridge`:

```xml
<service>
  <id>MySQLMCPBridge</id>
  <name>MySQL MCP Bridge</name>
  <description>Read-only MCP bridge</description>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>server\standalone.mjs --config "C:\ProgramData\MySQLMCPBridge\standalone.json"</arguments>
  <workingdirectory>C:\MySQL-MCP-Bridge</workingdirectory>
  <log mode="roll-by-size" />
  <onfailure action="restart" delay="10 sec" />
</service>
```

Provision `MCP_MYSQL_PASSWORD` and `MCP_BEARER_TOKEN` **for the service identity**, not merely your own interactive shell. Use protected secret storage / account environment and locked-down NTFS ACLs; never embed raw secrets in the XML or commit them. Verify the wrapper's current installation instructions and test startup/recovery under the service identity before enabling it.

The headless server deliberately does not decrypt Electron's `safeStorage` file: the Windows DPAPI encryption scope may belong to a different account. An external file with plaintext passwords must be restricted by ACL, because the standalone runner does not encrypt such files.

## Security and scope

- Standalone requires `accessMode: "read"` and enforces multi-statement and file-access guards. You **must** also restrict the MySQL account to SELECT, because the SQL classifier is not a complete database security boundary.
- ngrok requires a non-empty bearer token. Review the exposure of confidential business data before enabling a tunnel.
- The existing `select_rows` tool enforces `selectLimit`, but `execute_sql` can return unbounded query results: do not run heavy AI queries against live production until an output cap has been added.
- This first phase does not include multi-server MySQL, Microsoft Access `.mdb` / `.accdb`, or a standalone service control panel within Electron. Those remain separate planned changes.
