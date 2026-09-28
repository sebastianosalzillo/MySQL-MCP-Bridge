import mysql from 'mysql2/promise';

export function poolConfig(mysqlSettings, mcpSettings = {}) {
  const cfg = {
    host: mysqlSettings.host,
    port: Number(mysqlSettings.port || 3306),
    user: mysqlSettings.user,
    password: mysqlSettings.password || '',
    database: mysqlSettings.database || undefined,
    waitForConnections: true,
    connectionLimit: 6,
    maxIdle: 3,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: Number(mysqlSettings.connectTimeoutMs || 10000),
    multipleStatements: false,
    dateStrings: true,
    decimalNumbers: true
  };
  if (mysqlSettings.ssl) cfg.ssl = {};
  return cfg;
}

export function createPool(settings) {
  return mysql.createPool(poolConfig(settings.mysql || settings, settings.mcp || {}));
}

export async function testConnection(mysqlSettings) {
  const pool = mysql.createPool(poolConfig(mysqlSettings));
  try {
    const [rows] = await pool.query('SELECT VERSION() AS version, DATABASE() AS database_name, CURRENT_USER() AS logged_user');
    const [tables] = mysqlSettings.database
      ? await pool.query('SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = ?', [mysqlSettings.database])
      : [[{ total: 0 }]];
    return { ok: true, ...rows[0], tableCount: Number(tables[0]?.total || 0) };
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
        try { connection.destroy(); } catch {}
        reject(new Error(`Query timeout dopo ${timeout} ms`));
      }, timeout + 1500);
    });
    return await Promise.race([task, hardTimeout]);
  } finally {
    clearTimeout(timer);
    if (!destroyed) connection.release();
  }
}
