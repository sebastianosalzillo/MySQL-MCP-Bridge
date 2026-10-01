export const MIN_SUPPORTED_VERSION = '5.6';

const VENDOR_LABELS = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  percona: 'Percona Server',
  aurora: 'Amazon Aurora'
};

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function cleanComment(versionComment) {
  return String(versionComment || '')
    .replace(/^.*?\)(\s*,\s*)?/, '')
    .trim();
}

/**
 * Parses the many shapes MySQL-compatible servers return from VERSION():
 *   8.0.36                       plain MySQL
 *   5.7.44-log                   Debian/Ubuntu build
 *   8.4.0 / 9.1.0                current MySQL
 *   5.5.5-10.6.18-MariaDB        MariaDB replication compatibility prefix
 *   10.11.6-MariaDB-1:10.11.6+maria~ubu2204
 *   8.0.mysql_aurora.3.04.0      Amazon Aurora MySQL 3
 *   5.7.44-48                    Percona build
 */
export function parseServerVersion(raw, versionComment = '') {
  const text = String(raw || '').trim();
  const comment = String(versionComment || '');

  const isMaria = /mariadb/i.test(text) || /maria(db)?\s*server/i.test(comment);
  const isAurora = /mysql_aurora/i.test(text) || /\bAurora\b/i.test(comment);
  const isPercona = !isMaria && /\bpercona\b/i.test(comment);

  let vendor = 'mysql';
  if (isMaria) vendor = 'mariadb';
  else if (isAurora) vendor = 'aurora';
  else if (isPercona) vendor = 'percona';

  // MariaDB >= 10 prefixes the real version with a 5.5.5- shim.
  const mariaShim = text.match(/^5\.5\.5-(\d+\.\d+(?:\.\d+)?)/);
  const aurora = text.match(/mysql_aurora\.(\d+\.\d+\.\d+)/);

  const candidate = mariaShim ? mariaShim[1] : text;
  const parts = candidate.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  const major = toInt(parts?.[1]);
  const minor = toInt(parts?.[2]);
  const patch = toInt(parts?.[3]);

  const version = `${major}.${minor}.${patch}`;

  return {
    raw: text,
    version,
    major,
    minor,
    patch,
    vendor,
    vendorLabel: VENDOR_LABELS[vendor] || VENDOR_LABELS.mysql,
    isMariaDB: isMaria,
    isAurora,
    isPercona,
    auroraVersion: aurora ? aurora[1] : '',
    versionComment: cleanComment(comment),
    supported: isAtLeast({ major, minor, patch }, 5, 6, 0),
    // Feature detection and metadata live here too, because they are useless apart.
    innodbPageSize: 0,
    innodbDefaultRowFormat: '',
    sqlMode: '',
    maxAllowedPacket: 0,
    characterSetServer: ''
  };
}

