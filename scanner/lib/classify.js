// Guess a vendor from the MAC prefix and a device kind from vendor and hostname.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let table = null;
function loadTable() {
  if (table) return table;
  try {
    table = JSON.parse(readFileSync(fileURLToPath(new URL('../data/oui.json', import.meta.url)), 'utf8')).prefixes;
  } catch {
    table = {};
  }
  return table;
}

/** True when the MAC has the locally administered bit set. Phones use these for private Wi-Fi addresses. */
export const isRandomMac = (mac) => (parseInt(mac.slice(0, 2), 16) & 2) === 2;

export function vendorFor(mac) {
  if (!mac) return null;
  if (isRandomMac(mac)) return null;
  const key = mac.slice(0, 8).toUpperCase().replace(/:/g, '');
  return loadTable()[key] || null;
}

const RULES = [
  ['router', /\b(tp-?link|netgear|ubiquiti|eero|linksys|arris|technicolor|sagemcom|askey|actiontec|mikrotik|cisco|juniper|zyxel|huawei|calix|nokia|commscope|plume|asus.*router)\b|gateway|router|^(gw|rt)-/i],
  ['phone', /\b(iphone|android|galaxy|pixel|oneplus|motorola mobility|xiaomi|oppo|vivo)\b|phone/i],
  ['tv', /\b(roku|vizio|tcl|hisense|chromecast|apple ?tv|fire ?tv|bravia|lg electronics|samsung.*tv)\b|tv\b|television/i],
  ['printer', /\b(brother|canon|epson|lexmark|xerox|kyocera|ricoh)\b|printer|^hp[a-f0-9]{6}/i],
  ['speaker', /\b(sonos|bose|echo|homepod|nest audio|google home)\b/i],
  ['console', /\b(nintendo|sony interactive|playstation|xbox|valve)\b/i],
  ['iot', /\b(espressif|tuya|shelly|ring|wyze|ecobee|nest labs|philips lighting|signify|lifx|raspberry)\b/i],
  ['pc', /\b(intel|realtek|dell|lenovo|hewlett|micro-star|msi|gigabyte|asustek|liteon|azurewave|apple|microsoft|framework)\b|desktop|laptop|-pc\b|macbook|imac/i],
];

/**
 * Best guess at what a device is. The router is known from the gateway address, so callers pass isGateway.
 * Returns one of router, phone, pc, tv, printer, speaker, console, iot, unknown.
 */
export function guessKind({ vendor, hostname, mac, isGateway }) {
  if (isGateway) return 'router';
  const text = `${hostname || ''} ${vendor || ''}`;
  for (const [kind, re] of RULES) if (kind !== 'router' && re.test(text)) return kind;
  if (mac && isRandomMac(mac)) return 'phone';
  return 'unknown';
}
