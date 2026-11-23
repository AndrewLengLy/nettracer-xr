// Parser tests use made-up output in the exact shape each OS tool prints.
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/net-core/engine';
import { guessKind, isRandomMac } from './classify.js';
import { normMac, parseArp, parseIfconfig, parseIpAddr, parseIpconfig, parsePingAlive, parsePingAvg, parseTrace, pickAdapter } from './parse.js';
import { buildTopology, maskMac, sweepTargets } from './topology.js';

const IPCONFIG = `
Windows IP Configuration

   Host Name . . . . . . . . . . . . : DESK
   Node Type . . . . . . . . . . . . : Hybrid

Ethernet adapter Ethernet:

   Media State . . . . . . . . . . . : Media disconnected
   Description . . . . . . . . . . . : Realtek Gaming 2.5GbE Family Controller
   Physical Address. . . . . . . . . : 74-56-3C-00-00-01

Wireless LAN adapter Wi-Fi:

   Connection-specific DNS Suffix  . : lan
   Description . . . . . . . . . . . : Intel(R) Wi-Fi 6E AX211 160MHz
   Physical Address. . . . . . . . . : 3C-22-FB-1A-00-10
   DHCP Enabled. . . . . . . . . . . : Yes
   Link-local IPv6 Address . . . . . : fe80::1234:5678:9abc:def0%11(Preferred)
   IPv4 Address. . . . . . . . . . . : 192.168.1.42(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : fe80::1%11
                                       192.168.1.1
   DNS Servers . . . . . . . . . . . : 192.168.1.1
`;

const ARP_WIN = `
Interface: 192.168.1.42 --- 0xb
  Internet Address      Physical Address      Type
  192.168.1.1           a4-2b-b0-00-00-01     dynamic
  192.168.1.23          da-a1-19-00-00-23     dynamic
  192.168.1.50          00-17-88-00-00-50     dynamic
  192.168.1.255         ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
  239.255.255.250       01-00-5e-7f-ff-fa     static
`;

const ARP_MAC = `? (192.168.1.1) at a4:2b:b0:0:0:1 on en0 ifscope [ethernet]
? (192.168.1.77) at (incomplete) on en0 ifscope [ethernet]
? (192.168.1.9) at 3c:22:fb:1a:0:9 on en0 ifscope [ethernet]`;

const TRACERT = `
Tracing route to 8.8.8.8 over a maximum of 8 hops

  1    <1 ms    <1 ms     1 ms  192.168.1.1
  2     9 ms     8 ms    10 ms  100.64.12.1
  3     *        *        *     Request timed out.
  4    14 ms    12 ms    13 ms  203.0.113.9

Trace complete.
`;

const TRACEROUTE = `traceroute to 8.8.8.8 (8.8.8.8), 8 hops max, 60 byte packets
 1  192.168.1.1  0.512 ms  0.433 ms  0.401 ms
 2  * * *
 3  198.51.100.4  11.2 ms  10.8 ms  12.0 ms`;

describe('Windows parsers', () => {
  it('reads the connected adapter, including a gateway that wraps to the next line', () => {
    const a = pickAdapter(parseIpconfig(IPCONFIG));
    expect(a).toMatchObject({ ipv4: '192.168.1.42', mask: '255.255.255.0', gateway: '192.168.1.1', mac: '3c:22:fb:1a:00:10' });
    expect(a.description).toContain('Wi-Fi');
  });

  it('skips disconnected adapters', () => {
    expect(parseIpconfig(IPCONFIG)).toHaveLength(1);
  });

  it('reads arp -a and drops broadcast and multicast entries', () => {
    expect(parseArp(ARP_WIN)).toEqual([
      { ip: '192.168.1.1', mac: 'a4:2b:b0:00:00:01' },
      { ip: '192.168.1.23', mac: 'da:a1:19:00:00:23' },
      { ip: '192.168.1.50', mac: '00:17:88:00:00:50' },
    ]);
  });

  it('reads tracert hops with the median time, and timeouts as null', () => {
    expect(parseTrace(TRACERT)).toEqual([
      { n: 1, ip: '192.168.1.1', rttMs: 0.5 },
      { n: 2, ip: '100.64.12.1', rttMs: 9 },
      { n: 3, ip: null, rttMs: null },
      { n: 4, ip: '203.0.113.9', rttMs: 13 },
    ]);
  });

  it('reads ping replies and averages', () => {
    expect(parsePingAlive('Reply from 192.168.1.1: bytes=32 time=3ms TTL=64')).toBe(true);
    expect(parsePingAlive('Request timed out.')).toBe(false);
    expect(parsePingAlive('Reply from 192.168.1.42: Destination host unreachable.')).toBe(false);
    expect(parsePingAvg('    Minimum = 2ms, Maximum = 5ms, Average = 3ms')).toBe(3);
  });
});

