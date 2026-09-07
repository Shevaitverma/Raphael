package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Outbound notification delivery: the adapter db/014 said would come.
//
// That migration created `notifications` and stated the intent verbatim — "the
// in-app feed = the delivery sink. Firing writes one row here; delivery is
// decoupled from firing so WhatsApp/push can be added as adapters later." This
// is that adapter. It drains the table rather than being wired to a producer, so
// every producer (reminders, the fitness coach, mail) reaches the same channel
// without knowing the channel exists.
//
// WHAT GETS SENT. Only tier act_now and act_soon. tier defaults to 'fyi', so the
// two existing producers keep their exact current behaviour — in-app bell only,
// no surprise buzzing on a feature nobody asked to change. Promoting reminders to
// act_soon is a one-word change once that is a decision someone has made.
//
// DELIVERY GUARANTEE: at-least-once, marked AFTER the API call succeeds. Marking
// before would be at-most-once, and would lose an alert SILENTLY on a crash —
// which is the one failure mode a personal alerter must not have. A duplicate
// buzz is mildly annoying; a lost one destroys trust in the whole system.
//
// SINGLE SENDER: FOR UPDATE SKIP LOCKED, same as fireDue. Two senders would also
// break Telegram's ~1 message/second per chat pacing.

const (
	notifyTick       = 30 * time.Second
	notifyBatch      = 20
	notifyMaxAttempt = 6
)

// startNotifier launches the delivery goroutine. One line in main.go, exactly
// like startScheduler and startFitnessCoach.
//
// Inert unless a bot token is configured — an unset token means the channel is
// off, not broken, so the goroutine simply never starts and rows stay in the
// in-app feed where they already were.
func startNotifier(pool *pgxpool.Pool) {
	if !telegramConfigured() {
		slog.Info("notifier disabled", "reason", "TELEGRAM_BOT_TOKEN unset")
		return
	}
	go func() {
		t := time.NewTicker(notifyTick)
		defer t.Stop()
		for range t.C {
			ctx, cancel := context.WithTimeout(context.Background(), notifyTick-2*time.Second)
			if err := deliverDue(ctx, pool); err != nil {
				slog.Error("notifier tick", "err", err.Error())
			}
			cancel()
		}
	}()
	slog.Info("notifier started", "channel", "telegram", "tick", notifyTick.String())
}

type dueAlert struct {
	id       string
	userID   string
	text     string
	tier     string
	linkURL  *string
	attempts int
	chatID   *string
	timezone string
	quietBeg string
	quietEnd string
	expired  bool
}

