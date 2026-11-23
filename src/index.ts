/**
 * NetTracer XR entry point. World options come from iwsdk.config.json through
 * the virtual:iwsdk-project module; this file registers the app's systems.
 */
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { App } from './app.js';
import { AppTickSystem, InteractionSystem, PinSystem } from './systems.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then(async (world) => {
  const app = new App(world);
  (world.globals as Record<string, unknown>).app = app;
  world
    .registerSystem(InteractionSystem, { priority: 5 })
    .registerSystem(PinSystem, { priority: 12 })
    .registerSystem(AppTickSystem, { priority: 30 });
  await app.init();
  document.getElementById('boot')?.remove();
});
