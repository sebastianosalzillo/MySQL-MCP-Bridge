import fs from 'node:fs';
import mysql from 'mysql2/promise';
import mysqlCallback from 'mysql2';
import { applyServerProbe, buildCapabilities, parseServerVersion } from './mysqlVersion.mjs';

export const TLS_MODES = ['off', 'required', 'verify-ca', 'verify-full'];

/**
 * mysql2 defaults to UTF8MB4_UNICODE_CI, which is utf8mb4_0900_ai_ci (collation
 * 224). That collation only exists on MySQL 8.0+, so the default handshake is
 * rejected outright by 5.6, 5.7, MariaDB and Percona. Every entry here is
 * therefore an explicit mysql2 Charsets constant rather than a free-form name.
 */
export const COLLATIONS = {
  'server-default': null,
  utf8mb4: 'UTF8MB4_GENERAL_CI',
  'utf8mb4-unicode': 'UTF8MB4_UNICODE_CI',
  'utf8mb4-bin': 'UTF8MB4_BIN',
  utf8: 'UTF8_GENERAL_CI',
  latin1: 'LATIN1_GENERAL_CI',
  utf16: 'UTF16_GENERAL_CI',
  utf32: 'UTF32_GENERAL_CI',
  binary: 'BINARY'
};

export const AUTH_PLUGINS = ['auto', 'mysql_native_password', 'caching_sha2_password', 'sha256_password', 'mysql_clear_password'];

const AUTH_PLUGIN_ALIASES = {
  native: 'mysql_native_password',
  caching_sha2: 'caching_sha2_password',
  sha256: 'sha256_password',
  clear: 'mysql_clear_password'
};

// Only these variables exist on every supported server, which keeps detection
// from being the thing that breaks on an old box.
const BOOTSTRAP_SQL = [
  'SELECT VERSION() AS version,',
  '@@version_comment AS version_comment,',
  '@@sql_mode AS sql_mode,',
  '@@max_allowed_packet AS max_allowed_packet,',
  '@@character_set_server AS character_set_server'
].join(' ');

// Each optional variable is probed on its own: a single unknown variable would
// fail the whole statement, and these do not all exist on every supported server.
const OPTIONAL_PROBES = [
  { sql: 'SELECT @@innodb_page_size AS innodb_page_size, @@innodb_default_row_format AS innodb_default_row_format' },
  { sql: 'SELECT @@innodb_large_prefix AS innodb_large_prefix' },
  { sql: 'SELECT @@explicit_defaults_for_timestamp AS explicit_defaults_for_timestamp' }
];

const HANDSHAKE_CODES = new Set([
  1045, // ER_ACCESS_DENIED_ERROR
  1044, // ER_DBACCESS_DENIED_ERROR
  1251, // ER_NOT_SUPPORTED_AUTH_MODE
  1253, // ER_COLLATION_CHARSET_MISMATCH
  1273, // ER_UNKNOWN_CHARACTER_SET
  1698 // ER_ACCESS_DENIED_NO_PASSWORD_ERROR
]);

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function normalizeTlsMode(value) {
  const mode = String(value ?? 'off').toLowerCase().trim();
  if (mode === 'true' || mode === '1' || mode === 'on') return 'required';
  if (mode === 'false' || mode === '0' || mode === 'none' || mode === 'disabled') return 'off';
  return TLS_MODES.includes(mode) ? mode : 'off';
}

export function normalizeCollation(value) {
  const key = String(value ?? 'utf8mb4').toLowerCase().trim();
  return key in COLLATIONS ? key : 'utf8mb4';
}

function readPem(filePath, label) {
  const target = String(filePath || '').trim();
  if (!target) return undefined;
  try {
    return fs.readFileSync(target);
  } catch (err) {
    throw new Error(`Cannot read ${label} file "${target}": ${err?.message || String(err)}`);
  }
}

export function buildSslOptions(mysqlSettings = {}, overrides = {}) {
  const mode = overrides.tlsMode ? normalizeTlsMode(overrides.tlsMode) : normalizeTlsMode(mysqlSettings.tlsMode);
  if (mode === 'off') return { ssl: false, tlsMode: 'off' };

  const ca = readPem(mysqlSettings.caFile, 'CA');
  const cert = readPem(mysqlSettings.certFile, 'client certificate');
  const key = readPem(mysqlSettings.keyFile, 'client key');

  const ssl = {
    // "required" encrypts without validating the certificate, which is what makes
    // the self-signed defaults on old MySQL 5.6 hosts usable at all.
    rejectUnauthorized: mode === 'required' ? false : true
  };
  if (mode === 'verify-full') ssl.verifyIdentity = true;
  if (ca) ssl.ca = ca;
  if (cert) ssl.cert = cert;
  if (key) ssl.key = key;

  const minVersion = String(mysqlSettings.minTlsVersion || '').trim();
  if (minVersion) ssl.minVersion = minVersion;
  const maxVersion = String(mysqlSettings.maxTlsVersion || '').trim();
  if (maxVersion) ssl.maxVersion = maxVersion;
  const ciphers = String(mysqlSettings.ciphers || '').trim();
  if (ciphers) ssl.ciphers = ciphers;

  return { ssl, tlsMode: mode };
}

