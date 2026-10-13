import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

export const DEFAULT_INSTRUCTIONS = [
  '# Database AI — istruzioni aziendali',
  '',
  'Sei un assistente di analisi aziendale. Rispondi in italiano.',
  'Utilizza esclusivamente le fonti MCP di sola lettura autorizzate.',
  'Non modificare database, file gestionali o configurazioni del sistema.',
  'Indica sempre origine dei dati, periodo analizzato e limiti delle conclusioni.',
  'Se mancano i dati, dichiaralo; non inventare numeri.'
].join('\n');

const FREQUENCIES = new Set(['hourly', 'daily', 'weekly']);

function writeAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function validateJob(value, previous = null) {
  if (!value || typeof value !== 'object') throw new Error('Job must be an object.');
  const id = previous?.id || randomUUID();
  const name = String(value.name || '').trim();
  const prompt = String(value.prompt || '').trim();
  if (!name || name.length > 100) throw new Error('Job name must be 1-100 characters.');
  if (!prompt || prompt.length > 12000) throw new Error('Job prompt must be 1-12000 characters.');
  const frequency = String(value.frequency || 'daily');
  if (!FREQUENCIES.has(frequency)) throw new Error('Frequency must be hourly, daily, or weekly.');
  const at = String(value.at || '08:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error('Time must be HH:mm.');
  const weekday = Number(value.weekday ?? 1);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be 0-6.');
  return {
    id, name, prompt, frequency, at, weekday, enabled: value.enabled === true,
    lastRunKey: previous?.lastRunKey || null
  };
}

export function localSchedule(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: parts.year + '-' + parts.month + '-' + parts.day,
    time: (parts.hour === '24' ? '00' : parts.hour) + ':' + parts.minute,
    hour: parts.hour === '24' ? '00' : parts.hour,
    weekday: day };
}

export function dueKey(job, local) {
  if (job.frequency === 'hourly') {
    return local.time.slice(3) === '00' ? local.date + 'T' + local.hour : null;
  }
  if (local.time !== job.at) return null;
  if (job.frequency === 'weekly' && job.weekday !== local.weekday) return null;
  return local.date;
}

export function workspaceFiles(settings) {
  const workspace = path.join(path.resolve(settings.stateDir), 'workspace');
  return {
    workspace,
    instructions: path.join(workspace, 'AGENTS.md'),
    config: path.join(workspace, 'opencode.json')
  };
}

export function configureWorkspace(settings, instructions) {
  const paths = workspaceFiles(settings);
  const endpointPort = Number(settings.mcpPort);
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) {
    throw new Error('Invalid MCP endpoint port.');
  }
  fs.mkdirSync(paths.workspace, { recursive: true });
  // The generated workspace is owned by this feature; no user workspaces are overwritten.
  const config = {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      '*': 'deny', read: 'allow', 'database_bridge_*': 'allow'
    },
    mcp: {
      database_bridge: {
        type: 'remote',
        url: 'http://127.0.0.1:' + endpointPort + '/mcp',
        enabled: true,
        oauth: false,
        headers: { Authorization: 'Bearer {env:MCP_BEARER_TOKEN}' }
      }
    }
  };
  writeAtomic(paths.instructions, instructions.endsWith('\n') ? instructions : instructions + '\n');
  writeAtomic(paths.config, JSON.stringify(config, null, 2) + '\n');
  return paths;
}

export function runOpenCode(job, settings, { spawn = nodeSpawn } = {}) {
  const workspace = workspaceFiles(settings).workspace;
  const executable = settings.executable || 'opencode';
  if (/[^\w .:/\\-]/.test(executable) || /\.(cmd|bat|ps1)$/i.test(executable)) {
    throw new Error('Use a native OpenCode executable, not a shell script.');
  }
  const maxMs = Math.min(1800000, Math.max(10000, Number(settings.runTimeoutMs || 300000)));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['run', '--dir', workspace, job.prompt], {
      cwd: workspace, shell: false, windowsHide: true,
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    let completed = false;
    const maxBytes = 2 * 1024 * 1024;
    const finalize = (error, data) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => {
      child.kill();
      finalize(new Error('OpenCode execution timed out.'));
    }, maxMs);
    child.stdout.on('data', data => {
      out += data.toString();
      if (Buffer.byteLength(out) > maxBytes) {
        child.kill();
        finalize(new Error('OpenCode output exceeded 2 MB.'));
      }
    });
    child.stderr.on('data', data => {
      err += data.toString().slice(0, 4000);
      if (err.length > 16000) err = err.slice(-16000);
    });
    child.on('error', () => finalize(new Error('Cannot launch OpenCode. Install the CLI and configure the executable path.')));
    child.on('close', code => {
      if (code === 0) finalize(null, { output: out.trim(), diagnostics: err.slice(-2000) });
      else finalize(new Error('OpenCode exited with code ' + code + '. ' + err.slice(-500)));
    });
  });
}

