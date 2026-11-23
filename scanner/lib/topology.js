// Turns what the scanner found into a net-core topology the headset app can simulate.
import { guessKind, isRandomMac, vendorFor } from './classify.js';
import { intToIp, ipToInt, maskToPrefix } from './parse.js';

export const SCAN_VERSION = 1;
const LAN_MASK_FALLBACK = '255.255.255.0';
// The router's WAN side is modelled with documentation and shared address space, never the real public IP.
const WAN_IP = '100.64.0.2';
const ISP_IP = '100.64.0.1';
const WAN_MASK = '255.255.255.0';
const INTERNET_IP = '8.8.8.8';

/** "a4:83:e7:12:34:56" -> "a4:83:e7:12:xx:xx" */
export const maskMac = (mac) => `${mac.slice(0, 11)}:xx:xx`;

/** The /24 that holds `ip`, as a list of host addresses (.1 to .254). */
export function sweepTargets(ip) {
  const base = ipToInt(ip) & 0xffffff00;
  const out = [];
  for (let h = 1; h <= 254; h++) out.push(intToIp((base + h) >>> 0));
  return out;
}

const KIND_LABEL = {
  router: 'Router', phone: 'Phone', pc: 'PC', tv: 'TV', printer: 'Printer',
  speaker: 'Speaker', console: 'Console', iot: 'Smart device', unknown: 'Device',
};

const WIRELESS_HINT = /wi-?fi|wireless|wlan|802\.11|airport/i;