function resolveAuthPlugin(mysqlSettings) {
  let name = String(mysqlSettings.authPlugin || 'auto').toLowerCase().trim();
  name = AUTH_PLUGIN_ALIASES[name] || name;
  if (name === 'auto' || !AUTH_PLUGINS.includes(name)) return {};
  const factory = mysqlCallback.authPlugins?.[name];
  if (!factory) return {};
  const options = {};
  const serverPublicKey = String(mysqlSettings.serverPublicKey || '').trim();
  if (serverPublicKey) options.serverPublicKey = serverPublicKey;
  return {
    authPlugins: { [name]: factory(options) },
    enableCleartextPlugin: name === 'mysql_clear_password'
  };
}

/**
 * Collapses 224 (utf8mb4_0900_ai_ci) on servers that predate it, so a saved
 * MySQL 8.0 configuration still connects to a 5.7 host.
 */
export function resolveCollation(collationKey, version) {
  const key = normalizeCollation(collationKey);
  const name = COLLATIONS[key];
  if (!name) return { key, name: null, number: null, downgraded: false };
  if (name === 'UTF8MB4_UNICODE_CI' && version && version.major < 8) {
    return { key: 'utf8mb4', name: 'UTF8MB4_GENERAL_CI', number: mysql.Charsets.UTF8MB4_GENERAL_CI, downgraded: true };
  }
  return { key, name, number: mysql.Charsets[name] ?? null, downgraded: false };
}

export function poolConfig(mysqlSettings = {}, overrides = {}) {
  const tls = buildSslOptions(mysqlSettings, overrides);
  const collation = resolveCollation(mysqlSettings.collation, overrides.version);

  const cfg = {
    host: mysqlSettings.host || '127.0.0.1',
    port: Number(mysqlSettings.port || 3306),
    user: mysqlSettings.user,
    password: mysqlSettings.password || '',
    waitForConnections: true,
    connectionLimit: Number(mysqlSettings.connectionLimit || 6),
    maxIdle: 3,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: Number(mysqlSettings.connectTimeoutMs || 10000),
    multipleStatements: false,
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // Pinning the client to UTC avoids depending on the host's local zone.
    timezone: 'Z'
  };

  if (mysqlSettings.database) cfg.database = mysqlSettings.database;
  if (mysqlSettings.socketPath) {
    // Local Windows services frequently listen on a named pipe rather than TCP.
    cfg.socketPath = String(mysqlSettings.socketPath);
    delete cfg.host;
    delete cfg.port;
  }
  if (collation.name) cfg.charset = collation.name;
  if (tls.ssl) cfg.ssl = tls.ssl;
  Object.assign(cfg, resolveAuthPlugin(mysqlSettings));

  return { config: cfg, collation, tlsMode: tls.tlsMode };
}

export function createPool(settings, overrides = {}) {
  const { config } = poolConfig(settings.mysql || settings, overrides);
  return mysql.createPool(config);
}

export function isHandshakeError(err) {
  const code = String(err?.code || '');
  const errno = Number(err?.errno || 0);
  if (HANDSHAKE_CODES.has(errno)) return true;
  if (TLS_ERROR_CODES.has(code)) return true;
  return /collation|character set|auth(entication)? plugin|ssl|tls|certificate/i.test(err?.message || '');
}

