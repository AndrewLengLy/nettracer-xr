// Builds public/demo-scan.json: a made-up home network for desktop visitors and screenshots.
// Every address and MAC here is invented (documentation ranges and unassigned tails).
import { writeFileSync } from 'node:fs';
import { buildTopology } from '../scanner/lib/topology.js';

const arp = [
  { ip: '192.168.1.1', mac: 'a4:2b:b0:3c:10:01' },   // TP-Link router
  { ip: '192.168.1.12', mac: '00:1b:21:7a:22:12' },  // Intel PC
  { ip: '192.168.1.23', mac: 'da:a1:19:5e:33:23' },  // phone with a private Wi-Fi address
  { ip: '192.168.1.31', mac: 'b0:a7:37:11:44:31' },  // Roku TV
  { ip: '192.168.1.40', mac: '00:80:77:42:55:40' },  // Brother printer
  { ip: '192.168.1.52', mac: '48:a6:b8:12:66:52' },  // Sonos speaker
  { ip: '192.168.1.61', mac: 'b8:06:0d:e6:77:61' },  // Tuya smart plug
];
const topo = buildTopology({
  adapter: { ipv4: '192.168.1.42', mask: '255.255.255.0', gateway: '192.168.1.1', mac: '3c:22:fb:1a:00:42', description: 'Wi-Fi' },
  arp,
  alive: new Set(arp.map((a) => a.ip)),
  hostnames: { '192.168.1.12': 'office-desktop', '192.168.1.23': 'Pixel-8', '192.168.1.31': 'Living-Room-Roku', '192.168.1.40': 'BRW-Printer' },
  latency: { '192.168.1.1': 3, '192.168.1.12': 2, '192.168.1.23': 41, '192.168.1.31': 9, '192.168.1.40': 6, '192.168.1.52': 12, '192.168.1.61': 88 },
  hops: [
    { n: 1, ip: '192.168.1.1', rttMs: 3 },
    { n: 2, ip: '100.64.12.1', rttMs: 9 },
    { n: 3, ip: '198.51.100.17', rttMs: 12 },
    { n: 4, ip: null, rttMs: null },
    { n: 5, ip: '203.0.113.90', rttMs: 16 },
    { n: 6, ip: '8.8.8.8', rttMs: 18 },
  ],
  internetLatency: 18,
  fullMac: false,
  names: true,
  scannerName: 'laptop',
});
topo.scan.scannedAt = '2026-11-01T18:00:00.000Z';
topo.devices.pc.name = 'This PC';
writeFileSync(new URL('../public/demo-scan.json', import.meta.url), JSON.stringify(topo, null, 2));
console.log(Object.values(topo.devices).map((d) => `${d.id} ${d.name} ${d.meta?.kind || ''} ${d.meta?.vendor || ''}`).join('\n'));
