package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Fitness: per-user workouts + body metrics, uid-scoped like tasks/reminders
// (the gateway forces uid from the JWT). Two doors: a chat tool and a UI form,
// both landing on the same user_id-scoped rows. Nullable numeric/text fields are
// pointers so an omitted field stays NULL; performed_on/recorded_on omitted fall
// to the DB default (today) via COALESCE. Date columns are read as YYYY-MM-DD via
// to_char (same trick as tasks.due_date). Every query is WHERE user_id — mirrors
// reminders.go, ownership re-checked on every op.

// ---------- row shapes ----------

type workout struct {
	ID          string    `json:"id"`
	Category    string    `json:"category"`
	Title       string    `json:"title"`
	DurationMin *int      `json:"duration_min"`
	Calories    *int      `json:"calories"`
	DistanceKm  *float64  `json:"distance_km"`
	Notes       *string   `json:"notes"`
	PerformedOn string    `json:"performed_on"`
	CreatedAt   time.Time `json:"created_at"`
}

// performed_on read as text so it marshals as YYYY-MM-DD, not an RFC3339 stamp.
const workoutCols = `id, category, title, duration_min, calories, distance_km, notes, to_char(performed_on, 'YYYY-MM-DD'), created_at`

func scanWorkout(row pgx.Row) (*workout, error) {
	var w workout
	if err := row.Scan(&w.ID, &w.Category, &w.Title, &w.DurationMin, &w.Calories,
		&w.DistanceKm, &w.Notes, &w.PerformedOn, &w.CreatedAt); err != nil {
		return nil, err
	}
	return &w, nil
}

type bodyMetric struct {
	ID         string    `json:"id"`
	MetricType string    `json:"metric_type"`
	Value      float64   `json:"value"`
	Unit       *string   `json:"unit"`
	Notes      *string   `json:"notes"`
	RecordedOn string    `json:"recorded_on"`
	CreatedAt  time.Time `json:"created_at"`
}

const metricCols = `id, metric_type, value, unit, notes, to_char(recorded_on, 'YYYY-MM-DD'), created_at`

func scanMetric(row pgx.Row) (*bodyMetric, error) {
	var m bodyMetric
	if err := row.Scan(&m.ID, &m.MetricType, &m.Value, &m.Unit, &m.Notes,
		&m.RecordedOn, &m.CreatedAt); err != nil {
		return nil, err
	}
	return &m, nil
}

// metricBrief is the trimmed shape embedded in fitness stats (latest weight).
type metricBrief struct {
	Value      float64 `json:"value"`
	Unit       *string `json:"unit"`
	RecordedOn string  `json:"recorded_on"`
}

type fitnessStats struct {
	WorkoutsThisWeek int          `json:"workouts_this_week"`
	StreakDays       int          `json:"streak_days"`
	TotalWorkouts    int          `json:"total_workouts"`
	LatestWeight     *metricBrief `json:"latest_weight"`
}

// ---------- store: workouts (all WHERE user_id) ----------