function shortName(hostname) {
  if (!hostname) return null;
  const s = hostname.split('.')[0];
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

/**
 * Build the topology.
 * @param {object} p
 * @param {object} p.adapter  { ipv4, mask, gateway, mac, description }
 * @param {{ip:string, mac:string}[]} p.arp  ARP entries seen after the sweep
 * @param {Set<string>} p.alive  addresses that answered ping
 * @param {Record<string,string|null>} p.hostnames
 * @param {Record<string,number|null>} p.latency  ms per address, scanner PC to device
 * @param {{n:number, ip:string|null, rttMs:number|null}[]} p.hops  traceroute hops
 * @param {number|null} p.internetLatency  ms to 8.8.8.8
 * @param {boolean} p.fullMac  keep full MAC addresses
 * @param {boolean} p.names  keep hostnames
 * @param {string} p.scannerName  hostname of this PC
 */
export function buildTopology(p) {
  const mask = p.adapter.mask || LAN_MASK_FALLBACK;
  const gw = p.adapter.gateway;
  const subnet = `${intToIp((ipToInt(p.adapter.ipv4) & ipToInt(mask)) >>> 0)}/${maskToPrefix(mask)}`;
  const seenMac = new Set();
  let idx = 0;

  /** MAC shown to people, and a MAC the simulator can use. Masked MACs get a unique, made-up tail. */
  const macPair = (real) => {
    idx++;
    if (p.fullMac) return { sim: real, display: real };
    let sim = `${real.slice(0, 11)}:${(idx >> 8).toString(16).padStart(2, '0')}:${(idx & 255).toString(16).padStart(2, '0')}`;
    while (seenMac.has(sim)) sim = `${sim.slice(0, 15)}${(++idx & 255).toString(16).padStart(2, '0')}`;
    seenMac.add(sim);
    return { sim, display: maskMac(real) };
  };

  const devices = {};
  const arpByIp = new Map(p.arp.map((e) => [e.ip, e.mac]));
  const gwMacReal = arpByIp.get(gw) || '00:00:00:00:00:01';
  const gwMac = macPair(gwMacReal);
  const gwVendor = vendorFor(gwMacReal);

  devices.lan = { id: 'lan', type: 'switch', name: 'Home LAN', label: 'Router switch and Wi-Fi', power: true, macStatic: {} };

  devices.router = {
    id: 'router', type: 'router', name: 'Router', label: gwVendor ? `${gwVendor} router` : 'Home router',
    power: true, priority: 100, arpStatic: {},
    ifaces: [
      { name: 'LAN', mac: gwMac.sim, peer: 'lan', vlan: 1, addrs: [{ ip: gw, mask }], hsrp: [] },
      { name: 'WAN', mac: '02:00:00:00:00:02', peer: 'internet', vlan: 1, addrs: [{ ip: WAN_IP, mask: WAN_MASK }], hsrp: [] },
    ],
    routes: [
      { net: subnet.split('/')[0], mask, iface: 'LAN', via: '', type: 'C' },
      { net: '100.64.0.0', mask: WAN_MASK, iface: 'WAN', via: '', type: 'C' },
      { net: '0.0.0.0', mask: '0.0.0.0', iface: 'WAN', via: ISP_IP, type: 'S' },
    ],
    nat: { inside: 'LAN', outside: 'WAN', publicIp: WAN_IP },
    meta: {
      kind: 'router', vendor: gwVendor || undefined, macDisplay: gwMac.display, randomMac: isRandomMac(gwMacReal),
      latencyMs: p.latency[gw] ?? null, hostname: p.names ? p.hostnames[gw] || undefined : undefined, link: 'wired',
    },
  };

  const pcMacReal = p.adapter.mac || '02:00:00:00:00:03';
  const pcMac = macPair(pcMacReal);
  devices.pc = {
    id: 'pc', type: 'laptop', role: 'client', name: (p.names && shortName(p.scannerName)) || 'This PC', label: 'Scanning PC',
    ip: p.adapter.ipv4, mask, gw, dns: INTERNET_IP, mac: pcMac.sim, uplink: 'lan', vlan: 1, power: true, arpStatic: {},
    meta: {
      kind: 'pc', scanner: true, vendor: vendorFor(pcMacReal) || undefined, macDisplay: pcMac.display, randomMac: isRandomMac(pcMacReal),
      latencyMs: 0, link: WIRELESS_HINT.test(p.adapter.description || '') ? 'wifi' : 'wired',
      hostname: p.names ? p.scannerName || undefined : undefined,
    },
  };

  const lanIps = new Set([...p.alive, ...arpByIp.keys()]);
  lanIps.delete(gw);
  lanIps.delete(p.adapter.ipv4);
  const sorted = [...lanIps]
    .filter((ip) => (ipToInt(ip) & ipToInt(mask)) >>> 0 === (ipToInt(p.adapter.ipv4) & ipToInt(mask)) >>> 0)
    .sort((a, b) => ipToInt(a) - ipToInt(b));
  const counts = {};
  for (const ip of sorted) {
    const real = arpByIp.get(ip);
    if (!real) continue; // answered ping without an ARP entry, so there is no MAC to work with
    const vendor = vendorFor(real);
    const hostname = p.hostnames[ip] || null;
    const kind = guessKind({ vendor, hostname, mac: real, isGateway: false });
    const mac = macPair(real);
    const last = ip.split('.')[3];
    counts[kind] = (counts[kind] || 0) + 1;
    const id = `h${last}`;
    devices[id] = {
      id, type: 'laptop', role: 'client',
      name: (p.names && shortName(hostname)) || `${KIND_LABEL[kind]} .${last}`,
      label: vendor ? `${vendor} ${KIND_LABEL[kind].toLowerCase()}` : KIND_LABEL[kind],
      ip, mask, gw, dns: INTERNET_IP, mac: mac.sim, uplink: 'lan', vlan: 1, power: true, arpStatic: {},
      meta: {
        kind, vendor: vendor || undefined, macDisplay: mac.display, randomMac: isRandomMac(real),
        latencyMs: p.latency[ip] ?? null, hostname: p.names ? hostname || undefined : undefined,
        link: kind === 'pc' || kind === 'printer' || kind === 'tv' ? 'wired' : 'wifi',
      },
    };
  }

  // The internet: one ISP edge router that also answers for 8.8.8.8. The real hops between them come from the traceroute.
  devices.internet = {
    id: 'internet', type: 'router', name: 'Internet', label: 'Your ISP and beyond',
    power: true, priority: 100, arpStatic: {},
    ifaces: [{ name: 'ISP', mac: '02:00:00:08:08:08', peer: 'router', vlan: 1, addrs: [{ ip: ISP_IP, mask: WAN_MASK }, { ip: INTERNET_IP, mask: '255.255.255.255' }], hsrp: [] }],
    routes: [{ net: '100.64.0.0', mask: WAN_MASK, iface: 'ISP', via: '', type: 'C' }],
    meta: { kind: 'internet', latencyMs: p.internetLatency ?? null, link: 'wired' },
  };

  const hops = p.hops.filter((h) => h.ip !== gw && !(h.n === 1 && h.ip === null));
  return {
    vlans: false, hsrp: false, tls: false,
    devices,
    internet: { target: INTERNET_IP, latencyMs: p.internetLatency ?? null, gatewayLatencyMs: p.latency[gw] ?? null, hops },
    scan: { version: SCAN_VERSION, scannedAt: new Date().toISOString(), subnet, macsMasked: !p.fullMac, tool: 'nettracer-scan' },
  };
}
