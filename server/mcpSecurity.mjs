/**
 * Host headers normally include the TCP port (e.g. 127.0.0.1:3001).
 * Keep both forms for HTTP proxies while preserving strict DNS rebinding checks.
 * Never trust wildcard domains or arbitrary browser Origins.
 */
export function mcpAllowedConnections({ port, publicBase = '', hosts = [], origins = [] } = {}) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error('Invalid MCP listener port.');
  }
  const allowedHosts = new Set([
    '127.0.0.1', '127.0.0.1:' + number,
    'localhost', 'localhost:' + number,
    '[::1]', '[::1]:' + number
  ]);
  const allowedOrigins = new Set([
    'http://127.0.0.1', 'http://127.0.0.1:' + number,
    'http://localhost', 'http://localhost:' + number,
    'http://[::1]', 'http://[::1]:' + number
  ]);
  for (const host of hosts) {
    if (typeof host === 'string' && host.trim()) allowedHosts.add(host.trim());
  }
  for (const origin of origins) {
    if (typeof origin === 'string' && origin.trim()) allowedOrigins.add(origin.trim());
  }
  if (publicBase) {
    const url = new URL(publicBase);
    allowedHosts.add(url.host);
    allowedOrigins.add(url.origin);
  }
  return { allowedHosts: [...allowedHosts], allowedOrigins: [...allowedOrigins] };
}
