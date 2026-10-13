import { useEffect, useMemo, useState } from 'react';
import appIcon from '../assets/icon.png';

const empty = {
  mysql: {
    host: '127.0.0.1', port: 3306, database: '', user: '', password: '',
    socketPath: '', collation: 'utf8mb4', tlsMode: 'off',
    caFile: '', certFile: '', keyFile: '', minTlsVersion: '', ciphers: '',
    serverPublicKey: '', authPlugin: 'auto', allowTlsFallback: true,
    sessionTimeZone: '+00:00', sqlMode: '', groupConcatMaxLen: 0,
    connectTimeoutMs: 10000
  },
  mcp: {
    port: 3001, accessMode: 'read', allowedTables: [], selectLimit: 1000,
    queryTimeoutMs: 30000, blockMultipleStatements: true, blockFileAccess: true,
    allowSlowFunctions: false, requireWhereForUpdateDelete: true,
    confirmUpdate: true, confirmDelete: true, confirmDdl: true,
    enableExecuteSql: false, jsonResponses: true, allowedHosts: [],
    allowedOrigins: [], bearerToken: ''
  },
  ngrok: { enabled: true, authtoken: '', domain: '' },
  sources: []
};

const COLLATIONS = [
  ['utf8mb4', 'utf8mb4 (works on every supported server)'],
  ['utf8mb4-unicode', 'utf8mb4_0900_ai_ci (MySQL 8.0+ only)'],
  ['utf8mb4-bin', 'utf8mb4_bin'],
  ['utf8', 'utf8 / utf8mb3'],
  ['latin1', 'latin1'],
  ['utf16', 'utf16'],
  ['utf32', 'utf32'],
  ['binary', 'binary'],
  ['server-default', 'Server default']
];

const TLS_MODES = [
  ['off', 'Off (plaintext)'],
  ['required', 'Required, certificate not verified'],
  ['verify-ca', 'Verify the certificate chain'],
  ['verify-full', 'Verify chain and hostname']
];

const TLS_VERSIONS = [['', 'Node default'], ['TLSv1', 'TLSv1 (pre-2019 servers only)'], ['TLSv1.1', 'TLSv1.1'], ['TLSv1.2', 'TLSv1.2'], ['TLSv1.3', 'TLSv1.3']];

const AUTH_PLUGINS = [
  ['auto', 'Automatic (server decides)'],
  ['mysql_native_password', 'mysql_native_password'],
  ['caching_sha2_password', 'caching_sha2_password (MySQL 8 default)'],
  ['sha256_password', 'sha256_password'],
  ['mysql_clear_password', 'mysql_clear_password']
];

const api = window.bridgeAPI;