func (s *store) listWorkouts(ctx context.Context, userID string) ([]workout, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+workoutCols+`
		FROM workouts
		WHERE user_id = $1
		ORDER BY performed_on DESC, created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []workout{}
	for rows.Next() {
		w, err := scanWorkout(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *w)
	}
	return out, rows.Err()
}

// createWorkout inserts a workout. Nullable columns take nil for absent. A nil
// performedOn -> COALESCE falls to today's date (the DB default).
func (s *store) createWorkout(ctx context.Context, userID, title, category string,
	durationMin, calories *int, distanceKm *float64, notes *string, performedOn *time.Time) (*workout, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	return scanWorkout(s.pool.QueryRow(ctx, `
		INSERT INTO workouts (user_id, title, category, duration_min, calories, distance_km, notes, performed_on)
		VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, now()::date))
		RETURNING `+workoutCols, userID, title, category, durationMin, calories, distanceKm, notes, performedOn))
}

func (s *store) deleteWorkout(ctx context.Context, userID, id string) error {
	if !validUUID(userID) || !validUUID(id) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// ---------- store: body metrics ----------

// listMetrics returns the user's metrics, optionally filtered to one type.
// metricType "" = all types.
func (s *store) listMetrics(ctx context.Context, userID, metricType string) ([]bodyMetric, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+metricCols+`
		FROM body_metrics
		WHERE user_id = $1 AND ($2 = '' OR metric_type = $2)
		ORDER BY recorded_on DESC, created_at DESC`, userID, metricType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []bodyMetric{}
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func (s *store) createMetric(ctx context.Context, userID, metricType string, value float64,
	unit, notes *string, recordedOn *time.Time) (*bodyMetric, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	return scanMetric(s.pool.QueryRow(ctx, `
		INSERT INTO body_metrics (user_id, metric_type, value, unit, notes, recorded_on)
		VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, now()::date))
		RETURNING `+metricCols, userID, metricType, value, unit, notes, recordedOn))
}

func (s *store) deleteMetric(ctx context.Context, userID, id string) error {
	if !validUUID(userID) || !validUUID(id) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `DELETE FROM body_metrics WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// fitnessStats aggregates the dashboard counters. WorkoutsThisWeek / TotalWorkouts
// / LatestWeight are pure SQL; StreakDays is computed in Go from the distinct
// workout days (a consecutive run of days ending today or yesterday).
func (s *store) fitnessStats(ctx context.Context, userID string) (fitnessStats, error) {
	var st fitnessStats
	if !validUUID(userID) {
		return st, errNotFound
	}

	// last 7 days (>= current_date - 6) + lifetime total, one row.
	if err := s.pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE performed_on >= current_date - 6),
			count(*)
		FROM workouts
		WHERE user_id = $1`, userID).Scan(&st.WorkoutsThisWeek, &st.TotalWorkouts); err != nil {
		return st, err
	}

	// Most recent weight, or nil.
	var mb metricBrief
	err := s.pool.QueryRow(ctx, `
		SELECT value, unit, to_char(recorded_on, 'YYYY-MM-DD')
		FROM body_metrics
		WHERE user_id = $1 AND metric_type = 'weight'
		ORDER BY recorded_on DESC, created_at DESC
		LIMIT 1`, userID).Scan(&mb.Value, &mb.Unit, &mb.RecordedOn)
	if err == nil {
		st.LatestWeight = &mb
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return st, err
	}

	// Distinct workout days + today, both as YYYY-MM-DD so the parse is exact
	// (no DST hour drift). Days come back newest-first.
	var today string
	if err := s.pool.QueryRow(ctx, `SELECT to_char(current_date, 'YYYY-MM-DD')`).Scan(&today); err != nil {
		return st, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(performed_on, 'YYYY-MM-DD')
		FROM (SELECT DISTINCT performed_on FROM workouts WHERE user_id = $1) d
		ORDER BY performed_on DESC`, userID)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	var days []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return st, err
		}
		days = append(days, d)
	}
	if err := rows.Err(); err != nil {
		return st, err
	}
	st.StreakDays = streakDays(today, days)
	return st, nil
}

// streakDays counts consecutive days (newest-first) ending today or yesterday.
// A gap >1 day from today, or between days, ends the run. Inputs are YYYY-MM-DD.
func streakDays(today string, days []string) int {
	if len(days) == 0 {
		return 0
	}
	const layout = "2006-01-02"
	t0, err := time.Parse(layout, today)
	if err != nil {
		return 0
	}
	dayDiff := func(a, b time.Time) int { return int(a.Sub(b).Hours()) / 24 }

	prev, err := time.Parse(layout, days[0])
	if err != nil {
		return 0
	}
	// Most recent workout must be today or yesterday, else the streak is dead.
	if g := dayDiff(t0, prev); g < 0 || g > 1 {
		return 0
	}
	streak := 1
	for _, d := range days[1:] {
		cur, err := time.Parse(layout, d)
		if err != nil {
			break
		}
		switch dayDiff(prev, cur) {
		case 0:
			continue // duplicate (shouldn't happen; distinct) — ignore
		case 1:
			streak++
			prev = cur
		default:
			return streak
		}
	}
	return streak
}

