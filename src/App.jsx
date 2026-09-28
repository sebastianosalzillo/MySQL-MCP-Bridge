import { useEffect, useMemo, useState } from 'react';

const empty = {
  mysql: { host: '127.0.0.1', port: 3306, database: '', user: '', password: '', ssl: false, connectTimeoutMs: 10000 },
  mcp: { port: 3001, accessMode: 'read', allowedTables: [], selectLimit: 1000, queryTimeoutMs: 30000, blockMultipleStatements: true, requireWhereForUpdateDelete: true, confirmUpdate: true, confirmDelete: true, confirmDdl: true, enableExecuteSql: false, bearerToken: '' },
  ngrok: { enabled: true, authtoken: '', domain: '' }
};

const api = window.bridgeAPI;

export default function App() {
  const [settings, setSettings] = useState(empty);
  const [tab, setTab] = useState('connection');
  const [status, setStatus] = useState({ running: false });
  const [logs, setLogs] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [notice, setNotice] = useState('');
  const [sql, setSql] = useState('SELECT VERSION() AS version;');
  const [sqlResult, setSqlResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getStatus().then(setStatus);
    api.listApprovals().then(setApprovals);
    const offLog = api.onLog(entry => setLogs(prev => [entry, ...prev].slice(0, 500)));
    const offStatus = api.onStatus(setStatus);
    const offApproval = api.onApproval(item => {
      setApprovals(prev => [item, ...prev.filter(x => x.id !== item.id)]);
      setTab('approvals');
    });
    const timer = setInterval(() => api.listApprovals().then(setApprovals), 2500);
    return () => { offLog(); offStatus(); offApproval(); clearInterval(timer); };
  }, []);

  const set = (section, key, value) => setSettings(prev => ({ ...prev, [section]: { ...prev[section], [key]: value } }));

  async function save() {
    setBusy(true); setNotice('');
    try { const saved = await api.saveSettings(settings); setSettings(saved); setNotice('Impostazioni salvate.'); }
    catch (e) { setNotice(`Errore: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setNotice('');
    try {
      const r = await api.testMySql(settings);
      setNotice(`Connessione OK — MySQL ${r.version} — tabelle: ${r.tableCount}`);
    } catch (e) { setNotice(`Connessione fallita: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function start() {
    setBusy(true); setNotice('');
    try { await api.saveSettings(settings); const s = await api.startBridge(); setStatus(s); setNotice('Bridge avviato.'); }
    catch (e) { setNotice(`Avvio fallito: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try { setStatus(await api.stopBridge()); setNotice('Bridge arrestato.'); }
    finally { setBusy(false); }
  }

  async function decide(id, approved) {
    await api.decideApproval(id, approved);
    setApprovals(await api.listApprovals());
  }

  async function runSql() {
    setBusy(true); setSqlResult(null);
    try { setSqlResult(await api.runSql(sql)); }
    catch (e) { setSqlResult({ ok: false, error: e.message }); }
    finally { setBusy(false); }
  }

  const whitelistText = useMemo(() => (settings.mcp.allowedTables || []).join(', '), [settings.mcp.allowedTables]);

  return <div className="app">
    <header>
      <div>
        <h1>MySQL MCP Bridge</h1>
        <p>Collega un server MySQL a client MCP tramite endpoint locale e ngrok.</p>
      </div>
      <div className={`badge ${status.running ? 'online' : ''}`}>{status.running ? 'ONLINE' : 'OFFLINE'}</div>
    </header>

    <nav>
      {[
        ['connection','Connessione'], ['mcp','MCP + ngrok'], ['security','Sicurezza'], ['console','SQL Console'], ['approvals','Approvazioni'], ['logs','Log']
      ].map(([id,label]) => <button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}{id==='approvals' && approvals.filter(a=>a.status==='pending').length ? ` (${approvals.filter(a=>a.status==='pending').length})` : ''}</button>)}
    </nav>

    {notice && <div className="notice">{notice}</div>}

    <main>
      {tab === 'connection' && <section className="panel">
        <h2>Server MySQL</h2>
        <div className="grid two">
          <Field label="Host / IP"><input value={settings.mysql.host} onChange={e=>set('mysql','host',e.target.value)} /></Field>
          <Field label="Porta"><input type="number" value={settings.mysql.port} onChange={e=>set('mysql','port',Number(e.target.value))} /></Field>
          <Field label="Database predefinito"><input value={settings.mysql.database} onChange={e=>set('mysql','database',e.target.value)} placeholder="opzionale" /></Field>
          <Field label="Utente"><input value={settings.mysql.user} onChange={e=>set('mysql','user',e.target.value)} /></Field>
          <Field label="Password"><input type="password" value={settings.mysql.password} onChange={e=>set('mysql','password',e.target.value)} /></Field>
          <Field label="Timeout connessione (ms)"><input type="number" value={settings.mysql.connectTimeoutMs} onChange={e=>set('mysql','connectTimeoutMs',Number(e.target.value))} /></Field>
        </div>
        <Check checked={settings.mysql.ssl} onChange={v=>set('mysql','ssl',v)} label="Usa TLS/SSL per MySQL" />
        <div className="actions"><button onClick={test} disabled={busy}>Test connessione</button><button className="primary" onClick={save} disabled={busy}>Salva</button></div>
        <p className="hint">Password e token vengono salvati tramite Electron safeStorage/DPAPI su Windows, non nel repository Git.</p>
      </section>}

      {tab === 'mcp' && <section className="panel">
        <h2>MCP e ngrok</h2>
        <div className="grid two">
          <Field label="Porta MCP locale"><input type="number" value={settings.mcp.port} onChange={e=>set('mcp','port',Number(e.target.value))} /></Field>
          <Field label="Modalità">
            <select value={settings.mcp.accessMode} onChange={e=>set('mcp','accessMode',e.target.value)}>
              <option value="read">READ ONLY</option><option value="write">READ + WRITE</option><option value="admin">ADMIN</option>
            </select>
          </Field>
          <Field label="ngrok Authtoken"><input type="password" value={settings.ngrok.authtoken} onChange={e=>set('ngrok','authtoken',e.target.value)} /></Field>
          <Field label="Dominio ngrok fisso"><input value={settings.ngrok.domain} onChange={e=>set('ngrok','domain',e.target.value)} placeholder="xxxx.ngrok-free.app (opzionale)" /></Field>
        </div>
        <Check checked={settings.ngrok.enabled} onChange={v=>set('ngrok','enabled',v)} label="Pubblica MCP tramite ngrok" />
        <Field label="Bearer token MCP opzionale"><input type="password" value={settings.mcp.bearerToken} onChange={e=>set('mcp','bearerToken',e.target.value)} placeholder="lascia vuoto se il client non supporta header Authorization" /></Field>
        <div className="actions">
          {!status.running ? <button className="primary" onClick={start} disabled={busy}>Avvia MCP</button> : <button className="danger" onClick={stop} disabled={busy}>Ferma MCP</button>}
          <button onClick={save} disabled={busy}>Salva</button>
        </div>
        <div className="statusbox">
          <Row label="MCP locale" value={status.mcpUrl || '—'} copy />
          <Row label="MCP pubblico" value={status.publicUrl || '—'} copy />
          <Row label="Health" value={status.healthUrl || '—'} copy />
        </div>
      </section>}

      {tab === 'security' && <section className="panel">
        <h2>Sicurezza</h2>
        <div className="grid two">
          <Field label="Limite massimo SELECT"><input type="number" value={settings.mcp.selectLimit} onChange={e=>set('mcp','selectLimit',Number(e.target.value))} /></Field>
          <Field label="Timeout query (ms)"><input type="number" value={settings.mcp.queryTimeoutMs} onChange={e=>set('mcp','queryTimeoutMs',Number(e.target.value))} /></Field>
        </div>
        <Check checked={settings.mcp.blockMultipleStatements} onChange={v=>set('mcp','blockMultipleStatements',v)} label="Blocca query SQL multiple" />
        <Check checked={settings.mcp.requireWhereForUpdateDelete} onChange={v=>set('mcp','requireWhereForUpdateDelete',v)} label="Richiedi WHERE per UPDATE e DELETE" />
        <Check checked={settings.mcp.confirmUpdate} onChange={v=>set('mcp','confirmUpdate',v)} label="Richiedi approvazione per UPDATE" />
        <Check checked={settings.mcp.confirmDelete} onChange={v=>set('mcp','confirmDelete',v)} label="Richiedi approvazione per DELETE" />
        <Check checked={settings.mcp.confirmDdl} onChange={v=>set('mcp','confirmDdl',v)} label="Richiedi approvazione per DDL (CREATE/ALTER/DROP...)" />
        <Check checked={settings.mcp.enableExecuteSql} onChange={v=>set('mcp','enableExecuteSql',v)} label="Abilita SQL amministrativo libero via execute_sql (solo ADMIN)" />
        <Field label="Whitelist tabelle (separata da virgole; vuota = tutte)">
          <textarea value={whitelistText} onChange={e=>set('mcp','allowedTables',e.target.value.split(',').map(x=>x.trim()).filter(Boolean))} rows="3" />
        </Field>
        <div className="warning">La modalità ADMIN può modificare o eliminare strutture e dati. Usa un utente MySQL con i soli privilegi realmente necessari.</div>
        <div className="actions"><button className="primary" onClick={save} disabled={busy}>Salva sicurezza</button></div>
      </section>}

      {tab === 'console' && <section className="panel">
        <h2>SQL Console locale</h2>
        <p className="hint">Rispetta la modalità configurata e il blocco multi-statement. Le approvazioni MCP non sono richieste perché l’azione viene avviata manualmente dall’app.</p>
        <textarea className="sql" value={sql} onChange={e=>setSql(e.target.value)} spellCheck="false" />
        <div className="actions"><button className="primary" onClick={runSql} disabled={busy}>Esegui</button></div>
        {sqlResult && <pre className={sqlResult.ok ? '' : 'error'}>{JSON.stringify(sqlResult, null, 2)}</pre>}
      </section>}

      {tab === 'approvals' && <section className="panel">
        <h2>Richieste di approvazione</h2>
        {!approvals.length && <p className="hint">Nessuna richiesta.</p>}
        <div className="approvalList">
          {approvals.map(a => <article key={a.id} className={`approval ${a.status}`}>
            <div><strong>{a.summary}</strong><span>{a.status}</span></div>
            <code>{a.sql || a.action}</code>
            <small>{a.createdAt}</small>
            {a.status === 'pending' && <div className="actions"><button className="danger" onClick={()=>decide(a.id,false)}>Nega</button><button className="primary" onClick={()=>decide(a.id,true)}>Approva una volta</button></div>}
          </article>)}
        </div>
      </section>}

      {tab === 'logs' && <section className="panel">
        <div className="titleRow"><h2>Log</h2><button onClick={()=>setLogs([])}>Pulisci</button></div>
        <div className="logs">{logs.map((l,i)=><div key={i}><time>{new Date(l.time).toLocaleTimeString()}</time><b>{l.type}</b><span>{JSON.stringify(l.data)}</span></div>)}</div>
      </section>}
    </main>
  </div>;
}

function Field({ label, children }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Check({ checked, onChange, label }) { return <label className="check"><input type="checkbox" checked={!!checked} onChange={e=>onChange(e.target.checked)} /><span>{label}</span></label>; }
function Row({ label, value, copy }) { return <div className="row"><span>{label}</span><code>{value}</code>{copy && value !== '—' && <button onClick={()=>navigator.clipboard.writeText(value)}>Copia</button>}</div>; }
