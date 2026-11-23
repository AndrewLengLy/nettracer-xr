// Runs the operating system's own network tools. Nothing here needs admin rights.
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { parseArp, parseIfconfig, parseIpAddr, parseIpconfig, parsePingAlive, parsePingAvg, parseTrace, pickAdapter } from './parse.js';

export const platform = process.platform; // 'win32' | 'darwin' | 'linux'
const WIN = platform === 'win32';

/** Run a command and resolve with stdout. Never rejects: a failed tool returns its partial output. */
export function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(String(stdout || '') + (err && !stdout ? String(stderr || '') : ''));
    });
  });
}

/** This PC's adapter, IPv4 address, subnet mask, gateway and MAC. */
export async function readAdapter() {
  if (WIN) return pickAdapter(parseIpconfig(await run('ipconfig', ['/all'])));
  if (platform === 'darwin') return pickAdapter(parseIfconfig(await run('ifconfig', []), await run('route', ['-n', 'get', 'default'])));
  return pickAdapter(parseIpAddr(await run('ip', ['-4', '-o', 'addr', 'show']), await run('ip', ['route', 'show', 'default']), await run('ip', ['link', 'show'])));
}

/** One ping with a short timeout. */
export async function pingOnce(ip) {
  const args = WIN ? ['-n', '1', '-w', '600', ip] : platform === 'darwin' ? ['-c', '1', '-W', '600', ip] : ['-c', '1', '-W', '1', ip];
  return parsePingAlive(await run('ping', args, 4000));
}

/** Average latency over four pings, in ms. */
export async function pingAvg(ip) {
  const args = WIN ? ['-n', '4', '-w', '1000', ip] : ['-c', '4', ip];
  return parsePingAvg(await run('ping', args, 12000));
}

/** Ping every address in the list, a few at a time, and report progress. */
export async function sweep(ips, { concurrency = 12, onProgress } = {}) {
  const alive = new Set();
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < ips.length) {
      const ip = ips[next++];
      if (await pingOnce(ip)) alive.add(ip);
      done++;
      if (onProgress) onProgress(done, ips.length, alive.size);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  return alive;
}

export async function readArp() {
  return parseArp(await run('arp', ['-a']));
}

/** Hostname for an address through the OS resolver (DNS, mDNS or NetBIOS, whatever the OS uses). */
export function hostnameFor(ip, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    dns.lookupService(ip, 0, (err, host) => {
      clearTimeout(timer);
      resolve(!err && host && host !== ip ? host.replace(/\.$/, '') : null);
    });
  });
}

/** Hops toward the target. Uses numeric output so no reverse lookups slow it down. */
export async function trace(target, maxHops = 8) {
  const out = WIN
    ? await run('tracert', ['-d', '-h', String(maxHops), '-w', '1000', target], 90000)
    : await run('traceroute', ['-n', '-m', String(maxHops), '-w', '2', '-q', '3', target], 90000);
  return parseTrace(out);
}
