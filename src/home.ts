/**
 * My Network: loading a scan, laying devices out, and saving room pins.
 */
import type { Device, Topology } from './net-core/types.js';

/** Loose check that a scan really is a net-core topology with a router and the scanning PC. */
export function validateScan(v: unknown): Topology {
  const t = v as Topology;
  if (!t || typeof t !== 'object' || !t.devices || typeof t.devices !== 'object') throw new Error('That is not a NetTracer scan.');
  if (!t.devices.router || !t.devices.pc) throw new Error('The scan has no router or PC in it.');
  for (const d of Object.values(t.devices)) {
    if (!d || typeof d.id !== 'string' || typeof d.type !== 'string') throw new Error('The scan has a damaged device entry.');
  }
  return t;
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Read `#scan=` from the URL: base64url of deflate-raw JSON, as the scanner writes it. */
export async function scanFromHash(hash: string): Promise<Topology | null> {
  const m = hash.match(/[#&]scan=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const bytes = fromBase64Url(m[1]);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const text = await new Response(stream).text();
  return validateScan(JSON.parse(text));
}

export async function scanFromCode(code: string): Promise<Topology> {
  const res = await fetch(`/api/share?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `The share service answered ${res.status}.`);
  return validateScan(body);
}

export async function demoScan(): Promise<Topology> {
  const res = await fetch(`${import.meta.env.BASE_URL}demo-scan.json`);
  return validateScan(await res.json());
}

/** Stable id for a home network so pins come back for the same network only. */
export function networkKey(t: Topology): string {
  const r = t.devices.router;
  const lan = r.ifaces?.[0]?.addrs[0]?.ip || '';
  return `${t.scan?.subnet || lan}|${r.meta?.macDisplay || ''}`;
}

export type PinStore = Record<string, [number, number, number]>;

const PIN_KEY = 'nettracer-xr:pins';

export function loadPins(netKey: string): PinStore {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) || '{}');
    return all[netKey] || {};
  } catch {
    return {};
  }
}

export function savePins(netKey: string, pins: PinStore) {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) || '{}');
    all[netKey] = pins;
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {
    // Storage is unavailable. Pins last for this session only.
  }
}

export function clearPins(netKey: string) {
  savePins(netKey, {});
}

/** Order for the pinning walkthrough: router first, then this PC, then the rest by address. */
export function pinOrder(t: Topology): Device[] {
  const list = Object.values(t.devices).filter((d) => d.id !== 'lan' && d.id !== 'internet');
  const rank = (d: Device) => (d.id === 'router' ? 0 : d.id === 'pc' ? 1 : 2);
  const last = (d: Device) => Number((d.ip || d.ifaces?.[0]?.addrs[0]?.ip || '0.0.0.0').split('.')[3]);
  return list.sort((a, b) => rank(a) - rank(b) || last(a) - last(b));
}

export const deviceIp = (d: Device) => (d.meta?.kind === 'internet' ? '8.8.8.8' : d.ip || d.ifaces?.[0]?.addrs[0]?.ip || '');

/**
 * Positions in a virtual room for VR, desktop and unpinned devices:
 * the router 2.2 m ahead, the PC to the right, everything else on an arc.
 */
export function roomLayout(t: Topology): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  out.router = [0, 0.9, -2.2];
  out.lan = [0.06, 0.9, -2.2];
  out.pc = [0.9, 0.75, -1.2];
  out.internet = [0, 1.7, -4.2];
  const rest = pinOrder(t).filter((d) => d.id !== 'router' && d.id !== 'pc');
  const n = rest.length;
  rest.forEach((d, i) => {
    // Spread from 75 degrees left to 75 degrees right, leaving the middle for the router.
    const u = n === 1 ? 0 : i / (n - 1);
    let deg = -75 + u * 150;
    if (Math.abs(deg) < 18) deg = deg < 0 ? -18 : 18;
    const a = (deg * Math.PI) / 180;
    const r = 1.9 + (i % 2) * 0.6;
    out[d.id] = [Math.sin(a) * r, 0.75 + (i % 3) * 0.22, -Math.cos(a) * r];
  });
  return out;
}

/** A tray of floating slots in front of the viewer for devices that are not pinned yet. */
export function trayLayout(ids: string[]): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  const n = ids.length;
  ids.forEach((id, i) => {
    // Waist height, a step away, below the pin panel.
    const a = n === 1 ? 0 : -1.2 + (i / (n - 1)) * 2.4;
    out[id] = [Math.sin(a) * 1.1, 0.62 + (i % 2) * 0.22, -Math.cos(a) * 1.1];
  });
  return out;
}
