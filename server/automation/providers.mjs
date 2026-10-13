import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

const supported = new Set(['opencode', 'claude', 'codex']);

/** Two sibling workspaces ensure opt-out sessions never inherit managed project instructions. */
export function workspaceFiles(settings, includeInstructions = true) {
  const workspace = path.join(path.resolve(settings.stateDir), 'workspaces',
    includeInstructions ? 'with-instructions' : 'without-instructions');
  return {
    workspace,
    agents: path.join(workspace, 'AGENTS.md'),
    claude: path.join(workspace, 'CLAUDE.md'),
    opencode: path.join(workspace, 'opencode.json'),
    claudeMcp: path.join(workspace, '.mcp.json'),
    codex: path.join(workspace, '.codex', 'config.toml')
  };
}

function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.temp-' + randomUUID());
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function configureWorkspaces(settings, instructions) {
  const port = Number(settings.mcpPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('mcpPort must be 1-65535.');
  }
  const url = 'http://127.0.0.1:' + port + '/mcp';
  const content = String(instructions || '').trim();
  if (!content) throw new Error('Instructions cannot be empty.');
  const configurations = [];
  for (const enabled of [true, false]) {
    const paths = workspaceFiles(settings, enabled);
    fs.mkdirSync(paths.workspace, { recursive: true });
    if (enabled) {
      atomic(paths.agents, content + '\n');
      atomic(paths.claude, content + '\n');
    } else {
      // This directory is managed by the application and must never contain project instructions.
      for (const file of [paths.agents, paths.claude]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }

    const openConfig = {
      $schema: 'https://opencode.ai/config.json',
      permission: {
        '*': 'deny',
        'read': 'allow',
        'database_bridge_*': 'allow'
      },
      mcp: {
        database_bridge: {
          type: 'remote', url, enabled: true, oauth: false,
          headers: { Authorization: 'Bearer {env:MCP_BEARER_TOKEN}' }
        }
      }
    };
    atomic(paths.opencode, JSON.stringify(openConfig, null, 2) + '\n');
    // Claude Code project MCP config. Variable expansion occurs in Claude Code, not here.
    atomic(paths.claudeMcp, JSON.stringify({
      mcpServers: {
        database_bridge: {
          type: 'http', url,
          headers: { Authorization: 'Bearer ' + ' }
        }
      }
    }, null, 2) + '\n');
    atomic(paths.codex, [
      '[mcp_servers.database_bridge]',
      'url = "' + url + '"',
      'bearer_token_env_var = "MCP_BEARER_TOKEN"',
      'required = true',
      ''
    ].join('\n'));
    configurations.push(paths);
  }
  return configurations;
}

export function buildAiCommand(job, settings) {
  const provider = String(job.provider || 'opencode');
  if (!supported.has(provider)) throw new Error('Unsupported AI provider: ' + provider);
  const workspace = workspaceFiles(settings, job.includeInstructions !== false).workspace;
  const prompt = String(job.prompt || '').trim();
  if (!prompt) throw new Error('AI prompt is required.');
  const binaries = settings.executables || {};
  const executable = String(binaries[provider] || provider);
  // Windows .cmd shims require special handling; prefer absolute native CLI binaries.
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new Error('Set a native executable path, not a shell script.');
  }
  let args;
  if (provider === 'opencode') {
    args = ['run', '--dir', workspace, prompt];
  } else if (provider === 'claude') {
    args = ['-p', '--permission-mode', 'dontAsk',
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit',
      prompt];
  } else {
    args = ['exec', '--cd', workspace, '--sandbox', 'read-only',
      '--skip-git-repo-check', prompt];
  }
  return { provider, executable, args, cwd: workspace, includeInstructions: job.includeInstructions !== false };
}

export function runAiProvider(job, settings, { spawn = nodeSpawn } = {}) {
  const spec = buildAiCommand(job, settings);
  const timeout = Math.min(1800000, Math.max(10000, Number(settings.runTimeoutMs || 300000)));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, shell: false, windowsHide: true,
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '', completed = false;
    const finish = (error, data) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('AI job exceeded its time limit.'));
    }, timeout);
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      if (Buffer.byteLength(out) > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error('AI output exceeded 2 MB.'));
      }
    });
    child.stderr.on('data', chunk => {
      err += chunk.toString();
      if (err.length > 16000) err = err.slice(-16000);
    });
    child.on('error', () => finish(new Error('Cannot start AI provider. Verify the executable is installed.')));
    child.on('close', code => {
      if (code === 0) finish(null, { output: out.trim() });
      else finish(new Error('AI provider exited with code ' + code + ': ' + err.slice(-400)));
    });
  });
}
 + '{MCP_BEARER_TOKEN}' }
        }
      }
    }, null, 2) + '\n');
    atomic(paths.codex, [
      '[mcp_servers.database_bridge]',
      'url = "' + url + '"',
      'bearer_token_env_var = "MCP_BEARER_TOKEN"',
      'required = true',
      ''
    ].join('\n'));
    configurations.push(paths);
  }
  return configurations;
}

export function buildAiCommand(job, settings) {
  const provider = String(job.provider || 'opencode');
  if (!supported.has(provider)) throw new Error('Unsupported AI provider: ' + provider);
  const workspace = workspaceFiles(settings, job.includeInstructions !== false).workspace;
  const prompt = String(job.prompt || '').trim();
  if (!prompt) throw new Error('AI prompt is required.');
  const binaries = settings.executables || {};
  const executable = String(binaries[provider] || provider);
  // Windows .cmd shims require special handling; prefer absolute native CLI binaries.
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new Error('Set a native executable path, not a shell script.');
  }
  let args;
  if (provider === 'opencode') {
    args = ['run', '--dir', workspace, prompt];
  } else if (provider === 'claude') {
    args = ['-p', '--permission-mode', 'dontAsk',
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit',
      prompt];
  } else {
    args = ['exec', '--cd', workspace, '--sandbox', 'read-only',
      '--skip-git-repo-check', prompt];
  }
  return { provider, executable, args, cwd: workspace, includeInstructions: job.includeInstructions !== false };
}

export function runAiProvider(job, settings, { spawn = nodeSpawn } = {}) {
  const spec = buildAiCommand(job, settings);
  const timeout = Math.min(1800000, Math.max(10000, Number(settings.runTimeoutMs || 300000)));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, shell: false, windowsHide: true,
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '', completed = false;
    const finish = (error, data) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('AI job exceeded its time limit.'));
    }, timeout);
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      if (Buffer.byteLength(out) > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error('AI output exceeded 2 MB.'));
      }
    });
    child.stderr.on('data', chunk => {
      err += chunk.toString();
      if (err.length > 16000) err = err.slice(-16000);
    });
    child.on('error', () => finish(new Error('Cannot start AI provider. Verify the executable is installed.')));
    child.on('close', code => {
      if (code === 0) finish(null, { output: out.trim() });
      else finish(new Error('AI provider exited with code ' + code + ': ' + err.slice(-400)));
    });
  });
}
