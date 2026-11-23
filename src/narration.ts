/**
 * Reads hop explanations aloud with the Web Speech API. When speechSynthesis
 * is missing the app shows captions only; captions are always on.
 */
import { signal } from '@iwsdk/core';

export const speechAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

export const narrationOn = signal(speechAvailable && loadPref('narration', 'on') === 'on');
export const narrationRate = signal(Number(loadPref('rate', '1')) || 1);
export const RATES = [0.75, 1, 1.25, 1.5];

function loadPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`nettracer-xr:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`nettracer-xr:${key}`, value);
  } catch {
    // Private mode or storage disabled. The setting lasts for this visit only.
  }
}

narrationOn.subscribe((v) => savePref('narration', v ? 'on' : 'off'));
narrationRate.subscribe((v) => savePref('rate', String(v)));

/** Make engine text easier to listen to: no arrows, no full MAC addresses. */
export function speakable(text: string): string {
  return text
    .replace(/ff:ff:ff:ff:ff:ff/gi, 'the broadcast address')
    .replace(/\b([0-9a-f]{2}:){5}([0-9a-f]{2})\b/gi, (m) => `the MAC ending ${m.slice(-5).replace(':', ' ')}`)
    .replace(/\b([0-9a-f]{2}:){4}xx:xx\b/gi, 'a masked MAC')
    .replace(/→/g, ' to ')
    .replace(/(\d+)\/(\d+)\b/g, '$1 slash $2')
    .replace(/\s+/g, ' ')
    .trim();
}

let current: SpeechSynthesisUtterance | null = null;

/** Speak and resolve when done. Resolves at once when narration is off or unavailable. */
export function speak(text: string): Promise<void> {
  if (!speechAvailable || !narrationOn.peek() || !text) return Promise.resolve();
  stopSpeaking();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(speakable(text));
    u.rate = narrationRate.peek();
    u.lang = 'en-US';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (current === u) current = null;
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    // Some engines never fire onend. Fall back to an estimate from the word count.
    const words = u.text.split(' ').length;
    setTimeout(done, (words / (2.6 * u.rate)) * 1000 + 2500);
    current = u;
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (!speechAvailable) return;
  current = null;
  window.speechSynthesis.cancel();
}
