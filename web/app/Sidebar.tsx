"use client";

// The app's primary navigation: a fixed-width left rail, always visible once
// signed in. Groups its items under muted section labels and pins Settings +
// the account row to the bottom. Inline SVG icons — no icon dependency.

export type View = "dashboard" | "chat" | "graph" | "settings" | "tasks" | "reminders" | "admin";

type Item = { view: View; label: string; icon: React.ReactNode };

// Inline stroke icons (currentColor, ~18px). Kept trivial on purpose.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  chat: (
    <Icon>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Icon>
  ),
  knowledge: (
    <Icon>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.54Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.54Z" />
    </Icon>
  ),
  dashboard: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </Icon>
  ),
  tasks: (
    <Icon>
      <path d="m3 8 2 2 3-3" />
      <path d="m3 16 2 2 3-3" />
      <path d="M13 9h8" />
      <path d="M13 17h8" />
    </Icon>
  ),
  reminders: (
    <Icon>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  ),
  // Shield — the admin-only area (user management + system provider config).
  admin: (
    <Icon>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Icon>
  ),
} as const;

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Workspace",
    items: [
      { view: "chat", label: "Chat", icon: ICONS.chat },
      // The `graph` view is labelled "Knowledge" in the nav.
      { view: "graph", label: "Knowledge", icon: ICONS.knowledge },
    ],
  },
  {
    label: "Operate",
    items: [
      { view: "dashboard", label: "Dashboard", icon: ICONS.dashboard },
      { view: "tasks", label: "Tasks", icon: ICONS.tasks },
      { view: "reminders", label: "Reminders", icon: ICONS.reminders },
    ],
  },
];

function NavButton({
  item,
  active,
  onClick,
}: {
  item: Item;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
        active
          ? "bg-raised font-medium text-accent"
          : "text-muted hover:bg-raised/60 hover:text-on-surface"
      }`}
    >
      {item.icon}
      <span className="truncate">{item.label}</span>
    </button>
  );
}

export default function Sidebar({
  view,
  setView,
  assistantName,
  email,
  role,
  onLogout,
}: {
  view: View;
  setView: (v: View) => void;
  assistantName: string;
  email: string;
  // Optional + undefined-is-not-admin so a missing/unknown role fails closed
  // (nav hidden). The server still enforces via requireAdmin regardless.
  role?: "admin" | "member";
  onLogout: () => void;
}) {
  return (
    <nav
      aria-label="Primary"
      className="flex w-56 shrink-0 flex-col border-r border-edge bg-panel"
    >
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/15 text-sm font-semibold text-accent">
          {(assistantName.trim()[0] || "R").toUpperCase()}
        </span>
        <span className="text-base font-semibold tracking-tight text-on-surface">
          {assistantName.trim() || "Raphael"}
        </span>
      </div>

      {/* Groups */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-2">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <span className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">
              {g.label}
            </span>
            {g.items.map((item) => (
              <NavButton
                key={item.view}
                item={item}
                active={view === item.view}
                onClick={() => setView(item.view)}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Pinned bottom: Admin (admins only) + Settings + account */}
      <div className="flex flex-col gap-1 border-t border-edge px-2 py-2">
        {role === "admin" && (
          <NavButton
            item={{ view: "admin", label: "Admin", icon: ICONS.admin }}
            active={view === "admin"}
            onClick={() => setView("admin")}
          />
        )}
        <NavButton
          item={{ view: "settings", label: "Settings", icon: ICONS.settings }}
          active={view === "settings"}
          onClick={() => setView("settings")}
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pt-1">
          <span className="min-w-0 truncate text-xs text-muted" title={email}>
            {email}
          </span>
          <button
            onClick={onLogout}
            className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface"
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
