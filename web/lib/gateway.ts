// Thin client for the Raphael gateway. No secrets live here — the JWT is passed
// in from component state (held in memory), never read from localStorage.

// Default to "" = RELATIVE, same-origin URLs (e.g. "/api/…", "/auth/…"). Next
// reverse-proxies those to the gateway (see next.config.mjs rewrites), so the
// browser only ever talks to its own origin — which is what makes this work over
// a tunnel. Set NEXT_PUBLIC_GATEWAY_URL to an absolute URL only to bypass the
// proxy (not needed for local or tunnelled dev). Note: an empty .env value reads
// as undefined here, so the "" default is what actually applies.
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || "";

export type User = {
  id: string;
  email?: string;
  name?: string;
  // Set at Google sign-in. Admins see the Admin area; the server
  // re-checks role on every privileged mutation, so this claim is UI-only.
  role?: "admin" | "member";
  // Only present in the admin listUsers() unified list: "active" = a real users
  // row (with last_active), "pending" = an allowed_emails invite not signed up yet.
  status?: "active" | "pending";
  last_active?: string | null;
};

// The result of the one-time cookie handoff after a Google callback: the gateway
// stashed the JWT behind a short-lived cookie and /auth/session trades it for the
// token + who you are. `role` may arrive top-level or inside `user`; fold it in.
export type Session = {
  token: string;
  user: User;
};

export type Conversation = {
  id: string;
  title?: string;
  created_at?: string;
};

export type Message = {
  id?: string;
  conversation_id?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at?: string;
  // Answer provenance, stored server-side so a reload renders the same banner
  // and model label the live SSE stream did (see Degraded/Done below).
  answered_model?: string | null;
  answered_provider?: string | null;
  degraded?: boolean;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
};

// --- Degraded / error metadata surfaced from the SSE stream ------------------

export type Degraded = {
  reason: string;
  provider: string;
  model: string;
};

export type Done = {
  provider?: string;
  model?: string;
  message_id?: string;
  // Per-turn token cost. Present only when the server knows it; absent/null when
  // unknown — never a fabricated 0. The UI shows the footnote only when set.
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
};

// A reloaded message stores provenance as `degraded` (boolean) + `answered_model` +
// `answered_provider`, while the live SSE stream carries a full Degraded object.
// Rebuild that same shape from stored state so a reload renders the identical warning
// banner — a lifeboat answer must never look like a normal one just because the page
// was refreshed. answered_provider falls back to "local" only for pre-016 rows that
// never persisted it; the lifeboat is admin-configurable and not local-only.
export function storedDegraded(m: Message): Degraded | undefined {
  return m.degraded
    ? { reason: "", provider: m.answered_provider ?? "local", model: m.answered_model ?? "" }
    : undefined;
}

// --- errors ------------------------------------------------------------------

// A failed API call, carrying the HTTP status so callers can tell an expired
// session apart from a service that is merely down.
export class ApiError extends Error {
  // A plain field, not a constructor parameter property: node's strip-only
  // type stripping (how `npm test` runs) rejects those.
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// A 401 on /api/* means the JWT expired (it is minted with a 24h TTL) — the
// session is over and nothing but a fresh login will fix it.
export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

// --- REST calls --------------------------------------------------------------

// Real logout: revokes the durable session server-side and clears the cookie.
// Best-effort — the SPA wipes its in-memory token regardless, so a network blip
// never strands the user "logged in" client-side.
export async function logout(): Promise<void> {
  try {
    await fetch(`${GATEWAY_URL}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    /* ignore — in-memory state is wiped by the caller either way */
  }
}

// --- auth: Google sign-in + session handoff ----------------------------------

// Google Sign-In is the login itself. Ask the gateway for the consent URL (no auth
// header — you aren't logged in yet), then navigate the browser to it. Mirrors
// connectGoogle, minus the token. On return the gateway sets a handoff cookie and
// bounces back to the app, where fetchSession() trades it for a JWT.
export async function googleLogin(): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/auth/google/login`);
  if (!res.ok) throw new ApiError(await errText(res, "google login"), res.status);
  const { auth_url } = await res.json();
  window.location.href = auth_url;
}

// Trades the one-time handoff cookie (credentials:'include') for the JWT and the
// signed-in user. A 401 means no valid handoff cookie — not signed in.
export async function fetchSession(): Promise<Session> {
  const res = await fetch(`${GATEWAY_URL}/auth/session`, {
    credentials: "include",
  });
  if (!res.ok) throw new ApiError(await errText(res, "session"), res.status);
  const d = await res.json();
  const user: User = d.user ?? {};
  // role may be top-level or already on the user object; top-level wins.
  if (d.role !== undefined) user.role = d.role;
  return { token: d.token, user };
}

export async function listConversations(token: string): Promise<Conversation[]> {
  const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
    headers: authHeader(token),
  });
  if (!res.ok) {
    throw new ApiError(`list conversations failed: ${res.status}`, res.status);
  }
  const data = await res.json();
  // Gateway may return a bare array or {conversations:[...]}.
  return Array.isArray(data) ? data : (data.conversations ?? []);
}

