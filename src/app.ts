/**
 * NetTracer XR app controller: modes, panels, the stage, packet playback and room pinning.
 * Systems in systems.ts forward ECS events and the frame tick here.
 */
import {
  BoxGeometry,
  DirectionalLight,
  EnvironmentRaycastTarget,
  EnvironmentType,
  Entity,
  Group,
  HemisphereLight,
  Hovered,
  LocomotionEnvironment,
  LocomotionSystem,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  QuadraticBezierCurve3,
  RaycastSpace,
  RingGeometry,
  SessionMode,
  TeleportSystem,
  TurningMethod,
  TurnSystem,
  Vector3,
  VisibilityState,
  World,
  XRAnchor,
  setWorldPosition,
  signal,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  SphereGeometry,
} from '@iwsdk/core';
import { clearPins, deviceIp, demoScan, loadPins, networkKey, pinOrder, roomLayout, savePins, scanFromCode, scanFromHash, trayLayout, type PinStore } from './home.js';
import { LAB_LAYOUT, TABLE, labTopology } from './lab.js';
import { makeLabel } from './models.js';
import { RATES, narrationOn, narrationRate, speechAvailable, stopSpeaking } from './narration.js';
import { cidr, clone, simulate } from './net-core/engine.js';
import type { Device, SimEvent, SimResult, Topology } from './net-core/types.js';
import { Playback, type LegPath } from './playback.js';
import { Stage, type Link } from './stage.js';
import { PinnedDevice } from './tags.js';
import { Panel, createPanel } from './ui.js';

export type Mode = 'menu' | 'lab' | 'home-load' | 'home';
type PanelId = 'menu' | 'hop' | 'ping' | 'device' | 'keypad' | 'pin';

const LAB_CENTER = new Vector3(0, TABLE.height, -0.78);
const ROOM_CENTER = new Vector3(0, 0, -3.4);
const ROOM_SCALE = 5;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const COLOR_SRC = '#22d3ee';
const COLOR_DST = '#fbbf24';

const v1 = new Vector3();
const v2 = new Vector3();

export class App {
  readonly mode = signal<Mode>('menu');
  panels!: Record<PanelId, Panel>;
  stage: Stage | null = null;
  playback!: Playback;
  topo: Topology = labTopology();
  baseTopo: Topology = labTopology();
  labScale: 'table' | 'room' = 'table';
  src = 'pcA';
  dst: string | null = 'srv';
  pickFrom = false;
  lastSim: SimResult | null = null;
  shownDevice: string | null = null;
  uiHovered = false;
  // My Network
  netKey = '';
  pins: PinStore = {};
  pinQueue: Device[] = [];
  pinIndex = -1;
  pendingRestore = new Map<string, [number, number, number]>();
  needsSave = new Set<string>();
  windowPos = new Vector3(0, 1.4, -3.4);
  hopPoints: Vector3[] = [];
  private hopGroup: Group | null = null;
  private hopEntity: Entity | null = null;
  private code = '';
  // scene furniture
  private env = new Group();
  private floor!: Mesh;
  private table!: Mesh;
  private windowFrame!: LineSegments;
  private reticle!: Entity;
  private viewer = new Vector3();

  constructor(readonly world: World) {}

