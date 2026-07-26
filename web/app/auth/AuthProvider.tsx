"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { DEV_EMAIL } from "../shared";
import {
  devLogin,
  fetchSession,
  googleLogin,
  isAuthError,
  logout,
  type User,
} from "@/lib/gateway";

// Dev-login is a local/dev convenience only. It shows in the UI solely when this
// build was compiled with NEXT_PUBLIC_DEV_AUTH=1; production builds omit the env
// var, so the dev button never renders and Google is the only door.
const DEV_AUTH = process.env.NEXT_PUBLIC_DEV_AUTH === "1";

type Auth = {
  token: string | null;
  user: User | null;
  authError: string | null;
  setAuthError: (msg: string | null) => void;
  loggingIn: boolean;
  devAuth: boolean;
  // Shared failure banner: every view funnels its errors here through `failed`.
  // ChatView reads it (that is where the banner renders) and clears it.
  error: string | null;
  clearError: () => void;
  failed: (e: unknown) => void;
  handleGoogleLogin: () => Promise<void>;
  handleLogin: () => Promise<void>;
  handleLogout: () => void;
};

const AuthCtx = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const v = useContext(AuthCtx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

// Same context, but `token` typed non-null — for the views that only ever render
// once a token exists (the shell gates them behind `if (!token) <LoginScreen/>`).
export function useAuthed(): Auth & { token: string } {
  const a = useAuth();
  return { ...a, token: a.token as string };
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  // JWT lives in memory only — never localStorage (product requirement).
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // admin-gated UI.
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
    // The shell resets its own profile state off the same `token -> null`.
    setToken(null);
    setUser(null);
    setError(null);
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

  return (
    <AuthCtx.Provider
      value={{
        token,
        user,
        authError,
        setAuthError,
        loggingIn,
        devAuth: DEV_AUTH,
        error,
        clearError,
        failed,
        handleGoogleLogin,
        handleLogin,
        handleLogout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
