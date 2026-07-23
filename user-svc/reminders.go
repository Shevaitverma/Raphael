package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Reminders + in-app notifications: per-user data, uid-scoped like tasks (the
// gateway forces uid from the JWT). Two doors: a chat create_reminder tool
// compiles NL -> {kind, cron, fire_at, until} ONCE at authoring, and a UI form
// hits REST directly. Runtime is LLM-free: startScheduler polls due reminders,
// writes a notification (the sink), and advances next_fire via cron.go's
// computeNext — all inside one claiming tx so a crashed worker auto-recovers.
//
// Timezone is FORCE-STAMPED from users.timezone; next_fire is computed
// server-side. The tool's tz/next_fire are never trusted. The tool sends
// fire_at/until as LOCAL ISO-8601 without an offset (e.g. 2026-07-23T17:00);
// we interpret them in the user's tz here.
//
// Column names mirror the live schema (text/cron/fire_at/timezone/last_fired_at),
// not the draft migration; the JSON keys mirror agent-svc/tools/reminders.py.

// ---------- row shapes ----------

type reminder struct {
	ID          string     `json:"id"`
	Text        string     `json:"text"`
	Kind        string     `json:"kind"`
	Cron        *string    `json:"cron"`
	FireAt      *time.Time `json:"fire_at"`
	Until       *time.Time `json:"until"`
	Timezone    string     `json:"timezone"`
	NextFire    *time.Time `json:"next_fire"`
	Active      bool       `json:"active"`
	LastFiredAt *time.Time `json:"last_fired_at"`
	CreatedAt   time.Time  `json:"created_at"`
}

const reminderCols = `id, text, kind, cron, fire_at, until, timezone, next_fire, active, last_fired_at, created_at`

func scanReminder(row pgx.Row) (*reminder, error) {
	var r reminder
	if err := row.Scan(&r.ID, &r.Text, &r.Kind, &r.Cron, &r.FireAt, &r.Until,
		&r.Timezone, &r.NextFire, &r.Active, &r.LastFiredAt, &r.CreatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

type notification struct {
	ID         string     `json:"id"`
	ReminderID *string    `json:"reminder_id"`
	Text       string     `json:"text"`
	ReadAt     *time.Time `json:"read_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

const notifCols = `id, reminder_id, text, read_at, created_at`

func scanNotification(row pgx.Row) (*notification, error) {
	var n notification
	if err := row.Scan(&n.ID, &n.ReminderID, &n.Text, &n.ReadAt, &n.CreatedAt); err != nil {
		return nil, err
	}
	return &n, nil
}

// parseLocalTime reads an ISO-8601 datetime as WALL-CLOCK time in loc. The tool
// emits a naive local datetime (no offset); we also accept an absolute RFC3339
// in case a caller included one. Getting this wrong schedules the fire at the
// wrong instant, so it has its own test.
var localLayouts = []string{
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
}

func parseLocalTime(s string, loc *time.Location) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, l := range localLayouts {
		if t, err := time.ParseInLocation(l, s, loc); err == nil {
			return t, nil
		}
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("expected an ISO-8601 datetime like 2006-01-02T15:04")
}

// ---------- store: reminders (all WHERE user_id — ownership re-checked every op) ----------

func (s *store) listReminders(ctx context.Context, userID string) ([]reminder, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+reminderCols+`
		FROM reminders
		WHERE user_id = $1
		ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []reminder{}
	for rows.Next() {
		r, err := scanReminder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// createReminder inserts a reminder. timezone is force-stamped and next_fire is
// computed by the handler. cron is nil for kind='once'; fire_at is nil for cron.
func (s *store) createReminder(ctx context.Context, userID, text, kind string,
	cron *string, fireAt *time.Time, tz string, until *time.Time, nextFire time.Time) (*reminder, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	return scanReminder(s.pool.QueryRow(ctx, `
		INSERT INTO reminders (user_id, text, kind, cron, fire_at, until, timezone, next_fire)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+reminderCols, userID, text, kind, cron, fireAt, until, tz, nextFire))
}

func (s *store) setReminderActive(ctx context.Context, userID, id string, active bool) (*reminder, error) {
	if !validUUID(userID) || !validUUID(id) {
		return nil, errNotFound
	}
	r, err := scanReminder(s.pool.QueryRow(ctx, `
		UPDATE reminders SET active = $3
		WHERE id = $1 AND user_id = $2
		RETURNING `+reminderCols, id, userID, active))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return r, err
}

func (s *store) deleteReminder(ctx context.Context, userID, id string) error {
	if !validUUID(userID) || !validUUID(id) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `DELETE FROM reminders WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// ---------- store: notifications ----------

func (s *store) listNotifications(ctx context.Context, userID string, unread bool) ([]notification, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	// Newest first, capped at 100 — the bell derives recent list + unread count
	// client-side. Unbounded history in the table; bounded read. unread=true
	// filters to unread rows so the badge count doesn't re-light on read ones.
	unreadFilter := ""
	if unread {
		unreadFilter = " AND read_at IS NULL"
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+notifCols+`
		FROM notifications
		WHERE user_id = $1`+unreadFilter+`
		ORDER BY created_at DESC
		LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []notification{}
	for rows.Next() {
		n, err := scanNotification(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *n)
	}
	return out, rows.Err()
}

// markNotificationRead stamps read_at (idempotent). No matching row -> errNotFound.
func (s *store) markNotificationRead(ctx context.Context, userID, id string) error {
	if !validUUID(userID) || !validUUID(id) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `
		UPDATE notifications SET read_at = now()
		WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// ---------- store: timezone (on users) ----------

// getUserTimezone returns the user's IANA tz, or "" if unset. errNotFound when
// the user row is absent (or uid is not a uuid).
func (s *store) getUserTimezone(ctx context.Context, userID string) (string, error) {
	if !validUUID(userID) {
		return "", errNotFound
	}
	var tz *string
	err := s.pool.QueryRow(ctx, `SELECT timezone FROM users WHERE id = $1`, userID).Scan(&tz)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotFound
	}
	if err != nil {
		return "", err
	}
	if tz == nil {
		return "", nil
	}
	return *tz, nil
}

func (s *store) setTimezone(ctx context.Context, userID, tz string) error {
	if !validUUID(userID) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `UPDATE users SET timezone = $2 WHERE id = $1`, userID, tz)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// ---------- handlers (tasks.go-style: Go-side validation so a CHECK never 500s) ----------

func (s *server) listReminders(w http.ResponseWriter, r *http.Request) {
	rems, err := s.store.listReminders(r.Context(), r.PathValue("uid"))
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list reminders")
		return
	}
	writeJSON(w, http.StatusOK, rems)
}

// windowEnd turns a coarse "window" hint into a concrete local end instant in loc:
// "today" -> today 23:59:59; "this_week" -> the coming Sunday 23:59:59 (today if it
// is Sunday). Empty/unknown -> nil (no bound). We compute the tz-correct instant
// here because a small model sets a category far more reliably than an exact `until`
// timestamp — so "every hour today" reliably stops at end of day.
func windowEnd(window string, loc *time.Location) *time.Time {
	now := time.Now().In(loc)
	switch strings.ToLower(strings.TrimSpace(window)) {
	case "today":
		t := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 0, loc)
		return &t
	case "this_week", "week":
		end := now.AddDate(0, 0, (7-int(now.Weekday()))%7) // coming Sunday, today if Sun
		t := time.Date(end.Year(), end.Month(), end.Day(), 23, 59, 59, 0, loc)
		return &t
	}
	return nil
}

// createReminderReq is what the chat tool / UI form send. timezone and next_fire
// are intentionally ABSENT: both are derived server-side, never trusted.
type createReminderReq struct {
	Text   string `json:"text"`
	Kind   string `json:"kind"`
	Cron   string `json:"cron"`    // 5-field, when kind='cron'
	FireAt string `json:"fire_at"` // local ISO-8601 (no offset), when kind='once'
	Until  string `json:"until"`   // optional local ISO-8601 bound
	Window string `json:"window"`  // optional coarse bound "today"/"this_week"; server derives until
}

func (s *server) createReminder(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")

	var req createReminderReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	text := strings.TrimSpace(req.Text)
	if text == "" || utf8.RuneCountInString(text) > 500 {
		writeErr(w, http.StatusBadRequest, "text must be 1..500 characters")
		return
	}
	if req.Kind != "once" && req.Kind != "cron" {
		writeErr(w, http.StatusBadRequest, "kind must be once or cron")
		return
	}

	// Force-stamp tz from the user row; the tool never sets it. No tz => can't
	// evaluate a schedule, so reject up front (the web sets it on login/Settings).
	tz, err := s.store.getUserTimezone(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read timezone")
		return
	}
	if tz == "" {
		writeErr(w, http.StatusBadRequest, "set your timezone in Settings before creating a reminder")
		return
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "stored timezone is not a valid IANA name; re-set it in Settings")
		return
	}

	// Optional until bound (local wall-clock in the user's tz).
	var until *time.Time
	if strings.TrimSpace(req.Until) != "" {
		u, err := parseLocalTime(req.Until, loc)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "until must be an ISO-8601 datetime")
			return
		}
		until = &u
	}
	// No explicit until but a coarse window ("every hour today")? Derive the end in
	// the user's tz — the tool passes "today"/"this_week" (easy for a small model),
	// we compute the exact instant. An explicit until always wins over the window.
	if until == nil {
		until = windowEnd(req.Window, loc)
	}

	var cron *string
	var fireAt *time.Time
	if req.Kind == "cron" {
		c := strings.TrimSpace(req.Cron)
		if c == "" {
			writeErr(w, http.StatusBadRequest, "cron is required for a cron reminder")
			return
		}
		cron = &c
	} else { // once
		if strings.TrimSpace(req.FireAt) == "" {
			writeErr(w, http.StatusBadRequest, "fire_at is required for a once reminder")
			return
		}
		f, err := parseLocalTime(req.FireAt, loc)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "fire_at must be an ISO-8601 datetime")
			return
		}
		fireAt = &f
	}

	// Compute next_fire server-side. computeNext validates cron/tz and applies the
	// until bound; nil (with no error) means the schedule can never fire — the
	// missing-schedule guard — so reject rather than store a dead reminder.
	cronStr := ""
	if cron != nil {
		cronStr = *cron
	}
	next, err := computeNext(time.Now(), req.Kind, cronStr, fireAt, until, tz, false)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid schedule: "+err.Error())
		return
	}
	if next == nil {
		writeErr(w, http.StatusBadRequest, "that schedule never fires (check the recurrence and the until bound)")
		return
	}

	rem, err := s.store.createReminder(r.Context(), uid, text, req.Kind, cron, fireAt, tz, until, *next)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to create reminder")
		return
	}
	writeJSON(w, http.StatusCreated, rem)
}

