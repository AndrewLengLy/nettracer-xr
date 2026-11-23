#!/usr/bin/env node
// Rebuilds scanner/data/oui.json from the IEEE MA-L registry (the public list of MAC prefixes).
// Keeps only vendors that commonly show up on home networks so the bundled file stays small.
// Usage: node scanner/tools/build-oui.js [path-to-oui.csv]
// Without a path it downloads https://standards-oui.ieee.org/oui/oui.csv.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://standards-oui.ieee.org/oui/oui.csv';

// Registry names are long legal names. Map them to short labels people recognise.
const VENDORS = [
  ['Apple', /\bApple, Inc\b/i],
  ['Samsung', /\bSamsung Electronics\b/i],
  ['Google', /\bGoogle, Inc\b|\bGoogle LLC\b/i],
  ['Amazon', /\bAmazon Technologies\b|\bAmazon\.com\b/i],
  ['Microsoft', /\bMicrosoft Corporation\b/i],
  ['Intel', /\bIntel Corporate\b|\bIntel Corporation\b/i],
  ['Realtek', /\bRealtek Semiconductor\b/i],
  ['Dell', /\bDell Inc\b|\bDell Technologies\b/i],
  ['HP', /\bHewlett Packard\b|\bHP Inc\b/i],
  ['Lenovo', /\bLenovo\b|\bLCFC/i],
  ['ASUS', /\bASUSTek\b/i],
  ['Micro-Star (MSI)', /\bMicro-Star\b/i],
  ['Gigabyte', /\bGIGA-BYTE\b/i],
  ['Liteon', /\bLiteon\b|\bLite-On\b/i],
  ['AzureWave', /\bAzureWave\b/i],
  ['MediaTek', /\bMediaTek\b/i],
  ['Qualcomm', /\bQualcomm\b/i],
  ['TP-Link', /\bTP-LINK\b|\bTP-Link\b/i],
  ['Netgear', /\bNETGEAR\b/i],
  ['Linksys', /\bLinksys\b|\bBelkin\b/i],
  ['Ubiquiti', /\bUbiquiti\b/i],
  ['eero', /\beero inc\b/i],
  ['Arris', /\bARRIS\b|\bCommScope\b/i],
  ['Technicolor', /\bTechnicolor\b/i],
  ['Sagemcom', /\bSagemcom\b/i],
  ['Askey', /\bAskey\b/i],
  ['Actiontec', /\bActiontec\b/i],
  ['Huawei', /\bHuawei\b/i],
  ['ZTE', /\bzte corporation\b/i],
  ['Nokia', /\bNokia\b/i],
  ['Cisco', /\bCisco Systems\b/i],
  ['MikroTik', /\bRouterboard\b|\bMikroTik\b/i],
  ['Zyxel', /\bZyxel\b/i],
  ['Xiaomi', /\bXiaomi\b/i],
  ['OnePlus', /\bOnePlus\b/i],
  ['Motorola', /\bMotorola Mobility\b/i],
  ['LG Electronics', /\bLG Electronics\b/i],
  ['Sony', /\bSony\b/i],
  ['Roku', /\bRoku, Inc\b/i],
  ['Vizio', /\bVIZIO\b/i],
  ['TCL', /\bTCL\b/i],
  ['Hisense', /\bHisense\b/i],
  ['Sonos', /\bSonos\b/i],
  ['Bose', /\bBose Corporation\b/i],
  ['Nintendo', /\bNintendo\b/i],
  ['Valve', /\bValve Corporation\b/i],
  ['Brother', /\bBrother industries\b/i],
  ['Canon', /\bCanon Inc\b/i],
  ['Epson', /\bSeiko Epson\b/i],
  ['Lexmark', /\bLexmark\b/i],
  ['Espressif', /\bEspressif\b/i],
  ['Tuya', /\bTuya\b/i],
  ['Raspberry Pi', /\bRaspberry Pi\b/i],
  ['Ring', /\bRing LLC\b/i],
  ['Wyze', /\bWyze\b/i],
  ['Ecobee', /\becobee\b/i],
  ['Nest', /\bNest Labs\b/i],
  ['Philips Hue', /\bPhilips Lighting\b|\bSignify\b/i],
  ['Synology', /\bSynology\b/i],
  ['Meta', /\bMeta Platforms\b|\bOculus\b|\bFacebook Technologies\b/i],
];

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    // Registry,Assignment,Organization Name,Organization Address
    const m = line.match(/^MA-L,([0-9A-F]{6}),("(?:[^"]|"")*"|[^,]*)/i);
    if (m) rows.push([m[1].toUpperCase(), m[2].replace(/^"|"$/g, '').replace(/""/g, '"')]);
  }
  return rows;
}

const csv = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await (await fetch(SOURCE)).text();
const prefixes = {};
for (const [hex, org] of parseCsv(csv)) {
  const hit = VENDORS.find(([, re]) => re.test(org));
  if (hit) prefixes[hex] = hit[0];
}
const out = {
  source: SOURCE,
  note: 'Filtered to vendors common on home networks. Rebuild with node scanner/tools/build-oui.js',
  built: new Date().toISOString().slice(0, 10),
  prefixes,
};
const dest = fileURLToPath(new URL('../data/oui.json', import.meta.url));
writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${Object.keys(prefixes).length} prefixes to ${dest}`);