export async function createConversation(
  token: string,
  title?: string,
): Promise<Conversation> {
  const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ title: title ?? "New conversation" }),
  });
  if (!res.ok) {
    throw new ApiError(`create conversation failed: ${res.status}`, res.status);
  }
  return res.json();
}

export async function listMessages(
  token: string,
  conversationId: string,
): Promise<Message[]> {
  const res = await fetch(
    `${GATEWAY_URL}/api/conversations/${conversationId}/messages`,
    { headers: authHeader(token) },
  );
  if (!res.ok) {
    throw new ApiError(`list messages failed: ${res.status}`, res.status);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.messages ?? []);
}

export async function deleteConversation(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/conversations/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete conversation"), res.status);
}

// --- provider credentials ----------------------------------------------------

export type Credential = {
  id: string;
  provider: "anthropic" | "openai_compat" | "local";
  auth_type: "api_key" | "oauth";
  base_url?: string | null;
  model_id: string;
  is_active: boolean;
  is_lifeboat: boolean;
  created_at?: string;
};

export type NewCredential = {
  provider: string;
  auth_type: string;
  api_key?: string;
  base_url?: string | null;
  model_id: string;
  activate: boolean;
};

export async function listProviders(token: string): Promise<Credential[]> {
  const res = await fetch(`${GATEWAY_URL}/api/providers`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list providers failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.credentials ?? []);
}

export async function addProvider(token: string, cred: NewCredential): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(cred),
  });
  if (!res.ok) throw new ApiError(await errText(res, "add provider"), res.status);
  return res.json();
}

export async function activateProvider(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers/${id}/activate`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "activate"), res.status);
  return res.json();
}

export async function setLifeboat(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers/${id}/lifeboat`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "set lifeboat"), res.status);
  return res.json();
}

export async function clearLifeboat(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers/${id}/lifeboat`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "clear lifeboat"), res.status);
  return res.json();
}

// --- tasks --------------------------------------------------------------------
// A kanban board, three columns keyed by status. Same fetch/ApiError/
// authHeader shape as the provider calls above.

export type Task = {
  id: string;
  title: string;
  notes: string;
  status: "open" | "in_progress" | "done";
  due_date: string | null; // "YYYY-MM-DD"
  priority: "none" | "low" | "medium" | "high";
  position: number;
  created_at?: string;
  updated_at?: string;
};

export async function getTasks(token: string): Promise<Task[]> {
  const res = await fetch(`${GATEWAY_URL}/api/tasks`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list tasks failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.tasks ?? []);
}

export async function createTask(
  token: string,
  task: { title: string; notes?: string; due_date?: string | null; priority?: Task["priority"] },
): Promise<Task> {
  const res = await fetch(`${GATEWAY_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(task),
  });
  if (!res.ok) throw new ApiError(await errText(res, "create task"), res.status);
  return res.json();
}

export async function updateTask(
  token: string,
  id: string,
  patch: Partial<Pick<Task, "title" | "notes" | "status" | "due_date" | "priority" | "position">>,
): Promise<Task> {
  const res = await fetch(`${GATEWAY_URL}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(await errText(res, "update task"), res.status);
  return res.json();
}

export async function deleteTask(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/tasks/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete task"), res.status);
}

// --- reminders + notifications ------------------------------------------------
// Per-user reminders (like tasks). kind='once' fires at fire_at; kind='cron'
// recurs on a 5-field cron string, optionally bounded by `until`. The server
// force-stamps timezone from users.timezone and computes next_fire — the client
// never sends either (see setTimezone). Same fetch/ApiError/authHeader shape as
// the tasks calls above. Firing writes a notification row (the delivery sink).

export type Reminder = {
  id: string;
  text: string; // what to be reminded about, e.g. "drink water"
  kind: "once" | "cron";
  cron: string | null; // 5-field cron when kind='cron'
  fire_at: string | null; // RFC3339 when kind='once'
  until: string | null; // RFC3339 bound; closes the "today only" case
  next_fire: string | null; // server-computed poll key; null once deactivated
  timezone: string; // IANA, force-stamped server-side
  active: boolean;
  created_at?: string;
};

export type Notification = {
  id: string;
  reminder_id: string | null;
  content: string;
  read: boolean;
  created_at?: string;
};

export async function getReminders(token: string): Promise<Reminder[]> {
  const res = await fetch(`${GATEWAY_URL}/api/reminders`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list reminders failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.reminders ?? []);
}

export async function createReminder(
  token: string,
  reminder: {
    text: string;
    kind: "once" | "cron";
    cron?: string | null;
    fire_at?: string | null;
    until?: string | null;
  },
): Promise<Reminder> {
  const res = await fetch(`${GATEWAY_URL}/api/reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(reminder),
  });
  if (!res.ok) throw new ApiError(await errText(res, "create reminder"), res.status);
  return res.json();
}

