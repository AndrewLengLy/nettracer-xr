// Parsers for the text that ipconfig, ip, ifconfig, arp, ping and traceroute print.
// Pure functions so they can be unit tested with saved output.

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

export const isIpv4 = (s) => {
  const m = String(s || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
};

export const ipToInt = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0) >>> 0;
export const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export const maskToPrefix = (mask) => {
  let n = ipToInt(mask);
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
};

export const prefixToMask = (p) => intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);

/** Normalize "AA-BB-CC-DD-EE-FF" or "a:b:c:d:e:f" to "aa:bb:cc:dd:ee:ff". Returns null for anything else. */
export function normMac(raw) {
  const parts = String(raw || '').trim().toLowerCase().split(/[-:]/);
  if (parts.length !== 6) return null;
  const out = parts.map((p) => p.padStart(2, '0'));
  if (!out.every((p) => /^[0-9a-f]{2}$/.test(p))) return null;
  return out.join(':');
}

/**
 * Windows `ipconfig /all`. Returns one entry per adapter that has an IPv4 address.
 * Values can wrap onto following indented lines (Default Gateway often lists IPv6 first).
 */
export function parseIpconfig(text) {
  const adapters = [];
  let cur = null;
  let lastKey = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      const m = raw.match(/^(.*adapter\s+)?(.+?):\s*$/i);
      cur = m && /adapter/i.test(raw) ? { name: m[2].trim(), ipv4: null, mask: null, gateway: null, mac: null, description: '', dns: [] } : null;
      if (cur) adapters.push(cur);
      lastKey = null;
      continue;
    }
    if (!cur) continue;
    const kv = raw.match(/^\s+([^:]+?)[ .]*:\s*(.*)$/);
    let key;
    let val;
    if (kv && /\. \.|\.\s*:/.test(raw.split(':')[0] + ':')) {
      key = kv[1].trim().toLowerCase();
      val = kv[2].trim();
      lastKey = key;
    } else {
      key = lastKey;
      val = raw.trim();
    }
    if (!key) continue;
    const ip = (val.match(IPV4) || [])[1];
    if (key.startsWith('ipv4 address') || key === 'ip address') { if (ip) cur.ipv4 = ip; }
    else if (key.startsWith('subnet mask')) { if (ip) cur.mask = ip; }
    else if (key.startsWith('default gateway')) { if (ip && !cur.gateway) cur.gateway = ip; }
    else if (key.startsWith('physical address')) cur.mac = normMac(val) || cur.mac;
    else if (key.startsWith('description')) cur.description = val;
    else if (key.startsWith('dns servers')) { if (ip) cur.dns.push(ip); }
  }
  return adapters.filter((a) => a.ipv4 && a.mask);
}

/** Linux `ip -4 -o addr show` plus `ip route show default`. */
export function parseIpAddr(addrText, routeText, linkText = '') {
  const gw = (String(routeText).match(/default via (\S+) dev (\S+)/) || []);
  const out = [];
  for (const line of String(addrText).split(/\r?\n/)) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (!m || m[1] === 'lo') continue;
    const macM = String(linkText).match(new RegExp(`\\d+:\\s+${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[\\s\\S]*?link/ether\\s+([0-9a-f:]{17})`));
    out.push({
      name: m[1], ipv4: m[2], mask: prefixToMask(Number(m[3])),
      gateway: gw[2] === m[1] ? gw[1] : null, mac: macM ? normMac(macM[1]) : null, description: m[1], dns: [],
    });
  }
  return out;
}

/** macOS `ifconfig` plus `route -n get default`. */
export function parseIfconfig(text, routeText) {
  const gw = (String(routeText).match(/gateway:\s*(\S+)/) || [])[1] || null;
  const gwIf = (String(routeText).match(/interface:\s*(\S+)/) || [])[1] || null;
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const head = line.match(/^(\S+?):\s+flags=/);
    if (head) { cur = { name: head[1], ipv4: null, mask: null, gateway: null, mac: null, description: head[1], dns: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const inet = line.match(/\binet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]+|\d+\.\d+\.\d+\.\d+)/i);
    if (inet && inet[1] !== '127.0.0.1') {
      cur.ipv4 = inet[1];
      cur.mask = inet[2].startsWith('0x') ? intToIp(parseInt(inet[2], 16) >>> 0) : inet[2];
    }
    const ether = line.match(/\bether ([0-9a-f:]{11,17})/i);
    if (ether) cur.mac = normMac(ether[1]);
  }
  for (const a of out) if (a.name === gwIf) a.gateway = gw;
  return out.filter((a) => a.ipv4 && a.mask);
}

/** Pick the adapter that carries the default route. */
export function pickAdapter(adapters) {
  return adapters.find((a) => a.gateway) || adapters[0] || null;
}

/**
 * `arp -a` on Windows ("  192.168.1.1    aa-bb-cc-dd-ee-ff   dynamic"), Linux and macOS
 * ("? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0"). Skips incomplete, broadcast and multicast entries.
 */
export function parseArp(text) {
  const seen = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    let ip = null;
    let mac = null;
    let m = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\w+)/i);
    if (m) { ip = m[1]; mac = normMac(m[2]); }
    else {
      m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{11,17})/i);
      if (m) { ip = m[1]; mac = normMac(m[2]); }
    }
    if (!ip || !mac) continue;
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') continue;
    const first = parseInt(mac.slice(0, 2), 16);
    if (first & 1) continue; // multicast MAC
    const o1 = Number(ip.split('.')[0]);
    if (o1 >= 224) continue; // multicast or broadcast range
    if (ip.endsWith('.255')) continue;
    seen.set(ip, mac);
  }
  return [...seen].map(([ip, mac]) => ({ ip, mac }));
}

/** Average round-trip time from ping output, in ms. Null when every probe was lost. */
export function parsePingAvg(text) {
  const t = String(text);
  let m = t.match(/Average\s*=\s*(\d+)\s*ms/i); // Windows
  if (m) return Number(m[1]);
  m = t.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+/); // Linux and macOS min/avg/max
  if (m) return Math.round(Number(m[1]) * 10) / 10;
  return null;
}

/** True when a single ping got a reply. */
export function parsePingAlive(text) {
  const t = String(text);
  if (/TTL=/i.test(t)) return true; // Windows "Reply from ...: bytes=32 time<1ms TTL=64"
  if (/bytes from/i.test(t)) return true; // Linux and macOS
  return false;
}

/**
 * tracert (Windows) or traceroute (Linux/macOS) with numeric output.
 * Returns hops in order: { n, ip, rttMs } where rttMs is the median of the replies, or null on timeout.
 */
export function parseTrace(text) {
  const hops = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,2})\s+(.*)$/);
    if (!m) continue;
    const n = Number(m[1]);
    const rest = m[2];
    const ip = (rest.match(IPV4) || [])[1] || null;
    const times = [];
    for (const tm of rest.matchAll(/(<?)([\d.]+)\s*ms/g)) times.push(tm[1] === '<' ? 0.5 : Number(tm[2]));
    if (!ip && !times.length && !/\*/.test(rest)) continue;
    times.sort((a, b) => a - b);
    const rttMs = times.length ? times[Math.floor(times.length / 2)] : null;
    hops.push({ n, ip, rttMs });
  }
  return hops;
}
