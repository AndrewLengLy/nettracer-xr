/**
 * The stage draws one topology: a model and label per device, cables as tubes
 * merged into one mesh, Wi-Fi links as animated arcs, and a grabbable plug at
 * the device end of every cable.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CurvePath,
  DistanceGrabbable,
  Entity,
  Group,
  LineCurve3,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  Object3D,
  QuadraticBezierCurve3,
  RayInteractable,
  RingGeometry,
  ShaderMaterial,
  TubeGeometry,
  Vector3,
  World,
  BoxGeometry,
  CatmullRomCurve3,
  DoubleSide,
} from '@iwsdk/core';
import { ACCENT, deviceMesh, kindFor, makeLabel } from './models.js';
import { isHost, isRouter } from './net-core/engine.js';
import type { Device, Topology } from './net-core/types.js';
import { CablePlug, DeviceNode } from './tags.js';

export type StageStyle = 'table' | 'room';

export interface Link {
  key: string;
  /** End that owns the plug: a host, or a router for router-to-switch links. */
  owner: string;
  /** Interface name when the owner is a router. */
  iface?: string;
  other: string;
}

const tmpA = new Vector3();
const tmpB = new Vector3();

/** Every cable in the topology, one per pair of devices. */
export function linksOf(topo: Topology): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const add = (owner: string, other: string, iface?: string) => {
    const key = [owner, other].sort().join('~');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, owner, other, iface });
  };
  for (const d of Object.values(topo.devices)) {
    if (isHost(d) && d.uplink && topo.devices[d.uplink]) add(d.id, d.uplink);
  }
  for (const d of Object.values(topo.devices)) {
    if (!isRouter(d)) continue;
    for (const f of d.ifaces || []) if (f.peer && topo.devices[f.peer]) add(d.id, f.peer, f.name);
  }
  return out;
}

const WIFI_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const WIFI_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float dash = step(0.45, fract(vUv.x * 14.0 - uTime * 0.8));
    float fade = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
    gl_FragColor = vec4(uColor, (0.25 + 0.55 * dash) * fade);
  }
