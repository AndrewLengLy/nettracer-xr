# NetTracer XR

Live at [nettracer-xr.andrewlengly.com](https://nettracer-xr.andrewlengly.com). Best in Meta Quest Browser. Also runs on desktop.

NetTracer XR is the mixed reality companion to [NetTracer](https://nettracer.andrewlengly.com). It has two modes.

- Lab mode puts a sample network on a table: three PCs, a switch, a router with NAT and a web server. Send a ping and watch it move device to device. Each hop opens a panel that says what happened (ARP lookup, MAC table hit, routing decision, NAT, TTL). Grab devices to move them. Pull a cable plug out and the next ping explains the failure. Room scale blows the table up to walk-in size.
- My Network loads your real home network from a scan made on your PC. In passthrough you pin each device to the spot where it really sits, so packets fly between your actual router, PC and phone. Pings to the internet leave through a window you pin and pass the traceroute hops from your scan, labelled with their real latency.

Every hop explanation can be read aloud. Captions are always on.

Built with [Immersive Web SDK](https://developers.meta.com/horizon/documentation/web/iwsdk-overview) 1.1, Three.js and TypeScript. The simulation is NetTracer's own engine (`src/net-core/`).

## How it fits together

```
 Your PC                          Vercel                             Quest Browser
 ─────────────────                ─────────────────────              ──────────────────────────
 nettracer-scan  ── POST JSON ──▶ /api/share  ──▶ Upstash Redis      NetTracer XR
  ipconfig, ping sweep,           (64 KB cap)     key expires          My Network keypad
  arp -a, tracert                 returns code    after 15 min   ◀──── GET /api/share?code=
  builds a net-core topology                                         or the #scan= backup link
```

- `scanner/` reads the network and writes a topology in net-core format.
- `api/share.ts` stores it for 15 minutes behind a 6-character code.
- `src/` is the headset app: `net-core/` simulates, `stage.ts` draws devices and cables, `playback.ts` animates packets, `app.ts` runs the modes, panels and room pinning.

## Run it locally

1. Install Node.js 20.19+, 22.12+ or 24+.
2. `npm install`
3. `npm run dev`. This starts the IWSDK dev server and opens a managed browser with IWER, the IWSDK browser emulator for Quest 3 (it fakes the headset, controllers and a living room).
4. Open the URL it prints. Click Enter headset view to enter the emulated mixed reality session, or use the page as a desktop 3D view.
5. To try it on a Quest on the same Wi-Fi, run `npx @iwsdk/cli dev status`, open one of the `runtimeUrls.network` addresses in Quest Browser and accept the local certificate warning.

## Scan your home network (Windows, PowerShell)

The headset cannot scan a network, so a small command line tool does it on your PC. It needs no admin rights and nothing beyond Node.js.

1. Open PowerShell in this folder.
2. Link the command once: `npm link`
3. Run the scan: `npx nettracer-scan`
4. Read what it prints. It shows your adapter, IP, subnet and gateway, then asks before it pings anything. Type `y` to start the sweep.
5. Wait about a minute. It pings the 254 addresses around your PC, 12 at a time, reads `arp -a`, looks up hostnames, measures latency to each device, your router and 8.8.8.8, and runs `tracert -d -h 8 8.8.8.8`.
6. At the end it prints a 6-character code and a backup link. The scan is also saved as `nettracer-scan.json`.
7. On the headset, open NetTracer XR, choose My Network and type the code on the keypad. Or open the backup link.

Without `npm link`, run `node scanner/index.js` instead. Useful options:

- `--yes` skips the question before the sweep.
- `--full-mac` keeps full MAC addresses. By default the last two bytes are hidden (`a4:2b:b0:3c:xx:xx`).
- `--no-names` leaves hostnames out.
- `--no-upload` skips the share API and prints only the backup link.

The backup link carries the whole scan after the `#`, which browsers never send to a server.

### Turn on the share API in Vercel

The code hand-off needs an Upstash Redis database. Until it exists, `/api/share` answers 503 and the scanner falls back to the backup link.

1. In the Vercel dashboard, open the nettracer-xr project, then Storage, then Create Database, and pick Upstash for Redis (the free plan is enough).
2. Connect it to the nettracer-xr project for Production and Preview. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. If you made the database on upstash.com instead, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` under Settings, Environment Variables, copied from the database's REST API section.
4. Redeploy (Deployments, then the latest one, then Redeploy).
5. Check it: run `npx nettracer-scan` and confirm it prints a code. Codes expire after 15 minutes and the API rejects anything over 64 KB.

## Test

1. `npm test` runs the Vitest suites (37 tests):
   - `src/net-core/engine.test.ts`: ping across one switch, across one router with an ARP miss, from a PC to a public IP through NAT, and a router-to-router hop to an ISP.
   - `scanner/lib/parse.test.js`: `ipconfig /all`, `arp -a`, `tracert`, `ping`, `ip`, `ifconfig` and `traceroute` parsers, MAC masking, and a scanned topology loading in net-core.
   - `api/share.test.ts`: store and fetch by code, 15-minute expiry, the 64 KB cap and bad input.
2. `npm run typecheck`
3. `npm run build`

## Deploy

The project lives in the Parabox Digital team on Vercel and is connected to this GitHub repo, so every push to `main` deploys.

1. Push to `main`, or run `npx vercel deploy --prod --scope parabox-digital-studio` from this folder.
2. The custom domain is `nettracer-xr.andrewlengly.com`. To add it again: `npx vercel domains add nettracer-xr.andrewlengly.com nettracer-xr --scope parabox-digital-studio`. DNS for andrewlengly.com is already on Vercel, so HTTPS is issued on its own.
3. Check `https://nettracer-xr.andrewlengly.com/`, `/manifest.webmanifest` and `/icons/icon-512.png` all return 200.

## Meta Horizon Store packaging

The app installs as a PWA. It ships `public/manifest.webmanifest`, black and white icons in `public/icons/` (192, 512 and a maskable 512), and an empty `public/.well-known/assetlinks.json` placeholder. When it runs as the installed app it enters the immersive session straight after load, with no 2D page. `store/twa-manifest.example.json` is a filled-in Bubblewrap manifest.

These are the steps to run yourself. The signing key is permanent, so keep it safe and never put it in `public/`.

1. Install the Meta fork of Bubblewrap: `npm i -g @meta-quest/bubblewrap-cli`
2. In a normal terminal, run `bubblewrap doctor` once and accept the JDK 17 and Android SDK installs. It asks questions that need a person.
3. Make a folder outside this repo, for example `C:\Users\andre\nettracer-xr-twa`, and copy `store/twa-manifest.example.json` into it as `twa-manifest.json`.
4. Create the signing key there (skip if you already have one you want to reuse):
   `& "$env:USERPROFILE\.bubblewrap\jdk\<jdk-folder>\bin\keytool.exe" -genkeypair -v -keystore android.keystore -alias android -keyalg RSA -keysize 2048 -validity 10000`
5. Edit `twa-manifest.json`: set `signingKey.path` to the full path of `android.keystore`, and set `applicationId` to the numeric App ID from the Meta Developer Dashboard (leave `"0"` to sideload only).
6. Set the key passwords for this PowerShell window: `$env:BUBBLEWRAP_KEYSTORE_PASSWORD = "<password>"` and `$env:BUBBLEWRAP_KEY_PASSWORD = "<password>"`
7. Build: `bubblewrap update` then `bubblewrap build`. This writes `app-release-signed.apk`.
8. Print the certificate fingerprint: `keytool -list -v -keystore android.keystore -alias android` and copy the `SHA256:` line.
9. Put it in `public/.well-known/assetlinks.json` in this repo, then push so it goes live:
   ```json
   [{ "relation": ["delegate_permission/common.handle_all_urls"],
      "target": { "namespace": "android_app", "package_name": "com.andrewlengly.nettracerxr",
                  "sha256_cert_fingerprints": ["AA:BB:..."] } }]
   ```
10. Sideload and test on the headset: `adb install -r app-release-signed.apk`. The app should open straight into the session.
11. Download `ovr-platform-util` for Windows from the Developer Dashboard (Distribution, then Upload).
12. Upload to a test channel:
    `.\ovr-platform-util.exe upload-quest-build --app-id <APP_ID> --app-secret <APP_SECRET> --apk app-release-signed.apk --channel ALPHA --age-group MIXED_AGES --notes "First build"`
13. If it says you must agree to the Developer Distribution Agreement, an org admin signs it in the dashboard, then run the same command again.

## Known limits

- The headset cannot scan or ping your network. Latency in My Network comes from the scan. It does not update live.
- The scanner only sees devices that answer ping or show up in the ARP table. Some phones and smart devices stay hidden.
- The sweep covers the 254 addresses around your PC, even on a larger subnet.
- The simulator models the internet as one ISP router that answers for 8.8.8.8. The real hops in between come from your traceroute and are drawn past the window.
- Wired or Wi-Fi is a guess from the device type. Switch it on the device's panel.
- Room pins are saved as offsets from one persistent anchor that IWSDK keeps for the site, so there is no limit of 8 anchors per site. Clearing Quest Browser's site data, or using private mode, forgets them.
- Quest 2 loads the app as VR only, with no room pinning.

## Shared code with NetTracer

`src/net-core/` is a copy of the engine extracted from NetTracer in [AndrewLengLy/nettracer#2](https://github.com/AndrewLengLy/nettracer/pull/2) (branch `net-core-extract`, waiting for review). This repo adds router-to-router links on top, used for the ISP hop, and the same change is pushed to that branch. Until the PR merges, edit `src/net-core/` in both repos together.

## Comfort and performance

- Teleport and snap turn only. Smooth sliding is switched off. In passthrough My Network the player does not move, so pins stay lined up with the room.
- The session asks for 72 fps with fixed foveation on.
- Each device kind is one merged mesh with shared geometry and material, so a device is one draw call. All cables are one merged mesh, and all Wi-Fi arcs another.
- Panel text is at least 14 UIKit units at scale 0.25 (3.5 cm) within about 1.4 m of the viewer, above 24 dmm (2.4 cm at 1 m).

Built by [Andrew Leng Ly](https://www.andrewlengly.com).
