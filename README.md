# MySQL MCP Bridge

Windows desktop application that connects a **MySQL** server to **MCP (Model Context Protocol)** clients. The bridge exposes a local MCP Streamable HTTP endpoint and, optionally, publishes it through **ngrok**.

> Status: `0.1.0`. Supports MySQL 5.6 through 9.x. Before using it against a production database, test on a copy and create a MySQL user with the minimum privileges required.
>
> The previous Italian version of this document is kept in [README.it.md](./README.it.md).

## What it does

- Connects to any MySQL server, including MySQL-compatible forks, over TCP, a Windows named pipe, or a Unix socket.
- Local MCP endpoint at `http://127.0.0.1:3001/mcp` (port configurable).
- Optional HTTPS tunnel through ngrok, with authtoken and a fixed domain.
- `READ ONLY`, `READ + WRITE` and `ADMIN` modes.
- Optional whitelist of the tables visible to the tools.
- Maximum SELECT limit, query timeout, multi-statement blocking.
- UPDATE/DELETE without WHERE blocked by default.
- One-shot approvals from the UI for UPDATE, DELETE and DDL.
- Local SQL console.
- MySQL password, ngrok authtoken and MCP bearer token stored with Electron `safeStorage` (DPAPI on Windows when available).
- Logs of MCP calls and queries, without writing secrets into the log.

## MySQL version compatibility

Version detection runs once at connection time and drives the behaviour of every tool. The detected version, its capabilities and any limitations are returned by the `mysql_server_info` tool, shown in the app after **Test connection**, and written to the log at startup.

| Feature | Minimum version | Behaviour on older servers |
| --- | --- | --- |
| Connection and introspection | 5.6 | supported baseline |
| `DATETIME DEFAULT` / `ON UPDATE CURRENT_TIMESTAMP` | 5.6.5 | rejected by `create_table` with an explicit message |
| `JSON` column type | 5.7.8 | rejected by `create_table`, use `LONGTEXT` instead |
| InnoDB index keys of 3072 bytes | 5.7.7 | 767 byte limit; `create_index` computes a prefix length automatically |
| `utf8mb4_0900_ai_ci` collation | 8.0 | the connection retries with `utf8mb4_general_ci` |
| Common table expressions (`WITH`) | 8.0 | the syntax is rejected by the server |
| Expression column defaults | 8.0.13 | only literal defaults are accepted |
| `ALGORITHM=INSTANT` for `ADD COLUMN` | 8.0.12 | `INPLACE` and `COPY` remain available from 5.6 |
| Enforced `CHECK` constraints | 8.0.16 | constraints are parsed and ignored |
| `utf8` treated as `utf8mb3` | 8.0.28 | no deprecation warning |

The following servers are recognised explicitly, including the awkward version strings they report:

- `5.7.44-log`, `8.0.32-0ubuntu0.20.04.2`, `5.7.44-48` (Percona)
- `5.5.5-10.6.18-MariaDB`, the replication compatibility prefix used by MariaDB
- `8.0.mysql_aurora.3.04.0` (Amazon Aurora)

Compatibility gates live in `server/mysqlVersion.mjs`, version parsing in `server/mysqlVersion.mjs`, and the connection layer in `server/mysqlManager.mjs`.

### TLS on older servers

MySQL 5.6 boxes usually present a self-signed certificate. A bare `ssl: {}` fails against them, because the driver defaults to `rejectUnauthorized: true`, so TLS is configured explicitly:

| Mode | Behaviour |
| --- | --- |
| `off` | plaintext |
| `required` | encrypted, certificate not verified. The practical default for a self-signed 5.6 server |
| `verify-ca` | certificate chain verified against your CA file |
| `verify-full` | chain and hostname verified |

Pre-2019 servers may also need `minTlsVersion = TLSv1` and `ciphers = DEFAULT@SECLEVEL=0`, both available in the **Advanced** section.

When **Retry with weaker TLS settings** is enabled, the bridge tries, in order: your settings, an unverified certificate, TLSv1 with legacy ciphers, then no TLS. Every attempt is logged, so a downgraded connection is never silent. Disable the option to fail instead of downgrading.

## Connection settings

