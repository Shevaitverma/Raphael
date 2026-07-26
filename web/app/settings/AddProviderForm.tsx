"use client";

import { useState } from "react";
import type { Credential, NewCredential } from "@/lib/gateway";

export default function AddProviderForm({
  onAdd,
}: {
  onAdd: (cred: NewCredential) => Promise<void>;
}) {
  const [provider, setProvider] = useState<Credential["provider"]>("openai_compat");
  const [authType, setAuthType] = useState<"api_key" | "oauth">("api_key");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [activate, setActivate] = useState(false);
  const [saving, setSaving] = useState(false);

  const needsBaseUrl = provider === "openai_compat" || provider === "local";
  const oauthAllowed = provider === "anthropic";

  async function submit() {
    if (!modelId.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd({
        provider,
        auth_type: authType,
        api_key: apiKey || undefined,
        base_url: needsBaseUrl && baseUrl ? baseUrl : undefined,
        model_id: modelId.trim(),
        activate,
      });
      setModelId("");
      setBaseUrl("");
      setApiKey("");
      setActivate(false);
    } catch {
      /* error shown by parent */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-4 text-base font-semibold text-on-surface">
        Add a provider
      </h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-faint">Provider</span>
          <select
            value={provider}
            onChange={(e) => {
              const p = e.target.value as Credential["provider"];
              setProvider(p);
              if (p !== "anthropic" && authType === "oauth") setAuthType("api_key");
            }}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent"
          >
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="openai_compat">OpenRouter</option>
            <option value="local">Local (Ollama)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-faint">Auth</span>
          <select
            value={authType}
            onChange={(e) => setAuthType(e.target.value as "api_key" | "oauth")}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent"
          >
            <option value="api_key">API key</option>
            {oauthAllowed && <option value="oauth">OAuth (Claude subscription)</option>}
          </select>
        </label>

        <label className="col-span-2 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-faint">Model</span>
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder={
              provider === "anthropic"
                ? "claude-opus-4-8"
                : provider === "local"
                  ? "qwen2.5:7b"
                  : "meta-llama/llama-3.1-70b-instruct"
            }
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
          />
        </label>

        {needsBaseUrl && (
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-widest text-faint">
              Base URL {provider === "local" && "(blank = deployment default)"}
            </span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                provider === "local" ? "http://ollama:11434/v1" : "https://openrouter.ai/api/v1"
              }
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {authType === "api_key" && provider !== "local" && (
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-widest text-faint">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="stored encrypted; never shown again"
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        <label className="col-span-2 flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
          />
          Make this the active provider
        </label>
      </div>

      <button
        onClick={() => void submit()}
        disabled={saving || !modelId.trim()}
        className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
      >
        {saving ? "Adding…" : "Add provider"}
      </button>
    </div>
  );
}
