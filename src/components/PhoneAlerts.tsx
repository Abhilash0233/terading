import { useEffect, useState } from "react";

/**
 * Turns on trade alerts for this phone or computer (Web Push). The server bot sends one when it
 * opens or closes a trade, even when the app is closed. On iPhone this works only from the app
 * added to the Home Screen (iOS 16.4 or later).
 */

type State = "checking" | "unsupported" | "install" | "off" | "on" | "blocked" | "busy" | "error";

const API_ROOT = "/api/";

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function keyBytes(base64: string): ArrayBuffer {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export function PhoneAlerts() {
  const [state, setState] = useState<State>("checking");
  const [note, setNote] = useState("");

  useEffect(() => {
    void (async () => {
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!supported) {
        setState(isIos() && !isStandalone() ? "install" : "unsupported");
        return;
      }
      try {
        const reg = await registration();
        if (Notification.permission === "denied") {
          setState("blocked");
          return;
        }
        const sub = await reg.pushManager.getSubscription();
        setState(sub ? "on" : "off");
      } catch {
        setState("error");
      }
    })();
  }, []);

  async function enable() {
    setState("busy");
    setNote("");
    try {
      const keyRes = await fetch(API_ROOT + "push-key").then((res) => res.json()) as { key?: string | null };
      if (!keyRes.key) throw new Error("Phone alerts aren't set up on the server yet.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription()
        ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(keyRes.key) });
      const saved = await fetch(API_ROOT + "push-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!saved.ok) throw new Error("The server couldn't save this device.");
      setState("on");
      setNote("Alerts are on for this device.");
    } catch (error) {
      setState("error");
      setNote(error instanceof Error ? error.message : "Couldn't turn on alerts.");
    }
  }

  async function disable() {
    setState("busy");
    try {
      const reg = await registration();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(API_ROOT + "push-unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
      setNote("");
    } catch {
      setState("error");
    }
  }

  async function test() {
    setNote("Sending a test alert…");
    const res = await fetch(API_ROOT + "push-test", { method: "POST" }).then((r) => r.json()).catch(() => null) as { sent?: number } | null;
    setNote(res?.sent ? `Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"}.` : "The test didn't reach any device.");
  }

  if (state === "checking" || state === "unsupported") return null;
  return (
    <span className="phone-alerts">
      {state === "install" && (
        <span className="badge" title="In Safari, tap Share, then Add to Home Screen. Open the app from the Home Screen and tap Phone alerts.">
          Add to Home Screen for alerts
        </span>
      )}
      {(state === "off" || state === "error") && (
        <button type="button" className="badge sound-toggle off" onClick={() => void enable()}>Phone alerts off</button>
      )}
      {state === "busy" && <span className="badge">Phone alerts…</span>}
      {state === "blocked" && (
        <span className="badge" title="Notifications are blocked for this app. Allow them in Settings → Notifications.">Alerts blocked</span>
      )}
      {state === "on" && (
        <>
          <button type="button" className="badge sound-toggle on" title="Turn off alerts on this device" onClick={() => void disable()}>Phone alerts on</button>
          <button type="button" className="badge" onClick={() => void test()}>Test</button>
        </>
      )}
      {note && <span className="phone-alerts-note" role="status">{note}</span>}
    </span>
  );
}
