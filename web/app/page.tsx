"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Admin from "./Admin";
import Dashboard from "./Dashboard";
import MemoryGraph from "./MemoryGraph";
import Reminders from "./Reminders";
import Fitness from "./Fitness";
import Sidebar, { type View } from "./Sidebar";
import Tasks from "./Tasks";
import LoginScreen from "./LoginScreen";
import OnboardingScreen from "./OnboardingScreen";
import NotificationsBell from "./NotificationsBell";
import SettingsView from "./settings/SettingsView";
import ChatView from "./chat/ChatView";
import { DEV_EMAIL, detectedTz, TZ_SEEN, TZ_VALUE } from "./shared";
import {
  devLogin,
  fetchSession,
  getCapabilities,
  getProfile,
  googleLogin,
  isAuthError,
  logout,
  setTimezone,
  type User,
} from "@/lib/gateway";

const SEARCH_KEY = "raphael.search";
const VIEW_KEY = "raphael.view";
// Views a hard refresh may restore to. "admin" is intentionally excluded — it is
// role-gated, so restoring it for a non-admin would show an empty/forbidden panel.
const RESTORABLE_VIEWS: readonly View[] = ["dashboard", "chat", "graph", "settings", "tasks", "reminders", "fitness"];

// Dev-login is a local/dev convenience only. It shows in the UI solely when this
// build was compiled with NEXT_PUBLIC_DEV_AUTH=1; production builds omit the env
// var, so the dev button never renders and Google is the only door.
const DEV_AUTH = process.env.NEXT_PUBLIC_DEV_AUTH === "1";