export async function setReminderActive(
  token: string,
  id: string,
  active: boolean,
): Promise<Reminder> {
  const res = await fetch(`${GATEWAY_URL}/api/reminders/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ active }),
  });
  if (!res.ok) throw new ApiError(await errText(res, "update reminder"), res.status);
  return res.json();
}

export async function deleteReminder(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/reminders/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete reminder"), res.status);
}

// The in-app delivery feed. The bell polls this (unread=1 for the badge) and
// PATCHes mark-read; both hit REST directly — zero tokens.
export async function getNotifications(
  token: string,
  opts?: { unread?: boolean },
): Promise<Notification[]> {
  const q = opts?.unread ? "?unread=1" : "";
  const res = await fetch(`${GATEWAY_URL}/api/notifications${q}`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list notifications failed: ${res.status}`, res.status);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.notifications ?? []);
  // Server emits {text, read_at}; the client shape is {content, read}. Map here so
  // bodies render and the bell gets a real read flag (client-side unread filtering
  // works even before a server-side read_at filter lands).
  return rows.map((r: { id: string; reminder_id: string | null; text: string; read_at: string | null; created_at?: string }) => ({
    id: r.id,
    reminder_id: r.reminder_id,
    content: r.text,
    read: r.read_at != null,
    created_at: r.created_at,
  }));
}

export async function markNotificationRead(token: string, id: string): Promise<Notification> {
  const res = await fetch(`${GATEWAY_URL}/api/notifications/${id}/read`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ read: true }),
  });
  if (!res.ok) throw new ApiError(await errText(res, "mark notification read"), res.status);
  return res.json();
}

// Force-stamped onto reminders server-side (cron is evaluated in this tz). The web
// auto-detects Intl.DateTimeFormat().resolvedOptions().timeZone and saves it, and a
// Settings picker changes it. The model never sets tz.
export async function setTimezone(token: string, timezone: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/timezone`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ timezone }),
  });
  if (!res.ok) throw new ApiError(await errText(res, "save timezone"), res.status);
}

// --- fitness ------------------------------------------------------------------
// Per-user workouts + body metrics (same fetch/ApiError/authHeader shape as the
// reminders calls above). performed_on / recorded_on are dates; the server owns
// created_at. stats is a small server-computed rollup for the overview tiles.

// One line of a workout — the server stores these as a jsonb array. All fields
// but name are optional; the model fills whatever the NL implied.
export type Exercise = {
  name: string;
  sets?: number | null;
  reps?: number | null;
  weight_kg?: number | null;
  duration_min?: number | null;
  distance_km?: number | null;
};

export type Workout = {
  id: string;
  category: string | null;
  title: string;
  duration_min: number | null;
  calories: number | null;
  distance_km: number | null;
  pace_min_km: number | null;
  avg_heart_rate: number | null;
  perceived_effort: number | null; // RPE 1..10
  exercises: Exercise[];
  mood: string | null;
  location: string | null;
  notes: string | null;
  performed_on: string | null;
  created_at?: string;
};

export type Metric = {
  id: string;
  metric_type: string;
  value: number;
  unit: string | null;
  notes: string | null;
  recorded_on: string | null;
  created_at?: string;
};

export type FitnessStats = {
  workouts_this_week: number;
  streak_days: number;
  longest_streak: number;
  total_workouts: number;
  avg_per_week: number; // 12-wk count / 12
  avg_duration_min: number; // avg of duration_min>0
  latest_weight: { value: number; unit: string; recorded_on: string } | null;
  weight_trend_30d: number | null; // latest weight minus most-recent >30d weight
  weekly: { week_start: string; count: number }[]; // last 12 ISO weeks, oldest→newest
  by_category: { category: string; count: number }[];
};

// weight/height come from the latest metric of each type; missing either → null bmi.
export type Bmi =
  | { bmi: number; category: "underweight" | "normal" | "overweight" | "obese"; weight_kg: number; height_cm: number }
  | { bmi: null; reason: string };

// A fitness goal. progress_pct is server-computed (direction-aware), 0..1.
export type Goal = {
  id: string;
  goal_type: "frequency" | "metric_target" | "streak" | "duration";
  title: string;
  target_value: number;
  target_unit: string | null;
  metric_type: string | null;
  category: string | null;
  direction: "gte" | "lte" | "eq";
  deadline: string | null; // "YYYY-MM-DD"
  status: "active" | "achieved" | "abandoned";
  starting_value: number | null;
  current_value: number | null;
  progress_pct: number; // 0..1
  notes: string | null;
  created_at?: string;
};

export type Meal = {
  id: string;
  meal_type: string | null;
  items_text: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  water_ml: number | null;
  notes: string | null;
  logged_on: string | null;
  logged_at?: string;
};

export type NutritionStats = {
  today: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; water_ml: number };
  week_avg: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
  targets: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number; water_ml?: number };
  meals_today: number;
};

export type FitnessConfig = {
  enabled: boolean;
  checkin_time: string; // "HH:MM"
  workout_split: Record<string, unknown>;
  rest_days: unknown[];
  daily_macro_targets: Record<string, number>;
  last_checkin_at: string | null;
  last_weekly_at: string | null;
};

export async function getWorkouts(token: string): Promise<Workout[]> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/workouts`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list workouts failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.workouts ?? []);
}

