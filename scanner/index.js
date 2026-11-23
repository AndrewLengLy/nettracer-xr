#!/usr/bin/env node
// nettracer-scan: maps your home network so NetTracer XR can show it in your room.
// Runs on Windows (PowerShell or cmd), macOS and Linux. No admin rights needed.
import { writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fragmentLink, upload } from './lib/share.js';
import { hostnameFor, pingAvg, platform, readAdapter, readArp, sweep, trace } from './lib/system.js';
import { buildTopology, sweepTargets } from './lib/topology.js';

const HELP = `nettracer-scan  maps your home network for NetTracer XR

Usage:  npx nettracer-scan [options]      (after npm link)
        node scanner/index.js [options]

Options:
  --yes           skip the question before the ping sweep
  --full-mac      keep full MAC addresses (by default the last two bytes are hidden)
  --no-names      leave device hostnames out of the scan
  --no-upload     do not upload; print the backup link only
  --out <file>    where to save the scan JSON (default: nettracer-scan.json)
  --site <url>    NetTracer XR address (default: https://nettracer-xr.andrewlengly.com)
  --help          show this help
`;

function parseArgs(argv) {
  const o = { yes: false, fullMac: false, names: true, upload: true, out: 'nettracer-scan.json', site: 'https://nettracer-xr.andrewlengly.com' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--full-mac') o.fullMac = true;
    else if (a === '--no-names') o.names = false;
    else if (a === '--no-upload') o.upload = false;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--site') o.site = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error(`Unknown option ${a}. Run with --help to see the options.`); process.exit(2); }
  }
  return o;
}

const step = (n, text) => console.log(`\n[${n}/6] ${text}`);
const say = (text) => console.log(`      ${text}`);
const fmtMs = (v) => (v == null ? 'no reply' : `${v} ms`);

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { console.log(HELP); return; }
  console.log('NetTracer scan. This reads your own network settings and pings devices on your local network.');
  console.log('Your scan results stay on this PC until step 6, and leave it only through the upload or the link you copy.');

  step(1, 'Reading this PC\'s network adapter');
  const adapter = await readAdapter();
  if (!adapter || !adapter.ipv4) {
    console.error('      No connected network adapter with an IPv4 address was found. Connect to your home network and try again.');
    process.exit(1);
  }
  if (!adapter.gateway) {
    console.error(`      ${adapter.name} has address ${adapter.ipv4} and no default gateway, so there is no router to map.`);
    process.exit(1);
  }
  say(`Adapter: ${adapter.description || adapter.name}`);
  say(`This PC: ${adapter.ipv4}, subnet mask ${adapter.mask}, gateway (router) ${adapter.gateway}`);
  if (adapter.mask !== '255.255.255.0') say('Your subnet is not a /24. The sweep covers only the 254 addresses around this PC.');

  step(2, 'Ping sweep of your local network');
  const targets = sweepTargets(adapter.ipv4).filter((ip) => ip !== adapter.ipv4);
  say(`This sends one small ping to each of ${targets.length} addresses (${targets[0]} to ${targets[targets.length - 1]}), 12 at a time.`);
  say('It takes about a minute. Only devices on your own network are contacted.');
  if (!opt.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('      Start the sweep? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { say('Stopped. Nothing was sent.'); return; }
  }
  let lastPct = -1;
  const alive = await sweep(targets, {
    onProgress: (done, total, found) => {
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct !== lastPct) { lastPct = pct; process.stdout.write(`      ${pct}% checked, ${found} answered\r`); }
    },
  });
  process.stdout.write('\n');
  say(`${alive.size} addresses answered the ping.`);

  step(3, 'Reading the ARP table and naming devices');
  say('The ARP table is the list of IP and MAC address pairs your PC has learned. Some devices show up here even when they ignore ping.');
  const arp = await readArp();
  const lanArp = arp.filter((e) => e.ip !== adapter.ipv4);
  say(`${lanArp.length} devices are in the ARP table.`);
  const hostnames = {};
  const ips = [...new Set([...alive, ...lanArp.map((e) => e.ip)])];
  if (opt.names) {
    say('Asking the system for hostnames. Many devices do not publish one.');
    await Promise.all(ips.map(async (ip) => { hostnames[ip] = await hostnameFor(ip); }));
    say(`${Object.values(hostnames).filter(Boolean).length} hostnames resolved.`);
  } else say('Skipping hostnames (--no-names).');

  step(4, 'Measuring latency to each device, the router and the internet');
  const latency = {};
  const pingTargets = [adapter.gateway, ...ips.filter((ip) => ip !== adapter.gateway)];
  let n = 0;
  for (let i = 0; i < pingTargets.length; i += 8) {
    await Promise.all(pingTargets.slice(i, i + 8).map(async (ip) => {
      latency[ip] = await pingAvg(ip);
      n++;
      process.stdout.write(`      ${n} of ${pingTargets.length} measured\r`);
    }));
  }
  process.stdout.write('\n');
  const internetLatency = await pingAvg('8.8.8.8');
  say(`Router ${adapter.gateway}: ${fmtMs(latency[adapter.gateway])}`);
  say(`Internet (8.8.8.8): ${fmtMs(internetLatency)}`);

  step(5, `Tracing the path to 8.8.8.8 (up to 8 hops, using ${platform === 'win32' ? 'tracert' : 'traceroute'})`);
  say('This shows the routers your traffic crosses after it leaves home. It can take up to a minute.');
  const hops = await trace('8.8.8.8', 8);
  for (const h of hops) say(`hop ${h.n}: ${h.ip || 'no reply'}  ${h.rttMs == null ? '' : `${h.rttMs} ms`}`);

  const topology = buildTopology({
    adapter, arp: lanArp, alive, hostnames, latency, hops, internetLatency,
    fullMac: opt.fullMac, names: opt.names, scannerName: osHostname(),
  });
  const deviceCount = Object.keys(topology.devices).length - 4; // minus switch, router, internet and this PC
  const outPath = resolve(opt.out);
  writeFileSync(outPath, JSON.stringify(topology, null, 2));

  step(6, 'Handing the scan to your headset');
  say(`Found your router, this PC and ${deviceCount} other device${deviceCount === 1 ? '' : 's'}. Saved to ${outPath}`);
  say(opt.fullMac ? 'Full MAC addresses are included (--full-mac).' : 'MAC addresses have their last two bytes hidden.');
  if (opt.upload) {
    say(`Uploading to ${opt.site}/api/share. It is kept for 15 minutes, then deleted.`);
    try {
      const { code } = await upload(opt.site, topology);
      console.log(`\n      Your code:  ${code}\n`);
      say('In NetTracer XR, choose My Network and type this code on the keypad.');
    } catch (e) {
      say(`Upload failed: ${e.message}`);
      say('Use the backup link below instead.');
    }
  }
  console.log('\n      Backup link (the scan rides in the part after #, which is never sent to a server):');
  console.log(`      ${fragmentLink(opt.site, topology)}\n`);
}

main().catch((e) => {
  console.error(`\nThe scan stopped: ${e.message}`);
  process.exit(1);
});