function attemptConfigs(mysqlSettings, mcpSettings) {
  void mcpSettings;
  const base = poolConfig(mysqlSettings);
  const attempts = [{ label: `tls=${base.tlsMode}, collation=${base.collation.key}`, ...base }];

  // A configuration saved against MySQL 8.0 may carry utf8mb4_0900_ai_ci, which
  // 5.6/5.7 reject during the handshake, so retry with the portable collation.
  if (base.collation.name === 'UTF8MB4_UNICODE_CI') {
    const downgraded = { ...base.config, charset: 'UTF8MB4_GENERAL_CI' };
    attempts.push({ label: 'collation=utf8mb4 (pre-8.0 fallback)', config: downgraded, collation: { key: 'utf8mb4', name: 'UTF8MB4_GENERAL_CI', downgraded: true }, tlsMode: base.tlsMode });
  }

  if (base.tlsMode !== 'off') {
    const unverified = poolConfig(mysqlSettings, { tlsMode: 'required' });
    attempts.push({ label: 'tls=required (unverified certificate)', ...unverified });

    const legacy = { ...unverified.config, ssl: { rejectUnauthorized: false, minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' } };
    attempts.push({ label: 'tls=required (TLSv1, legacy ciphers)', config: legacy, collation: unverified.collation, tlsMode: 'required' });

    const plain = poolConfig(mysqlSettings, { tlsMode: 'off' });
    attempts.push({ label: 'tls=off', ...plain });
  }

  return attempts;
}

/**
 * Connects using the first candidate that completes a handshake, then detects the
 * server version so callers can gate behaviour on it. Only negotiation failures
 * trigger a retry, and every attempt is reported so a downgraded connection is
 * never silent.
 */
export async function connectWithFallback(settings, hooks = {}) {
  const mysqlSettings = settings.mysql || settings;
  const mcpSettings = settings.mcp || {};
  const allowFallback = mysqlSettings.allowTlsFallback !== false;
  const attempts = attemptConfigs(mysqlSettings, mcpSettings);
  const maxAttempts = allowFallback ? attempts.length : 1;
  const failures = [];

  for (let i = 0; i < maxAttempts; i += 1) {
    const attempt = attempts[i];
    if (i > 0) hooks.onAttempt?.({ attempt: i + 1, of: attempts.length, label: attempt.label, reason: failures.at(-1) });
    let pool;
    try {
      pool = mysql.createPool(attempt.config);
      const detected = await detectServer(pool);
      return { pool, ...detected, tlsMode: attempt.tlsMode, collation: attempt.collation, label: attempt.label };
    } catch (err) {
      if (pool) await pool.end().catch(() => {});
      failures.push(err);
      if (!allowFallback || !isHandshakeError(err) || i === maxAttempts - 1) break;
    }
  }

  const err = failures.at(-1);
  const detail = failures.map(f => f?.message || String(f)).join(' | ');
  const error = new Error(`MySQL connection failed: ${detail}`);
  error.code = err?.code;
  error.errno = err?.errno;
  error.attempts = failures.length;
  throw error;
}

export async function detectServer(pool) {
  const [rows] = await pool.query(BOOTSTRAP_SQL);
  const row = rows?.[0] || {};
  const version = parseServerVersion(row.version, row.version_comment);
  const capabilities = buildCapabilities(version);
  version.probe = row;

  const extra = {};
  for (const probe of OPTIONAL_PROBES) {
    try {
      const [result] = await pool.query(probe.sql);
      Object.assign(extra, result?.[0] || {});
    } catch {
      // Unknown variable on this server version; the defaults are used instead.
    }
  }
  applyServerProbe(capabilities, version, { ...row, ...extra });

  return { version, capabilities, probe: { ...row, ...extra } };
}

export async function openSession(pool, settings, hooks = {}) {
  const mysqlSettings = settings.mysql || settings;
  const connection = await pool.getConnection();
  const applied = [];
  try {
    // An offset is used so this never depends on the mysql.time_zone* lookup
    // tables, which many hosts leave empty.
    const timeZone = String(mysqlSettings.sessionTimeZone ?? '+00:00').trim();
    if (timeZone && /^[+-]\d{2}:\d{2}$|^UTC$/.test(timeZone)) {
      await connection.query(`SET SESSION time_zone = '${timeZone.replaceAll("'", '')}'`);
      applied.push(`time_zone=${timeZone}`);
    }
    const sqlMode = String(mysqlSettings.sqlMode ?? '').trim();
    if (sqlMode && /^[A-Z_,]*$/i.test(sqlMode)) {
      await connection.query(`SET SESSION sql_mode = '${sqlMode.replaceAll("'", '')}'`);
      applied.push(`sql_mode=${sqlMode}`);
    }
    const groupConcat = Number(mysqlSettings.groupConcatMaxLen || 0);
    if (groupConcat > 0) {
      await connection.query(`SET SESSION group_concat_max_len = ${Math.min(groupConcat, 4294967295)}`);
      applied.push(`group_concat_max_len=${groupConcat}`);
    }
  } catch (err) {
    hooks.onWarn?.(`Session setup skipped: ${err?.message || String(err)}`);
  } finally {
    connection.release();
  }
  if (applied.length) hooks.onSession?.(applied);
  return applied;
}

export async function testConnection(mysqlSettings, hooks = {}) {
  const settings = { mysql: mysqlSettings, mcp: {} };
  const { pool, version, capabilities, probe, tlsMode, collation } = await connectWithFallback(settings, hooks);
  try {
    const tables = mysqlSettings.database
      ? await pool.query('SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = ?', [mysqlSettings.database])
      : [[{ total: 0 }]];
    await openSession(pool, settings, hooks);
    return {
      ok: true,
      version: probe?.version,
      versionLabel: `${version.vendorLabel} ${probe?.version}`,
      versionComment: probe?.version_comment,
      server: version,
      capabilities,
      sqlMode: probe?.sql_mode,
      maxAllowedPacket: Number(probe?.max_allowed_packet || 0),
      characterSetServer: probe?.character_set_server,
      tableCount: Number(tables?.[0]?.[0]?.total || 0),
      tlsMode,
      collation: collation?.key
    };
  } finally {
    await pool.end();
  }
}

export async function queryWithTimeout(pool, sql, values, timeoutMs) {
  const connection = await pool.getConnection();
  const timeout = Math.max(1000, Number(timeoutMs || 30000));
  let timer;
  let destroyed = false;
  try {
    const task = connection.query({ sql, timeout }, values || []);
    const hardTimeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        destroyed = true;
        try { connection.destroy(); } catch { /* the socket is already gone */ }
        reject(new Error(`Query timed out after ${timeout} ms`));
      }, timeout + 1500);
    });
    return await Promise.race([task, hardTimeout]);
  } finally {
    clearTimeout(timer);
    if (!destroyed) connection.release();
  }
}