export async function createWorkout(
  token: string,
  w: {
    title: string;
    category?: string;
    duration_min?: number | null;
    calories?: number | null;
    distance_km?: number | null;
    pace_min_km?: number | null;
    avg_heart_rate?: number | null;
    perceived_effort?: number | null;
    exercises?: Exercise[];
    mood?: string;
    location?: string;
    notes?: string;
    performed_on?: string;
  },
): Promise<Workout> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/workouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(w),
  });
  if (!res.ok) throw new ApiError(await errText(res, "create workout"), res.status);
  return res.json();
}

export async function deleteWorkout(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/workouts/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete workout"), res.status);
}

export async function getMetrics(token: string, type?: string): Promise<Metric[]> {
  const q = type ? `?type=${encodeURIComponent(type)}` : "";
  const res = await fetch(`${GATEWAY_URL}/api/fitness/metrics${q}`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list metrics failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.metrics ?? []);
}

export async function createMetric(
  token: string,
  m: {
    metric_type: string;
    value: number;
    unit?: string;
    notes?: string;
    recorded_on?: string;
  },
): Promise<Metric> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(m),
  });
  if (!res.ok) throw new ApiError(await errText(res, "create metric"), res.status);
  return res.json();
}

export async function deleteMetric(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/metrics/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete metric"), res.status);
}

export async function getFitnessStats(token: string): Promise<FitnessStats> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/stats`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`fitness stats failed: ${res.status}`, res.status);
  return res.json();
}

// --- fitness v2: bmi, goals, nutrition, config --------------------------------
// Same fetch/ApiError/authHeader shape as the v1 fitness calls. All routed under
// /api/fitness/*; the gateway forces uid from the JWT.

export async function getBmi(token: string): Promise<Bmi> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/bmi`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`bmi failed: ${res.status}`, res.status);
  return res.json();
}

export async function getGoals(token: string): Promise<Goal[]> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/goals`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list goals failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.goals ?? []);
}

export async function createGoal(
  token: string,
  g: {
    goal_type: Goal["goal_type"];
    title: string;
    target_value: number;
    target_unit?: string;
    metric_type?: string;
    category?: string;
    direction?: Goal["direction"];
    starting_value?: number | null;
    deadline?: string | null;
  },
): Promise<Goal> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(g),
  });
  if (!res.ok) throw new ApiError(await errText(res, "create goal"), res.status);
  return res.json();
}

export async function updateGoal(
  token: string,
  id: string,
  patch: Partial<Pick<Goal, "title" | "target_value" | "target_unit" | "direction" | "starting_value" | "deadline" | "status" | "category" | "metric_type">>,
): Promise<Goal> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/goals/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(await errText(res, "update goal"), res.status);
  return res.json();
}

export async function deleteGoal(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/goals/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete goal"), res.status);
}

export async function getMeals(
  token: string,
  opts?: { date_from?: string; date_to?: string },
): Promise<Meal[]> {
  const q = new URLSearchParams();
  if (opts?.date_from) q.set("date_from", opts.date_from);
  if (opts?.date_to) q.set("date_to", opts.date_to);
  const qs = q.toString();
  const res = await fetch(`${GATEWAY_URL}/api/fitness/nutrition${qs ? `?${qs}` : ""}`, {
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(`list meals failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.meals ?? []);
}

