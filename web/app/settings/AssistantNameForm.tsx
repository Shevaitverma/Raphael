"use client";

import { useEffect, useState } from "react";
import { updateProfile } from "@/lib/gateway";
import { useAuthed } from "../auth/AuthProvider";

export default function AssistantNameForm({
  assistantName,
  onSaved,
}: {
  assistantName: string;
  onSaved: (name: string) => void;
}) {
  const { token } = useAuthed();
  const [name, setName] = useState(assistantName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Keep the field in step with the loaded/lifted name (the profile fetch may
  // land after this panel mounts, and a save lifts the canonical value back).
  useEffect(() => {
    setName(assistantName);
  }, [assistantName]);

  const trimmed = name.trim();
  const dirty = trimmed !== assistantName;

  async function save() {
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const p = await updateProfile(token, trimmed);
      onSaved(p.assistant_name); // lift so the chat UI updates without a reload
      setName(p.assistant_name);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-on-surface">
        Assistant name
      </h3>
      <p className="mb-4 text-sm text-muted">
        The name shown on the assistant&apos;s messages and in the composer.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-3 border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[11px] uppercase tracking-widest text-faint">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          maxLength={40}
          placeholder="Raphael"
          className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
        />
      </label>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving || !trimmed || !dirty}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && (
          <span role="status" className="text-xs text-muted">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}
