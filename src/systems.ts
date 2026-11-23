/**
 * ECS systems. They watch interaction tags (Hovered, Pressed, Grabbed) on
 * devices, plugs and panels and hand the events to the App controller.
 */
import { createSystem, Entity, Grabbed, Hovered, Pressed, Vector3, XRAnchor } from '@iwsdk/core';
import type { App } from './app.js';
import { CablePlug, DeviceNode, PinnedDevice, UiPanel } from './tags.js';

const appOf = (globals: Record<string, unknown>) => globals.app as App | undefined;

export class InteractionSystem extends createSystem({
  hovered: { required: [DeviceNode, Hovered] },
  pressed: { required: [DeviceNode, Pressed] },
  grabbedDevices: { required: [DeviceNode, Grabbed] },
  grabbedPlugs: { required: [CablePlug, Grabbed] },
  panelHover: { required: [UiPanel, Hovered] },
}) {
  private pressStart = new Map<Entity, { at: Vector3; t: number }>();
  private tmp!: Vector3;

  init() {
    this.tmp = new Vector3();
    const q = this.queries;
    this.cleanupFuncs.push(
      q.hovered.subscribe('qualify', (e) => appOf(this.globals)?.onDeviceHover(e.getValue(DeviceNode, 'deviceId') as string)),
      q.pressed.subscribe('qualify', (e) => {
        this.pressStart.set(e, { at: e.object3D!.getWorldPosition(new Vector3()), t: performance.now() });
      }),
      q.pressed.subscribe('disqualify', (e) => {
        const start = this.pressStart.get(e);
        this.pressStart.delete(e);
        if (!start) return;
        const moved = e.object3D!.getWorldPosition(this.tmp).distanceTo(start.at);
        // A short press that did not drag the device counts as a click.
        if (moved < 0.015 && performance.now() - start.t < 700) appOf(this.globals)?.onDeviceClick(e.getValue(DeviceNode, 'deviceId') as string);
      }),
      q.grabbedDevices.subscribe('disqualify', (e) => appOf(this.globals)?.onDeviceReleased(e.getValue(DeviceNode, 'deviceId') as string)),
      q.grabbedPlugs.subscribe('qualify', (e) => {
        const stage = appOf(this.globals)?.stage;
        const link = stage?.linkForPlug(e);
        if (stage && link) stage.wasDetached.set(link.key, stage.detached.has(link.key));
      }),
      q.grabbedPlugs.subscribe('disqualify', (e) => {
        const app = appOf(this.globals);
        const link = app?.stage?.linkForPlug(e);
        if (app && link) app.onPlugReleased(link, e.object3D!.position.clone());
      }),
      q.panelHover.subscribe('qualify', () => this.syncPanelHover()),
      q.panelHover.subscribe('disqualify', () => this.syncPanelHover()),
    );
  }

  private syncPanelHover() {
    const app = appOf(this.globals);
    if (app) app.uiHovered = this.queries.panelHover.entities.size > 0;
  }

  update() {
    const app = appOf(this.globals);
    const stage = app?.stage;
    if (!stage) return;
    // Cables follow a device or plug while it is held.
    if (this.queries.grabbedDevices.entities.size) stage.markDirty();
    for (const e of this.queries.grabbedPlugs.entities) {
      const link = stage.linkForPlug(e);
      if (!link) continue;
      const p = stage.detached.get(link.key);
      if (p) p.copy(e.object3D!.position);
      else stage.detached.set(link.key, e.object3D!.position.clone());
      stage.markDirty();
    }
  }
}

/** Applies saved room pins once IWSDK's persistent anchor is attached, and saves new ones. */
export class PinSystem extends createSystem({
  pinned: { required: [PinnedDevice, XRAnchor] },
}) {
  update() {
    const app = appOf(this.globals);
    if (!app) return;
    for (const e of this.queries.pinned.entities) app.updatePinned(e);
  }
}

/** Drives packet playback, label facing and cable rebuilds. */
export class AppTickSystem extends createSystem({}) {
  update(delta: number, time: number) {
    appOf(this.globals)?.update(delta, time);
  }
}
