/**
 * Code-owned spatial panels. Each panel is a UIKitML asset placed at scale 0.25
 * (1 UIKit unit = 2.5 mm), so 14-unit text is 3.5 cm tall. Panels sit within
 * about 1.4 m of the viewer, which keeps text above 24 dmm (2.4 cm at 1 m).
 */
import { Entity, Follower, FollowBehavior, RayInteractable, UIKit, UIKitMLAsset, Vector3, World } from '@iwsdk/core';
import { UiPanel } from './tags.js';

export const PANEL_SCALE = 0.25;

/** The panel font has no arrows or middle dots. Swap them for plain ASCII. */
export function panelText(s: string): string {
  return (s || ' ').replace(/\s*→\s*/g, ' -> ').replace(/\s*·\s*/g, '  |  ').replace(/…/g, '...');
}

export class Panel {
  private listeners: (() => void)[] = [];
  visible = true;

  constructor(
    readonly id: string,
    readonly entity: Entity,
    readonly doc: UIKitMLAsset,
  ) {}

  el(elementId: string) {
    return this.doc.requireElementById<UIKit.Text>(elementId);
  }

  /** Set text. Blank text hides the element (UIKit needs non-empty text to keep a text node). */
  text(elementId: string, value: string) {
    const el = this.el(elementId);
    if (!value || !value.trim()) {
      el.setProperties({ display: 'none' });
      return;
    }
    el.setProperties({ text: panelText(value), display: 'flex' });
  }

  display(elementId: string, on: boolean) {
    this.el(elementId).setProperties({ display: on ? 'flex' : 'none' });
  }

  onClick(elementId: string, fn: () => void) {
    const el = this.el(elementId);
    el.name = elementId;
    const handler = () => fn();
    el.addEventListener('click', handler);
    this.listeners.push(() => el.removeEventListener('click', handler));
  }

  show(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    this.doc.visible = on;
    if (on) this.entity.addComponent(RayInteractable);
    else if (this.entity.hasComponent(RayInteractable)) this.entity.removeComponent(RayInteractable);
  }

  /** Place in world space, turned to face `facing` (yaw only) and tipped back slightly. */
  place(pos: Vector3, facing: Vector3, tilt = -0.12, scale = PANEL_SCALE) {
    if (this.entity.hasComponent(Follower)) this.entity.removeComponent(Follower);
    const o = this.doc;
    o.scale.setScalar(scale);
    o.position.copy(pos);
    o.rotation.set(tilt, Math.atan2(facing.x - pos.x, facing.z - pos.z), 0, 'YXZ');
  }

  /** Follow the viewer lazily, for room-scale use. `offset` is in head space. */
  follow(world: World, offset: [number, number, number]) {
    this.entity.addComponent(Follower, {
      target: world.player.head,
      offsetPosition: offset,
      behavior: FollowBehavior.PivotY,
      maxAngle: 35,
      tolerance: 0.35,
      speed: 1,
    });
  }

  dispose() {
    for (const off of this.listeners) off();
    this.listeners = [];
  }
}

export async function createPanel(world: World, assetId: string, panelId: string): Promise<Panel> {
  const doc = await world.assets.instantiate<UIKitMLAsset>(assetId);
  doc.name = panelId;
  doc.scale.setScalar(PANEL_SCALE);
  const entity = world.createTransformEntity(doc, { persistent: true });
  entity.addComponent(RayInteractable);
  entity.addComponent(UiPanel, { panelId });
  return new Panel(panelId, entity, doc);
}