export function createAutomationManager(config, dependencies = {}) {
  const settings = {
    ...config,
    stateDir: path.resolve(config.stateDir),
    timeZone: config.timeZone || 'Europe/Rome'
  };
  new Intl.DateTimeFormat('en-US', { timeZone: settings.timeZone }); // validate
  const now = dependencies.now || (() => new Date());
  const run = dependencies.run || runOpenCode;
  const jobsFile = path.join(settings.stateDir, 'jobs.json');
  const instructionFile = path.join(settings.stateDir, 'instructions.md');
  const runDirectory = path.join(settings.stateDir, 'runs');
  const reportDirectory = path.join(settings.stateDir, 'reports');
  fs.mkdirSync(settings.stateDir, { recursive: true });
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.mkdirSync(reportDirectory, { recursive: true });

  let jobs = readJson(jobsFile, { jobs: [] }).jobs.map(p => validateJob(p, p));
  let instructions = fs.existsSync(instructionFile) ? fs.readFileSync(instructionFile, 'utf8') : DEFAULT_INSTRUCTIONS;
  let busy = false;
  let activeJob = null;
  let closed = false;
  let timer = null;
  const history = readJson(path.join(settings.stateDir, 'history.json'), { runs: [] }).runs;
  configureWorkspace(settings, instructions);
  const saveJobs = () => writeAtomic(jobsFile, JSON.stringify({ jobs }, null, 2));
  const saveHistory = () => writeAtomic(path.join(settings.stateDir, 'history.json'), JSON.stringify({ runs: history.slice(0, 100) }, null, 2));

  const getInstructions = () => ({ instructions, workspace: workspaceFiles(settings).workspace });

  function setInstructions(value) {
    const content = String(value || '').trim();
    if (!content || content.length > 30000) throw new Error('Instructions must be 1-30000 characters.');
    // Update managed workspace before acknowledging success.
    configureWorkspace(settings, content);
    writeAtomic(instructionFile, content + '\n');
    instructions = content;
    return getInstructions();
  }

  const listJobs = () => jobs.map(j => ({ ...j }));
  function upsertJob(value) {
    const existing = value?.id ? jobs.find(j => j.id === value.id) : null;
    if (value?.id && !existing) throw new Error('Unknown job.');
    if (!existing && jobs.length >= 100) throw new Error('Maximum of 100 jobs.');
    const job = validateJob(value, existing);
    jobs = existing ? jobs.map(j => j.id === existing.id ? job : j) : [...jobs, job];
    saveJobs();
    return { ...job };
  }
  function deleteJob(id) {
    if (activeJob === id) throw new Error('Cannot delete an active job.');
    if (!jobs.some(j => j.id === id)) throw new Error('Unknown job.');
    jobs = jobs.filter(j => j.id !== id);
    saveJobs();
  }
  function listHistory() { return history.slice(0, 40).map(r => ({ ...r })); }
  function status() {
    return { enabled: !closed, running: busy, activeJob,
      jobs: jobs.length, workspace: workspaceFiles(settings).workspace, timeZone: settings.timeZone };
  }

  async function execute(job, key, trigger) {
    if (closed) throw new Error('Scheduler stopped.');
    if (busy) throw new Error('Another task is running.');
    busy = true; activeJob = job.id;
    const start = now().toISOString();
    const entry = { id: randomUUID(), jobId: job.id, jobName: job.name,
      trigger, startedAt: start, status: 'running' };
    try {
      // A task always uses the current persistent instructions in the shared workspace.
      const result = await run(job, settings);
      const file = path.join(reportDirectory, entry.id + '.txt');
      writeAtomic(file, String(result.output || '').slice(0, 2000000));
      entry.report = file;
      entry.status = 'success';
    } catch (error) {
      entry.status = 'error';
      entry.error = String(error?.message || error).slice(0, 1000);
    } finally {
      entry.endedAt = now().toISOString();
      history.unshift(entry);
      if (history.length > 100) history.length = 100;
      saveHistory();
      activeJob = null; busy = false;
    }
    return { ...entry };
  }

  async function runNow(id) {
    const job = jobs.find(j => j.id === id);
    if (!job) throw new Error('Unknown job.');
    return execute(job, null, 'manual');
  }

  function tick() {
    if (closed || busy) return;
    const local = localSchedule(now(), settings.timeZone);
    for (const job of jobs) {
      if (!job.enabled) continue;
      const key = dueKey(job, local);
      if (key === null || key === job.lastRunKey) continue;
      job.lastRunKey = key;
      saveJobs(); // Do not accidentally repeat on service restart.
      void execute(job, key, 'schedule');
      break;
    }
  }

  function start() {
    if (closed) throw new Error('Scheduler stopped.');
    if (timer) return;
    timer = setInterval(tick, 15000);
  }
  async function stop() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    // The running child is allowed to finish; the service wrapper should have a graceful stop window.
  }
  return { getInstructions, setInstructions, listJobs, upsertJob, deleteJob,
    listHistory, status, runNow, tick, start, stop, _workspace: workspaceFiles(settings) };
}