export default function Page() {
  // JWT lives in memory only — never localStorage (product requirement).
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Shared failure banner: every view funnels its errors here through `failed`.
  // ChatView reads it (that is where the banner renders) and clears it.
  const [error, setError] = useState<string | null>(null);

  // Dashboard is the post-login/onboarding landing. The Google OAuth round-trip
  // still forces "settings" in its effect below.
  const [view, setView] = useState<View>("dashboard");

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

  // --- auth ------------------------------------------------------------------

  // Google Sign-In IS the login. googleLogin() navigates the browser to Google's
  // consent screen on success, so we only clear `loggingIn` on failure — a
  // success means we're already gone. The callback bounces back with ?login=ok
  // (handled by the effect below) or ?login=denied (uninvited — fail closed).
  async function handleGoogleLogin() {
    setLoggingIn(true);
    setAuthError(null);
    try {
      await googleLogin();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
      setLoggingIn(false);
    }
  }

  // Dev-only backdoor, gated to builds with NEXT_PUBLIC_DEV_AUTH=1. The response
  // carries the role the gateway assigned, so setUser is enough to drive the
  // admin-gated UI below.
  async function handleLogin() {
    setLoggingIn(true);
    setAuthError(null);
    try {
      const res = await devLogin(DEV_EMAIL);
      setToken(res.token);
      setUser(res.user);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoggingIn(false);
    }
  }

  const handleLogout = useCallback(() => {
    void logout(); // revoke the durable session server-side (best-effort)
    // Dropping the token renders LoginScreen, which unmounts ChatView — its
    // unmount cleanup aborts any in-flight stream and its state goes with it.
    setToken(null);
    setUser(null);
    setError(null);
    setAssistantName("Raphael");
    // The server flag is the source of truth; drop it so a re-login re-checks.
    setOnboarded(null);
  }, []);

  // Every /api call funnels its failure here. On a 401 the short-lived access JWT
  // has expired — before dropping to the login screen, try ONCE to mint a fresh
  // one from the durable session cookie (/auth/session). Success re-arms the
  // in-memory token (effects keyed on `token` re-fire and the view self-heals);
  // only when that ALSO fails is the durable session truly gone -> log out.
  // ponytail: refreshes the token, not the exact failed call; the token-keyed
  // effects re-run, so a read self-heals. Add per-call retry if a mutation must
  // survive an expiry mid-flight.
  // Single-flight the refresh: when the access JWT expires the whole dashboard
  // 401s at once; without this each failed call fires its own /auth/session and
  // the burst trips the rate limiter. Share one in-flight refresh instead.
  const refreshing = useRef<Promise<void> | null>(null);
  const failed = useCallback(
    (e: unknown) => {
      if (isAuthError(e)) {
        if (!refreshing.current) {
          refreshing.current = fetchSession()
            .then((s) => {
              setToken(s.token);
              setUser(s.user);
            })
            .catch(() => {
              handleLogout();
              setAuthError("Your session expired. Sign in again.");
            })
            .finally(() => {
              refreshing.current = null;
            });
        }
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    },
    [handleLogout],
  );

  // Handed to ChatView, which clears the banner on every successful chat call.
  // Stable identity matters: it sits in the dep list of ChatView's list/load
  // callbacks, and a new function each render would re-fire their effects.
  const clearError = useCallback(() => setError(null), []);

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

  // Session restore. Runs once on EVERY mount (fresh load, page refresh, or the
  // return from a Google/dev login), before a token exists, so it drives the
  // initial LoginScreen. The durable httpOnly session cookie is the credential:
  // /auth/session trades it for a fresh in-memory access JWT. A 401 means no
  // valid session -> stay on the login screen silently (this is the normal
  // logged-out case, not an error). ?login=denied (uninvited — fail closed) is
  // the one branch that shows a message instead of attempting a restore.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const login = params.get("login");
    const stripLogin = () => {
      if (!login) return;
      params.delete("login");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
      );
    };

    if (login === "denied") {
      setAuthError(
        "You're not on the invite list yet. Ask an admin to add your email, then sign in again.",
      );
      stripLogin();
      return;
    }

    fetchSession()
      .then((s) => {
        setToken(s.token);
        setUser(s.user); // s.user.role drives the admin-gated UI
      })
      .catch(() => {
        /* no valid session cookie — remain on the login screen */
      })
      .finally(stripLogin);
  }, []);

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
        onDevLogin={handleLogin}
        devAuth={DEV_AUTH}
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
    <div className="flex h-screen bg-surface font-sans text-on-surface">
      <Sidebar
        view={view}
        setView={setView}
        assistantName={assistantName}
        email={user?.email ?? user?.id ?? ""}
        role={user?.role}
        onLogout={handleLogout}
      />

      {/* Content column — sits to the RIGHT of the nav rail. For chat it holds
          its own [conversation list][thread] pair; everything else is one pane. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
      {/* In-app delivery feed — polls unread, marks read on open. REST, 0 tokens. */}
      <NotificationsBell token={token} onFail={failed} />
      {view === "dashboard" ? (
        <Dashboard token={token} onNavigate={setView} onFail={failed} />
      ) : view === "graph" ? (
        <MemoryGraph token={token} onNavigate={setView} onFail={failed} />
      ) : view === "tasks" ? (
        <Tasks token={token} onFail={failed} />
      ) : view === "reminders" ? (
        <Reminders token={token} onFail={failed} />
      ) : view === "fitness" ? (
        <Fitness token={token} onFail={failed} />
      ) : view === "settings" ? (
        <SettingsView
          token={token}
          assistantName={assistantName}
          onSaved={setAssistantName}
          onFail={failed}
          googleReload={googleReload}
          googleNotice={googleNotice}
        />
      ) : view === "admin" ? (
        // UI gate only — fail closed for non-admins. The gateway re-verifies role
        // server-side on every admin mutation, so a crafted view state buys nothing.
        user?.role === "admin" ? (
          <Admin token={token} onFail={failed} />
        ) : (
          <Dashboard token={token} onNavigate={setView} onFail={failed} />
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
          token={token}
          assistantName={assistantName}
          searchOn={searchOn}
          searchAvailable={searchAvailable}
          onToggleSearch={toggleSearch}
          error={error}
          onClearError={clearError}
          onFail={failed}
        />
      </div>
      </div>
    </div>
  );
}