export function isAtLeast(version, major, minor = 0, patch = 0) {
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

function maxIndexKeyBytes(version) {
  if (isAtLeast(version, 8, 0, 0)) return 3072;
  if (version.isMariaDB && isAtLeast(version, 10, 2, 2)) return 3072;
  if (isAtLeast(version, 5, 7, 7)) return 3072;
  return 767;
}

/**
 * Feature gates derived from the server version. Everything version dependent in
 * the tools layer must consult this instead of assuming a modern server.
 */
export function buildCapabilities(version) {
  const at = (major, minor, patch = 0) => isAtLeast(version, major, minor, patch);
  return {
    serverVersion: version.version,
    vendor: version.vendor,
    vendorLabel: version.vendorLabel,
    isAurora: version.isAurora,

    // Data types and column defaults
    jsonType: at(5, 7, 8),
    generatedColumns: at(5, 7, 6),
    defaultExpressions: at(8, 0, 13),
    datetimeDefault: at(5, 6, 5),
    multipleTimestampDefaults: at(5, 6, 5),
    enforcedCheckConstraints: at(8, 0, 16),

    // Query language
    cte: at(8, 0, 0),
    windowFunctions: at(8, 0, 0),

    // DDL execution strategies
    instantAddColumn: at(8, 0, 12),
    onlineDdl: at(5, 6, 0),
    atomicRename: at(5, 7, 0),

    // Index limits
    maxIndexKeyBytes: maxIndexKeyBytes(version),
    functionalIndexes: at(8, 0, 13),

    // Removals / deprecations worth warning about
    utf8mb3Deprecated: at(8, 0, 28) && !version.isMariaDB,
    displayWidthDeprecated: at(8, 0, 19) && !version.isMariaDB
  };
}

export function applyServerProbe(caps, version, probe = {}) {
  if (Number(probe.max_allowed_packet) > 0) {
    caps.maxAllowedPacket = Number(probe.max_allowed_packet);
  }
  if (Number(probe.innodb_page_size) > 0) {
    caps.innodbPageSize = Number(probe.innodb_page_size);
  }
  if (probe.innodb_default_row_format) {
    caps.innodbDefaultRowFormat = String(probe.innodb_default_row_format);
  }
  if (probe.innodb_large_prefix !== undefined && probe.innodb_large_prefix !== null) {
    caps.innodbLargePrefix = String(probe.innodb_large_prefix);
  }
  if (probe.explicit_defaults_for_timestamp !== undefined && probe.explicit_defaults_for_timestamp !== null) {
    caps.explicitDefaultsForTimestamp = String(probe.explicit_defaults_for_timestamp);
  }
  if (probe.sql_mode) {
    caps.sqlMode = String(probe.sql_mode);
  }
  if (probe.character_set_server) {
    caps.characterSetServer = String(probe.character_set_server);
  }
  version.sqlMode = caps.sqlMode;
  version.maxAllowedPacket = caps.maxAllowedPacket;
  version.characterSetServer = caps.characterSetServer;
  return caps;
}

/**
 * Per-column index key budget, in bytes, for a concrete table. InnoDB scales the
 * limit down with the page size, and 5.6 defaults to a 767 byte budget while 5.7+
 * defaults to 3072, so this has to be resolved against the live table rather than
 * assumed from the version alone.
 */
export function indexKeyBudget(caps, tableInfo = {}) {
  const engine = String(tableInfo.engine || 'InnoDB');
  const rowFormat = String(tableInfo.rowFormat || caps.innodbDefaultRowFormat || '').toUpperCase();
  const pageSize = Number(caps.innodbPageSize) || 16384;

  if (engine === 'MyISAM') {
    return { engine, rowFormat: rowFormat || null, perColumn: 1000, total: 1000, prefixable: true };
  }

  const narrowRowFormat = rowFormat === 'COMPACT' || rowFormat === 'REDUNDANT';
  const largePrefix = caps.innodbLargePrefix === 'ON' || caps.innodbLargePrefix === '1';
  const versionLimit = Number(caps.maxIndexKeyBytes) || 3072;

  // 767 bytes unless the row format is wide and innodb_large_prefix is on, which
  // is only the default from MySQL 5.7.7 onwards. MySQL 8.0 dropped the variable.
  let perColumn = narrowRowFormat ? 767 : (largePrefix ? 3072 : versionLimit);

  // InnoDB lowers the key length proportionally when the page size is reduced.
  perColumn = Math.floor(perColumn * (Math.min(pageSize, 16384) / 16384));

  return {
    engine,
    rowFormat: rowFormat || null,
    perColumn,
    total: Math.min(3072, perColumn),
    prefixable: true
  };
}

export function compatibilityWarnings(version, caps) {
  const warnings = [];
  const add = (id, message) => warnings.push({ id, message });

  if (!version.supported) {
    add('unsupported', `Server reports ${version.raw}. Only MySQL ${MIN_SUPPORTED_VERSION} and newer are supported; some tools may fail.`);
  }
  if (!caps.jsonType) add('no-json', 'JSON columns are not available before MySQL 5.7.8 and will be rejected by create_table.');
  if (!caps.datetimeDefault) add('no-datetime-default', 'Before MySQL 5.6.5 a TIMESTAMP column can only auto-initialise once per table.');
  if (!caps.cte) add('no-cte', 'Common table expressions (WITH) require MySQL 8.0 or newer.');
  if (!caps.defaultExpressions) add('no-default-expr', 'Expression defaults require MySQL 8.0.13 or newer; only literals are accepted.');
  if (caps.maxIndexKeyBytes < 3072) add('small-index-key', `InnoDB index keys are limited to ${caps.maxIndexKeyBytes} bytes on this server; wide utf8mb4 columns need a prefix length.`);
  if (caps.utf8mb3Deprecated) add('utf8mb3', 'MySQL 8.0.28+ treats the legacy utf8 character set as utf8mb3 and emits deprecation warnings.');
  if (version.isMariaDB) add('mariadb', 'MariaDB reports its own version; MySQL 8.0-only features (CTEs, window functions, JSON type) are unavailable.');

  return warnings;
}

export function describeVersion(version) {
  const parts = [version.vendorLabel, version.version];
  if (version.isAurora && version.auroraVersion) parts.push(`(Aurora ${version.auroraVersion})`);
  if (version.isMariaDB) parts.push('(MySQL-compatible)');
  return parts.join(' ');
}