// ---------- handlers (Go-side validation so a CHECK never 500s) ----------

// parseDay validates an optional YYYY-MM-DD date. "" -> nil (use DB default).
func parseDay(s string) (*time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, true
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil, false
	}
	return &t, true
}

func (s *server) listWorkoutsHandler(w http.ResponseWriter, r *http.Request) {
	ws, err := s.store.listWorkouts(r.Context(), r.PathValue("uid"))
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list workouts")
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

type createWorkoutReq struct {
	Title       string   `json:"title"`
	Category    string   `json:"category"`
	DurationMin *int     `json:"duration_min"`
	Calories    *int     `json:"calories"`
	DistanceKm  *float64 `json:"distance_km"`
	Notes       *string  `json:"notes"`
	PerformedOn string   `json:"performed_on"`
}

func (s *server) createWorkoutHandler(w http.ResponseWriter, r *http.Request) {
	var req createWorkoutReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" || utf8.RuneCountInString(title) > 200 {
		writeErr(w, http.StatusBadRequest, "title must be 1..200 characters")
		return
	}
	category := strings.TrimSpace(req.Category)
	if category == "" {
		category = "strength"
	}
	performedOn, ok := parseDay(req.PerformedOn)
	if !ok {
		writeErr(w, http.StatusBadRequest, "performed_on must be a YYYY-MM-DD date")
		return
	}

	wk, err := s.store.createWorkout(r.Context(), r.PathValue("uid"), title, category,
		req.DurationMin, req.Calories, req.DistanceKm, req.Notes, performedOn)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to create workout")
		return
	}
	writeJSON(w, http.StatusCreated, wk)
}

func (s *server) deleteWorkoutHandler(w http.ResponseWriter, r *http.Request) {
	if err := s.store.deleteWorkout(r.Context(), r.PathValue("uid"), r.PathValue("id")); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "workout not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete workout")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *server) listMetricsHandler(w http.ResponseWriter, r *http.Request) {
	metricType := strings.TrimSpace(r.URL.Query().Get("type"))
	ms, err := s.store.listMetrics(r.Context(), r.PathValue("uid"), metricType)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list metrics")
		return
	}
	writeJSON(w, http.StatusOK, ms)
}

type createMetricReq struct {
	MetricType string   `json:"metric_type"`
	Value      *float64 `json:"value"`
	Unit       *string  `json:"unit"`
	Notes      *string  `json:"notes"`
	RecordedOn string   `json:"recorded_on"`
}

func (s *server) createMetricHandler(w http.ResponseWriter, r *http.Request) {
	var req createMetricReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	metricType := strings.TrimSpace(req.MetricType)
	if metricType == "" || utf8.RuneCountInString(metricType) > 60 {
		writeErr(w, http.StatusBadRequest, "metric_type must be 1..60 characters")
		return
	}
	if req.Value == nil {
		writeErr(w, http.StatusBadRequest, "value is required")
		return
	}
	recordedOn, ok := parseDay(req.RecordedOn)
	if !ok {
		writeErr(w, http.StatusBadRequest, "recorded_on must be a YYYY-MM-DD date")
		return
	}

	m, err := s.store.createMetric(r.Context(), r.PathValue("uid"), metricType, *req.Value,
		req.Unit, req.Notes, recordedOn)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to create metric")
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *server) deleteMetricHandler(w http.ResponseWriter, r *http.Request) {
	if err := s.store.deleteMetric(r.Context(), r.PathValue("uid"), r.PathValue("id")); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "metric not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete metric")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *server) fitnessStatsHandler(w http.ResponseWriter, r *http.Request) {
	st, err := s.store.fitnessStats(r.Context(), r.PathValue("uid"))
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to compute fitness stats")
		return
	}
	writeJSON(w, http.StatusOK, st)
}