export async function createMeal(
  token: string,
  m: {
    items_text: string;
    meal_type?: string;
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    fiber_g?: number | null;
    water_ml?: number | null;
    notes?: string;
    logged_on?: string;
  },
): Promise<Meal> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/nutrition`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(m),
  });
  if (!res.ok) throw new ApiError(await errText(res, "create meal"), res.status);
  return res.json();
}

export async function deleteMeal(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/nutrition/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete meal"), res.status);
}

export async function getNutritionStats(token: string): Promise<NutritionStats> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/nutrition/stats`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`nutrition stats failed: ${res.status}`, res.status);
  return res.json();
}

export async function getFitnessConfig(token: string): Promise<FitnessConfig> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/config`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`fitness config failed: ${res.status}`, res.status);
  return res.json();
}

export async function putFitnessConfig(
  token: string,
  patch: Partial<Pick<FitnessConfig, "enabled" | "checkin_time" | "workout_split" | "rest_days" | "daily_macro_targets">>,
): Promise<FitnessConfig> {
  const res = await fetch(`${GATEWAY_URL}/api/fitness/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(await errText(res, "save fitness config"), res.status);
  return res.json();
}

// --- profile (display-only assistant name) -----------------------------------

export type Profile = { assistant_name: string; onboarded: boolean };

export async function getProfile(token: string): Promise<Profile> {
  const res = await fetch(`${GATEWAY_URL}/api/profile`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`get profile failed: ${res.status}`, res.status);
  return res.json();
}

// `onboarded` is sent only when opts.onboarded is given, so Settings (which omits
// it) leaves the server flag untouched while onboarding can set it true.
export async function updateProfile(
  token: string,
  assistantName: string,
  opts?: { onboarded?: boolean },
): Promise<Profile> {
  const body: { assistant_name: string; onboarded?: boolean } = {
    assistant_name: assistantName,
  };
  if (opts?.onboarded !== undefined) body.onboarded = opts.onboarded;
  const res = await fetch(`${GATEWAY_URL}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await errText(res, "save name"), res.status);
  return res.json();
}

// --- capabilities ------------------------------------------------------------

export type Capabilities = {
  provider: string;
  model: string;
  max_context_tokens?: number;
  // How the gateway knows the model/context window: "discovered" (asked the
  // provider), "static" (from a lookup table), or "default" (a fallback guess).
  source?: string;
  web_search: boolean;
  google_connected?: boolean;
};

export async function getCapabilities(token: string): Promise<Capabilities> {
  const res = await fetch(`${GATEWAY_URL}/api/capabilities`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`capabilities failed: ${res.status}`, res.status);
  return res.json();
}

// --- memory: knowledge graph + stats -----------------------------------------
// Both routes are read-only projections of what Raphael has learned. Same
// fetch/ApiError/authHeader shape as getCapabilities.

export type GraphNode = {
  id: string;
  label: string;
  kind: "identity" | "entity";
  degree: number;
};

export type GraphEdge = {
  // The facts row id — the only stable per-edge handle, and the only safe unit
  // of deletion (a node id is normalized text shared by many facts).
  // OPTIONAL on purpose: a server that predates the governance API sends no id.
  // Such an edge is still shown (it is a real belief) but cannot be forgotten,
  // so every delete path must check for it rather than assume it exists.
  id?: string;
  source: string;
  target: string;
  label: string;
  confidence: number;
  times_seen: number;
  // How often this fact was recalled INTO a prompt. 0 = no recorded recalls.
  // UNDEFINED = the server didn't report the field (older build) — that is
  // "unknown", not zero, and the UI must not render it as "never recalled".
  access_count?: number;
  first_seen?: string;
  last_seen?: string;
};

export type GraphNote = {
  id: string;
  content: string;
  confidence: number;
  last_seen?: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes: GraphNote[];
  truncated: boolean;
};

export type TopFact = {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  times_seen: number;
  last_seen?: string;
};

export type MemoryStats = {
  facts: number;
  episodic: number;
  conversations: number;
  top_facts: TopFact[];
  activity: { day: string; count: number }[];
  truncated: boolean;
};

// Per-edge validation at the boundary, so no component downstream has to guess
// whether a missing number means 0 or "the server never said". Numbers stay
// undefined when absent; only the required identity/shape fields are enforced.
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function toEdge(raw: unknown): GraphEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = str(e.id);
  const source = str(e.source);
  const target = str(e.target);
  const label = str(e.label);
  // An edge NEEDS source/target/label to be drawable at all — without those it is
  // not a relationship and is dropped. `id` is NOT required: it only enables
  // Forget. An older server (or one mid-deploy) sends no id, and dropping those
  // edges hid the entire graph — the user saw an empty canvas and asked where
  // their knowledge graph had gone. Fail closed on the destructive action, never
  // on showing the user their own data: the UI hides Forget when id is absent.
  if (!source || !target || !label) return null;
  return {
    id,
    source,
    target,
    label,
    confidence: num(e.confidence) ?? 0,
    times_seen: num(e.times_seen) ?? 0,
    access_count: num(e.access_count),
    first_seen: str(e.first_seen),
    last_seen: str(e.last_seen),
  };
}

export async function getMemoryGraph(token: string): Promise<GraphData> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/graph`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`memory graph failed: ${res.status}`, res.status);
  const d = await res.json();
  const edges = (Array.isArray(d.edges) ? d.edges : [])
    .map(toEdge)
    .filter((e: GraphEdge | null): e is GraphEdge => e !== null);
  const ids = new Set(edges.flatMap((e: GraphEdge) => [e.source, e.target]));
  return {
    // Drop nodes no surviving edge references — otherwise a malformed edge
    // leaves an orphan dot the graph can never explain.
    nodes: (Array.isArray(d.nodes) ? d.nodes : []).filter((n: GraphNode) => ids.has(n?.id)),
    edges,
    notes: Array.isArray(d.notes) ? d.notes : [],
    truncated: !!d.truncated,
  };
}

