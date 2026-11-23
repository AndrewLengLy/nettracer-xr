// Black and white app icons for the web manifest and the Quest launcher.
// Run with: node scripts/icons.mjs
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

// Three hosts on a switch, wired up to a router: the NetTracer lab in one glyph.
const glyph = `
  <g stroke="#ffffff" stroke-width="18" stroke-linecap="round" fill="none">
    <line x1="256" y1="150" x2="256" y2="250"/>
    <line x1="256" y1="250" x2="150" y2="352"/>
    <line x1="256" y1="250" x2="256" y2="352"/>
    <line x1="256" y1="250" x2="362" y2="352"/>
  </g>
  <rect x="196" y="104" width="120" height="58" rx="14" fill="#ffffff"/>
  <rect x="206" y="228" width="100" height="44" rx="10" fill="#ffffff"/>
  <circle cx="150" cy="370" r="36" fill="#ffffff"/>
  <circle cx="256" cy="370" r="36" fill="#ffffff"/>
  <circle cx="362" cy="370" r="36" fill="#ffffff"/>`;

const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#000000"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">${glyph}</g>
</svg>`;

await mkdir('public/icons', { recursive: true });
const png = (s, size, out) => sharp(Buffer.from(s)).resize(size, size).png().toFile(out);
await png(svg(0), 512, 'public/icons/icon-512.png');
await png(svg(0), 192, 'public/icons/icon-192.png');
// Maskable: full-bleed black, glyph inside the middle 80% safe zone.
await png(svg(52), 512, 'public/icons/icon-512-maskable.png');
await png(svg(0), 180, 'public/icons/apple-touch-icon.png');
console.log('icons written to public/icons');