// deliverDue claims and sends one batch.
func deliverDue(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit

	rows, err := tx.Query(ctx, `
		SELECT n.id, n.user_id, n.text, n.tier, n.link_url, n.attempts,
		       c.telegram_chat_id, u.timezone,
		       COALESCE(c.quiet_start,'22:00'), COALESCE(c.quiet_end,'07:00'),
		       (n.expires_at IS NOT NULL AND n.expires_at < now()) AS expired
		  FROM notifications n
		  JOIN users u ON u.id = n.user_id
		  LEFT JOIN mail_config c ON c.user_id = n.user_id
		 WHERE n.delivered_at IS NULL
		   AND n.tier IN ('act_now','act_soon')
		   AND n.next_attempt_at <= now()
		 ORDER BY n.tier DESC, n.created_at ASC
		 LIMIT $1
		 FOR UPDATE OF n SKIP LOCKED`, notifyBatch)
	if err != nil {
		return err
	}
	// One transaction holds one connection, so the rows must be fully drained
	// into a slice before any further statement is issued inside the tx.
	var batch []dueAlert
	for rows.Next() {
		var a dueAlert
		if err := rows.Scan(&a.id, &a.userID, &a.text, &a.tier, &a.linkURL,
			&a.attempts, &a.chatID, &a.timezone, &a.quietBeg, &a.quietEnd, &a.expired); err != nil {
			rows.Close()
			return err
		}
		batch = append(batch, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(batch) == 0 {
		return tx.Commit(ctx)
	}

	for _, a := range batch {
		// A stale urgent alert is worse than none: "meeting in 20 minutes"
		// arriving after a three-hour outage is noise. Retire it from the queue;
		// it stays visible in the in-app feed.
		if a.expired {
			_, _ = tx.Exec(ctx, `UPDATE notifications SET delivered_at = now(), channel = 'expired' WHERE id = $1`, a.id)
			continue
		}
		if a.chatID == nil || *a.chatID == "" {
			// No chat id: this user has not linked Telegram. Not an error, and
			// not something to retry every 30 seconds forever.
			_, _ = tx.Exec(ctx, `UPDATE notifications SET delivered_at = now(), channel = 'inapp' WHERE id = $1`, a.id)
			continue
		}

		silent := a.tier != "act_now" || inQuietHours(time.Now(), a.timezone, a.quietBeg, a.quietEnd)
		link := ""
		if a.linkURL != nil {
			link = *a.linkURL
		}

		res, sendErr := sendTelegram(ctx, *a.chatID, a.text, link, silent)
		switch {
		case sendErr == nil:
			// MARK AFTER THE CALL. See the file header.
			_, _ = tx.Exec(ctx, `
				UPDATE notifications
				   SET delivered_at = now(), channel = 'telegram', channel_msg_id = $2
				 WHERE id = $1`, a.id, res.messageID)
		case errors.Is(sendErr, errTelegramPermanent):
			_, _ = tx.Exec(ctx, `
				UPDATE notifications SET delivered_at = now(), channel = 'failed', attempts = attempts + 1
				 WHERE id = $1`, a.id)
			slog.Warn("notify permanent failure", "user_id", a.userID, "err", sendErr.Error())
		default:
			delay := res.retryAfter
			if delay <= 0 {
				delay = backoffFor(a.attempts)
			}
			give := a.attempts+1 >= notifyMaxAttempt
			if give {
				_, _ = tx.Exec(ctx, `
					UPDATE notifications SET delivered_at = now(), channel = 'failed', attempts = attempts + 1
					 WHERE id = $1`, a.id)
			} else {
				_, _ = tx.Exec(ctx, `
					UPDATE notifications
					   SET attempts = attempts + 1, next_attempt_at = now() + $2::interval
					 WHERE id = $1`, a.id, delay.String())
			}
			slog.Warn("notify retry", "user_id", a.userID, "attempts", a.attempts+1,
				"err", sendErr.Error())
		}
	}
	return tx.Commit(ctx)
}

// backoffFor is truncated exponential: 1s, 2s, 4s ... capped at 5 minutes.
func backoffFor(attempts int) time.Duration {
	d := time.Second << attempts
	if d > 5*time.Minute || d <= 0 {
		d = 5 * time.Minute
	}
	return d
}

// inQuietHours evaluates the window in the USER'S timezone, and handles a window
// that wraps midnight (22:00-07:00 is the normal case, and it wraps).
//
// Quiet hours never suppress an alert here — they only make it silent. Telegram
// delivers it instantly and visibly with no sound, which is strictly better than
// holding it in a queue and risking the 06:00 alert arriving at 09:00.
func inQuietHours(now time.Time, tz, start, end string) bool {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	n := now.In(loc)
	cur := n.Hour()*60 + n.Minute()
	s, ok1 := parseHHMM(start)
	e, ok2 := parseHHMM(end)
	if !ok1 || !ok2 || s == e {
		return false
	}
	if s < e {
		return cur >= s && cur < e
	}
	return cur >= s || cur < e // wraps midnight
}

func parseHHMM(v string) (int, bool) {
	if len(v) != 5 || v[2] != ':' {
		return 0, false
	}
	h := int(v[0]-'0')*10 + int(v[1]-'0')
	m := int(v[3]-'0')*10 + int(v[4]-'0')
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

// --------------------------------------------------------------------------

type internalNotifyReq struct {
	Text      string  `json:"text"`
	Tier      string  `json:"tier"`
	DedupKey  *string `json:"dedup_key"`
	LinkURL   *string `json:"link_url"`
	ExpiresAt *string `json:"expires_at"`
}

// internalNotify (INTERNAL) lets agent-svc's mail worker put an alert in the
// outbox without writing to another service's table.
//
// The dedup key is the whole point of the 409: a UNIQUE partial index on
// (user_id, dedup_key) means the same thread cannot alert twice at the same
// tier, and a duplicate is reported as a normal outcome rather than an error.
func (s *server) internalNotify(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !validUUID(uid) {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req internalNotifyReq
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// Validate in Go so a DB CHECK never surfaces as a 500.
	if l := len([]rune(req.Text)); l == 0 || l > 500 {
		writeErr(w, http.StatusBadRequest, "text must be 1..500 characters")
		return
	}
	switch req.Tier {
	case "act_now", "act_soon", "fyi":
	default:
		writeErr(w, http.StatusBadRequest, "tier must be act_now, act_soon or fyi")
		return
	}
	var expires *time.Time
	if req.ExpiresAt != nil && *req.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, *req.ExpiresAt)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "expires_at must be RFC3339")
			return
		}
		expires = &t
	}

	err := s.store.insertNotification(r.Context(), uid, req.Text, req.Tier,
		req.DedupKey, req.LinkURL, expires)
	if errors.Is(err, errDuplicateNotification) {
		writeJSON(w, http.StatusConflict, map[string]any{"duplicate": true})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to queue notification")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"queued": true})
}

var errDuplicateNotification = errors.New("notification already queued for this dedup key")

func (s *store) insertNotification(ctx context.Context, userID, text, tier string,
	dedupKey, linkURL *string, expiresAt *time.Time) error {
	if !validUUID(userID) {
		return errNotFound
	}
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO notifications (user_id, text, tier, dedup_key, link_url, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT DO NOTHING
		RETURNING id`, userID, text, tier, dedupKey, linkURL, expiresAt).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// ON CONFLICT DO NOTHING returns no row: the dedup key already exists.
		return errDuplicateNotification
	}
	return err
}