| Setting | Purpose |
| --- | --- |
| Host / Port | TCP endpoint |
| Socket path | Windows named pipe such as `\\.\pipe\mysql`, or a Unix socket. Takes precedence over host and port |
| Connection collation | `utf8mb4` is the portable default. `utf8mb4_0900_ai_ci` requires MySQL 8.0+ |
| TLS mode | see above |
| CA / certificate / key files | for TLS and mutual TLS |
| Minimum TLS version | `TLSv1` for legacy servers |
| TLS ciphers | `DEFAULT@SECLEVEL=0` for legacy servers |
| Authentication plugin | leave on automatic unless the handshake fails |
| Server public key | skips the RSA round-trip; works with hosts that block key retrieval |
| Session time zone | a UTC offset such as `+00:00`, which avoids any dependency on the `mysql.time_zone*` tables |
| Session SQL mode | empty keeps the server default |
| `group_concat_max_len` | the server default of 1024 silently truncates aggregated text |

The client pins `timezone` to UTC and reads `DATE` and `DATETIME` as strings, so temporal values are not shifted by the difference between the server's zone and yours.

## MCP tools included

### Reading

- `mysql_server_info` — version, SQL mode, capabilities, compatibility warnings
- `list_databases`
- `list_tables`
- `describe_table`
- `show_create_table` — the exact DDL the server reports
- `get_foreign_keys`
- `select_rows`
- `explain_query` — execution plan without running the statement

### Writing

- `insert_rows`
- `update_rows`
- `delete_rows`

### Administration

- `create_database`
- `drop_database`
- `create_table`
- `drop_table`
- `add_column`
- `drop_column`
- `modify_column`
- `create_index`
- `drop_index`
- `execute_sql`

`execute_sql` always respects the access level. Administrative statements require ADMIN mode plus the **Enable free administrative SQL** option.

### Filtering

`where` in `select_rows`, `update_rows` and `delete_rows` accepts plain values, arrays for `IN`, or a single operator. Every value is bound as a parameter and never interpolated:

| Input | Produces |
| --- | --- |
| `{ id: 3 }` | `` `id` = ? `` |
| `{ tags: ['a', 'b'] }` | `` `tags` IN (?, ?) `` |
| `{ age: { $gte: 18 } }` | `` `age` >= ? `` |
| `{ name: { $like: 'a%' } }` | `` `name` LIKE ? `` |
| `{ r: { $between: [1, 5] } }` | `` `r` BETWEEN ? AND ? `` |
| `{ deleted: null }` | `` `deleted` IS NULL `` |
| `{ deleted: { $isNotNull: true } }` | `` `deleted` IS NOT NULL `` |

Operators are `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$like`, `$notLike`, `$in`, `$between`, `$isNull`, `$isNotNull`.

## Architecture

```text
ChatGPT / Claude / MCP client
              |
              | HTTPS
              v
        ngrok (optional)
              |
              v
  http://127.0.0.1:3001/mcp
              |
       MCP Streamable HTTP
              |
   version detection + guardrails
              |
              v
            mysql2
              |
              v
        MySQL Server
```

The MySQL server is **never exposed to the internet**. ngrok only forwards the local MCP HTTP server.

## Development requirements

- Windows 10/11 x64
- Node.js 22 or newer recommended
- npm
- An ngrok account if you want the public endpoint

## Running in development

```powershell
npm install
npm run dev
```

## Building the Windows installer

From PowerShell:

```powershell
.\build.ps1
```

or:

```powershell
npm install
npm run dist:win
```

The installer is produced in `release/`.

## First run

1. Enter the MySQL host/IP, port, database, user and password. Leave host and port alone if the server listens on a named pipe or socket.
2. Press **Test connection**. The detected version and its capabilities appear in the panel below.
3. Choose the MCP access mode.
4. Enter the ngrok authtoken.
5. The ngrok domain is optional. If your account has a development domain, set it to force that URL.
6. Press **Start MCP**.
7. Copy the public URL, for example `https://example.ngrok-free.app/mcp`, and configure it in your MCP client.

## Approvals

When an MCP client attempts a sensitive operation, the tool replies with:

```json
{
  "approval_required": true,
  "approval_id": "...",
  "status": "pending"
}
```