  async init() {
    const w = this.world;
    this.buildEnvironment();
    const [menu, hop, ping, device, keypad, pin] = await Promise.all([
      createPanel(w, 'menu-panel', 'menu'),
      createPanel(w, 'hop-panel', 'hop'),
      createPanel(w, 'ping-panel', 'ping'),
      createPanel(w, 'device-panel', 'device'),
      createPanel(w, 'keypad-panel', 'keypad'),
      createPanel(w, 'pin-panel', 'pin'),
    ]);
    this.panels = { menu, hop, ping, device, keypad, pin };
    this.wirePanels();

    this.playback = new Playback(w, {
      packetRadius: 0.012,
      path: (from, to) => this.legPath(from, to),
      at: (id, out) => (this.stage ? this.stage.worldPos(id, out) : out.set(0, 0, 0)),
      onEvent: (ev, i, sim) => this.showEvent(ev, i, sim),
      onDone: (sim) => this.showDone(sim),
    });
    this.playback.playing.subscribe((p) => this.panels.hop.text('lbl-play', p ? 'Pause' : this.playback.sim ? 'Play' : 'Play'));

    const loco = w.getSystem(LocomotionSystem);
    if (loco) {
      // Teleport and snap turn only: no smooth sliding.
      loco.config.slidingSpeed.value = 0;
      loco.config.turningMethod.value = TurningMethod.SnapTurn;
      loco.config.turningAngle.value = 30;
      loco.config.enableJumping.value = false;
    }

    w.visibilityState.subscribe((s) => this.onVisibility(s));
    // Right-hand select (trigger or pinch) pins devices during room pinning.
    w.renderer.xr.addEventListener('sessionstart', () => {
      const s = w.renderer.xr.getSession();
      if (!s) return;
      const onSelect = (e: XRInputSourceEvent) => {
        if (e.inputSource.handedness === 'right') this.onRightSelect();
      };
      s.addEventListener('selectstart', onSelect);
      s.addEventListener('end', () => s.removeEventListener('selectstart', onSelect), { once: true });
    });
    this.refreshMenu();
    this.setMode('menu');

    // A backup link from the scanner carries the scan in the URL fragment.
    try {
      const fromHash = await scanFromHash(location.hash);
      if (fromHash) {
        history.replaceState(null, '', location.pathname + location.search);
        this.openHome(fromHash);
      }
    } catch (e) {
      this.setMode('home-load');
      this.panels.keypad.text('kp-status', `The link did not load: ${(e as Error).message}`);
    }

    // Deep links for desktop visitors and screenshots: ?mode=lab or ?mode=demo.
    const startMode = new URLSearchParams(location.search).get('mode');
    if (startMode === 'lab') this.openLab();
    else if (startMode === 'demo') demoScan().then((t) => this.openHome(t)).catch(() => undefined);

    window.addEventListener('resize', () => this.placeDesktopCamera());

    // Desktop keys: Space plays or pauses, the arrow keys step one hop.
    window.addEventListener('keydown', (e) => {
      if (this.isImmersive() || (this.mode.peek() !== 'lab' && this.mode.peek() !== 'home')) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!this.playback.sim) this.sendPing();
        else this.playback.togglePause();
      } else if (e.key === 'ArrowRight') this.playback.next();
      else if (e.key === 'ArrowLeft') this.playback.prev();
    });

    // Installed as an app (the Quest Store build is a Trusted Web Activity): there is no 2D page,
    // so spend the launch tap on entering the headset view right away.
    // getDigitalGoodsService exists only inside the installed app on the headset.
    if ('getDigitalGoodsService' in window || matchMedia('(display-mode: standalone)').matches) {
      this.enterXR();
    }
  }

  /* ------------------------------------------------------------------ scene */

  private buildEnvironment() {
    const w = this.world;
    this.env.name = 'environment';
    // Floor for VR and desktop. Hidden in passthrough, still walkable for teleport.
    this.floor = new Mesh(new PlaneGeometry(30, 30), new MeshStandardMaterial({ color: '#202126', roughness: 0.95 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.name = 'floor';
    const floorEntity = w.createTransformEntity(this.floor, { persistent: true });
    floorEntity.addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

    this.table = new Mesh(new BoxGeometry(TABLE.width, 0.04, TABLE.depth), new MeshStandardMaterial({ color: '#3f3f46', roughness: 0.7 }));
    this.table.position.set(LAB_CENTER.x, TABLE.height - 0.02, LAB_CENTER.z);
    this.table.name = 'lab-platform';
    const legs = new Mesh(new BoxGeometry(TABLE.width * 0.9, TABLE.height - 0.04, 0.04), new MeshStandardMaterial({ color: '#27272a' }));
    legs.position.set(0, -TABLE.height / 2, 0);
    this.table.add(legs);
    w.createTransformEntity(this.table, { persistent: true });

    // Virtual window the internet leaves through in VR and desktop.
    this.windowFrame = new LineSegments(new EdgesGeometry(new PlaneGeometry(1.1, 0.8)), new LineBasicMaterial({ color: '#7dd3fc' }));
    this.windowFrame.name = 'internet-window';
    this.windowFrame.visible = false;
    w.createTransformEntity(this.windowFrame, { persistent: true });

    const hemi = new HemisphereLight('#e4e7ef', '#26272b', 1.4);
    w.createTransformEntity(hemi, { persistent: true });
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(1.5, 3, 1);
    w.createTransformEntity(sun, { persistent: true });

    // Reticle that follows real surfaces under the right controller ray (passthrough only).
    const ring = new Mesh(new RingGeometry(0.035, 0.05, 32), new MeshBasicMaterial({ color: '#22d3ee' }));
    ring.rotation.x = -Math.PI / 2;
    const ret = new Group();
    ret.add(ring);
    ret.name = 'reticle';
    ret.visible = false;
    this.reticle = w.createTransformEntity(ret, { persistent: true });
    this.reticle.addComponent(EnvironmentRaycastTarget, { space: RaycastSpace.Right, maxDistance: 8 });
  }

  isImmersive() {
    return this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
  }

  /** True in a passthrough (mixed reality) session. */
  isAR() {
    const s = this.world.session as (XRSession & { environmentBlendMode?: string }) | undefined;
    return !!s && !!s.environmentBlendMode && s.environmentBlendMode !== 'opaque';
  }

  private wasImmersive = false;

  private onVisibility(state: VisibilityState) {
    const immersive = state !== VisibilityState.NonImmersive;
    const changed = immersive !== this.wasImmersive;
    this.wasImmersive = immersive;
    if (state === VisibilityState.Visible) {
      this.world.session?.updateTargetFrameRate?.(72).catch(() => undefined);
      this.world.renderer.xr.setFoveation(1);
    }
    if (!changed) return;
    this.refreshMenu();
    this.applyEnvironment();
    this.layoutPanels();
    this.placeDesktopCamera();
    // Passthrough and virtual rooms lay My Network out differently.
    if (this.mode.peek() === 'home') this.openHome(this.baseTopo, true);
  }

  private applyEnvironment() {
    const ar = this.isAR();
    this.floor.visible = !ar;
    const mode = this.mode.peek();
    this.table.visible = mode === 'lab' && this.labScale === 'table';
    this.windowFrame.visible = mode === 'home' && !ar;
    // In passthrough My Network, content is pinned to the real room, so the player must not move virtually.
    const lockPlayer = ar && mode === 'home';
    const tp = this.world.getSystem(TeleportSystem);
    const turn = this.world.getSystem(TurnSystem);
    if (lockPlayer) {
      tp?.stop();
      turn?.stop();
      this.world.player.position.set(0, 0, 0);
      this.world.player.rotation.set(0, 0, 0);
    } else {
      tp?.play();
      turn?.play();
    }
  }

  enterXR() {
    if (this.isImmersive()) {
      this.world.exitXR();
      return;
    }
    const xr = navigator.xr;
    if (!xr) return;
    xr.isSessionSupported('immersive-ar').then((ar) => {
      if (ar) this.world.launchXR();
      else this.world.launchXR({ sessionMode: SessionMode.ImmersiveVR });
    }).catch(() => this.world.launchXR({ sessionMode: SessionMode.ImmersiveVR }));
  }

  /* ------------------------------------------------------------------ panels */

  private wirePanels() {
    const { menu, hop, ping, device, keypad, pin } = this.panels;
    menu.onClick('btn-lab', () => this.openLab());
    menu.onClick('btn-home', () => this.setMode('home-load'));
    menu.onClick('btn-scale', () => this.toggleScale());
    menu.onClick('btn-xr', () => this.enterXR());
    menu.onClick('btn-narration', () => {
      if (!speechAvailable) return;
      narrationOn.value = !narrationOn.peek();
      if (!narrationOn.peek()) stopSpeaking();
      this.refreshMenu();
    });
    menu.onClick('btn-rate', () => {
      const i = RATES.indexOf(narrationRate.peek());
      narrationRate.value = RATES[(i + 1) % RATES.length];
      this.refreshMenu();
    });

    hop.onClick('btn-play', () => {
      if (!this.playback.sim) this.sendPing();
      else this.playback.togglePause();
    });
    hop.onClick('btn-next', () => this.playback.next());
    hop.onClick('btn-prev', () => this.playback.prev());
    hop.onClick('btn-replay', () => (this.lastSim ? this.playback.start(this.lastSim) : this.sendPing()));

    ping.onClick('btn-pick-from', () => {
      this.pickFrom = !this.pickFrom;
      this.refreshPing();
    });
    ping.onClick('btn-send', () => this.sendPing());
    ping.onClick('btn-internet', () => {
      this.dst = 'internet';
      this.refreshPing();
      this.sendPing();
    });
    ping.onClick('btn-reset', () => (this.mode.peek() === 'lab' ? this.openLab() : this.setMode('home-load')));

    device.onClick('btn-dev-close', () => this.hideDevice());
    device.onClick('btn-dev-ping', () => {
      if (!this.shownDevice) return;
      this.dst = this.shownDevice;
      this.refreshPing();
      this.sendPing();
    });
    device.onClick('btn-dev-link', () => this.toggleLink());

    for (const c of CODE_CHARS) keypad.onClick(`key-${c}`, () => this.typeCode(c));
    keypad.onClick('key-del', () => {
      this.code = this.code.slice(0, -1);
      this.refreshCode();
    });
    keypad.onClick('btn-kp-load', () => this.loadCode());
    keypad.onClick('btn-kp-demo', async () => {
      try {
        this.openHome(await demoScan());
      } catch (e) {
        keypad.text('kp-status', (e as Error).message);
      }
    });
    keypad.onClick('btn-kp-back', () => this.setMode('menu'));

    pin.onClick('btn-pin-skip', () => this.nextPin(1));
    pin.onClick('btn-pin-back', () => this.nextPin(-1));
    pin.onClick('btn-pin-done', () => this.finishPinning());
    pin.onClick('btn-pin-clear', () => {
      clearPins(this.netKey);
      this.pins = {};
      this.openHome(this.baseTopo, true);
    });
  }

  private refreshMenu() {
    const m = this.panels?.menu;
    if (!m) return;
    m.text('lbl-narration', speechAvailable ? (narrationOn.peek() ? 'Narration on' : 'Narration off') : 'Captions only');
    m.text('lbl-rate', `Voice ${narrationRate.peek()}x`);
    m.display('btn-rate', speechAvailable);
    m.text('lbl-scale', this.labScale === 'table' ? 'Room scale' : 'Tabletop scale');
    m.display('btn-scale', this.mode.peek() === 'lab');
    m.text('lbl-xr', this.isImmersive() ? 'Exit to browser' : 'Enter headset view');
    m.text('menu-sub', this.isImmersive() ? 'Pick a mode. Point and pull the trigger to press a button.' : 'Pick a mode. Click a button, or put on a Quest and open this page in its browser.');
    m.display('btn-xr', this.world.xrEnabled !== false && !!navigator.xr);
  }

  private refreshPing() {
    const p = this.panels.ping;
    const name = (id: string | null) => (id && this.topo.devices[id] ? this.topo.devices[id].name : 'nothing yet');
    p.text('ping-from', `From: ${name(this.src)}`);
    p.text('ping-to', `To: ${this.dst === 'internet' ? 'the internet (8.8.8.8)' : name(this.dst)}`);
    p.text('lbl-pick-from', this.pickFrom ? 'Picking source' : 'Pick source');
    const xr = this.isImmersive();
    p.text('ping-hint', this.pickFrom
      ? (xr ? 'Point at the device that should send the ping, then pull the trigger.' : 'Click the device that should send the ping.')
      : (xr ? 'Point at a device and pull the trigger to make it the destination. Point at it to see its details.' : 'Click a device to make it the destination. Hover over it to see its details.'));
    const home = this.mode.peek() === 'home';
    p.display('btn-internet', home);
    p.text('lbl-reset', home ? 'Load another scan' : 'Reset lab');
    if (this.stage) {
      for (const id of this.stage.devices.keys()) this.stage.setRing(id, id === this.src ? COLOR_SRC : id === this.dst ? COLOR_DST : null);
    }
  }

  private typeCode(c: string) {
    if (this.code.length >= 6) return;
    this.code += c;
    this.refreshCode();
  }

  private refreshCode() {
    const shown = this.code.padEnd(6, '-').split('').join(' ');
    this.panels.keypad.text('kp-code', shown);
  }

  private async loadCode() {
    const k = this.panels.keypad;
    if (this.code.length !== 6) {
      k.text('kp-status', 'A code has 6 characters.');
      return;
    }
    k.text('kp-status', 'Loading your scan...');
    try {
      this.openHome(await scanFromCode(this.code));
      this.code = '';
      this.refreshCode();
    } catch (e) {
      k.text('kp-status', (e as Error).message);
    }
  }

  /** Where each panel sits for the current mode and view. */
  layoutPanels() {
    const { menu, hop, ping, device, keypad, pin } = this.panels;
    const mode = this.mode.peek();
    const immersive = this.isImmersive();
    const eye = v1.set(0, 1.6, 0);
    const show = (p: Panel, on: boolean) => p.show(on);
    show(menu, true);
    const pinning = mode === 'home' && this.pinIndex >= 0;
    show(hop, (mode === 'lab' || mode === 'home') && !pinning);
    show(ping, (mode === 'lab' || mode === 'home') && !pinning);
    show(keypad, mode === 'home-load');
    show(pin, pinning);
    if (this.hopGroup) this.hopGroup.visible = !pinning;
    const inet = this.stage?.devices.get('internet');
    if (inet) inet.group.visible = !pinning;
    if (mode !== 'lab' && mode !== 'home') show(device, false);

    const at = (p: Panel, x: number, y: number, z: number, tilt = -0.12) => p.place(v2.set(x, y, z), eye, tilt);
    if (mode === 'menu' || mode === 'home-load') {
      if (mode === 'menu') at(menu, 0, 1.35, -1.05);
      else if (immersive) at(menu, -0.95, 1.3, -0.75);
      else menu.place(v2.set(-1.15, 1.3, -1.3), v1.set(0, 1.55, 0.9), 0);
      at(keypad, immersive ? 0.15 : 0.3, 1.3, -1.15);
      return;
    }
    const roomish = (mode === 'lab' && this.labScale === 'room') || mode === 'home';
    if (roomish && immersive) {
      menu.place(v2.set(-1.05, 1.35, -0.55), eye);
      menu.follow(this.world, [-0.95, -0.15, -0.65]);
      hop.place(v2.set(-0.45, 1.3, -0.95), eye);
      hop.follow(this.world, [-0.42, -0.28, -0.95]);
      ping.place(v2.set(0.55, 1.25, -0.9), eye);
      ping.follow(this.world, [0.55, -0.32, -0.85]);
      // Off to the lower left so the ray can reach spots straight ahead.
      at(pin, -0.6, 1.3, -0.75);
      pin.follow(this.world, [-0.62, -0.3, -0.72]);
      return;
    }
    if (mode === 'home') {
      // Desktop view of a virtual room, seen from above and behind. Panels float over the room, larger than in the headset.
      const cam = v1.set(0, 2.5, 2.9);
      hop.place(v2.set(0, 2.6, -2.6), cam, 0, 0.42);
      ping.place(v2.set(2.3, 2.1, -1.2), cam, 0, 0.38);
      menu.place(v2.set(-2.3, 2.1, -1.2), cam, 0, 0.38);
      return;
    }
    if (this.labScale === 'room') {
      const cam = v1.set(0, 3.6, 2.6);
      hop.place(v2.set(0, 2.75, -5.8), cam, 0, 0.5);
      ping.place(v2.set(3.4, 2.5, -3.4), cam, 0, 0.45);
      menu.place(v2.set(-3.4, 2.5, -3.4), cam, 0, 0.45);
      return;
    }
    // Tabletop lab: panels around the back half of the platform.
    if (!immersive) {
      const cam = v1.set(0, 1.65, 1.25);
      menu.place(v2.set(-1.34, 1.18, -1.45), cam, 0);
      hop.place(v2.set(0, 1.55, -1.7), cam, 0);
      ping.place(v2.set(1.34, 1.22, -1.45), cam, 0);
      return;
    }
    at(menu, -0.98, 1.5, -0.72);
    at(hop, 0, 1.33, -1.2, -0.08);
    at(ping, -0.92, 1.0, -0.62, -0.3);
  }

  /* ------------------------------------------------------------------ modes */

  setMode(mode: Mode) {
    this.mode.value = mode;
    if (mode !== 'home') this.endPinning();
    if (mode === 'menu' || mode === 'home-load') {
      this.playback?.stop();
      this.clearStage();
      if (mode === 'home-load') {
        this.code = '';
        this.refreshCode();
        this.panels.keypad.text('kp-status', 'Run the scanner on your PC. It prints a 6-character code.');
      }
    }
    this.applyEnvironment();
    this.refreshMenu();
    this.layoutPanels();
    this.placeDesktopCamera();
  }

  private clearStage() {
    this.stage?.dispose();
    this.stage = null;
    this.hopEntity?.destroy();
    this.hopEntity = null;
    this.hopGroup = null;
    this.hideDevice();
  }

  openLab() {
    this.playback.stop();
    this.clearStage();
    this.baseTopo = labTopology();
    this.topo = clone(this.baseTopo);
    const pos: Record<string, [number, number, number]> = {};
    for (const [id, [x, z]] of Object.entries(LAB_LAYOUT)) pos[id] = [x, 0, z];
    this.stage = new Stage(this.world, this.topo, 'table', pos, { labelDistance: 1 });
    this.applyLabScale();
    this.src = 'pcA';
    this.dst = 'srv';
    this.pickFrom = false;
    this.lastSim = null;
    this.mode.value = 'lab';
    this.setMode('lab');
    this.refreshPing();
    this.idleHop('Lab mode', 'Three PCs, a switch, a router with NAT and a web server. Send a ping to watch it cross the network one hop at a time. Grab a device to move it. Pull a cable plug away from its device to unplug it.');
  }

  private toggleScale() {
    if (this.mode.peek() !== 'lab') return;
    this.labScale = this.labScale === 'table' ? 'room' : 'table';
    this.applyLabScale();
    this.applyEnvironment();
    this.refreshMenu();
    this.layoutPanels();
    this.placeDesktopCamera();
    if (this.lastSim) this.playback.start(this.lastSim);
  }

  private applyLabScale() {
    const root = this.stage?.rootObject;
    if (!root) return;
    if (this.labScale === 'table') {
      root.position.copy(LAB_CENTER);
      root.scale.setScalar(1);
      this.playback.setRadius(0.012);
    } else {
      root.position.copy(ROOM_CENTER);
      root.scale.setScalar(ROOM_SCALE);
      this.playback.setRadius(0.05);
    }
    // The stage grows 5x in room scale. Labels grow 2x so they stay readable without covering the devices.
    const labelScale = this.labScale === 'room' ? 2 / ROOM_SCALE : 1;
    for (const v of this.stage!.devices.values()) {
      v.label.scale.setScalar(labelScale);
      v.label.position.y = 0.17 + (this.labScale === 'room' ? 0.06 : 0.04);
    }
    this.stage?.markDirty();
  }

  /** Load a scan into My Network. `keepPins` re-lays out the same network (after entering or leaving XR). */
  openHome(topo: Topology, keepPins = false) {
    this.playback.stop();
    this.clearStage();
    this.endPinning();
    this.baseTopo = topo;
    this.topo = clone(topo);
    this.netKey = networkKey(topo);
    if (!keepPins || !Object.keys(this.pins).length) this.pins = loadPins(this.netKey);
    this.mode.value = 'home';

    const ar = this.isAR();
    const layout = roomLayout(this.topo);
    const order = pinOrder(this.topo);
    if (ar) {
      // Devices wait in a tray in front of the viewer until they are pinned.
      this.world.player.head.getWorldPosition(v1);
      const tray = trayLayout(order.map((d) => d.id));
      for (const [id, p] of Object.entries(tray)) layout[id] = [p[0] + v1.x, p[1] + Math.max(0, v1.y - 1.6), p[2] + v1.z];
    }
    // Passthrough devices end up 1 to 3 m away in a real room; virtual-room devices are seen from farther back.
    this.stage = new Stage(this.world, this.topo, 'room', layout, { labelDistance: ar ? 1.3 : 2.2, hide: ['lan'] });
    for (const d of Object.values(this.topo.devices)) {
      if (d.meta?.link === 'wifi' && d.uplink) this.stage.wifi.add([d.id, d.uplink].sort().join('~'));
    }
    this.stage.markDirty();
    // The router's built-in switch sits inside the router.
    this.stage.localPos('lan').copy(this.stage.localPos('router')).add(v1.set(0.03, 0, 0));

    if (ar) {
      this.windowPos.copy(this.pins.__window ? new Vector3(...this.pins.__window) : this.stage.localPos('router').clone().add(v1.set(0, 0.5, -1.2)));
      this.restorePins();
      this.startPinning(order);
    } else {
      this.windowPos.set(0, 1.4, -3.1);
      this.windowFrame.position.copy(this.windowPos);
    }
    this.buildHops();
    this.src = 'pc';
    this.dst = 'router';
    this.pickFrom = false;
    this.lastSim = null;
    this.setMode('home');
    this.refreshPing();
    const n = Object.keys(this.topo.devices).length - 3;
    this.idleHop('My Network', `${n} devices from your scan, plus your router. Send a ping from your PC to any device, or out to the internet. Latency numbers come from the scan. They do not update live.`);
  }

  /* ------------------------------------------------------------------ internet path */

  /** Labels and markers for each traceroute hop, running out past the window. */
  private buildHops() {
    this.hopEntity?.destroy();
    const g = new Group();
    g.name = 'internet-hops';
    const stage = this.stage;
    if (!stage) return;
    const router = stage.localPos('router').clone();
    const dir = this.windowPos.clone().sub(router).setY(0);
    if (dir.lengthSq() < 0.01) dir.set(0, 0, -1);
    dir.normalize();
    const hops = this.topo.internet?.hops || [];
    this.hopPoints = [];
    const marker = new SphereGeometry(0.025, 12, 8);
    const mat = new MeshBasicMaterial({ color: '#7dd3fc' });
    // Hops fan up and to the side of the window so their labels stay readable from inside the room.
    const side = new Vector3(-dir.z, 0, dir.x);
    hops.forEach((h, i) => {
      const k = i + 1;
      const p = this.windowPos.clone().addScaledVector(side, 0.26 * k).addScaledVector(dir, 0.12 * k);
      p.y += 0.17 * k;
      this.hopPoints.push(p);
      const m = new Mesh(marker, mat);
      m.position.copy(p);
      g.add(m);
      const label = makeLabel([`Hop ${h.n}`, `${h.ip || 'no reply'}${h.rttMs != null ? `  ${h.rttMs} ms` : ''}`], { viewDistance: 2.5, accent: '#7dd3fc' });
      label.position.copy(p).add(v1.set(0, 0.12, 0));
      label.lookAt(0, p.y + 0.12, 0);
      g.add(label);
    });
    const end = (this.hopPoints.at(-1) || this.windowPos).clone().addScaledVector(side, 0.35).addScaledVector(dir, 0.2);
    end.y += 0.2;
    stage.localPos('internet').copy(end);
    if (stage.devices.get('internet')) stage.setLabel('internet', ['Internet 8.8.8.8', this.topo.internet?.latencyMs != null ? `${this.topo.internet.latencyMs} ms from your PC` : 'latency unknown'], 2.5);
    this.hopGroup = g;
    this.hopEntity = this.world.createTransformEntity(g);
    stage.markDirty();
  }

  /** Path for one hop of the simulation, in world space. */
  legPath(from: string, to: string): LegPath {
    const stage = this.stage!;
    const a = stage.worldPos(from, new Vector3());
    const b = stage.worldPos(to, new Vector3());
    const scale = this.mode.peek() === 'lab' && this.labScale === 'room' ? ROOM_SCALE : 1;
    if (this.mode.peek() === 'home' && (from === 'internet' || to === 'internet')) {
      const router = stage.worldPos('router', new Vector3());
      const chain = [router, this.windowPos.clone(), ...this.hopPoints.map((p) => p.clone()), stage.worldPos('internet', new Vector3())];
      if (from === 'internet') chain.reverse();
      const hops = this.topo.internet?.hops || [];
      const lag = hops.reduce((s, h) => s + Math.min(h.rttMs ?? 40, 200), 0) / 250;
      return { points: chain, seconds: 1.6 + lag };
    }
    if (this.mode.peek() === 'lab') {
      a.y = this.stage!.rootObject.position.y + 0.012 * scale;
      b.y = a.y;
      const mid = a.clone().lerp(b, 0.5);
      return { points: [a, mid, b], seconds: this.labScale === 'room' ? 1.3 : 0.85 };
    }
    const dist = a.distanceTo(b);
    const key = [from, to].sort().join('~');
    const lift = stage.wifi.has(key) ? 0.25 + dist * 0.2 : 0.08;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y = Math.max(a.y, b.y) + lift;
    const curve = new QuadraticBezierCurve3(a, mid, b);
    return { points: curve.getPoints(10), seconds: Math.max(0.6, dist / 1.6) };
  }

  /* ------------------------------------------------------------------ simulation */

  sendPing() {
    if (!this.stage || !this.dst) return;
    const dstIp = this.dst === 'internet' ? '8.8.8.8' : deviceIp(this.topo.devices[this.dst]);
    if (!dstIp || this.dst === this.src) {
      this.idleHop('Pick another destination', 'The source and destination are the same device.');
      return;
    }
    this.hideDevice();
    const sim = simulate(this.topo, { type: 'ping', src: this.src, dst: dstIp });
    this.lastSim = sim;
    this.playback.start(sim);
  }

  private idleHop(title: string, text: string) {
    const h = this.panels.hop;
    h.text('hop-step', ' ');
    h.text('hop-title', title);
    h.text('hop-text', text);
    h.text('hop-why', ' ');
    h.text('lbl-play', 'Send ping');
  }

  private showEvent(ev: SimEvent, i: number, sim: SimResult) {
    const h = this.panels.hop;
    const step = sim.steps[ev.step];
    h.text('hop-step', `Hop ${i + 1} of ${sim.events.length}  ·  ${ev.drop ? 'Dropped' : ev.proto}${ev.nat ? '  ·  NAT' : ''}`);
    h.text('hop-title', step ? prettyTitle(step.title) : ev.info);
    h.text('hop-text', ev.note || ev.info);
    h.text('hop-why', i === step?.start ? step.why : ' ');
  }

  private showDone(sim: SimResult) {
    const h = this.panels.hop;
    const last = sim.events.at(-1);
    if (sim.ok) {
      h.text('hop-title', 'The reply made it back');
      h.text('hop-text', `${sim.events.length} frames crossed the network. Press Replay to watch again, or pick another destination.`);
    } else {
      h.text('hop-title', `Dropped: ${sim.failure?.title || 'packet lost'}`);
      h.text('hop-text', last?.note || 'The packet did not arrive.');
    }
    h.text('hop-why', ' ');
  }

  /* ------------------------------------------------------------------ devices */

  onDeviceClick(id: string) {
    if (!this.stage || id === 'lan') return;
    if (this.pinIndex >= 0) return;
    if (this.pickFrom) {
      if (this.topo.devices[id].type === 'switch') return;
      this.src = id;
      this.pickFrom = false;
    } else {
      this.dst = id;
    }
    this.refreshPing();
  }

  onDeviceHover(id: string) {
    if (!this.stage || id === 'lan' || this.pinIndex >= 0) return;
    this.showDevice(id);
  }

  private showDevice(id: string) {
    const d = this.topo.devices[id];
    if (!d) return;
    this.shownDevice = id;
    const p = this.panels.device;
    const home = this.mode.peek() === 'home';
    p.text('dev-name', d.name);
    const rows = home ? homeRows(d) : labRows(d, this.lastSim);
    p.text('dev-kind', rows.kind);
    for (let i = 0; i < 5; i++) p.text(`dev-r${i + 1}`, rows.lines[i] || '');
    const linkable = home && !!d.uplink && d.id !== 'internet';
    p.display('btn-dev-link', linkable);
    if (linkable) p.text('lbl-dev-link', d.meta?.link === 'wifi' ? 'Use cable' : 'Use Wi-Fi');
    p.display('btn-dev-ping', d.type !== 'switch' && id !== this.src);
    p.show(true);
    const eye = this.world.player.head.getWorldPosition(v1);
    if (!this.isImmersive()) eye.copy(this.world.camera.getWorldPosition(v1));
    if (this.mode.peek() === 'lab' && this.labScale === 'table') {
      if (this.isImmersive()) p.place(v2.set(0.92, 1.05, -0.62), eye, -0.3);
      else p.place(v2.set(1.36, 0.62, -1.25), eye, -0.2);
    } else {
      const at = this.stage!.worldPos(id, v2);
      const toEye = eye.clone().sub(at).setY(0).normalize();
      at.addScaledVector(toEye, 0.35);
      at.y += this.mode.peek() === 'home' ? 0.45 : 1.2;
      at.x += 0.35;
      p.place(at, eye, -0.12, this.isImmersive() ? 0.25 : 0.38);
    }
  }

  hideDevice() {
    this.shownDevice = null;
    this.panels?.device.show(false);
  }

  private toggleLink() {
    const id = this.shownDevice;
    if (!id || !this.stage) return;
    for (const t of [this.topo, this.baseTopo]) {
      const d = t.devices[id];
      if (!d) continue;
      d.meta = { ...(d.meta || {}), link: d.meta?.link === 'wifi' ? 'wired' : 'wifi' };
    }
    const d = this.topo.devices[id];
    const key = [id, d.uplink].sort().join('~');
    if (d.meta?.link === 'wifi') this.stage.wifi.add(key);
    else this.stage.wifi.delete(key);
    this.stage.markDirty();
    this.showDevice(id);
  }

  /** Called when a grabbed device is let go: keep it on its surface. */
  onDeviceReleased(id: string) {
    if (!this.stage) return;
    const p = this.stage.localPos(id);
    if (this.mode.peek() === 'lab') p.y = 0;
    this.stage.markDirty();
    for (const l of this.stage.links) if (l.owner === id && !this.stage.detached.has(l.key)) this.stage.placePlugHome(l);
    if (this.mode.peek() === 'home' && this.isAR() && this.pinIndex < 0) {
      // Moving a pinned device in passthrough re-pins it where it was dropped.
      const e = this.stage.devices.get(id)!.entity;
      this.pinAt(id, e.object3D!.getWorldPosition(new Vector3()));
    }
  }

  /** A plug was dropped. Close to its device: plugged in. Near another switch or router: moved there. Otherwise: unplugged. */
  onPlugReleased(link: Link, plugPos: Vector3) {
    const stage = this.stage;
    if (!stage || this.mode.peek() !== 'lab') return;
    const home = stage.plugHome(link, new Vector3());
    let target: string | null = null;
    let best = 0.1;
    for (const d of Object.values(this.topo.devices)) {
      if (d.id === link.owner || (d.type !== 'switch' && d.type !== 'router')) continue;
      const dist = stage.localPos(d.id).distanceTo(plugPos);
      if (dist < best) {
        best = dist;
        target = d.id;
      }
    }
    const wasDetached = stage.wasDetached.get(link.key) ?? false;
    stage.wasDetached.delete(link.key);
    if (!wasDetached) stage.detached.delete(link.key);
    const owner = this.topo.devices[link.owner];
    const setPeer = (peer: string) => {
      if (link.iface) {
        const f = owner.ifaces!.find((x) => x.name === link.iface)!;
        f.peer = peer;
      } else owner.uplink = peer;
    };
    let story: string;
    if (plugPos.distanceTo(home) < 0.06 || (target === link.other && !wasDetached)) {
      if (wasDetached) {
        stage.detached.delete(link.key);
        setPeer(link.other);
        story = `${owner.name} is plugged back in to ${this.topo.devices[link.other].name}.`;
      } else {
        stage.placePlugHome(link);
        return;
      }
    } else if (target) {
      stage.detached.delete(link.key);
      setPeer(target);
      story = `${owner.name} is now cabled to ${this.topo.devices[target].name}. The ping below shows what that changes.`;
    } else {
      setPeer('');
      stage.detached.set(link.key, plugPos.clone());
      story = `You unplugged ${owner.name} from ${this.topo.devices[link.other].name}. Nothing crosses that cable now.`;
    }
    this.playback.stop();
    stage.setTopology(this.topo);
    for (const l of stage.links) if (!stage.detached.has(l.key)) stage.placePlugHome(l);
    stage.markDirty();
    this.idleHop('Cable change', story);
    // Re-run the last ping so the failure or the new path is explained hop by hop.
    setTimeout(() => this.sendPing(), 1600);
  }

  /* ------------------------------------------------------------------ room pinning */

  private startPinning(order: Device[]) {
    this.pinQueue = order;
    const firstUnpinned = order.findIndex((d) => !this.pins[d.id]);
    this.pinIndex = firstUnpinned >= 0 ? firstUnpinned : order.length;
    (this.reticle.object3D as Group).visible = true;
    this.refreshPin();
  }

  private endPinning() {
    this.pinIndex = -1;
    if (this.reticle) (this.reticle.object3D as Group).visible = false;
  }

  private finishPinning() {
    this.endPinning();
    this.layoutPanels();
    this.idleHop('Pinned', 'Your devices are where they really sit. Point at one to see what it is, or send a ping.');
  }

  private nextPin(step: number) {
    this.pinIndex = Math.max(0, Math.min(this.pinQueue.length, this.pinIndex + step));
    this.refreshPin();
  }

  private refreshPin() {
    const p = this.panels.pin;
    const total = this.pinQueue.length + 1;
    if (this.pinIndex < this.pinQueue.length) {
      const d = this.pinQueue[this.pinIndex];
      p.text('pin-progress', `Device ${this.pinIndex + 1} of ${total}${this.pins[d.id] ? '  ·  pinned' : ''}`);
      p.text('pin-device', `${d.name}, ${deviceIp(d)}`);
      p.text('pin-hint', 'Point at the spot where it really sits, then pull the trigger.');
      for (const id of this.stage?.devices.keys() || []) this.stage!.setRing(id, id === d.id ? COLOR_DST : null);
    } else if (this.pinIndex === this.pinQueue.length) {
      p.text('pin-progress', `Step ${total} of ${total}${this.pins.__window ? '  ·  pinned' : ''}`);
      p.text('pin-device', 'A window or outside wall');
      p.text('pin-hint', 'Point at a window or an outside wall. Packets bound for the internet leave through it.');
      for (const id of this.stage?.devices.keys() || []) this.stage!.setRing(id, null);
    }
    this.layoutPanels();
  }

  /** True while the ray rests on a visible panel, so a button press is not also a pin. */
  private pointingAtPanel() {
    return Object.values(this.panels).some((p) => p.visible && p.entity.hasComponent(Hovered));
  }

  /** Right trigger or pinch in a session. Pins the current device at the reticle. */
  onRightSelect() {
    if (this.pinIndex < 0 || !this.isAR() || this.pointingAtPanel()) return;
    const hit = this.reticle.getValue(EnvironmentRaycastTarget, 'xrHitTestResult');
    if (!hit) {
      console.info('[pin] no surface under the ray yet');
      return;
    }
    const pos = this.reticle.object3D!.getWorldPosition(new Vector3());
    if (this.pinIndex < this.pinQueue.length) {
      this.pinAt(this.pinQueue[this.pinIndex].id, pos);
    } else {
      this.windowPos.copy(pos).add(v1.set(0, 0.2, 0));
      this.pins.__window = [this.windowPos.x, this.windowPos.y, this.windowPos.z];
      savePins(this.netKey, this.pins);
      this.buildHops();
    }
    this.pinIndex++;
    if (this.pinIndex > this.pinQueue.length) this.finishPinning();
    else this.refreshPin();
  }

  /** Put a device at a world position and anchor it to the room. */
  pinAt(id: string, worldPos: Vector3) {
    const v = this.stage?.devices.get(id);
    if (!v) return;
    setWorldPosition(v.group, worldPos);
    if (!v.entity.hasComponent(PinnedDevice)) v.entity.addComponent(PinnedDevice, { deviceId: id });
    if (!v.entity.hasComponent(XRAnchor)) v.entity.addComponent(XRAnchor);
    this.needsSave.add(id);
    this.stage!.markDirty();
    if (id === 'router') this.stage!.localPos('lan').copy(v.group.position).add(v1.set(0.03, 0, 0));
  }

  /** Saved pins are offsets from IWSDK's persistent room anchor. Apply them once that anchor is attached. */
  private restorePins() {
    for (const [id, local] of Object.entries(this.pins)) {
      if (id.startsWith('__')) continue;
      const v = this.stage?.devices.get(id);
      if (!v) continue;
      v.entity.addComponent(PinnedDevice, { deviceId: id });
      v.entity.addComponent(XRAnchor);
      this.pendingRestore.set(id, local);
    }
  }

  /** Per-frame pin bookkeeping, driven by PinSystem. */
  updatePinned(entity: Entity) {
    const id = entity.getValue(PinnedDevice, 'deviceId') as string;
    if (!entity.getValue(XRAnchor, 'attached')) return;
    const o = entity.object3D!;
    const pending = this.pendingRestore.get(id);
    if (pending) {
      o.position.set(pending[0], pending[1], pending[2]);
      this.pendingRestore.delete(id);
      entity.setValue(PinnedDevice, 'restored', true);
      this.stage?.markDirty();
      if (id === 'router') this.stage?.localPos('lan').copy(o.getWorldPosition(v1));
      return;
    }
    if (this.needsSave.has(id)) {
      this.pins[id] = [o.position.x, o.position.y, o.position.z];
      savePins(this.netKey, this.pins);
      this.needsSave.delete(id);
    }
  }

  /* ------------------------------------------------------------------ frame */

  private placeDesktopCamera() {
    if (this.isImmersive()) return;
    const cam = this.world.camera;
    const mode = this.mode.peek();
    this.world.player.position.set(0, 0, 0);
    // A narrower lens than the headset keeps flat panels from looking keystoned on a monitor.
    cam.fov = 50;
    cam.updateProjectionMatrix();
    const target = v2.set(0, 1.3, -1.1);
    if (mode === 'lab' && this.labScale === 'table') {
      cam.position.set(0, 1.65, 1.25);
      target.set(0, 1.0, -1.0);
    } else if (mode === 'lab') {
      cam.position.set(0, 3.6, 2.6);
      target.set(0, 0.8, -3.4);
    } else if (mode === 'home') {
      cam.position.set(0, 2.5, 2.9);
      target.set(0, 1.05, -1.6);
    } else {
      cam.position.set(0, 1.55, 0.9);
    }
    // The layouts are framed for a 16:10 window. Narrower windows (4:3, phones in portrait) pull the camera back.
    const aspect = this.world.renderer.domElement.clientWidth / Math.max(1, this.world.renderer.domElement.clientHeight);
    const back = Math.min(2.6, Math.max(1, 1.6 / aspect));
    cam.position.sub(target).multiplyScalar(back).add(target);
    cam.lookAt(target);
  }

  update(delta: number, time: number) {
    if (!this.panels) return;
    this.playback.update(delta);
    if (this.stage) {
      if (this.isImmersive()) this.world.player.head.getWorldPosition(this.viewer);
      else this.world.camera.getWorldPosition(this.viewer);
      this.stage.tick(time, this.viewer);
      if (this.hopGroup) {
        for (const c of this.hopGroup.children) if (c.name === 'label') c.lookAt(this.viewer.x, c.position.y, this.viewer.z);
      }
    }
  }
}

function prettyTitle(t: string): string {
  return t.replace(/\s+·\s+/g, ': ');
}

function labRows(d: Device, sim: SimResult | null): { kind: string; lines: string[] } {
  if (d.type === 'router') {
    const lines = (d.ifaces || []).map((f) => `${f.name}  ${f.addrs.map((a) => `${a.ip}/${cidr(a.mask)}`).join(', ')}${f.peer ? '' : '  (unplugged)'}`);
    if (d.nat) lines.push(`NAT  ${d.nat.inside} to ${d.nat.outside} as ${d.nat.publicIp}`);
    lines.push(`MAC  ${d.ifaces?.[0]?.mac || ''}`);
    return { kind: d.label || 'Router', lines };
  }
  if (d.type === 'switch') {
    const learned = sim ? Object.keys(sim.final.mac[d.id] || {}).length : 0;
    return { kind: d.label || 'Switch', lines: ['Layer 2: forwards by MAC address', `MAC table  ${learned} learned after the last ping`, 'VLAN  1 on every port'] };
  }
  return {
    kind: d.label || 'Host',
    lines: [`IP  ${d.ip}`, `Subnet  ${d.mask}`, `Gateway  ${d.gw || 'none'}`, `MAC  ${d.mac}`, `VLAN  ${d.vlan ?? 1}${d.uplink ? '' : '  (unplugged)'}`],
  };
}

function homeRows(d: Device): { kind: string; lines: string[] } {
  const m = d.meta || {};
  const kind = [m.vendor ? `${m.vendor}` : null, m.kind && m.kind !== 'unknown' ? m.kind : d.type === 'router' ? 'router' : 'device'].filter(Boolean).join(' ');
  const ip = deviceIp(d);
  const lines = [
    `IP  ${ip}`,
    `MAC  ${m.macDisplay || d.mac || d.ifaces?.[0]?.mac || 'unknown'}${m.randomMac ? '  (private address)' : ''}`,
    `Vendor guess  ${m.vendor || 'unknown'}`,
    `Latency at scan  ${m.latencyMs == null ? 'no reply' : `${m.latencyMs} ms`}`,
    m.hostname ? `Name  ${m.hostname}` : `Link  ${m.link === 'wifi' ? 'Wi-Fi' : 'cable'} (your choice)`,
  ];
  if (d.id === 'internet') return { kind: 'Public DNS resolver', lines: [`IP  ${ip}`, `Latency at scan  ${m.latencyMs == null ? 'no reply' : `${m.latencyMs} ms`}`] };
  return { kind: kind.charAt(0).toUpperCase() + kind.slice(1), lines };
}