export default function App() {
  const [settings, setSettings] = useState(empty);
  const [tab, setTab] = useState('connection');
  const [status, setStatus] = useState({ running: false });
  const [probe, setProbe] = useState(null);
  const [logs, setLogs] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [notice, setNotice] = useState('');
  const [sql, setSql] = useState('SELECT VERSION() AS version;');
  const [sqlResult, setSqlResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [standaloneStatus, setStandaloneStatus] = useState(null);
  const [exportInfo, setExportInfo] = useState(null);
  const [aiPort, setAiPort] = useState(3002);
  const [aiToken, setAiToken] = useState('');
  const [aiStatus, setAiStatus] = useState(null);
  const [aiInstructions, setAiInstructions] = useState('');
  const [aiJobs, setAiJobs] = useState([]);
  const [aiHistory, setAiHistory] = useState([]);
  const [aiJob, setAiJob] = useState({
    name: '', prompt: '', provider: 'opencode', frequency: 'daily',
    at: '08:00', weekday: 1, enabled: false, includeInstructions: true
  });

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


  const addSource = type => setSettings(prev => ({
    ...prev,
    sources: [...(prev.sources || []), {
      id: type + '_' + (prev.sources || []).length,
      name: '', type, host: '127.0.0.1', port: 3306, database: '', user: '', file: '', allowedTables: []
    }]
  }));
  const editSource = (index, field, value) => setSettings(prev => ({
    ...prev, sources: (prev.sources || []).map((p, i) => i === index ? { ...p, [field]: value } : p)
  }));
  const removeSource = index => setSettings(prev => ({
    ...prev, sources: (prev.sources || []).filter((_, i) => i !== index)
  }));
  async function checkService() {
    setStandaloneStatus(await api.checkStandalone(settings.mcp.port));
  }
  async function exportSources() {
    setBusy(true); setExportInfo(null);
    try {
      const output = await api.exportStandalone(settings);
      setExportInfo(output);
      setNotice('Read-only service configuration exported; restart service to apply.');
    } catch (e) { setNotice('Export failed: ' + e.message); }
    finally { setBusy(false); }
  }


  async function aiCall(method, route, payload) {
    return api.aiRequest({ method, route, payload, token: aiToken, port: aiPort });
  }
  async function refreshAi() {
    setBusy(true);
    try {
      const [state, instructions, jobs, history] = await Promise.all([
        aiCall('GET', '/status'),
        aiCall('GET', '/instructions'),
        aiCall('GET', '/jobs'),
        aiCall('GET', '/history')
      ]);
      setAiStatus({ ...state, ...instructions });
      setAiInstructions(instructions.instructions);
      setAiJobs(jobs);
      setAiHistory(history);
      setNotice('AI service connected.');
    } catch (error) { setNotice('AI service: ' + error.message); }
    finally { setBusy(false); }
  }
  async function saveAiInstructions() {
    setBusy(true);
    try { await aiCall('PUT', '/instructions', { instructions: aiInstructions });
      setNotice('Shared instructions saved.'); await refreshAi(); }
    catch (error) { setNotice('Cannot save instructions: ' + error.message); }
    finally { setBusy(false); }
  }
  async function saveAiJob() {
    setBusy(true);
    try {
      await aiCall('POST', '/jobs', aiJob);
      setAiJob({ name: '', prompt: '', provider: 'opencode', frequency: 'daily',
        at: '08:00', weekday: 1, enabled: false, includeInstructions: true });
      await refreshAi();
    } catch (error) { setNotice('Cannot save task: ' + error.message); }
    finally { setBusy(false); }
  }
  async function removeAiJob(id) {
    setBusy(true);
    try { await aiCall('DELETE', '/jobs/' + id); await refreshAi(); }
    catch (error) { setNotice('Cannot delete task: ' + error.message); }
    finally { setBusy(false); }
  }
  async function runAiJob(id) {
    setBusy(true);
    try {
      const outcome = await aiCall('POST', '/jobs/' + id + '/run');
      setNotice('AI execution: ' + outcome.status);
      await refreshAi();
    } catch (error) { setNotice('AI execution failed: ' + error.message); }
    finally { setBusy(false); }
  }
  const setAiField = (field, value) => setAiJob(previous => ({ ...previous, [field]: value }));

  async function save() {
    setBusy(true); setNotice('');
    try { const saved = await api.saveSettings(settings); setSettings(saved); setNotice('Settings saved.'); }
    catch (e) { setNotice(`Error: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setNotice(''); setProbe(null);
    try {
      const r = await api.testMySql(settings);
      setProbe(r);
      setNotice(`Connected — ${r.versionLabel} — tables: ${r.tableCount}`);
    } catch (e) { setNotice(`Connection failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function start() {
    setBusy(true); setNotice('');
    try { await api.saveSettings(settings); const s = await api.startBridge(); setStatus(s); setNotice('Bridge started.'); }
    catch (e) { setNotice(`Startup failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try { setStatus(await api.stopBridge()); setNotice('Bridge stopped.'); }
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
  const hostsText = useMemo(() => (settings.mcp.allowedHosts || []).join(', '), [settings.mcp.allowedHosts]);
  const originsText = useMemo(() => (settings.mcp.allowedOrigins || []).join(', '), [settings.mcp.allowedOrigins]);
  const pending = approvals.filter(a => a.status === 'pending').length;
  const capabilities = probe?.capabilities || status.capabilities;
  const warnings = probe ? compatibilityFrom(probe) : (status.compatibilityWarnings || []);
  const tlsOn = settings.mysql.tlsMode !== 'off';

  return <div className="app">
    <header>
      <div className="brand">
        <img className="app-icon" src={appIcon} alt="" width="64" height="64" />
        <div>
        <h1>MySQL MCP Bridge</h1>
        <p>Expose a MySQL server to MCP clients through a local endpoint and an optional ngrok tunnel.</p>
        </div>
      </div>
      <div className={`badge ${status.running ? 'online' : ''}`}>{status.running ? 'ONLINE' : 'OFFLINE'}</div>
    </header>

    <nav>
      {[
        ['connection', 'Connection'], ['sources', 'Standalone Sources'], ['ai', 'AI Agents + Scheduler'], ['mcp', 'MCP + ngrok'], ['security', 'Security'], ['console', 'SQL Console'], ['approvals', 'Approvals'], ['logs', 'Logs']
      ].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
        {label}{id === 'approvals' && pending ? ` (${pending})` : ''}
      </button>)}
    </nav>

    {notice && <div className="notice">{notice}</div>}

    <main>
      {tab === 'connection' && <section className="panel">
        <h2>MySQL server</h2>
        <div className="grid two">
          <Field label="Host / IP"><input value={settings.mysql.host} onChange={e => set('mysql', 'host', e.target.value)} /></Field>
          <Field label="Port"><input type="number" value={settings.mysql.port} onChange={e => set('mysql', 'port', Number(e.target.value))} /></Field>
          <Field label="Default database"><input value={settings.mysql.database} onChange={e => set('mysql', 'database', e.target.value)} placeholder="optional" /></Field>
          <Field label="User"><input value={settings.mysql.user} onChange={e => set('mysql', 'user', e.target.value)} /></Field>
          <Field label="Password"><input type="password" value={settings.mysql.password} onChange={e => set('mysql', 'password', e.target.value)} /></Field>
          <Field label="Connection timeout (ms)"><input type="number" value={settings.mysql.connectTimeoutMs} onChange={e => set('mysql', 'connectTimeoutMs', Number(e.target.value))} /></Field>
        </div>

        <Field label="Socket path or Windows named pipe" hint="Optional. Local Windows services frequently listen on a pipe such as \\.\pipe\mysql instead of TCP. When set, host and port are ignored.">
          <input value={settings.mysql.socketPath} onChange={e => set('mysql', 'socketPath', e.target.value)} placeholder="\\.\pipe\mysql or /var/run/mysqld/mysqld.sock" />
        </Field>

        <div className="grid two">
          <Field label="Connection collation" hint="utf8mb4 maps to utf8mb4_general_ci, the widest collation that exists on MySQL 5.6 through 9.x.">
            <Select value={settings.mysql.collation} onChange={v => set('mysql', 'collation', v)} options={COLLATIONS} />
          </Field>
          <Field label="TLS / SSL mode">
            <Select value={settings.mysql.tlsMode} onChange={v => set('mysql', 'tlsMode', v)} options={TLS_MODES} />
          </Field>
        </div>

        {tlsOn && <>
          <div className="grid two">
            <Field label="CA certificate file" hint="Required for verify-ca and verify-full.">
              <input value={settings.mysql.caFile} onChange={e => set('mysql', 'caFile', e.target.value)} placeholder="C:\certs\ca.pem" />
            </Field>
            <Field label="Client certificate file" hint="Optional, for servers requiring mutual TLS.">
              <input value={settings.mysql.certFile} onChange={e => set('mysql', 'certFile', e.target.value)} placeholder="C:\certs\client.pem" />
            </Field>
            <Field label="Client key file">
              <input value={settings.mysql.keyFile} onChange={e => set('mysql', 'keyFile', e.target.value)} placeholder="C:\certs\client.key" />
            </Field>
            <Field label="Minimum TLS version">
              <Select value={settings.mysql.minTlsVersion} onChange={v => set('mysql', 'minTlsVersion', v)} options={TLS_VERSIONS} />
            </Field>
          </div>
          <Check checked={settings.mysql.allowTlsFallback} onChange={v => set('mysql', 'allowTlsFallback', v)} label="Retry with weaker TLS settings if the handshake fails" />
          <p className="hint">With fallback enabled the bridge first tries your settings, then an unverified certificate, then TLSv1 with legacy ciphers, then no TLS. Every attempt is written to the log, so a downgraded connection is never silent.</p>
        </>}

        <details className="advanced">
          <summary>Advanced</summary>
          <div className="grid two">
            <Field label="Authentication plugin" hint="Leave on automatic unless the handshake fails.">
              <Select value={settings.mysql.authPlugin} onChange={v => set('mysql', 'authPlugin', v)} options={AUTH_PLUGINS} />
            </Field>
            <Field label="Session time zone" hint="A UTC offset avoids any dependency on the mysql.time_zone tables.">
              <input value={settings.mysql.sessionTimeZone} onChange={e => set('mysql', 'sessionTimeZone', e.target.value)} placeholder="+00:00" />
            </Field>
            <Field label="Session SQL mode" hint="Leave empty to keep the server default.">
              <input value={settings.mysql.sqlMode} onChange={e => set('mysql', 'sqlMode', e.target.value)} placeholder="STRICT_TRANS_TABLES,NO_ZERO_DATE" />
            </Field>
            <Field label="group_concat_max_len" hint="0 keeps the server default of 1024, which silently truncates aggregated text.">
              <input type="number" value={settings.mysql.groupConcatMaxLen} onChange={e => set('mysql', 'groupConcatMaxLen', Number(e.target.value))} />
            </Field>
            <Field label="TLS ciphers" hint="Legacy servers may need DEFAULT@SECLEVEL=0.">
              <input value={settings.mysql.ciphers} onChange={e => set('mysql', 'ciphers', e.target.value)} placeholder="DEFAULT@SECLEVEL=0" />
            </Field>
            <Field label="Server public key (PEM)" hint="Optional. Skips the RSA round-trip and works with hosts that block key retrieval.">
              <input value={settings.mysql.serverPublicKey} onChange={e => set('mysql', 'serverPublicKey', e.target.value)} />
            </Field>
          </div>
        </details>

        <div className="actions">
          <button onClick={test} disabled={busy}>Test connection</button>
          <button className="primary" onClick={save} disabled={busy}>Save</button>
        </div>
        <p className="hint">Passwords and tokens are stored with Electron safeStorage (DPAPI on Windows) and are never written to the Git repository.</p>

        {(capabilities || warnings.length > 0) && <div className="statusbox">
          {probe && <>
            <Row label="Detected server" value={probe.versionLabel} />
            <Row label="Raw version" value={probe.version} />
            <Row label="SQL mode" value={probe.sqlMode || '—'} />
            <Row label="Server charset" value={probe.characterSetServer || '—'} />
            <Row label="Negotiated TLS" value={probe.tlsMode || 'off'} />
          </>}
          {capabilities && <>
            <Row label="JSON column type" value={capabilities.jsonType ? 'available' : 'not available (needs 5.7.8+)'} />
            <Row label="CTEs (WITH)" value={capabilities.cte ? 'available' : 'not available (needs 8.0+)'} />
            <Row label="Expression defaults" value={capabilities.defaultExpressions ? 'available' : 'not available (needs 8.0.13+)'} />
            <Row label="InnoDB index key limit" value={`${capabilities.maxIndexKeyBytes} bytes`} />
          </>}
          {warnings.length > 0 && <div className="tags">{warnings.map(w => <span className="tag" key={w.id}>{w.message}</span>)}</div>}
        </div>}
      </section>}


      {tab === 'sources' && <section className="panel">
        <h2>Read-only MySQL and Access sources</h2>
        <p className="hint">Configure independent database sources for the standalone Node.js service. The desktop application does not store their passwords and closing it will not stop the service.</p>
        <div className="actions">
          <button onClick={() => addSource('mysql')}>+ MySQL</button>
          <button onClick={() => addSource('access')}>+ Access MDB / ACCDB</button>
          <button onClick={checkService}>Check independent service</button>
        </div>
        {standaloneStatus && <div className="statusbox">
          <Row label="Service" value={standaloneStatus.online ? 'ONLINE (standalone)' : 'OFFLINE / different service'} />
          <Row label="Source count" value={String(standaloneStatus.sources?.length || 0)} />
          {standaloneStatus.error && <Row label="Info" value={standaloneStatus.error} />}
          {(standaloneStatus.sources || []).map(s => <Row key={s.id} label={s.name} value={s.type} />)}
        </div>}
        {(settings.sources || []).map((p, i) => <div className="panel" key={i}>
          <div className="titleRow">
            <h3>{p.name || p.id || 'New source'} — {p.type}</h3>
            <button className="danger" onClick={() => removeSource(i)}>Remove</button>
          </div>
          <div className="grid two">
            <Field label="Unique source ID"><input value={p.id} onChange={e => editSource(i, 'id', e.target.value)} /></Field>
            <Field label="Display name"><input value={p.name} onChange={e => editSource(i, 'name', e.target.value)} /></Field>
          </div>
          {p.type === 'mysql' ? <div className="grid two">
            <Field label="Host / IP"><input value={p.host} onChange={e => editSource(i, 'host', e.target.value)} /></Field>
            <Field label="Port"><input type="number" value={p.port} onChange={e => editSource(i, 'port', Number(e.target.value))} /></Field>
            <Field label="Database"><input value={p.database} onChange={e => editSource(i, 'database', e.target.value)} /></Field>
            <Field label="SELECT-only MySQL user"><input value={p.user} onChange={e => editSource(i, 'user', e.target.value)} /></Field>
          </div> : <Field label="MDB / ACCDB file (use a consistent snapshot)">
            <input value={p.file} onChange={e => editSource(i, 'file', e.target.value)} />
          </Field>}
          <Field label="Allowed tables, comma separated (blank means all)">
            <textarea rows="2" value={(p.allowedTables || []).join(', ')}
              onChange={e => editSource(i, 'allowedTables', splitList(e.target.value))} />
          </Field>
        </div>)}
        <div className="actions">
          <button onClick={save} disabled={busy}>Save profiles</button>
          <button className="primary" onClick={exportSources} disabled={busy}>Export standalone.json</button>
        </div>
        {exportInfo && <div className="statusbox">
          <Row label="Configuration file" value={exportInfo.path} copy />
          <Row label="Exported source count" value={String(exportInfo.count)} />
        </div>}
        <p className="hint">Export contains environment-variable placeholders for MySQL passwords and the MCP bearer token. Set these variables for the Windows service account, then start/restart the separate server. It is not started by this button.</p>
      </section>}


      {tab === 'ai' && <section className="panel">
        <h2>AI instructions and task scheduler</h2>
        <p className="hint">Shared project instructions can be ON or OFF per task. Supports OpenCode, Claude Code and Codex when their CLIs and MCP configuration are installed on the service machine. Admin access stays on 127.0.0.1, separate from ngrok/MCP.</p>
        <div className="grid two">
          <Field label="Local AI admin port"><input type="number" value={aiPort} onChange={e => setAiPort(Number(e.target.value))} /></Field>
          <Field label="Admin token (not saved)"><input type="password" value={aiToken} onChange={e => setAiToken(e.target.value)} /></Field>
        </div>
        <div className="actions"><button onClick={refreshAi} disabled={busy}>Connect / Refresh</button></div>
        {aiStatus && <>
          <div className="statusbox">
            <Row label="Scheduler" value={aiStatus.enabled ? 'Enabled' : 'Disabled'} />
            <Row label="Active AI task" value={aiStatus.activeJob || 'None'} />
            <Row label="Workspace WITH instructions" value={aiStatus.workspaceWithInstructions || aiStatus.workspaces?.withInstructions || ''} copy />
            <Row label="Workspace WITHOUT instructions" value={aiStatus.workspaceWithoutInstructions || aiStatus.workspaces?.withoutInstructions || ''} copy />
          </div>
          <h3>Permanent instructions (optional per task)</h3>
          <textarea className="sql" value={aiInstructions} onChange={e => setAiInstructions(e.target.value)}
            rows={10} spellCheck="false" />
          <div className="actions"><button className="primary" onClick={saveAiInstructions} disabled={busy}>Save shared instructions</button></div>
          <h3>Create or edit scheduled task</h3>
          <div className="grid two">
            <Field label="Task name"><input value={aiJob.name} onChange={e => setAiField('name', e.target.value)} /></Field>
            <Field label="AI engine"><Select value={aiJob.provider} onChange={v => setAiField('provider', v)}
              options={[['opencode', 'OpenCode'], ['claude', 'Claude Code'], ['codex', 'Codex']]} /></Field>
            <Field label="Frequency"><Select value={aiJob.frequency} onChange={v => setAiField('frequency', v)}
              options={[['hourly', 'Every hour'], ['daily', 'Every day'], ['weekly', 'Every week']]} /></Field>
            <Field label="Time (daily/weekly)"><input type="time" value={aiJob.at}
              onChange={e => setAiField('at', e.target.value)} /></Field>
          </div>
          {aiJob.frequency === 'weekly' && <Field label="Weekday (0=Sunday, 1=Monday, ..., 6=Saturday)">
            <Select value={String(aiJob.weekday)} onChange={v => setAiField('weekday', Number(v))}
              options={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => [String(i), day])} />
          </Field>}
          <Field label="Task prompt">
            <textarea className="sql" rows="5" value={aiJob.prompt} onChange={e => setAiField('prompt', e.target.value)} />
          </Field>
          <div className="actions">
            <Check checked={aiJob.includeInstructions} onChange={v => setAiField('includeInstructions', v)}
              label="Pass the permanent instructions to this task" />
            <Check checked={aiJob.enabled} onChange={v => setAiField('enabled', v)}
              label="Enable automatic schedule" />
          </div>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={saveAiJob}>{aiJob.id ? 'Update task' : 'Save task'}</button>
            {aiJob.id && <button onClick={() => setAiJob({
              name: '', prompt: '', provider: 'opencode', frequency: 'daily',
              at: '08:00', weekday: 1, enabled: false, includeInstructions: true
            })}>New task</button>}
          </div>
          <h3>Saved tasks</h3>
          {!aiJobs.length && <p className="hint">No scheduled AI tasks yet.</p>}
          {aiJobs.map(job => <div className="statusbox" key={job.id}>
            <Row label={job.name} value={job.provider + ' | ' + job.frequency + ' | ' +
              (job.includeInstructions ? 'Instructions ON' : 'Instructions OFF') +
              (job.enabled ? ' | Scheduled' : ' | Paused')} />
            <div className="actions">
              <button onClick={() => setAiJob({ ...job })}>Edit</button>
              <button disabled={busy} onClick={() => runAiJob(job.id)}>Run now</button>
              <button className="danger" disabled={busy} onClick={() => removeAiJob(job.id)}>Delete</button>
            </div>
          </div>)}
          <h3>Recent task history</h3>
          {aiHistory.slice(0, 12).map(item => <div className="row" key={item.id}>
            <span>{item.jobName} ({item.provider})</span>
            <code>{item.status} — {item.startedAt}</code>
          </div>)}
          <p className="hint">Turning instructions OFF removes only dashboard-managed project instructions. The AI provider may still apply its own built-in or user-level instructions. Reports are written by the scheduler, not by the database MCP.</p>
        </>}
      </section>}

      {tab === 'mcp' && <section className="panel">
        <h2>MCP and ngrok</h2>
        <div className="grid two">
          <Field label="Local MCP port"><input type="number" value={settings.mcp.port} onChange={e => set('mcp', 'port', Number(e.target.value))} /></Field>
          <Field label="Access mode">
            <Select value={settings.mcp.accessMode} onChange={v => set('mcp', 'accessMode', v)} options={[['read', 'READ ONLY'], ['write', 'READ + WRITE'], ['admin', 'ADMIN']]} />
          </Field>
          <Field label="ngrok authtoken"><input type="password" value={settings.ngrok.authtoken} onChange={e => set('ngrok', 'authtoken', e.target.value)} /></Field>
          <Field label="Fixed ngrok domain"><input value={settings.ngrok.domain} onChange={e => set('ngrok', 'domain', e.target.value)} placeholder="example.ngrok-free.app (optional)" /></Field>
        </div>
        <Check checked={settings.ngrok.enabled} onChange={v => set('ngrok', 'enabled', v)} label="Publish the MCP endpoint through ngrok" />
        <Field label="Optional MCP bearer token"><input type="password" value={settings.mcp.bearerToken} onChange={e => set('mcp', 'bearerToken', e.target.value)} placeholder="leave empty if the client cannot send an Authorization header" /></Field>
        <details className="advanced">
          <summary>Advanced</summary>
          <Check checked={settings.mcp.jsonResponses} onChange={v => set('mcp', 'jsonResponses', v)} label="Answer with application/json instead of an SSE stream (expected by most remote MCP clients)" />
          <Field label="Extra allowed Host headers" hint="The local interface and the live ngrok host are always allowed.">
            <textarea value={hostsText} onChange={e => set('mcp', 'allowedHosts', splitList(e.target.value))} rows="2" />
          </Field>
          <Field label="Extra allowed Origin headers">
            <textarea value={originsText} onChange={e => set('mcp', 'allowedOrigins', splitList(e.target.value))} rows="2" />
          </Field>
        </details>
        <div className="actions">
          {!status.running ? <button className="primary" onClick={start} disabled={busy}>Start MCP</button> : <button className="danger" onClick={stop} disabled={busy}>Stop MCP</button>}
          <button onClick={save} disabled={busy}>Save</button>
        </div>
        <div className="statusbox">
          <Row label="Local MCP" value={status.mcpUrl || '—'} copy />
          <Row label="Public MCP" value={status.publicUrl || '—'} copy />
          <Row label="Health" value={status.healthUrl || '—'} copy />
          {status.mysqlVersion && <Row label="Connected server" value={`${status.mysqlVendor} ${status.mysqlVersion}`} />}
        </div>
      </section>}

      {tab === 'security' && <section className="panel">
        <h2>Security</h2>
        <div className="grid two">
          <Field label="Maximum SELECT limit"><input type="number" value={settings.mcp.selectLimit} onChange={e => set('mcp', 'selectLimit', Number(e.target.value))} /></Field>
          <Field label="Query timeout (ms)"><input type="number" value={settings.mcp.queryTimeoutMs} onChange={e => set('mcp', 'queryTimeoutMs', Number(e.target.value))} /></Field>
        </div>
        <Check checked={settings.mcp.blockMultipleStatements} onChange={v => set('mcp', 'blockMultipleStatements', v)} label="Block multi-statement SQL" />
        <Check checked={settings.mcp.blockFileAccess} onChange={v => set('mcp', 'blockFileAccess', v)} label="Block INTO OUTFILE, INTO DUMPFILE and LOAD_FILE()" />
        <Check checked={settings.mcp.allowSlowFunctions} onChange={v => set('mcp', 'allowSlowFunctions', v)} label="Allow SLEEP() and BENCHMARK() (denial-of-service risk)" />
        <Check checked={settings.mcp.requireWhereForUpdateDelete} onChange={v => set('mcp', 'requireWhereForUpdateDelete', v)} label="Require a WHERE clause for UPDATE and DELETE" />
        <Check checked={settings.mcp.confirmUpdate} onChange={v => set('mcp', 'confirmUpdate', v)} label="Require approval for UPDATE" />
        <Check checked={settings.mcp.confirmDelete} onChange={v => set('mcp', 'confirmDelete', v)} label="Require approval for DELETE" />
        <Check checked={settings.mcp.confirmDdl} onChange={v => set('mcp', 'confirmDdl', v)} label="Require approval for DDL (CREATE / ALTER / DROP...)" />
        <Check checked={settings.mcp.enableExecuteSql} onChange={v => set('mcp', 'enableExecuteSql', v)} label="Enable free administrative SQL through execute_sql (ADMIN only)" />
        <Field label="Table whitelist (comma separated, empty means all)">
          <textarea value={whitelistText} onChange={e => set('mcp', 'allowedTables', splitList(e.target.value))} rows="3" />
        </Field>
        <div className="warning">ADMIN mode can alter or destroy schemas and data. Use a MySQL user with only the privileges that are genuinely required.</div>
        <div className="actions"><button className="primary" onClick={save} disabled={busy}>Save security</button></div>
      </section>}

      {tab === 'console' && <section className="panel">
        <h2>Local SQL console</h2>
        <p className="hint">Respects the configured access mode and the multi-statement block. MCP approvals are not required here because the statement is started manually from the app.</p>
        <textarea className="sql" value={sql} onChange={e => setSql(e.target.value)} spellCheck="false" />
        <div className="actions"><button className="primary" onClick={runSql} disabled={busy}>Execute</button></div>
        {sqlResult && <pre className={sqlResult.ok ? '' : 'error'}>{JSON.stringify(sqlResult, null, 2)}</pre>}
      </section>}

      {tab === 'approvals' && <section className="panel">
        <h2>Approval requests</h2>
        {!approvals.length && <p className="hint">No requests.</p>}
        <div className="approvalList">
          {approvals.map(a => <article key={a.id} className={`approval ${a.status}`}>
            <div><strong>{a.summary}</strong><span>{a.status}</span></div>
            <code>{a.sql || a.action}</code>
            <small>{a.createdAt}</small>
            {a.status === 'pending' && <div className="actions">
              <button className="danger" onClick={() => decide(a.id, false)}>Deny</button>
              <button className="primary" onClick={() => decide(a.id, true)}>Approve once</button>
            </div>}
          </article>)}
        </div>
      </section>}

      {tab === 'logs' && <section className="panel">
        <div className="titleRow"><h2>Logs</h2><button onClick={() => setLogs([])}>Clear</button></div>
        <div className="logs">{logs.map((l, i) => <div key={i}><time>{new Date(l.time).toLocaleTimeString()}</time><b>{l.type}</b><span>{JSON.stringify(l.data)}</span></div>)}</div>
      </section>}
    </main>
  </div>;
}

function splitList(text) {
  return String(text).split(',').map(x => x.trim()).filter(Boolean);
}

function compatibilityFrom(probe) {
  const caps = probe?.capabilities || {};
  const notes = [];
  if (!caps.jsonType) notes.push({ id: 'no-json', message: 'JSON columns need MySQL 5.7.8 or newer and will be rejected by create_table.' });
  if (!caps.cte) notes.push({ id: 'no-cte', message: 'Common table expressions (WITH) need MySQL 8.0 or newer.' });
  if (!caps.defaultExpressions) notes.push({ id: 'no-default-expr', message: 'Expression defaults need MySQL 8.0.13 or newer, so only literals are accepted.' });
  if (caps.maxIndexKeyBytes < 3072) notes.push({ id: 'small-index-key', message: `InnoDB index keys are limited to ${caps.maxIndexKeyBytes} bytes on this server, so wide utf8mb4 columns are indexed by prefix.` });
  return notes;
}

function Field({ label, hint, children }) { return <label className="field"><span>{label}</span>{children}{hint && <small className="hint">{hint}</small>}</label>; }
function Check({ checked, onChange, label }) { return <label className="check"><input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>; }
function Select({ value, onChange, options }) { return <select value={value} onChange={e => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>; }
function Row({ label, value, copy }) { return <div className="row"><span>{label}</span><code>{value}</code>{copy && value !== '—' && <button onClick={() => navigator.clipboard.writeText(value)}>Copy</button>}</div>; }
