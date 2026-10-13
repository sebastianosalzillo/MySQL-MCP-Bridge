import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAiProvider, configureWorkspaces, workspaceFiles } from './providers.mjs';

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
const PROVIDERS = new Set(['opencode', 'claude', 'codex']);

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
  const provider = String(value.provider || 'opencode');
  if (!PROVIDERS.has(provider)) throw new Error('Provider must be opencode, claude or codex.');
  return {
    id, name, prompt, frequency, at, weekday, provider,
    includeInstructions: value.includeInstructions !== false, enabled: value.enabled === true,
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

export { workspaceFiles, configureWorkspaces } from './providers.mjs';

export function createAutomationManager(config, dependencies = {}) {
  const settings = {
    ...config,
    stateDir: path.resolve(config.stateDir),
    timeZone: config.timeZone || 'Europe/Rome'
  };
  new Intl.DateTimeFormat('en-US', { timeZone: settings.timeZone }); // validate
  const now = dependencies.now || (() => new Date());
  const run = dependencies.run || runAiProvider;
  const jobsFile = path.join(settings.stateDir, 'jobs.json');
  const instructionFile = path.join(settings.stateDir, 'instructions.md');
  const reportDirectory = path.join(settings.stateDir, 'reports');
  fs.mkdirSync(settings.stateDir, { recursive: true });
  fs.mkdirSync(reportDirectory, { recursive: true });

  let jobs = readJson(jobsFile, { jobs: [] }).jobs.map(p => validateJob(p, p));
  let instructions = fs.existsSync(instructionFile) ? fs.readFileSync(instructionFile, 'utf8') : DEFAULT_INSTRUCTIONS;
  let busy = false;
  let activeJob = null;
  let closed = false;
  let timer = null;
  const history = readJson(path.join(settings.stateDir, 'history.json'), { runs: [] }).runs;
  configureWorkspaces(settings, instructions);
  const saveJobs = () => writeAtomic(jobsFile, JSON.stringify({ jobs }, null, 2));
  const saveHistory = () => writeAtomic(path.join(settings.stateDir, 'history.json'), JSON.stringify({ runs: history.slice(0, 100) }, null, 2));

  const getInstructions = () => ({ instructions,
    workspaceWithInstructions: workspaceFiles(settings, true).workspace,
    workspaceWithoutInstructions: workspaceFiles(settings, false).workspace });

  function setInstructions(value) {
    const content = String(value || '').trim();
    if (!content || content.length > 30000) throw new Error('Instructions must be 1-30000 characters.');
    // Update managed workspace before acknowledging success.
    configureWorkspaces(settings, content);
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
      jobs: jobs.length, workspaces: {
        withInstructions: workspaceFiles(settings, true).workspace,
        withoutInstructions: workspaceFiles(settings, false).workspace
      }, timeZone: settings.timeZone };
  }

  async function execute(job, key, trigger) {
    if (closed) throw new Error('Scheduler stopped.');
    if (busy) throw new Error('Another task is running.');
    busy = true; activeJob = job.id;
    const start = now().toISOString();
    const entry = { id: randomUUID(), jobId: job.id, jobName: job.name,
      trigger, startedAt: start, provider: job.provider,
      includeInstructions: job.includeInstructions, status: 'running' };
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
    listHistory, status, runNow, tick, start, stop,
    _workspace: workspaceFiles(settings, true) };
}