export async function getMemoryStats(token: string): Promise<MemoryStats> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/stats`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`memory stats failed: ${res.status}`, res.status);
  const d = await res.json();
  return {
    facts: d.facts ?? 0,
    episodic: d.episodic ?? 0,
    conversations: d.conversations ?? 0,
    top_facts: Array.isArray(d.top_facts) ? d.top_facts : [],
    activity: Array.isArray(d.activity) ? d.activity : [],
    truncated: !!d.truncated,
  };
}

// Memory governance: the user's door for removing something Raphael believes but
// shouldn't. Destructive and irreversible — the UI confirms before calling these.
// There is deliberately no edit: facts.embedding is derived from the fact text, so
// a PATCH without re-embedding would leave retrieval matching the old meaning.
// Delete-and-reteach is the loop.

export async function deleteFact(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/facts/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete fact"), res.status);
}

export async function deleteNote(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/notes/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "delete note"), res.status);
}

// The user-portrait transparency door: the prose sketch Raphael injects into every
// system prompt, surfaced read-only so the user can see what it thinks of them.
// Empty string means nothing believed yet.
export async function getPortrait(token: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/portrait`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`portrait failed: ${res.status}`, res.status);
  const d = await res.json();
  return d.portrait ?? "";
}

// --- Google connector (read-only Calendar + profile) -------------------------

export type GoogleStatus = {
  connected: boolean;
  email: string | null;
  // Whether THIS stored grant carries gmail.modify. A user who connected before
  // mail existed has a valid Calendar grant and no mail access, so the UI has to
  // tell them to reconnect rather than showing mail as broken.
  mail_scope_granted: boolean;
};