// patchReminder toggles active (pause/resume). Only 'active' is settable; the
// schedule itself is immutable in v1 (delete + recreate to change it).
func (s *server) patchReminder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Active *bool `json:"active"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Active == nil {
		writeErr(w, http.StatusBadRequest, "nothing to update (only active is settable)")
		return
	}

	rem, err := s.store.setReminderActive(r.Context(), r.PathValue("uid"), r.PathValue("id"), *req.Active)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "reminder not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update reminder")
		return
	}
	writeJSON(w, http.StatusOK, rem)
}

func (s *server) deleteReminder(w http.ResponseWriter, r *http.Request) {
	if err := s.store.deleteReminder(r.Context(), r.PathValue("uid"), r.PathValue("id")); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "reminder not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete reminder")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *server) listNotifications(w http.ResponseWriter, r *http.Request) {
	unread := r.URL.Query().Get("unread") == "1"
	notifs, err := s.store.listNotifications(r.Context(), r.PathValue("uid"), unread)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list notifications")
		return
	}
	writeJSON(w, http.StatusOK, notifs)
}

func (s *server) markNotificationRead(w http.ResponseWriter, r *http.Request) {
	if err := s.store.markNotificationRead(r.Context(), r.PathValue("uid"), r.PathValue("id")); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "notification not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to mark notification read")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"read": true})
}

// putTimezone stores the user's IANA tz (web auto-detects + Settings picker).
// Validated with LoadLocation so a bad tz can't later break next_fire.
func (s *server) putTimezone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Timezone string `json:"timezone"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	tz := strings.TrimSpace(req.Timezone)
	if tz == "" {
		writeErr(w, http.StatusBadRequest, "timezone must not be blank")
		return
	}
	if _, err := time.LoadLocation(tz); err != nil {
		writeErr(w, http.StatusBadRequest, "unknown timezone (expected an IANA name like Asia/Kolkata)")
		return
	}

	if err := s.store.setTimezone(r.Context(), r.PathValue("uid"), tz); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update timezone")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"timezone": tz})
}

