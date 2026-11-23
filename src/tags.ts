/**
 * Component declarations. No systems, DOM or renderer imports here:
 * the editor imports this module too.
 */
import { createComponent, Types } from '@iwsdk/core';

/** A network device on the stage. `deviceId` is the net-core device id. */
export const DeviceNode = createComponent('DeviceNode', {
  deviceId: { type: Types.String, default: '' },
});

/** The grabbable plug at the device end of a cable. Pull it away to unplug. */
export const CablePlug = createComponent('CablePlug', {
  deviceId: { type: Types.String, default: '' },
});

/** Any spatial UI panel. Used to ignore room pinning while the ray is on a panel. */
export const UiPanel = createComponent('UiPanel', {
  panelId: { type: Types.String, default: '' },
});

/** A device pinned to a real spot in the room. `restored` flips once a saved pose is applied. */
export const PinnedDevice = createComponent('PinnedDevice', {
  deviceId: { type: Types.String, default: '' },
  restored: { type: Types.Boolean, default: false },
});