// Returns the Google consent URL to navigate to. A 503 means this deployment has
// no Google credentials configured — the ApiError carries the 503 so the UI can
// show the inert "not configured" note instead of a broken button.
export async function connectGoogle(token: string): Promise<{ auth_url: string }> {
  const res = await fetch(`${GATEWAY_URL}/api/google/connect`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(await errText(res, "connect Google"), res.status);
  return res.json();
}

export async function googleStatus(token: string): Promise<GoogleStatus> {
  const res = await fetch(`${GATEWAY_URL}/api/google/status`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`google status failed: ${res.status}`, res.status);
  const data = await res.json();
  return {
    connected: !!data.connected,
    email: data.email ?? null,
    mail_scope_granted: !!data.mail_scope_granted,
  };
}

export async function disconnectGoogle(token: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/google`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "disconnect Google"), res.status);
}

// --- admin: allowlist, users, system provider config -------------------------
// Admin-only. The gateway forces role from the JWT and re-checks users.role in the
// DB on every mutation, so a stale/crafted claim can't escalate. Same fetch/
// ApiError/authHeader shape as the rest of the file. Members never call these.

// An allowlisted email is what permits a person to sign in with Google (no invite
// email is sent — adding the row is the invite). Uninvited emails are rejected.
export type AllowedEmail = { email: string; created_at?: string };

export async function listAllowedEmails(token: string): Promise<AllowedEmail[]> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/allowlist`, {
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(`list allowed emails failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.emails ?? []);
}

export async function addAllowedEmail(token: string, email: string): Promise<AllowedEmail> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/allowlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new ApiError(await errText(res, "add allowed email"), res.status);
  return res.json();
}

export async function removeAllowedEmail(token: string, email: string): Promise<void> {
  const res = await fetch(
    `${GATEWAY_URL}/api/admin/allowlist/${encodeURIComponent(email)}`,
    { method: "DELETE", headers: authHeader(token) },
  );
  if (!res.ok) throw new ApiError(await errText(res, "remove allowed email"), res.status);
}

export async function listUsers(token: string): Promise<User[]> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/users`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list users failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.users ?? []);
}

export async function setUserRole(
  token: string,
  id: string,
  role: "admin" | "member",
): Promise<User> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/users/${id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new ApiError(await errText(res, "set role"), res.status);
  return res.json();
}

export async function removeUser(token: string, id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/users/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "remove user"), res.status);
}

// System provider config is admin-owned and system-wide: the gateway proxies these
// to the SAME credential handlers the per-user /api/providers calls hit, but rooted
// at the seeded system-config owner. Reuses Credential/NewCredential verbatim.
export async function listSystemProviders(token: string): Promise<Credential[]> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/providers`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list system providers failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.credentials ?? []);
}

export async function addSystemProvider(token: string, cred: NewCredential): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(cred),
  });
  if (!res.ok) throw new ApiError(await errText(res, "add system provider"), res.status);
  return res.json();
}

export async function activateSystemProvider(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/providers/${id}/activate`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "activate system provider"), res.status);
  return res.json();
}

export async function setSystemLifeboat(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/providers/${id}/lifeboat`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "set system lifeboat"), res.status);
  return res.json();
}

export async function clearSystemLifeboat(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/admin/providers/${id}/lifeboat`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "clear system lifeboat"), res.status);
  return res.json();
}

// Pull a human-readable message out of the {"error": "..."} body.
async function errText(res: Response, action: string): Promise<string> {
  const body = await safeText(res);
  try {
    const j = JSON.parse(body);
    if (j?.error) return `${action}: ${j.error}`;
  } catch {
    /* fall through */
  }
  return `${action} failed: ${res.status}`;
}

// A chat request that never became a stream. agent-svc answers 409 when the user
// has no active credential and the gateway copies status and body straight
// through, so name the one fix that exists rather than echoing an upstream body.
async function chatErrorMessage(res: Response): Promise<string> {
  if (res.status === 409) {
    return "No model provider is active. Add one in Settings, then send this message again.";
  }
  return errText(res, "chat");
}

// --- SSE chat ----------------------------------------------------------------

export type ChatHandlers = {
  onToken: (text: string) => void;
  onDegraded: (d: Degraded) => void;
  onDone: (d: Done) => void;
  onError: (message: string) => void;
};

// Streams POST /api/chat. We use fetch + ReadableStream (not EventSource) so we
// can send the Authorization header. Parses the text/event-stream framing by
// hand: events are separated by a blank line, fields are "event:" and "data:".
export async function streamChat(
  token: string,
  body: { conversation_id: string; message: string; search?: boolean },
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeader(token),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // Aborting before the first byte (Stop on a stream that never opened) is
    // the user's own doing, not a network failure.
    if ((e as Error)?.name === "AbortError") return;
    handlers.onError(networkMessage(e));
    return;
  }

  if (!res.ok || !res.body) {
    handlers.onError(await chatErrorMessage(res));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // An SSE event is terminated by a blank line. Handle both \n\n and \r\n\r\n.
      let sep: number;
      while ((sep = indexOfBlankLine(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + blankLineLength(buffer, sep));
        dispatchEvent(rawEvent, handlers);
      }
    }
    // Flush any trailing event without a terminating blank line.
    if (buffer.trim().length > 0) {
      dispatchEvent(buffer, handlers);
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    handlers.onError(networkMessage(e));
  } finally {
    reader.releaseLock();
  }
}