// ---------- scheduler (LLM-free; started once at boot from main.go) ----------

// startScheduler runs a background goroutine that fires due reminders every ~30s.
// main.go calls it after Ping (one line). A single instance needs no advisory
// lock; the FOR UPDATE SKIP LOCKED claim in fireDue makes it multi-instance-safe.
func startScheduler(pool *pgxpool.Pool) {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			if err := fireDue(ctx, pool); err != nil {
				log.Printf("reminder scheduler: %v", err)
			}
			cancel()
		}
	}()
}

// dueReminder is the subset the claim query reads.
type dueReminder struct {
	id, userID, text, kind, tz string
	cron                       *string
	until                      *time.Time
}

// fireDue claims all due reminders, writes a notification per row (the sink), and
// advances next_fire (or deactivates) — ALL inside one tx. FOR UPDATE SKIP LOCKED
// holds the row locks until commit, so a second instance skips these rows (no
// double-fire) and a crash before commit rolls back cleanly (the fire re-runs,
// and its notification was never committed, so no orphan).
func fireDue(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit

	rows, err := tx.Query(ctx, `
		SELECT id, user_id, text, kind, cron, timezone, until
		FROM reminders
		WHERE active AND next_fire IS NOT NULL AND next_fire <= now()
		ORDER BY next_fire
		FOR UPDATE SKIP LOCKED
		LIMIT 100`)
	if err != nil {
		return err
	}
	// Drain fully before issuing more statements: the tx holds one connection and
	// it stays busy until rows.Close().
	var due []dueReminder
	for rows.Next() {
		var d dueReminder
		if err := rows.Scan(&d.id, &d.userID, &d.text, &d.kind, &d.cron, &d.tz, &d.until); err != nil {
			rows.Close()
			return err
		}
		due = append(due, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, d := range due {
		// Sink: write the in-app notification. Decoupled from firing so a WhatsApp/
		// push adapter can be added later without touching the claim logic.
		if _, err := tx.Exec(ctx, `
			INSERT INTO notifications (user_id, reminder_id, text)
			VALUES ($1, $2, $3)`, d.userID, d.id, d.text); err != nil {
			return err
		}

		// Advance. cron.go anchors the next cron slot to now(), collapsing a long
		// outage's missed slots into this single catch-up fire; a 'once' or a cron
		// past `until` returns nil -> deactivate.
		cronStr := ""
		if d.cron != nil {
			cronStr = *d.cron
		}
		next, err := computeNext(time.Now(), d.kind, cronStr, nil, d.until, d.tz, true)
		if err != nil {
			// A stored cron that no longer parses (shouldn't happen — validated at
			// create) would fire forever; deactivate it instead of looping.
			log.Printf("reminder %s: cannot advance, deactivating: %v", d.id, err)
			next = nil
		}

		if next == nil {
			if _, err := tx.Exec(ctx, `
				UPDATE reminders SET active = false, last_fired_at = now()
				WHERE id = $1`, d.id); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `
			UPDATE reminders SET next_fire = $2, last_fired_at = now()
			WHERE id = $1`, d.id, *next); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
