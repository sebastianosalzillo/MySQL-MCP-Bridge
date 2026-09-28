# MySQL MCP Bridge

Applicazione desktop Windows che collega un server **MySQL** a client compatibili con **MCP (Model Context Protocol)**. Il bridge espone un endpoint MCP Streamable HTTP locale e, opzionalmente, lo pubblica tramite **ngrok**.

> Stato: versione iniziale `0.1.0`. Prima di usarla su database di produzione, testala su una copia e crea un utente MySQL con privilegi minimi.

## Cosa fa

- Connessione a server MySQL configurabili tramite host/IP, porta, database, utente e password.
- Endpoint MCP locale `http://127.0.0.1:3001/mcp` (porta configurabile).
- Tunnel HTTPS opzionale tramite ngrok con Authtoken e dominio assegnato/fisso.
- Modalità `READ ONLY`, `READ + WRITE`, `ADMIN`.
- Whitelist opzionale delle tabelle visibili ai tool.
- Limite massimo SELECT, timeout query, blocco multi-statement.
- Blocco predefinito di UPDATE/DELETE senza WHERE.
- Approvazioni one-shot dall’interfaccia per UPDATE, DELETE e DDL.
- Console SQL locale.
- Password MySQL, Authtoken ngrok e bearer token MCP memorizzati usando `Electron safeStorage` (DPAPI su Windows quando disponibile).
- Log delle chiamate MCP e delle query, senza scrivere segreti nei log.

## Tool MCP inclusi

### Lettura

- `mysql_server_info`
- `list_databases`
- `list_tables`
- `describe_table`
- `get_foreign_keys`
- `select_rows`

### Scrittura

- `insert_rows`
- `update_rows`
- `delete_rows`

### Amministrazione

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

`execute_sql` rispetta sempre il livello di accesso. Le istruzioni amministrative richiedono modalità ADMIN e l’opzione **Abilita SQL amministrativo libero**.

## Architettura

```text
ChatGPT / Claude / client MCP
              |
              | HTTPS
              v
        ngrok (opzionale)
              |
              v
  http://127.0.0.1:3001/mcp
              |
       MCP Streamable HTTP
              |
        guardrail/approval
              |
              v
            mysql2
              |
              v
          MySQL Server
```

Il server MySQL **non viene esposto direttamente su Internet**. ngrok inoltra solo il server HTTP MCP locale.

## Requisiti di sviluppo

- Windows 10/11 x64
- Node.js 22 consigliato
- npm
- Account ngrok se vuoi l’endpoint pubblico

## Avvio in sviluppo

```powershell
npm install
npm run dev
```

## Creazione installer Windows

Da PowerShell:

```powershell
.\build.ps1
```

oppure:

```powershell
npm install
npm run dist:win
```

L’installer viene creato in `release/`.

## Prima configurazione

1. Inserisci host/IP, porta, database, utente e password MySQL.
2. Premi **Test connessione**.
3. Scegli la modalità MCP.
4. Inserisci l’Authtoken ngrok.
5. Il dominio ngrok è opzionale: se il tuo account ha un Development Domain assegnato puoi indicarlo per forzare quell’URL.
6. Premi **Avvia MCP**.
7. Copia l’URL pubblico, ad esempio `https://example.ngrok-free.app/mcp`, e configuralo nel client MCP.

## Approvazioni

Quando un client MCP prova un’operazione configurata come sensibile, il tool risponde con:

```json
{
  "approval_required": true,
  "approval_id": "...",
  "status": "pending"
}
```

L’utente approva nell’app desktop. Il client deve quindi ripetere la stessa chiamata passando `approval_id`. L’approvazione è utilizzabile una sola volta e scade dopo 5 minuti.

## Sicurezza

Consigli:

- usa un utente MySQL dedicato;
- evita `GRANT ALL` se non serve;
- usa READ ONLY per analisi e reportistica;
- usa una whitelist delle tabelle per database sensibili;
- abilita ADMIN solo quando devi modificare lo schema;
- non disabilitare il requisito WHERE su database reali;
- non pubblicare `.env`, file di configurazione o token;
- se il client MCP supporta header `Authorization`, configura anche il bearer token.

### Nota sul bearer token

Non tutti i client MCP consentono di configurare un header Bearer arbitrario. Per questo è opzionale. Per una distribuzione pubblica/multiutente, aggiungi un flusso OAuth conforme alle richieste del client MCP invece di usare un endpoint anonimo.

## GitHub

Il progetto include `.gitignore` per escludere:

- `node_modules`
- installer e build
- `.env`
- configurazioni locali
- token ngrok
- log
- certificati/chiavi
- database locali

È incluso anche `.github/workflows/windows-release.yml`. Creando un tag, ad esempio:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions prova a creare l’installer Windows e ad allegarlo alla Release.

## Compatibilità MySQL

La connessione usa `mysql2`. Server MySQL molto vecchi possono richiedere impostazioni TLS/auth particolari. Il bridge evita sintassi SQL moderna nelle query di introspezione di base, ma la compatibilità effettiva dipende dai privilegi e dalla configurazione del server.

## MCP

Il bridge usa Streamable HTTP, trasporto consigliato per server MCP remoti. L’endpoint è `/mcp` e accetta richieste POST MCP.

## Licenza

MIT.