function dispatchEvent(raw: string, handlers: ChatHandlers): void {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  const dataStr = dataLines.join("\n");
  if (dataStr.length === 0) return;

  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // Non-JSON payload: only meaningful for token text.
    if (eventName === "token") handlers.onToken(dataStr);
    return;
  }

  const obj = data as Record<string, unknown>;
  switch (eventName) {
    case "token":
      handlers.onToken(String(obj.text ?? ""));
      break;
    case "degraded":
      handlers.onDegraded({
        reason: String(obj.reason ?? "credential rejected"),
        provider: String(obj.provider ?? "local"),
        model: String(obj.model ?? ""),
      });
      break;
    case "done":
      handlers.onDone({
        provider: obj.provider ? String(obj.provider) : undefined,
        model: obj.model ? String(obj.model) : undefined,
        message_id: obj.message_id ? String(obj.message_id) : undefined,
        // Only a real number counts; null/absent stay undefined so the footnote
        // hides rather than printing a fabricated 0.
        prompt_tokens:
          typeof obj.prompt_tokens === "number" ? obj.prompt_tokens : undefined,
        completion_tokens:
          typeof obj.completion_tokens === "number" ? obj.completion_tokens : undefined,
      });
      break;
    case "error":
      handlers.onError(String(obj.message ?? "unknown error"));
      break;
    default:
      break;
  }
}

// --- helpers -----------------------------------------------------------------

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function networkMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `Could not reach the gateway. ${msg}`;
}

// Returns the index of the first blank-line separator, or -1.
function indexOfBlankLine(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function blankLineLength(s: string, at: number): number {
  return s.startsWith("\r\n\r\n", at) ? 4 : 2;
}

// --- mail ------------------------------------------------------------------
// Straight REST against agent-svc through the gateway. Deliberately no chat and
// no tokens: reading your own mail settings should not cost model inference.

export type MailConfig = {
  enabled: boolean;
  alerts_enabled: boolean;
  backfill_days: number;
  label_prefix: string;
  quiet_start: string;
  quiet_end: string;
  telegram_chat_id: string | null;
  // Sync state, shown so "nothing is happening" is always explicable.
  history_id: string | null;
  backfill_cursor: string | null;
  backfill_done_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
};

export type MailMessage = {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  sender_address: string;
  sender_display: string;
  subject: string;
  received_at: string;
  state: string;
  auth_ok: boolean;
  bulk: boolean;
  stripped_hidden_chars: number;
  category: string | null;
  event_type: string | null;
  tier: string | null;
  summary: string | null;
  reason: string | null;
  deadline: string | null;
  amount_minor: number | null;
  currency: string | null;
  degraded: boolean | null;
  rule_fired: string | null;
  corrected_tier: string | null;
  corrected_category: string | null;
};

export type MailStats = {
  tiers: Record<string, number>;
  states: Record<string, number>;
};

export async function getMailConfig(token: string): Promise<MailConfig> {
  const res = await fetch(`${GATEWAY_URL}/api/mail/config`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`mail config failed: ${res.status}`, res.status);
  return (await res.json()) as MailConfig;
}

export async function saveMailConfig(
  token: string,
  patch: Partial<Pick<MailConfig,
    "enabled" | "alerts_enabled" | "backfill_days" | "label_prefix" |
    "quiet_start" | "quiet_end" | "telegram_chat_id">>,
): Promise<MailConfig> {
  const res = await fetch(`${GATEWAY_URL}/api/mail/config`, {
    method: "PUT",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(`mail config save failed: ${res.status}`, res.status);
  return (await res.json()) as MailConfig;
}

export async function listMail(
  token: string,
  tier?: string,
  limit = 50,
): Promise<MailMessage[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (tier) q.set("tier", tier);
  const res = await fetch(`${GATEWAY_URL}/api/mail/messages?${q}`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`mail list failed: ${res.status}`, res.status);
  const data = await res.json();
  return (data.items ?? []) as MailMessage[];
}

export async function getMailStats(token: string): Promise<MailStats> {
  const res = await fetch(`${GATEWAY_URL}/api/mail/stats`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`mail stats failed: ${res.status}`, res.status);
  return (await res.json()) as MailStats;
}

// Records that the human disagreed. Stored beside the original verdict, never
// over it — the pair is the training signal for personalised classification.
export async function correctMail(
  token: string,
  messageId: string,
  patch: { tier?: string; category?: string },
): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/mail/messages/${encodeURIComponent(messageId)}/correct`, {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(`correction failed: ${res.status}`, res.status);
}
