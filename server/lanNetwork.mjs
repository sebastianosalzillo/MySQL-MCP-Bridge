import os from 'node:os';
import net from 'node:net';

/**
 * LAN is opt-in and deliberately bound to ONE local private IPv4 interface.
 * This prevents exposing the service on a public adapter or a wildcard socket.
 * A second loopback listener keeps existing local OpenCode connections intact.
 */
function ipv4Number(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').reduce((acc, part) => ((acc * 256) + Number(part)) >>> 0, 0);
}

function isPrivateIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const parts = ip.split('.').map(Number);
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

export function availableLanInterfaces(interfaces = os.networkInterfaces()) {
  const unique = new Map();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const item of entries || []) {
      if (!item || item.internal || item.family !== 'IPv4' || !isPrivateIPv4(item.address)) continue;
      const address = String(item.address);
      const mask = String(item.netmask || '');
      if (ipv4Number(mask) === null) continue;
      unique.set(address, { address, netmask: mask, name });
    }
  }
  return [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

export function selectedLanInterface(lan = {}, interfaces = os.networkInterfaces()) {
  if (lan?.enabled !== true) return null;
  const ip = String(lan.host || '').trim();
  const selected = availableLanInterfaces(interfaces).find(item => item.address === ip);
  if (!selected) {
    throw new Error('Choose an active private IPv4 address from the LAN interface list before enabling LAN access.');
  }
  return selected;
}

export function isLanPeerAllowed(remoteAddress, selected = null) {
  let remote = String(remoteAddress || '');
  if (remote.startsWith('::ffff:')) remote = remote.slice(7);
  if (remote === '127.0.0.1' || remote === '::1') return true;
  if (!selected || !isPrivateIPv4(remote)) return false;
  const mask = ipv4Number(selected.netmask);
  const remoteNumber = ipv4Number(remote);
  const localNumber = ipv4Number(selected.address);
  return mask !== null && remoteNumber !== null && localNumber !== null &&
    (remoteNumber & mask) === (localNumber & mask);
}
