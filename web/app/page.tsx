"use client";

import { useEffect, useState } from "react";
import Admin from "./Admin";
import Dashboard from "./Dashboard";
import MemoryGraph from "./MemoryGraph";
import Reminders from "./Reminders";
import Fitness from "./Fitness";
import Sidebar, { VIEW_LABELS, type View } from "./Sidebar";
import Tasks from "./Tasks";
import LoginScreen from "./LoginScreen";
import OnboardingScreen from "./OnboardingScreen";
import NotificationsBell from "./NotificationsBell";
import SettingsView from "./settings/SettingsView";
import ChatView from "./chat/ChatView";
import { useAuth } from "./auth/AuthProvider";
import { detectedTz, TZ_SEEN, TZ_VALUE } from "./shared";
import { getCapabilities, getProfile, setTimezone } from "@/lib/gateway";

const SEARCH_KEY = "raphael.search";
const VIEW_KEY = "raphael.view";
// Views a hard refresh may restore to. "admin" is intentionally excluded — it is
// role-gated, so restoring it for a non-admin would show an empty/forbidden panel.
const RESTORABLE_VIEWS: readonly View[] = ["dashboard", "chat", "graph", "settings", "tasks", "reminders", "fitness"];

export default function Page() {
  // Auth lives in AuthProvider; the shell only reads it and decides what to render.
  const {
    token,
    user,
    authError,
    loggingIn,
    error,
    clearError,
    failed,
    handleGoogleLogin,
    handleLogout,
  } = useAuth();

  // Dashboard is the post-login/onboarding landing. The Google OAuth round-trip
  // still forces "settings" in its effect below.
  const [view, setView] = useState<View>("dashboard");

  // Nav drawer, phone only (the rail is persistent from `md:` up, where this is
  // ignored). Layout state, so it deliberately does not persist across reloads.
  const [navOpen, setNavOpen] = useState(false);

  // Result of a Google OAuth round-trip (the gateway redirects back with
  // ?google=connected|error). `googleReload` bumps to re-fetch the connection
  // status after a successful connect.
  const [googleNotice, setGoogleNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [googleReload, setGoogleReload] = useState(0);

  // Display-only assistant name. Defaults to the product name until the profile
  // loads; the system-prompt name is set server-side and never sent from here.
  const [assistantName, setAssistantName] = useState("Raphael");

  // null = not yet known (profile still loading / failed). We only show the
  // onboarding screen once we KNOW it's false, so it never flashes on load and
  // a failed profile fetch fails open (stays null → straight into the app).
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  // The toggle is the only gate on search, so it must survive a reload — but a
  // sticky true means nothing if this deployment has no search key, hence both
  // flags. searchOn, never `search` alone, is what reaches the wire.
  const [search, setSearch] = useState(false);
  const [searchAvailable, setSearchAvailable] = useState(false);
  const searchOn = search && searchAvailable;

  // Losing the token (sign-out button, or a session refresh that failed) is what
  // used to be reset inline inside handleLogout. Auth moved to AuthProvider, so
  // the shell's own profile state resets off the same signal: back to the default
  // name, and drop the onboarded flag so a re-login re-checks the server (the
  // server flag is the source of truth). Nothing renders either while token is
  // null — LoginScreen shows — so doing it in an effect is invisible.
  useEffect(() => {
    if (token) return;
    setAssistantName("Raphael");
    setOnboarded(null);
  }, [token]);

  // --- search toggle ---------------------------------------------------------

  // localStorage does not exist during the server render, so read it in an
  // effect rather than a useState initializer.
  useEffect(() => {
    setSearch(localStorage.getItem(SEARCH_KEY) === "1");
  }, []);

  // Restore the last-viewed tab across a hard refresh (localStorage, client-only).
  // Runs once on mount; the persist effect below writes it on every change.
  useEffect(() => {
    const saved = localStorage.getItem(VIEW_KEY) as View | null;
    if (saved && RESTORABLE_VIEWS.includes(saved)) setView(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // The gateway redirects the browser back here after Google consent. Read the
  // result once, open Settings so it's visible, then strip the query param via
  // replaceState so a reload doesn't re-fire the notice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (!g) return;
    if (g === "connected") {
      setGoogleNotice({ ok: true, msg: "Google connected." });
      setGoogleReload((n) => n + 1); // re-fetch status in Settings
    } else {
      setGoogleNotice({ ok: false, msg: "Google connection failed. Please try again." });
    }
    setView("settings");
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, []);

  // A checkbox that silently does nothing is the invisible failure this whole
  // feature must not have. No key -> no toggle, with the reason said out loud.
  useEffect(() => {
    if (!token) return;
    let live = true;
    getCapabilities(token)
      .then((c) => live && setSearchAvailable(c.web_search))
      .catch(() => live && setSearchAvailable(false));
    return () => {
      live = false;
    };
  }, [token]);

  // Load the display name + onboarding flag once signed in. A failure keeps the
  // "Raphael" default, surfaces through the same banner as everything else, and
  // fails OPEN on the onboarding gate: marking onboarded true lets the user into
  // the app rather than stranding them on a naming screen that never loaded.
  useEffect(() => {
    if (!token) return;
    let live = true;
    getProfile(token)
      .then((p) => {
        if (!live) return;
        if (p.assistant_name) setAssistantName(p.assistant_name);
        setOnboarded(p.onboarded);
      })
      .catch((e) => {
        if (!live) return;
        setOnboarded(true); // fail open — never lock someone out of their app
        failed(e);
      });
    return () => {
      live = false;
    };
  }, [token, failed]);

  // Auto-stamp the browser timezone so reminders fire in the right zone. Cron is
  // evaluated in users.timezone server-side; the model never sets it. The guard
  // sends the PUT only when this browser's tz differs from the one we last
  // stamped — skipping redundant writes AND leaving a manual Settings choice
  // untouched unless the browser's own tz actually changed (e.g. travel).
  useEffect(() => {
    if (!token) return;
    const tz = detectedTz();
    if (localStorage.getItem(TZ_SEEN) === tz) return;
    setTimezone(token, tz)
      .then(() => {
        localStorage.setItem(TZ_SEEN, tz);
        localStorage.setItem(TZ_VALUE, tz);
      })
      .catch(failed);
  }, [token, failed]);

  function toggleSearch(on: boolean) {
    setSearch(on);
    localStorage.setItem(SEARCH_KEY, on ? "1" : "0");
  }

  // --- render ----------------------------------------------------------------

  if (!token) {
    return (
      <LoginScreen
        onGoogleLogin={handleGoogleLogin}
        loading={loggingIn}
        error={authError}
      />
    );
  }

  // Only once we KNOW onboarding is incomplete — never while it's still unknown.
  if (onboarded === false) {
    return (
      <OnboardingScreen
        token={token}
        onDone={(name) => {
          setAssistantName(name);
          setOnboarded(true);
        }}
      />
    );
  }

  return (
    // h-dvh, not h-screen: 100vh is the *largest* viewport on mobile Safari, so
    // the shell's bottom row sits under the browser chrome until you scroll.
    <div className="flex h-dvh bg-surface font-sans text-on-surface">
      <Sidebar
        view={view}
        setView={setView}
        assistantName={assistantName}
        email={user?.email ?? user?.id ?? ""}
        role={user?.role}
        onLogout={handleLogout}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      {/* Content column — sits to the RIGHT of the nav rail (below `md:` the rail
          is off-canvas and this is the whole width). For chat it holds its own
          [conversation list][thread] pair; everything else is one pane.
          min-w-0: a flex child defaults to min-width:auto and refuses to shrink
          below its content — that is what makes the whole page scroll sideways. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
      {/* Phone-only top bar: opens the nav drawer and names the current view.
          pr-16 keeps the title clear of NotificationsBell, which absolutely
          positions itself at this column's top-right and lands inside the bar. */}
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-edge bg-panel pr-16 pt-safe md:hidden">
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
          aria-expanded={navOpen}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-on-surface"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">
          {VIEW_LABELS[view]}
        </h1>
      </header>

      {/* In-app delivery feed — polls unread, marks read on open. REST, 0 tokens. */}
      <NotificationsBell />
      {view === "dashboard" ? (
        <Dashboard onNavigate={setView} />
      ) : view === "graph" ? (
        <MemoryGraph onNavigate={setView} />
      ) : view === "tasks" ? (
        <Tasks />
      ) : view === "reminders" ? (
        <Reminders />
      ) : view === "fitness" ? (
        <Fitness />
      ) : view === "settings" ? (
        <SettingsView
          assistantName={assistantName}
          onSaved={setAssistantName}
          googleReload={googleReload}
          googleNotice={googleNotice}
        />
      ) : view === "admin" ? (
        // UI gate only — fail closed for non-admins. The gateway re-verifies role
        // server-side on every admin mutation, so a crafted view state buys nothing.
        user?.role === "admin" ? (
          <Admin />
        ) : (
          <Dashboard onNavigate={setView} />
        )
      ) : null}
      {/* Chat stays MOUNTED on every tab, hidden with CSS rather than unmounted.
          Its state (selected conversation, loaded messages) and any in-flight SSE
          stream live inside ChatView now, so unmounting on a tab switch would drop
          the thread and abort a reply mid-sentence — it did not before the split.
          `contents` makes this wrapper vanish from layout when visible, so
          ChatView's root stays a direct flex child of the content column. */}
      <div className={view === "chat" ? "contents" : "hidden"}>
        <ChatView
          assistantName={assistantName}
          searchOn={searchOn}
          searchAvailable={searchAvailable}
          onToggleSearch={toggleSearch}
          error={error}
          onClearError={clearError}
        />
      </div>
      </div>
    </div>
  );
}
