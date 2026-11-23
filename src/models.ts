/**
 * Low-poly device models built in code. Each kind is one merged geometry with
 * vertex colors, shared by every device of that kind, so a device costs one
 * draw call and no textures.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';

export type ModelKind = 'pc' | 'switch' | 'router' | 'server' | 'phone' | 'tv' | 'printer' | 'speaker' | 'console' | 'iot' | 'unknown' | 'internet';

/** NetTracer accents, so the headset and the website read the same. */
export const ACCENT: Record<ModelKind, string> = {
  pc: '#06B6D4',
  switch: '#94A3B8',
  router: '#3B82F6',
  server: '#10B981',
  phone: '#A78BFA',
  tv: '#F472B6',
  printer: '#FBBF24',
  speaker: '#FB923C',
  console: '#F87171',
  iot: '#2DD4BF',
  unknown: '#A1A1AA',
  internet: '#E4E4E7',
};

const BODY = new Color('#2a2c31');
const DARK = new Color('#16171a');
const LIGHT = new Color('#d4d4d8');

interface Part {
  geo: BufferGeometry;
  color: Color;
  at: [number, number, number];
  rot?: [number, number, number];
}

/** Merge parts into one non-indexed geometry with a color attribute. */
function merge(parts: Part[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const m = new Matrix4();
  const nm = new Matrix4();
  const v = new Vector3();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    m.identity();
    if (p.rot) m.makeRotationX(p.rot[0]).multiply(new Matrix4().makeRotationY(p.rot[1])).multiply(new Matrix4().makeRotationZ(p.rot[2]));
    nm.copy(m);
    m.setPosition(p.at[0], p.at[1], p.at[2]);
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(na, i).applyMatrix4(nm).normalize();
      nor.push(v.x, v.y, v.z);
      col.push(p.color.r, p.color.g, p.color.b);
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
const cyl = (r: number, h: number, seg = 10) => new CylinderGeometry(r, r, h, seg);

/** Geometry in meters at tabletop scale. The origin sits on the base so models rest on surfaces. */
function build(kind: ModelKind): BufferGeometry {
  const a = new Color(ACCENT[kind]);
  switch (kind) {
    case 'pc':
      return merge([
        { geo: box(0.13, 0.085, 0.008), color: BODY, at: [0, 0.075, 0] },
        { geo: box(0.118, 0.072, 0.002), color: a.clone().multiplyScalar(0.55), at: [0, 0.076, 0.005] },
        { geo: box(0.012, 0.03, 0.012), color: DARK, at: [0, 0.02, -0.004] },
        { geo: box(0.06, 0.006, 0.04), color: DARK, at: [0, 0.003, -0.004] },
        { geo: box(0.04, 0.09, 0.08), color: BODY, at: [0.09, 0.045, -0.01] },
        { geo: box(0.004, 0.004, 0.004), color: a, at: [0.09, 0.075, 0.031] },
      ]);
    case 'switch': {
      const parts: Part[] = [{ geo: box(0.2, 0.03, 0.09), color: BODY, at: [0, 0.015, 0] }];
      for (let i = 0; i < 8; i++) parts.push({ geo: box(0.012, 0.009, 0.004), color: DARK, at: [-0.07 + i * 0.02, 0.016, 0.045] });
      for (let i = 0; i < 8; i++) parts.push({ geo: box(0.004, 0.003, 0.003), color: a, at: [-0.07 + i * 0.02, 0.025, 0.046] });
      return merge(parts);
    }
    case 'router':
      return merge([
        { geo: box(0.16, 0.035, 0.11), color: BODY, at: [0, 0.0175, 0] },
        { geo: box(0.12, 0.003, 0.004), color: a, at: [0, 0.03, 0.056] },
        { geo: cyl(0.004, 0.09, 6), color: DARK, at: [-0.06, 0.08, -0.045], rot: [0, 0, 0.25] },
        { geo: cyl(0.004, 0.09, 6), color: DARK, at: [0.06, 0.08, -0.045], rot: [0, 0, -0.25] },
        { geo: cyl(0.004, 0.09, 6), color: DARK, at: [0, 0.08, -0.05] },
      ]);
    case 'server': {
      const parts: Part[] = [{ geo: box(0.09, 0.2, 0.11), color: BODY, at: [0, 0.1, 0] }];
      for (let i = 0; i < 4; i++) {
        parts.push({ geo: box(0.078, 0.034, 0.003), color: DARK, at: [0, 0.03 + i * 0.045, 0.0555] });
        parts.push({ geo: box(0.006, 0.004, 0.003), color: a, at: [0.03, 0.03 + i * 0.045, 0.057] });
      }
      return merge(parts);
    }
    case 'phone':
      return merge([
        { geo: box(0.04, 0.082, 0.008), color: DARK, at: [0, 0.045, 0], rot: [-0.25, 0, 0] },
        { geo: box(0.035, 0.072, 0.002), color: a.clone().multiplyScalar(0.6), at: [0, 0.046, 0.0045], rot: [-0.25, 0, 0] },
        { geo: box(0.05, 0.006, 0.03), color: BODY, at: [0, 0.003, -0.01] },
      ]);
    case 'tv':
      return merge([
        { geo: box(0.2, 0.12, 0.008), color: DARK, at: [0, 0.09, 0] },
        { geo: box(0.19, 0.108, 0.002), color: a.clone().multiplyScalar(0.45), at: [0, 0.09, 0.005] },
        { geo: box(0.012, 0.03, 0.012), color: BODY, at: [0, 0.018, 0] },
        { geo: box(0.08, 0.005, 0.04), color: BODY, at: [0, 0.0025, 0] },
      ]);
    case 'printer':
      return merge([
        { geo: box(0.14, 0.06, 0.1), color: LIGHT, at: [0, 0.03, 0] },
        { geo: box(0.1, 0.004, 0.06), color: DARK, at: [0, 0.062, -0.01] },
        { geo: box(0.09, 0.003, 0.04), color: new Color('#f4f4f5'), at: [0, 0.04, 0.06] },
        { geo: box(0.006, 0.006, 0.003), color: a, at: [0.05, 0.05, 0.051] },
      ]);
    case 'speaker':
      return merge([
        { geo: cyl(0.035, 0.11, 14), color: BODY, at: [0, 0.055, 0] },
        { geo: cyl(0.03, 0.004, 14), color: a, at: [0, 0.111, 0] },
      ]);
    case 'console':
      return merge([
        { geo: box(0.13, 0.03, 0.1), color: DARK, at: [0, 0.015, 0] },
        { geo: box(0.1, 0.003, 0.003), color: a, at: [0, 0.02, 0.051] },
      ]);
    case 'iot':
      return merge([
        { geo: box(0.05, 0.05, 0.05), color: BODY, at: [0, 0.025, 0] },
        { geo: new SphereGeometry(0.012, 10, 8), color: a, at: [0, 0.055, 0] },
      ]);
    case 'internet':
      return merge([{ geo: new SphereGeometry(0.07, 18, 12), color: new Color('#3f3f46'), at: [0, 0.07, 0] }]);
    case 'unknown':
    default:
      return merge([
        { geo: box(0.07, 0.05, 0.07), color: BODY, at: [0, 0.025, 0] },
        { geo: box(0.02, 0.004, 0.004), color: a, at: [0, 0.035, 0.036] },
      ]);
  }
}

const geoCache = new Map<ModelKind, BufferGeometry>();
let deviceMaterial: MeshStandardMaterial | null = null;

export function deviceGeometry(kind: ModelKind): BufferGeometry {
  let g = geoCache.get(kind);
  if (!g) {
    g = build(kind);
    geoCache.set(kind, g);
  }
  return g;
}

export function sharedDeviceMaterial(): MeshStandardMaterial {
  if (!deviceMaterial) deviceMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.1 });
  return deviceMaterial;
}

