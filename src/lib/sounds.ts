import openUrl from "../assets/sounds/open.mp3";
import targetUrl from "../assets/sounds/target.mp3";
import stopUrl from "../assets/sounds/stop.mp3";

export type TradeSound = "open" | "profit" | "loss";

const STORAGE_KEY = "terading.soundEnabled";

const URLS: Record<TradeSound, string> = {
  open: openUrl,
  profit: targetUrl,
  loss: stopUrl,
};

const pool: Partial<Record<TradeSound, HTMLAudioElement>> = {};
let enabled = readEnabled();
let queued: TradeSound[] = [];
let arming = false;

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

function template(kind: TradeSound): HTMLAudioElement {
  let audio = pool[kind];
  if (!audio) {
    audio = new Audio(URLS[kind]);
    audio.preload = "auto";
    pool[kind] = audio;
  }
  return audio;
}

function playOne(kind: TradeSound): void {
  const base = template(kind);
  const node = base.cloneNode(true) as HTMLAudioElement;
  node.volume = 1;
  void node.play().catch(() => {
    /* autoplay blocked until armed */
  });
}

function pump(): void {
  if (!enabled) {
    queued = [];
    return;
  }
  const batch = queued.splice(0);
  for (const [index, kind] of batch.entries()) {
    window.setTimeout(() => playOne(kind), index * 220);
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
  if (!on) {
    queued = [];
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}

/** Unlock playback (browser gesture) and optionally play the open clip as a test. */
export function armSound(playTest = false): void {
  for (const kind of Object.keys(URLS) as TradeSound[]) {
    const audio = template(kind);
    audio.load();
  }
  if (playTest && enabled) {
    playOne("open");
    announce("Trade alerts on");
  }
}

export function playTradeSound(kind: TradeSound): void {
  if (!enabled) return;
  queued.push(kind);
  if (arming) return;
  arming = true;
  queueMicrotask(() => {
    arming = false;
    pump();
  });
}

const SPOKEN_INTERVAL: Record<string, string> = { "5m": "5 minute", "15m": "15 minute", "1h": "1 hour" };

/** Interval as it should be read aloud, e.g. "5m" → "5 minute". */
export function spokenInterval(interval: string): string {
  return SPOKEN_INTERVAL[interval] ?? interval;
}

let voice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
  if (voice !== undefined) return voice;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null; // not loaded yet; try again next time
  voice = voices.find((v) => v.lang === "en-IN") ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
  return voice;
}

/**
 * Read a trade alert aloud after its chime, so the listener knows which instrument traded.
 * Follows the Sound on/off switch. Browsers queue utterances, so several alerts play one after another.
 */
export function announce(text: string, delayMs = 900): void {
  if (!enabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.setTimeout(() => {
    if (!enabled) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const chosen = pickVoice();
    if (chosen) utterance.voice = chosen;
    utterance.lang = chosen?.lang ?? "en-IN";
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }, delayMs);
}

export function soundForClose(reason: string, pnl: number): "profit" | "loss" {
  if (reason === "target") return "profit";
  if (reason === "stop") return "loss";
  return pnl >= 0 ? "profit" : "loss";
}

function prime(): void {
  for (const kind of Object.keys(URLS) as TradeSound[]) {
    const audio = template(kind);
    if (audio.readyState === 0) audio.load();
  }
}

window.addEventListener("pointerdown", prime, { passive: true });
window.addEventListener("keydown", prime);
