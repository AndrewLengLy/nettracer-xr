/**
 * Asset catalog shared by the runtime and the editor. Deterministic, no side effects.
 * Every panel is a UIKitML file under public/ui. Device models are built in code (src/models.ts).
 */
import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const ui = (file: string, name: string) => ({ url: publicAssetUrl(`ui/${file}`), type: AssetType.UIKitML, name });

export default defineAssets({
  'menu-panel': ui('menu.uikitml', 'Menu'),
  'hop-panel': ui('hop.uikitml', 'Hop explanation'),
  'ping-panel': ui('ping.uikitml', 'Ping controls'),
  'device-panel': ui('device.uikitml', 'Device details'),
  'keypad-panel': ui('keypad.uikitml', 'Code keypad'),
  'pin-panel': ui('pin.uikitml', 'Room pinning'),
});