`;

interface DeviceVisual {
  entity: Entity;
  group: Group;
  ring: Mesh;
  label: Mesh;
}

export class Stage {
  readonly root: Entity;
  readonly rootObject = new Group();
  readonly devices = new Map<string, DeviceVisual>();
  readonly plugs = new Map<string, Entity>();
  links: Link[] = [];
  /** Links whose plug was pulled out, with the plug's resting point in root space. */
  readonly detached = new Map<string, Vector3>();
  /** Whether a plug was already out when the current grab started. */
  readonly wasDetached = new Map<string, boolean>();
  /** Visual-only link style for My Network. */
  readonly wifi = new Set<string>();
  private wired: Mesh;
  private arcs: Mesh;
  private arcMaterial: ShaderMaterial;
  private dirty = true;
  private hidden = new Set<string>();

  constructor(
    private world: World,
    public topo: Topology,
    public style: StageStyle,
    positions: Record<string, [number, number, number]>,
    opts: { labelDistance: number; hide?: string[]; parent?: Entity } = { labelDistance: 1 },
  ) {
    this.rootObject.name = 'stage-root';
    this.root = world.createTransformEntity(this.rootObject, opts.parent ? { parent: opts.parent } : undefined);
    for (const id of opts.hide || []) this.hidden.add(id);

    this.wired = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    this.wired.name = 'cables';
    this.rootObject.add(this.wired);
    this.arcMaterial = new ShaderMaterial({
      vertexShader: WIFI_VERT,
      fragmentShader: WIFI_FRAG,
      uniforms: { uTime: { value: 0 }, uColor: { value: new Color('#7dd3fc') } },
      transparent: true,
      depthWrite: false,
    });
    this.arcs = new Mesh(new BufferGeometry(), this.arcMaterial);
    this.arcs.name = 'wifi-arcs';
    this.rootObject.add(this.arcs);

    for (const d of Object.values(topo.devices)) this.addDevice(d, positions[d.id] || [0, 0, 0], opts.labelDistance);
    this.setTopology(topo);
  }

  private addDevice(d: Device, p: [number, number, number], labelDistance: number) {
    const group = new Group();
    group.name = `device:${d.id}`;
    group.position.set(p[0], p[1], p[2]);
    const kind = kindFor(d);
    const ring = new Mesh(new RingGeometry(0.075, 0.09, 32), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, side: DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    ring.visible = false;
    ring.name = 'select-ring';
    const label = makeLabel([d.name, d.ip || d.label || ''], { viewDistance: labelDistance, accent: ACCENT[kind] });
    label.position.y = (kind === 'server' ? 0.24 : kind === 'internet' ? 0.2 : 0.15) + 0.04 * labelDistance;
    if (!this.hidden.has(d.id)) {
      group.add(deviceMesh(kind));
      group.add(ring);
      group.add(label);
    }
    const entity = this.world.createTransformEntity(group, { parent: this.root });
    entity.addComponent(DeviceNode, { deviceId: d.id });
    if (!this.hidden.has(d.id)) {
      entity.addComponent(RayInteractable);
      entity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
    }
    this.devices.set(d.id, { entity, group, ring, label });
  }

  /** Apply a new topology (after unplugging or replugging). Devices stay; links and plugs update. */
  setTopology(topo: Topology) {
    this.topo = topo;
    const links = linksOf(topo);
    // Keep detached links visible even though the topology no longer has them.
    for (const [key] of this.detached) {
      if (!links.some((l) => l.key === key)) {
        const old = this.links.find((l) => l.key === key);
        if (old) links.push(old);
      }
    }
    this.links = links;
    for (const [key, plug] of this.plugs) {
      if (!links.some((l) => l.key === key)) {
        plug.dispose();
        this.plugs.delete(key);
      }
    }
    if (this.style === 'table') for (const l of links) if (!this.plugs.has(l.key)) this.addPlug(l);
    this.dirty = true;
  }

  private addPlug(l: Link) {
    const mesh = new Mesh(new BoxGeometry(0.022, 0.016, 0.03), new MeshStandardMaterial({ color: '#e4e4e7', roughness: 0.4 }));
    mesh.name = `plug:${l.key}`;
    const e = this.world.createTransformEntity(mesh, { parent: this.root });
    e.addComponent(CablePlug, { deviceId: l.owner });
    e.addComponent(RayInteractable);
    e.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
    this.plugs.set(l.key, e);
    this.placePlugHome(l);
  }

  /** Root-space point where a link's plug sits when it is plugged in. */
  plugHome(l: Link, out: Vector3): Vector3 {
    const a = this.devices.get(l.owner)!.group.position;
    const b = this.devices.get(l.other)!.group.position;
    out.subVectors(b, a).setY(0);
    const len = out.length() || 1;
    out.multiplyScalar(0.075 / len).add(a);
    out.y = a.y + 0.012;
    return out;
  }

  placePlugHome(l: Link) {
    const plug = this.plugs.get(l.key);
    if (!plug) return;
    this.plugHome(l, plug.object3D!.position);
    const o = plug.object3D!;
    o.lookAt(this.rootObject.localToWorld(tmpB.copy(this.devices.get(l.other)!.group.position)));
  }

  linkForPlug(entity: Entity): Link | undefined {
    for (const [key, e] of this.plugs) if (e === entity) return this.links.find((l) => l.key === key);
    return undefined;
  }

  /** World position of a device's center, a little above its base. */
  worldPos(id: string, out: Vector3): Vector3 {
    const v = this.devices.get(id);
    if (!v) return out.set(0, 0, 0);
    v.group.updateWorldMatrix(true, false);
    out.set(0, 0.05, 0);
    return v.group.localToWorld(out);
  }

  /** Root-space position of a device. */
  localPos(id: string): Vector3 {
    return this.devices.get(id)!.group.position;
  }

  setRing(id: string, color: string | null) {
    const v = this.devices.get(id);
    if (!v) return;
    v.ring.visible = !!color;
    if (color) (v.ring.material as MeshBasicMaterial).color.set(color);
  }

  setLabel(id: string, lines: string[], labelDistance: number) {
    const v = this.devices.get(id);
    if (!v || this.hidden.has(id)) return;
    const d = this.topo.devices[id];
    const y = v.label.position.y;
    v.group.remove(v.label);
    (v.label.material as MeshBasicMaterial).map?.dispose();
    (v.label.material as MeshBasicMaterial).dispose();
    v.label.geometry.dispose();
    v.label = makeLabel(lines, { viewDistance: labelDistance, accent: ACCENT[kindFor(d)] });
    v.label.position.y = y;
    v.group.add(v.label);
  }

  markDirty() {
    this.dirty = true;
  }

  /** Face labels toward the viewer (yaw only) and animate Wi-Fi dashes. Call once per frame. */
  tick(time: number, viewer: Vector3) {
    this.arcMaterial.uniforms.uTime.value = time;
    for (const v of this.devices.values()) {
      v.label.getWorldPosition(tmpA);
      const yaw = Math.atan2(viewer.x - tmpA.x, viewer.z - tmpA.z);
      // Labels live under a possibly rotated parent; cancel the parent yaw.
      v.label.rotation.set(0, yaw - this.worldYaw(v.group), 0);
    }
    if (this.dirty) this.rebuildCables();
  }

  private worldYaw(o: Object3D): number {
    let y = 0;
    let p: Object3D | null = o.parent;
    while (p) {
      y += p.rotation.y;
      p = p.parent;
    }
    return y;
  }

  private endPoint(id: string, out: Vector3): Vector3 {
    out.copy(this.localPos(id));
    out.y += this.style === 'table' ? 0.008 : 0.05;
    return out;
  }

  private rebuildCables() {
    this.dirty = false;
    const wiredGeos: { geo: BufferGeometry; color: Color }[] = [];
    const arcGeos: BufferGeometry[] = [];
    const radius = this.style === 'table' ? 0.0035 : 0.008;
    for (const l of this.links) {
      // The window and hop markers show the internet link, so it gets no cable.
      if (this.topo.devices[l.owner]?.meta?.kind === 'internet' || this.topo.devices[l.other]?.meta?.kind === 'internet') continue;
      const a = this.endPoint(l.other, new Vector3());
      const detachedAt = this.detached.get(l.key);
      const b = detachedAt ? detachedAt.clone() : this.endPoint(l.owner, new Vector3());
      const plugged = !detachedAt;
      if (this.wifi.has(l.key)) {
        const mid = a.clone().add(b).multiplyScalar(0.5);
        mid.y = Math.max(a.y, b.y) + 0.25 + a.distanceTo(b) * 0.2;
        arcGeos.push(new TubeGeometry(new QuadraticBezierCurve3(a, mid, b), 40, radius * 0.7, 5, false));
        continue;
      }
      let curve;
      if (this.style === 'table') {
        const mid = a.clone().lerp(b, 0.5);
        mid.y = Math.min(a.y, b.y) - 0.004;
        const side = new Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar(0.012);
        mid.add(side);
        curve = new CatmullRomCurve3([a, mid, b]);
      } else {
        // Room cables drop to the floor, run along it, and climb back up.
        const floor = 0.012;
        const path = new CurvePath<Vector3>();
        const a2 = new Vector3(a.x, floor, a.z);
        const b2 = new Vector3(b.x, floor, b.z);
        path.add(new LineCurve3(a, a2));
        path.add(new LineCurve3(a2, b2));
        path.add(new LineCurve3(b2, b));
        curve = path;
      }
      wiredGeos.push({ geo: new TubeGeometry(curve, this.style === 'table' ? 24 : 12, radius, 6, false), color: new Color(plugged ? '#52525b' : '#f43f5e') });
    }
    this.wired.geometry.dispose();
    this.wired.geometry = mergeColored(wiredGeos);
    this.arcs.geometry.dispose();
    this.arcs.geometry = mergeWithUv(arcGeos);
    for (const g of wiredGeos) g.geo.dispose();
    for (const g of arcGeos) g.dispose();
  }

  dispose() {
    for (const p of this.plugs.values()) p.dispose();
    this.plugs.clear();
    for (const v of this.devices.values()) {
      (v.label.material as MeshBasicMaterial).map?.dispose();
      v.entity.destroy();
    }
    this.devices.clear();
    this.wired.geometry.dispose();
    this.arcs.geometry.dispose();
    this.root.destroy();
  }
}

/** Merge tube geometries into one with a per-vertex color. */
function mergeColored(parts: { geo: BufferGeometry; color: Color }[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  for (const { geo, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position').array;
    const n = g.getAttribute('normal').array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
      nor.push(n[i], n[i + 1], n[i + 2]);
      col.push(color.r, color.g, color.b);
    }
    if (g !== geo) g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  out.computeBoundingSphere();
  return out;
}

/** Merge geometries keeping uv (the Wi-Fi dash shader runs along uv.x). */
function mergeWithUv(parts: BufferGeometry[]): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (const geo of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position').array;
    const u = g.getAttribute('uv').array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    for (let i = 0; i < u.length; i++) uv.push(u[i]);
    if (g !== geo) g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  out.computeBoundingSphere();
  return out;
}
