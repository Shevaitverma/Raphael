"use client";

import { useState } from "react";
import { updateProfile } from "@/lib/gateway";

// First-login screen: pick the assistant's name, then mark onboarding complete.
// Same flat card as LoginScreen. A blank name falls back to "Raphael" — the goal
// is to get the user in, not to block them on a field.
export default function OnboardingScreen({
  token,
  onDone,
}: {
  token: string;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState("Raphael");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const p = await updateProfile(token, name.trim() || "Raphael", { onboarded: true });
      onDone(p.assistant_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false); // stay put so they can retry — don't advance on failure
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-surface px-4 font-sans text-on-surface">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-edge bg-panel px-8 py-10">
        <div className="text-center">
          <h1 className="font-display text-3xl font-semibold tracking-wide text-accent">
            Welcome
          </h1>
          <p className="mt-2 text-sm text-muted">
            What would you like to call your assistant?
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
          >
            {error}
          </div>
        )}

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[11px] uppercase tracking-widest text-faint">
            Assistant name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            maxLength={40}
            placeholder="Raphael"
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
          />
        </label>

        <button
          onClick={() => void submit()}
          disabled={saving}
          className="w-full rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