describe('macOS and Linux parsers', () => {
  it('reads macOS arp and pads short MAC bytes', () => {
    expect(parseArp(ARP_MAC)).toEqual([
      { ip: '192.168.1.1', mac: 'a4:2b:b0:00:00:01' },
      { ip: '192.168.1.9', mac: '3c:22:fb:1a:00:09' },
    ]);
  });

  it('reads ifconfig with a hex netmask', () => {
    const a = parseIfconfig('en0: flags=8863<UP> mtu 1500\n\tether 3c:22:fb:1a:00:10\n\tinet 192.168.1.42 netmask 0xffffff00 broadcast 192.168.1.255\n', 'gateway: 192.168.1.1\n  interface: en0');
    expect(a[0]).toMatchObject({ ipv4: '192.168.1.42', mask: '255.255.255.0', gateway: '192.168.1.1', mac: '3c:22:fb:1a:00:10' });
  });

  it('reads ip addr and the default route', () => {
    const a = parseIpAddr('2: wlan0    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0', 'default via 192.168.1.1 dev wlan0 proto dhcp', '2: wlan0: <UP> mtu 1500\n    link/ether 3c:22:fb:1a:00:10 brd ff:ff:ff:ff:ff:ff');
    expect(a[0]).toMatchObject({ ipv4: '192.168.1.42', mask: '255.255.255.0', gateway: '192.168.1.1', mac: '3c:22:fb:1a:00:10' });
  });

  it('reads traceroute and ping summaries', () => {
    expect(parseTrace(TRACEROUTE).map((h) => h.ip)).toEqual(['192.168.1.1', null, '198.51.100.4']);
    expect(parsePingAvg('rtt min/avg/max/mdev = 2.1/3.46/5.0/0.4 ms')).toBe(3.5);
  });
});

describe('classification and masking', () => {
  it('spots private (random) Wi-Fi MACs', () => {
    expect(isRandomMac('da:a1:19:00:00:23')).toBe(true);
    expect(isRandomMac('3c:22:fb:1a:00:10')).toBe(false);
  });

  it('guesses kinds from hostname and vendor', () => {
    expect(guessKind({ hostname: 'Living-Room-Roku', vendor: null })).toBe('tv');
    expect(guessKind({ hostname: null, vendor: 'Brother' })).toBe('printer');
    expect(guessKind({ hostname: null, vendor: null, mac: 'da:a1:19:00:00:23' })).toBe('phone');
    expect(guessKind({ isGateway: true })).toBe('router');
  });

  it('masks the last two bytes', () => {
    expect(maskMac('a4:2b:b0:12:34:56')).toBe('a4:2b:b0:12:xx:xx');
    expect(normMac('A4-2B-B0-12-34-56')).toBe('a4:2b:b0:12:34:56');
    expect(sweepTargets('192.168.1.42')).toHaveLength(254);
  });
});

describe('topology from a scan', () => {
  const adapter = pickAdapter(parseIpconfig(IPCONFIG));
  const arp = parseArp(ARP_WIN);
  const build = (fullMac) => buildTopology({
    adapter, arp, alive: new Set(['192.168.1.1', '192.168.1.23']), hostnames: { '192.168.1.23': 'Pixel-8' },
    latency: { '192.168.1.1': 3, '192.168.1.23': 40, '192.168.1.50': 5 }, hops: parseTrace(TRACERT), internetLatency: 18,
    fullMac, names: true, scannerName: 'DESK',
  });

  it('hides real MAC tails by default and keeps simulator MACs unique', () => {
    const t = build(false);
    const json = JSON.stringify(t);
    expect(json).not.toContain('00:00:23');
    expect(t.devices.h23.meta.macDisplay).toBe('da:a1:19:00:xx:xx');
    const macs = Object.values(t.devices).map((d) => d.mac).filter(Boolean);
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('keeps full MACs with --full-mac', () => {
    expect(build(true).devices.h23.mac).toBe('da:a1:19:00:00:23');
  });

  it('records hops beyond the router and the scan-time latency', () => {
    const t = build(false);
    expect(t.internet.hops.map((h) => h.ip)).toEqual(['100.64.12.1', null, '203.0.113.9']);
    expect(t.devices.h23.meta).toMatchObject({ kind: 'phone', latencyMs: 40, hostname: 'Pixel-8' });
  });

  it('loads in net-core: the PC can ping a phone and reach the internet through NAT', () => {
    const t = build(false);
    expect(simulate(t, { type: 'ping', src: 'pc', dst: '192.168.1.23' }).ok).toBe(true);
    const out = simulate(t, { type: 'ping', src: 'pc', dst: '8.8.8.8' });
    expect(out.ok).toBe(true);
    expect(out.events.some((e) => e.nat?.direction === 'out')).toBe(true);
  });
});
