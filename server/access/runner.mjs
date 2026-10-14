import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JAVA_SOURCE = fileURLToPath(new URL('./AccessReader.java', import.meta.url));

/**
 * Read-only Access adapter. Runs the UCanAccess JDBC library in a child JVM;
 * never invokes cmd.exe or PowerShell and never accepts raw SQL from the agent.
 */
export function runAccess(source, operation, args = {}, settings = {}, deps = {}) {
  const filename = source.file;
  if (typeof filename !== 'string' || !/\.(mdb|accdb)$/i.test(filename) || /[;\r\n]/.test(filename)) {
    throw new Error('Invalid Access file path.');
  }
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw new Error('The configured Access database file is unavailable.');
  }
  const classpath = source.classpath || process.env.MCP_ACCESS_CLASSPATH;
  if (!classpath) throw new Error('Set MCP_ACCESS_CLASSPATH to the UCanAccess JDBC jar directory (including dependencies).');
  if (!['list_tables', 'describe_table', 'select_rows'].includes(operation)) {
    throw new Error('Only structured read operations are allowed for Access.');
  }
  const timeout = Math.min(60000, Math.max(1000, Number(settings.mcp?.queryTimeoutMs || 30000)));
  const columns = args.columns || [];
  if (!Array.isArray(columns) || columns.some(x => typeof x !== 'string')) throw new Error('Invalid Access columns.');
  const params = [
    '-cp', classpath, JAVA_SOURCE, operation, filename,
    String(args.table || ''), String(args.limit || 1000), String(args.offset || 0),
    ...columns
  ];
  const spawnProcess = deps.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(source.javaExecutable || 'java', params, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Access read timeout.'));
    }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        child.kill();
        fail(new Error('Access result exceeds 4 MB.'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString().slice(0, 2000);
    });
    child.on('error', () => fail(new Error('Cannot start Java/UCanAccess. Check Java 11+ and classpath.')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return fail(new Error('Access read failed: ' + stderr.slice(0, 500)));
      try {
        const parsed = JSON.parse(stdout);
        settled = true;
        clearTimeout(timer);
        resolve(parsed);
      } catch {
        fail(new Error('Invalid response from Access reader.'));
      }
    });
  });
}