/** One device mesh. Geometry and material are shared; never dispose them from here. */
export function deviceMesh(kind: ModelKind): Mesh {
  const mesh = new Mesh(deviceGeometry(kind), sharedDeviceMaterial());
  mesh.name = `device-${kind}`;
  return mesh;
}

/** Map a net-core device to a model. */
export function kindFor(d: { type: string; role?: string; meta?: { kind?: string } }): ModelKind {
  const k = d.meta?.kind;
  if (k === 'internet') return 'internet';
  if (d.type === 'router') return 'router';
  if (d.type === 'switch') return 'switch';
  if (d.type === 'server') return 'server';
  if (k && k !== 'router' && k in ACCENT) return k as ModelKind;
  return 'pc';
}

/**
 * A flat text label drawn to a canvas. Text is sized so its cap height stays
 * at least 24 dmm (2.4 cm at 1 m) when the label is read from `viewDistance` meters.
 */
export function makeLabel(lines: string[], opts: { width?: number; viewDistance?: number; accent?: string } = {}): Mesh {
  const viewDistance = opts.viewDistance ?? 1;
  const lineH = 0.042 * viewDistance; // first-line glyphs about 2.9 cm tall at 1 m
  const pxPerLine = 64;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `700 ${pxPerLine * 0.7}px Inter, system-ui, sans-serif`;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  canvas.width = Math.ceil(textW + pxPerLine * 0.8);
  canvas.height = pxPerLine * lines.length + 12;
  ctx.fillStyle = 'rgba(16,17,20,0.88)';
  const r = 18;
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, r);
  ctx.fill();
  if (opts.accent) {
    ctx.fillStyle = opts.accent;
    ctx.fillRect(0, 10, 6, canvas.height - 20);
  }
  lines.forEach((l, i) => {
    ctx.font = `${i === 0 ? 700 : 600} ${pxPerLine * (i === 0 ? 0.7 : 0.62)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = i === 0 ? '#fafafa' : '#a1a1aa';
    ctx.textBaseline = 'middle';
    ctx.fillText(l, pxPerLine * 0.4, 6 + pxPerLine * (i + 0.5));
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const h = lineH * lines.length * 1.1;
  const w = (canvas.width / canvas.height) * h;
  const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide, depthWrite: false }));
  mesh.renderOrder = 10;
  mesh.name = 'label';
  return mesh;
}
