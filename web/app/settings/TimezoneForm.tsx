"use client";

import { useEffect, useMemo, useState } from "react";
import { setTimezone } from "@/lib/gateway";
import { detectedTz, TZ_SEEN, TZ_VALUE } from "../shared";

// Timezone picker: reminders fire in this IANA tz (evaluated server-side). The
// browser tz is auto-stamped on app-load; this row lets the user view/override.
// A native <select> from Intl.supportedValuesOf — no timezone dependency.
export default function TimezoneForm({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const detected = detectedTz();
  const [tz, setTz] = useState(detected);
  const [saved, setSaved] = useState(detected);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  // localStorage is client-only; hydrate the last-sent value in an effect. This
  // is the picker's source of truth since the server exposes no tz getter.
  useEffect(() => {
    const v = localStorage.getItem(TZ_VALUE) ?? detected;
    setTz(v);
    setSaved(v);
  }, [detected]);

  const zones = useMemo<string[]>(() => {
    // Native IANA list (ladder: platform feature over a tz library). Not yet in
    // every TS lib target, so probe it; fall back to just the current value.
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    const list = typeof f === "function" ? f("timeZone") : [];
    return list.includes(tz) ? list : [tz, ...list];
  }, [tz]);

  async function save() {
    if (busy || tz === saved) return;
    setBusy(true);
    setOk(false);
    try {
      await setTimezone(token, tz);
      localStorage.setItem(TZ_VALUE, tz);
      // Mark this browser reconciled so app-load auto-detect won't overwrite the
      // manual choice on the next load.
      localStorage.setItem(TZ_SEEN, detected);
      setSaved(tz);
      setOk(true);
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-on-surface">Timezone</h3>
      <p className="mb-4 text-sm text-muted">
        Reminders fire in this timezone. Detected from your browser as{" "}
        <span className="font-medium text-on-surface">{detected}</span>.
      </p>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[11px] uppercase tracking-widest text-faint">
          IANA timezone
        </span>
        <select
          value={tz}
          onChange={(e) => {
            setTz(e.target.value);
            setOk(false);
          }}
          className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy || tz === saved}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {ok && tz === saved && (
          <span role="status" className="text-xs text-muted">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}
