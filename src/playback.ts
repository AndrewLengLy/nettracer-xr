/**
 * Plays a net-core simulation as packets moving between devices.
 * Each event moves a packet along its legs, shows the hop explanation, reads
 * it aloud when narration is on, then waits before the next event.
 */
import { Color, Entity, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3, World, signal } from '@iwsdk/core';
import { speak, stopSpeaking } from './narration.js';
import { PROTO_COLOR } from './net-core/engine.js';
import type { SimEvent, SimResult } from './net-core/types.js';

export interface LegPath {
  /** World-space polyline from the sending device to the receiving one. */
  points: Vector3[];
  /** Travel time at speed 1. */
  seconds: number;
}

export interface PlaybackHost {
  path(from: string, to: string): LegPath;
  /** World position of a device, for drops that happen in place. */
  at(id: string, out: Vector3): Vector3;
  packetRadius: number;
  onEvent(ev: SimEvent, index: number, sim: SimResult): void;
  onDone(sim: SimResult): void;
}

type Phase = 'idle' | 'moving' | 'dwell' | 'done';

interface Flight {
  mesh: Mesh;
  path: LegPath;
  lengths: number[];
  total: number;
}

export class Playback {
  readonly playing = signal(false);
  readonly index = signal(-1);
  readonly speed = signal(1);
  sim: SimResult | null = null;
  private phase: Phase = 'idle';
  private t = 0;
  private dwellLeft = 0;
  private speaking = false;
  private flights: Flight[] = [];
  private pool: Mesh[] = [];
  private group = new Group();
  private entity: Entity;
  private geo: SphereGeometry;
  private dropPulse = 0;
  private dropMesh: Mesh | null = null;
  private token = 0;

  constructor(world: World, private host: PlaybackHost) {
    this.group.name = 'packets';
    this.entity = world.createTransformEntity(this.group);
    this.geo = new SphereGeometry(host.packetRadius, 16, 12);
  }

  setRadius(r: number) {
    this.host.packetRadius = r;
    this.geo.dispose();
    this.geo = new SphereGeometry(r, 16, 12);
    for (const m of this.pool) m.geometry = this.geo;
  }

  start(sim: SimResult) {
    this.stop();
    this.sim = sim;
    this.playing.value = true;
    this.go(0);
  }

  stop() {
    this.token++;
    stopSpeaking();
    this.clearFlights();
    this.phase = 'idle';
    this.playing.value = false;
    this.index.value = -1;
    this.sim = null;
  }

  togglePause() {
    if (!this.sim) return;
    if (this.phase === 'done') {
      this.start(this.sim);
      return;
    }
    this.playing.value = !this.playing.peek();
    if (!this.playing.peek()) stopSpeaking();
  }

  next() {
    if (!this.sim) return;
    const i = this.index.peek() + 1;
    if (i < this.sim.events.length) this.go(i, true);
  }

  prev() {
    if (!this.sim) return;
    this.go(Math.max(0, this.index.peek() - 1), true);
  }

  /** Jump to event i. `manual` stays on that event until the user moves on when paused. */
  private go(i: number, manual = false) {
    const sim = this.sim;
    if (!sim) return;
    this.token++;
    stopSpeaking();
    this.clearFlights();
    this.index.value = i;
    const ev = sim.events[i];
    this.host.onEvent(ev, i, sim);
    this.t = 0;
    if (ev.legs.length) {
      for (const leg of ev.legs) this.launch(ev, this.host.path(leg.from, leg.to));
      this.phase = 'moving';
    } else {
      this.showDrop(ev);
      this.arrive(ev);
    }
    if (manual && !this.playing.peek()) {
      // Show the final position at once so a paused step reads correctly.
      this.t = 1e6;
      this.updateFlights(0);
    }
  }

  private launch(ev: SimEvent, path: LegPath) {
    const mesh = this.pool.pop() || new Mesh(this.geo, new MeshBasicMaterial());
    (mesh.material as MeshBasicMaterial).color.set(ev.drop ? PROTO_COLOR.DROP : (PROTO_COLOR as Record<string, string>)[ev.proto] || '#e4e4e7');
    mesh.position.copy(path.points[0]);
    mesh.visible = true;
    this.group.add(mesh);
    const lengths: number[] = [];
    let total = 0;
    for (let k = 1; k < path.points.length; k++) {
      const d = path.points[k].distanceTo(path.points[k - 1]);
      lengths.push(d);
      total += d;
    }
    this.flights.push({ mesh, path, lengths, total });
  }

  private showDrop(ev: SimEvent) {
    const mesh = this.pool.pop() || new Mesh(this.geo, new MeshBasicMaterial());
    (mesh.material as MeshBasicMaterial).color.set(PROTO_COLOR.DROP);
    this.host.at(ev.at, mesh.position);
    mesh.position.y += this.host.packetRadius * 4;
    mesh.visible = true;
    this.group.add(mesh);
    this.dropMesh = mesh;
    this.dropPulse = 0;
  }

  private arrive(ev: SimEvent) {
    this.phase = 'dwell';
    this.dwellLeft = 1.1;
    this.speaking = true;
    const token = this.token;
    speak(ev.note).then(() => {
      if (token === this.token) this.speaking = false;
    });
  }

  private clearFlights() {
    for (const f of this.flights) {
      this.group.remove(f.mesh);
      this.pool.push(f.mesh);
    }
    this.flights = [];
    if (this.dropMesh) {
      this.group.remove(this.dropMesh);
      this.dropMesh.scale.setScalar(1);
      this.pool.push(this.dropMesh);
      this.dropMesh = null;
    }
  }

  private updateFlights(delta: number) {
    const speed = this.speed.peek();
    let allDone = true;
    for (const f of this.flights) {
      const dur = Math.max(0.25, f.path.seconds / speed);
      const u = Math.min(1, this.t / dur);
      if (u < 1) allDone = false;
      // Ease in and out so hops read as discrete moves.
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      let dist = e * f.total;
      let k = 0;
      while (k < f.lengths.length - 1 && dist > f.lengths[k]) {
        dist -= f.lengths[k];
        k++;
      }
      const a = f.path.points[k];
      const b = f.path.points[k + 1] || a;
      const seg = f.lengths[k] || 1;
      f.mesh.position.lerpVectors(a, b, Math.min(1, dist / seg));
    }
    void delta;
    return allDone;
  }

  update(delta: number) {
    if (this.dropMesh) {
      this.dropPulse += delta * 5;
      this.dropMesh.scale.setScalar(1 + 0.35 * Math.sin(this.dropPulse));
    }
    if (!this.sim || !this.playing.peek()) return;
    if (this.phase === 'moving') {
      this.t += delta;
      if (this.updateFlights(delta)) this.arrive(this.sim.events[this.index.peek()]);
    } else if (this.phase === 'dwell') {
      this.dwellLeft -= delta * this.speed.peek();
      if (this.dwellLeft <= 0 && !this.speaking) {
        const i = this.index.peek() + 1;
        if (i < this.sim.events.length) this.go(i);
        else {
          this.phase = 'done';
          this.playing.value = false;
          this.host.onDone(this.sim);
        }
      }
    }
  }

  dispose() {
    this.stop();
    for (const m of this.pool) (m.material as MeshBasicMaterial).dispose();
    this.geo.dispose();
    this.entity.destroy();
  }
}

export const protoColor = (p: string) => new Color((PROTO_COLOR as Record<string, string>)[p] || '#e4e4e7');