The user approves it in the desktop app. The client then repeats the same call passing `approval_id`. Each approval is single use and expires after 5 minutes.

## Security

Recommendations:

- use a dedicated MySQL user;
- avoid `GRANT ALL` unless it is genuinely needed;
- use READ ONLY for analysis and reporting;
- use the table whitelist for sensitive databases;
- enable ADMIN only when you need to change the schema;
- do not disable the WHERE requirement on real databases;
- do not commit `.env`, configuration files or tokens;
- if the MCP client supports an `Authorization` header, set the bearer token as well.

### What the guardrails block

- multi-statement SQL;
- `INTO OUTFILE`, `INTO DUMPFILE` and `LOAD_FILE()`;
- `SLEEP()` and `BENCHMARK()`, unless explicitly allowed;
- `DELETE` or DDL hidden behind a leading `WITH`, such as `WITH c AS (SELECT 1) DELETE FROM t`. MySQL 8 accepts this syntax, so the statement that actually runs is detected rather than the `WITH` keyword;
- `CALL` and `DO`, which can execute arbitrary procedure and function code, and are therefore treated as ADMIN.

### MCP transport

The endpoint is bound to `127.0.0.1` and the `Host` and `Origin` headers are pinned to the local interface plus the live ngrok host, which blocks DNS rebinding. Responses use `application/json` by default, which is what most remote MCP clients expect; the SSE stream remains available by turning off **Answer with application/json**.

### Note on the bearer token

Not every MCP client can be configured with an arbitrary Bearer header, which is why it is optional. For a public or multi-user deployment, add an OAuth flow matching the client's requirements instead of exposing an anonymous endpoint.

## Tests

```powershell
npm test          # unit tests: classification, guards, version parsing, capability gates
npm run lint
npm run build:renderer
npm run check     # all three
```

### Cross-version matrix

`tests/compat.matrix.mjs` boots one container per MySQL generation, detects the version through the real connection layer and drives the real tool handlers against each server, then prints a version by capability matrix.

```powershell
npm run test:matrix                       # all targets
npm run test:matrix -- 5.6 8.0            # only matching targets
npm run test:matrix -- --allow-skip       # exit 0 when Docker is unavailable
```

It requires Docker, and the MySQL 5.6 images are amd64 only. It is kept out of `npm run check` because of that.

## GitHub

The project includes a `.gitignore` that excludes:

- `node_modules`
- installers and build output
- `.env`
- local configuration
- ngrok tokens
- logs
- certificates and keys
- local databases

`.github/workflows/windows-release.yml` is also included. Creating a tag, for example:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

makes GitHub Actions attempt to build the Windows installer and attach it to the release.

## MCP

The bridge uses Streamable HTTP, the recommended transport for remote MCP servers. The endpoint is `/mcp` and accepts MCP POST requests.

## License

MIT.

## Standalone Windows service (preview)

Run this MCP bridge without Electron using `npm run start:server -- --config config/standalone.json`. See [Windows standalone setup](docs/standalone-windows.md). The desktop app continues to work independently; remote Electron management is not yet implemented.

## Preview: multi-source read-only bridge

The independent Node.js service can expose multiple sources through one MCP endpoint using the `sources` configuration array:
- MySQL: per-source hostname, port, database and credentials.
- Microsoft Access: `.mdb` and `.accdb` snapshots using Java 11+ and UCanAccess.

Only `list_sources`, `list_tables`, `describe_table`, `select_rows` and MySQL-only `read_query` are exposed in multi-source mode. The standalone service enforces READ ONLY and requires an authenticating bearer token when ngrok is enabled. Use SELECT-only MySQL credentials.

Electron now has a **Standalone Sources** tab to edit source profiles, export a `standalone.json` with secret placeholders and inspect the local service health. Export does not restart or install the Windows service.

**Example:** [Multi-source config](config/multi-source.example.json). **Windows setup and limitations:** [Standalone documentation](docs/standalone-windows.md).

**Preview limitations:** Access requires external UCanAccess dependencies and has not been tested on production files; MySQL 5.5 is outside the project's documented support baseline; verify on copies of real databases. The independent Windows service still requires an external wrapper (WinSW), and no production deployment has been performed.
