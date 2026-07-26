package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
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
	ID              string          `json:"id"`
	Category        string          `json:"category"`
	Title           string          `json:"title"`
	DurationMin     *int            `json:"duration_min"`
	Calories        *int            `json:"calories"`
	DistanceKm      *float64        `json:"distance_km"`
	PaceMinKm       *float64        `json:"pace_min_km"`
	AvgHeartRate    *int            `json:"avg_heart_rate"`
	PerceivedEffort *int            `json:"perceived_effort"`
	Exercises       json.RawMessage `json:"exercises"`
	Mood            *string         `json:"mood"`
	Location        *string         `json:"location"`
	Notes           *string         `json:"notes"`
	PerformedOn     string          `json:"performed_on"`
	CreatedAt       time.Time       `json:"created_at"`
}

// performed_on read as text so it marshals as YYYY-MM-DD, not an RFC3339 stamp.
// exercises is a jsonb array scanned raw so it re-marshals as-is.
const workoutCols = `id, category, title, duration_min, calories, distance_km, pace_min_km, avg_heart_rate, perceived_effort, exercises, mood, location, notes, to_char(performed_on, 'YYYY-MM-DD'), created_at`

func scanWorkout(row pgx.Row) (*workout, error) {
	var w workout
	if err := row.Scan(&w.ID, &w.Category, &w.Title, &w.DurationMin, &w.Calories,
		&w.DistanceKm, &w.PaceMinKm, &w.AvgHeartRate, &w.PerceivedEffort, &w.Exercises,
		&w.Mood, &w.Location, &w.Notes, &w.PerformedOn, &w.CreatedAt); err != nil {
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

type weekPoint struct {
	WeekStart string `json:"week_start"`
	Count     int    `json:"count"`
}

type catCount struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

type fitnessStats struct {
	WorkoutsThisWeek int          `json:"workouts_this_week"`
	StreakDays       int          `json:"streak_days"`
	LongestStreak    int          `json:"longest_streak"`
	TotalWorkouts    int          `json:"total_workouts"`
	AvgPerWeek       float64      `json:"avg_per_week"`
	AvgDurationMin   float64      `json:"avg_duration_min"`
	LatestWeight     *metricBrief `json:"latest_weight"`
	WeightTrend30d   *float64     `json:"weight_trend_30d"`
	Weekly           []weekPoint  `json:"weekly"`
	ByCategory       []catCount   `json:"by_category"`
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
// performedOn -> COALESCE falls to today's date (the DB default). exercises is a
// jsonb array passed through verbatim (empty -> '[]'). After a successful insert
// goals are recomputed best-effort (a recompute failure must not fail the log).
func (s *store) createWorkout(ctx context.Context, userID, title, category string,
	durationMin, calories, avgHeartRate, perceivedEffort *int, distanceKm, paceMinKm *float64,
	exercises json.RawMessage, mood, location, notes *string, performedOn *time.Time) (*workout, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	if len(exercises) == 0 {
		exercises = json.RawMessage("[]")
	}
	wk, err := scanWorkout(s.pool.QueryRow(ctx, `
		INSERT INTO workouts (user_id, title, category, duration_min, calories, distance_km,
			pace_min_km, avg_heart_rate, perceived_effort, exercises, mood, location, notes, performed_on)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::date, now()::date))
		RETURNING `+workoutCols, userID, title, category, durationMin, calories, distanceKm,
		paceMinKm, avgHeartRate, perceivedEffort, exercises, mood, location, notes, performedOn))
	if err != nil {
		return nil, err
	}
	_ = s.recomputeGoals(ctx, userID) // best-effort: never fail the log on a recompute error
	return wk, nil
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
	m, err := scanMetric(s.pool.QueryRow(ctx, `
		INSERT INTO body_metrics (user_id, metric_type, value, unit, notes, recorded_on)
		VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, now()::date))
		RETURNING `+metricCols, userID, metricType, value, unit, notes, recordedOn))
	if err != nil {
		return nil, err
	}
	_ = s.recomputeGoals(ctx, userID) // best-effort: a metric_target goal may now be achieved
	return m, nil
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

	// avg_duration_min: mean of workouts that recorded a positive duration.
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(avg(duration_min), 0)
		FROM workouts WHERE user_id = $1 AND duration_min > 0`, userID).Scan(&st.AvgDurationMin); err != nil {
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
		// weight_trend_30d: latest weight minus the most-recent weight older than
		// 30 days. Null (left nil) if there is no such older reading.
		var older float64
		e := s.pool.QueryRow(ctx, `
			SELECT value FROM body_metrics
			WHERE user_id = $1 AND metric_type = 'weight' AND recorded_on < current_date - 30
			ORDER BY recorded_on DESC, created_at DESC
			LIMIT 1`, userID).Scan(&older)
		if e == nil {
			trend := mb.Value - older
			st.WeightTrend30d = &trend
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return st, e
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return st, err
	}

	// weekly: last 12 ISO weeks (Mon-anchored), oldest→newest, zero-filled via a
	// generate_series left-joined onto the per-week counts.
	st.Weekly = []weekPoint{}
	wrows, err := s.pool.Query(ctx, `
		SELECT to_char(g.wk, 'YYYY-MM-DD'), COALESCE(x.c, 0)
		FROM generate_series(
			date_trunc('week', current_date) - interval '11 weeks',
			date_trunc('week', current_date),
			interval '1 week') g(wk)
		LEFT JOIN (
			SELECT date_trunc('week', performed_on) w, count(*) c
			FROM workouts WHERE user_id = $1 GROUP BY w
		) x ON x.w = g.wk
		ORDER BY g.wk`, userID)
	if err != nil {
		return st, err
	}
	var weeklyTotal int
	for wrows.Next() {
		var wp weekPoint
		if err := wrows.Scan(&wp.WeekStart, &wp.Count); err != nil {
			wrows.Close()
			return st, err
		}
		weeklyTotal += wp.Count
		st.Weekly = append(st.Weekly, wp)
	}
	if err := wrows.Err(); err != nil {
		wrows.Close()
		return st, err
	}
	wrows.Close()
	st.AvgPerWeek = float64(weeklyTotal) / 12

	// by_category: lifetime count per category, busiest first.
	st.ByCategory = []catCount{}
	crows, err := s.pool.Query(ctx, `
		SELECT category, count(*) FROM workouts WHERE user_id = $1
		GROUP BY category ORDER BY count(*) DESC, category`, userID)
	if err != nil {
		return st, err
	}
	for crows.Next() {
		var cc catCount
		if err := crows.Scan(&cc.Category, &cc.Count); err != nil {
			crows.Close()
			return st, err
		}
		st.ByCategory = append(st.ByCategory, cc)
	}
	if err := crows.Err(); err != nil {
		crows.Close()
		return st, err
	}
	crows.Close()

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
	st.LongestStreak = longestStreak(days)
	return st, nil
}

// longestStreak is the longest run of consecutive calendar days in the set.
// Input is distinct YYYY-MM-DD days (any order; newest-first here). Order-free:
// it sorts a copy internally-free by comparing parsed dates pairwise after sort.
func longestStreak(days []string) int {
	if len(days) == 0 {
		return 0
	}
	const layout = "2006-01-02"
	ts := make([]time.Time, 0, len(days))
	for _, d := range days {
		t, err := time.Parse(layout, d)
		if err != nil {
			continue
		}
		ts = append(ts, t)
	}
	if len(ts) == 0 {
		return 0
	}
	// Ascending sort so consecutive days sit next to each other.
	for i := 1; i < len(ts); i++ {
		for j := i; j > 0 && ts[j].Before(ts[j-1]); j-- {
			ts[j], ts[j-1] = ts[j-1], ts[j]
		}
	}
	best, run := 1, 1
	for i := 1; i < len(ts); i++ {
		switch int(ts[i].Sub(ts[i-1]).Hours()) / 24 {
		case 0:
			continue // duplicate day (shouldn't occur; distinct) — ignore
		case 1:
			run++
		default:
			run = 1
		}
		if run > best {
			best = run
		}
	}
	return best
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
	Title           string          `json:"title"`
	Category        string          `json:"category"`
	DurationMin     *int            `json:"duration_min"`
	Calories        *int            `json:"calories"`
	DistanceKm      *float64        `json:"distance_km"`
	PaceMinKm       *float64        `json:"pace_min_km"`
	AvgHeartRate    *int            `json:"avg_heart_rate"`
	PerceivedEffort *int            `json:"perceived_effort"`
	Exercises       json.RawMessage `json:"exercises"`
	Mood            *string         `json:"mood"`
	Location        *string         `json:"location"`
	Notes           *string         `json:"notes"`
	PerformedOn     string          `json:"performed_on"`
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
	// RPE is a 1..10 scale — validate in Go so a bad value is a clean 400.
	if req.PerceivedEffort != nil && (*req.PerceivedEffort < 1 || *req.PerceivedEffort > 10) {
		writeErr(w, http.StatusBadRequest, "perceived_effort must be between 1 and 10")
		return
	}

	wk, err := s.store.createWorkout(r.Context(), r.PathValue("uid"), title, category,
		req.DurationMin, req.Calories, req.AvgHeartRate, req.PerceivedEffort, req.DistanceKm, req.PaceMinKm,
		req.Exercises, req.Mood, req.Location, req.Notes, performedOn)
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

// ============================================================================
// GOAL RECOMPUTE — the load-bearing logic (see the build contract).
// ============================================================================

// goalCalc is the minimal slice of an active goal needed to recompute it.
type goalCalc struct {
	id         string
	goalType   string
	target     float64
	direction  string
	metricType *string
	category   *string
}

// recomputeGoals refreshes current_value for every active goal and flips status to
// 'achieved' once the direction test passes (never auto-un-achieves). It locks the
// user's active goals FOR UPDATE in id order (deterministic, per-user serialize) so
// concurrent logs can't interleave. Called at the end of every workout/metric/meal
// create (best-effort — the caller ignores the error) and inside create/updateGoal.
// A metric_target goal with no reading yet is left untouched (never phantom-0 achieved).
func (s *store) recomputeGoals(ctx context.Context, userID string) (err error) {
	// Callers invoke this best-effort (they ignore the return), so log any failure
	// here — otherwise a broken recompute (e.g. a SQL error) is invisible and goal
	// progress silently freezes, which is exactly how the FOR-UPDATE/ORDER-BY order
	// bug hid until a live test caught it.
	defer func() {
		if err != nil {
			slog.Error("recomputeGoals failed", "user_id", userID, "err", err.Error())
		}
	}()
	if !validUUID(userID) {
		return errNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, goal_type, target_value, direction, metric_type, category
		FROM fitness_goals WHERE user_id = $1 AND status = 'active'
		ORDER BY id FOR UPDATE`, userID)
	if err != nil {
		return err
	}
	var goals []goalCalc
	for rows.Next() {
		var g goalCalc
		if err := rows.Scan(&g.id, &g.goalType, &g.target, &g.direction, &g.metricType, &g.category); err != nil {
			rows.Close()
			return err
		}
		goals = append(goals, g)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, g := range goals {
		cur, ok, err := s.goalCurrent(ctx, tx, userID, g)
		if err != nil {
			return err
		}
		if !ok {
			continue // no basis to update — leave current_value + status untouched
		}
		achieved := false
		switch g.direction {
		case "gte":
			achieved = cur >= g.target
		case "lte":
			achieved = cur <= g.target
		case "eq":
			achieved = math.Abs(cur-g.target) < 0.01
		}
		if achieved {
			if _, err := tx.Exec(ctx, `
				UPDATE fitness_goals SET current_value = $2, status = 'achieved', updated_at = now()
				WHERE id = $1`, g.id, cur); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE fitness_goals SET current_value = $2 WHERE id = $1`, g.id, cur); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// goalCurrent computes a goal's live current_value. ok=false means "no basis to
// update" (metric_target with no reading, duration with no workouts) so the caller
// leaves current_value unchanged and skips the achieved test.
func (s *store) goalCurrent(ctx context.Context, tx pgx.Tx, userID string, g goalCalc) (float64, bool, error) {
	switch g.goalType {
	case "frequency":
		cat := ""
		if g.category != nil {
			cat = *g.category
		}
		var n int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM workouts
			WHERE user_id = $1 AND performed_on >= date_trunc('week', now())::date
			  AND ($2 = '' OR category = $2)`, userID, cat).Scan(&n); err != nil {
			return 0, false, err
		}
		return float64(n), true, nil
	case "metric_target":
		if g.metricType == nil || strings.TrimSpace(*g.metricType) == "" {
			return 0, false, nil
		}
		var v float64
		err := tx.QueryRow(ctx, `
			SELECT value FROM body_metrics WHERE user_id = $1 AND metric_type = $2
			ORDER BY recorded_on DESC, created_at DESC LIMIT 1`, userID, *g.metricType).Scan(&v)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		if err != nil {
			return 0, false, err
		}
		return v, true, nil
	case "streak":
		n, err := s.currentStreak(ctx, tx, userID)
		if err != nil {
			return 0, false, err
		}
		return float64(n), true, nil
	case "duration":
		var avg *float64
		if err := tx.QueryRow(ctx, `
			SELECT avg(duration_min) FROM (
				SELECT duration_min FROM workouts WHERE user_id = $1
				ORDER BY performed_on DESC, created_at DESC LIMIT 7) t`, userID).Scan(&avg); err != nil {
			return 0, false, err
		}
		if avg == nil {
			return 0, false, nil
		}
		return *avg, true, nil
	}
	return 0, false, nil
}

// currentStreak counts consecutive calendar days ending TODAY with >=1 workout
// (today-with-none => 0). Stricter than the stats streak, which also counts a run
// ending yesterday.
func (s *store) currentStreak(ctx context.Context, tx pgx.Tx, userID string) (int, error) {
	var today string
	if err := tx.QueryRow(ctx, `SELECT to_char(current_date, 'YYYY-MM-DD')`).Scan(&today); err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `
		SELECT to_char(performed_on, 'YYYY-MM-DD')
		FROM (SELECT DISTINCT performed_on FROM workouts WHERE user_id = $1) d
		ORDER BY performed_on DESC`, userID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var days []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return 0, err
		}
		days = append(days, d)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	// Must start exactly at today; then streakDays counts the consecutive run.
	if len(days) == 0 || days[0] != today {
		return 0, nil
	}
	return streakDays(today, days), nil
}

// goalProgress computes progress_pct (clamped 0..1) exactly per the contract.
// A nil current_value is 0 progress.
func goalProgress(g *fitnessGoal) float64 {
	if g.CurrentValue == nil {
		return 0
	}
	cur := *g.CurrentValue
	target := g.TargetValue
	clamp := func(x float64) float64 {
		if x < 0 {
			return 0
		}
		if x > 1 {
			return 1
		}
		return x
	}
	switch g.Direction {
	case "eq":
		denom := math.Abs(target)
		if denom == 0 {
			denom = 1
		}
		return clamp(1 - math.Min(1, math.Abs(cur-target)/denom))
	case "lte":
		if g.StartingValue != nil && *g.StartingValue > target {
			return clamp((*g.StartingValue - cur) / (*g.StartingValue - target))
		}
		if cur <= target {
			return 1
		}
		if cur == 0 {
			return 0
		}
		return clamp(target / cur)
	default: // gte
		if g.StartingValue != nil && *g.StartingValue < target {
			return clamp((cur - *g.StartingValue) / (target - *g.StartingValue))
		}
		if target == 0 {
			return 1
		}
		return clamp(cur / target)
	}
}

// ============================================================================
// GOALS store + handlers
// ============================================================================

type fitnessGoal struct {
	ID            string    `json:"id"`
	GoalType      string    `json:"goal_type"`
	Title         string    `json:"title"`
	TargetValue   float64   `json:"target_value"`
	TargetUnit    *string   `json:"target_unit"`
	MetricType    *string   `json:"metric_type"`
	Category      *string   `json:"category"`
	Direction     string    `json:"direction"`
	Deadline      *string   `json:"deadline"`
	Status        string    `json:"status"`
	StartingValue *float64  `json:"starting_value"`
	CurrentValue  *float64  `json:"current_value"`
	ProgressPct   float64   `json:"progress_pct"`
	Notes         *string   `json:"notes"`
	CreatedAt     time.Time `json:"created_at"`
}

const goalCols = `id, goal_type, title, target_value, target_unit, metric_type, category, direction, to_char(deadline, 'YYYY-MM-DD'), status, starting_value, current_value, notes, created_at`

func scanGoal(row pgx.Row) (*fitnessGoal, error) {
	var g fitnessGoal
	if err := row.Scan(&g.ID, &g.GoalType, &g.Title, &g.TargetValue, &g.TargetUnit, &g.MetricType,
		&g.Category, &g.Direction, &g.Deadline, &g.Status, &g.StartingValue, &g.CurrentValue,
		&g.Notes, &g.CreatedAt); err != nil {
		return nil, err
	}
	g.ProgressPct = goalProgress(&g)
	return &g, nil
}

func (s *store) listGoals(ctx context.Context, userID, status string) ([]fitnessGoal, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+goalCols+`
		FROM fitness_goals
		WHERE user_id = $1 AND ($2 = '' OR status = $2)
		ORDER BY created_at DESC`, userID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []fitnessGoal{}
	for rows.Next() {
		g, err := scanGoal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	return out, rows.Err()
}

func (s *store) getGoal(ctx context.Context, userID, id string) (*fitnessGoal, error) {
	if !validUUID(userID) || !validUUID(id) {
		return nil, errNotFound
	}
	g, err := scanGoal(s.pool.QueryRow(ctx, `SELECT `+goalCols+` FROM fitness_goals WHERE id = $1 AND user_id = $2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return g, err
}

// createGoal inserts a goal, seeding current_value from starting_value (so a
// decreasing goal's bar doesn't render ~100%), inferring direction when the caller
// omitted it, then recomputing (best-effort) before returning the fresh row.
func (s *store) createGoal(ctx context.Context, userID, goalType, title string, targetValue float64,
	targetUnit, metricType, category *string, direction string, startingValue *float64,
	deadline *time.Time, notes *string) (*fitnessGoal, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	dir := strings.TrimSpace(direction)
	if dir == "" {
		dir = "gte"
		if startingValue != nil {
			if targetValue < *startingValue {
				dir = "lte"
			} else if targetValue > *startingValue {
				dir = "gte"
			}
		}
	}
	var id string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO fitness_goals (user_id, goal_type, title, target_value, target_unit, metric_type,
			category, direction, deadline, starting_value, current_value, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $10, $11)
		RETURNING id`, userID, goalType, title, targetValue, targetUnit, metricType, category, dir,
		deadline, startingValue, notes).Scan(&id); err != nil {
		return nil, err
	}
	_ = s.recomputeGoals(ctx, userID)
	return s.getGoal(ctx, userID, id)
}

// goalUpdatable is the fixed allow-list (and column order) for a PATCH — the map
// keys come from validated request fields, never raw client strings, so no SQL
// injection surface.
var goalUpdatable = []string{"title", "target_value", "target_unit", "direction", "starting_value", "deadline", "status", "category", "metric_type"}

func (s *store) updateGoal(ctx context.Context, userID, id string, fields map[string]any) (*fitnessGoal, error) {
	if !validUUID(userID) || !validUUID(id) {
		return nil, errNotFound
	}
	if len(fields) > 0 {
		set := "updated_at = now()"
		args := []any{id, userID}
		n := 3
		for _, col := range goalUpdatable {
			if v, ok := fields[col]; ok {
				set += ", " + col + " = $" + strconv.Itoa(n)
				args = append(args, v)
				n++
			}
		}
		ct, err := s.pool.Exec(ctx, `UPDATE fitness_goals SET `+set+` WHERE id = $1 AND user_id = $2`, args...)
		if err != nil {
			return nil, err
		}
		if ct.RowsAffected() == 0 {
			return nil, errNotFound
		}
	}
	_ = s.recomputeGoals(ctx, userID)
	return s.getGoal(ctx, userID, id)
}

func (s *store) deleteGoal(ctx context.Context, userID, id string) error {
	if !validUUID(userID) || !validUUID(id) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `DELETE FROM fitness_goals WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

var goalTypes = map[string]bool{"frequency": true, "metric_target": true, "streak": true, "duration": true}
var goalDirections = map[string]bool{"gte": true, "lte": true, "eq": true}
var goalStatuses = map[string]bool{"active": true, "achieved": true, "abandoned": true}

func (s *server) listGoalsHandler(w http.ResponseWriter, r *http.Request) {
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !goalStatuses[status] {
		writeErr(w, http.StatusBadRequest, "status must be active, achieved, or abandoned")
		return
	}
	gs, err := s.store.listGoals(r.Context(), r.PathValue("uid"), status)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list goals")
		return
	}
	writeJSON(w, http.StatusOK, gs)
}

type createGoalReq struct {
	GoalType      string   `json:"goal_type"`
	Title         string   `json:"title"`
	TargetValue   *float64 `json:"target_value"`
	TargetUnit    *string  `json:"target_unit"`
	MetricType    *string  `json:"metric_type"`
	Category      *string  `json:"category"`
	Direction     string   `json:"direction"`
	StartingValue *float64 `json:"starting_value"`
	Deadline      string   `json:"deadline"`
	Notes         *string  `json:"notes"`
}

func (s *server) createGoalHandler(w http.ResponseWriter, r *http.Request) {
	var req createGoalReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !goalTypes[req.GoalType] {
		writeErr(w, http.StatusBadRequest, "goal_type must be frequency, metric_target, streak, or duration")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" || utf8.RuneCountInString(title) > 200 {
		writeErr(w, http.StatusBadRequest, "title must be 1..200 characters")
		return
	}
	if req.TargetValue == nil {
		writeErr(w, http.StatusBadRequest, "target_value is required")
		return
	}
	if req.Direction != "" && !goalDirections[req.Direction] {
		writeErr(w, http.StatusBadRequest, "direction must be gte, lte, or eq")
		return
	}
	deadline, ok := parseDay(req.Deadline)
	if !ok {
		writeErr(w, http.StatusBadRequest, "deadline must be a YYYY-MM-DD date")
		return
	}
	g, err := s.store.createGoal(r.Context(), r.PathValue("uid"), req.GoalType, title, *req.TargetValue,
		req.TargetUnit, req.MetricType, req.Category, req.Direction, req.StartingValue, deadline, req.Notes)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to create goal")
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

type updateGoalReq struct {
	Title         *string  `json:"title"`
	TargetValue   *float64 `json:"target_value"`
	TargetUnit    *string  `json:"target_unit"`
	Direction     *string  `json:"direction"`
	StartingValue *float64 `json:"starting_value"`
	Deadline      *string  `json:"deadline"`
	Status        *string  `json:"status"`
	Category      *string  `json:"category"`
	MetricType    *string  `json:"metric_type"`
}

func (s *server) updateGoalHandler(w http.ResponseWriter, r *http.Request) {
	var req updateGoalReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	fields := map[string]any{}
	if req.Title != nil {
		t := strings.TrimSpace(*req.Title)
		if t == "" || utf8.RuneCountInString(t) > 200 {
			writeErr(w, http.StatusBadRequest, "title must be 1..200 characters")
			return
		}
		fields["title"] = t
	}
	if req.TargetValue != nil {
		fields["target_value"] = *req.TargetValue
	}
	if req.TargetUnit != nil {
		fields["target_unit"] = *req.TargetUnit
	}
	if req.Direction != nil {
		if !goalDirections[*req.Direction] {
			writeErr(w, http.StatusBadRequest, "direction must be gte, lte, or eq")
			return
		}
		fields["direction"] = *req.Direction
	}
	if req.StartingValue != nil {
		fields["starting_value"] = *req.StartingValue
	}
	if req.Deadline != nil {
		d, ok := parseDay(*req.Deadline)
		if !ok {
			writeErr(w, http.StatusBadRequest, "deadline must be a YYYY-MM-DD date")
			return
		}
		fields["deadline"] = d
	}
	if req.Status != nil {
		if !goalStatuses[*req.Status] {
			writeErr(w, http.StatusBadRequest, "status must be active, achieved, or abandoned")
			return
		}
		fields["status"] = *req.Status
	}
	if req.Category != nil {
		fields["category"] = *req.Category
	}
	if req.MetricType != nil {
		fields["metric_type"] = *req.MetricType
	}
	g, err := s.store.updateGoal(r.Context(), r.PathValue("uid"), r.PathValue("id"), fields)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "goal not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update goal")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *server) deleteGoalHandler(w http.ResponseWriter, r *http.Request) {
	if err := s.store.deleteGoal(r.Context(), r.PathValue("uid"), r.PathValue("id")); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "goal not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete goal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// ============================================================================
// BMI — derived from the latest weight + height metrics.
// ============================================================================

// latestBodyValue returns the most recent reading of a metric type with its
// lower-cased unit. ok=false when the user has no such reading.
func (s *store) latestBodyValue(ctx context.Context, userID, metricType string) (value float64, unit string, ok bool, err error) {
	if !validUUID(userID) {
		return 0, "", false, errNotFound
	}
	var u *string
	err = s.pool.QueryRow(ctx, `
		SELECT value, unit FROM body_metrics WHERE user_id = $1 AND metric_type = $2
		ORDER BY recorded_on DESC, created_at DESC LIMIT 1`, userID, metricType).Scan(&value, &u)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", false, nil
	}
	if err != nil {
		return 0, "", false, err
	}
	if u != nil {
		unit = strings.ToLower(strings.TrimSpace(*u))
	}
	return value, unit, true, nil
}

func (s *server) bmiHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	wVal, wUnit, wok, err := s.store.latestBodyValue(r.Context(), uid, "weight")
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read metrics")
		return
	}
	hVal, hUnit, hok, err := s.store.latestBodyValue(r.Context(), uid, "height")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to read metrics")
		return
	}
	if !wok || !hok {
		writeJSON(w, http.StatusOK, map[string]any{"bmi": nil, "reason": "missing_measurements"})
		return
	}
	weightKg := wVal
	if wUnit == "lb" || wUnit == "lbs" {
		weightKg = wVal * 0.45359237
	}
	heightCm := hVal
	if hUnit == "in" || hUnit == "inch" || hUnit == "inches" {
		heightCm = hVal * 2.54
	}
	if heightCm <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"bmi": nil, "reason": "missing_measurements"})
		return
	}
	m := heightCm / 100
	bmi := math.Round(weightKg/(m*m)*100) / 100
	category := "obese"
	switch {
	case bmi < 18.5:
		category = "underweight"
	case bmi < 25:
		category = "normal"
	case bmi < 30:
		category = "overweight"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"bmi": bmi, "category": category, "weight_kg": weightKg, "height_cm": heightCm})
}

// ============================================================================
// NUTRITION store + handlers
// ============================================================================

type meal struct {
	ID        string    `json:"id"`
	MealType  *string   `json:"meal_type"`
	ItemsText string    `json:"items_text"`
	Calories  *int      `json:"calories"`
	ProteinG  *float64  `json:"protein_g"`
	CarbsG    *float64  `json:"carbs_g"`
	FatG      *float64  `json:"fat_g"`
	FiberG    *float64  `json:"fiber_g"`
	WaterMl   *int      `json:"water_ml"`
	Notes     *string   `json:"notes"`
	LoggedOn  string    `json:"logged_on"`
	LoggedAt  time.Time `json:"logged_at"`
}

const mealCols = `id, meal_type, items_text, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml, notes, to_char(logged_on, 'YYYY-MM-DD'), logged_at`

func scanMeal(row pgx.Row) (*meal, error) {
	var m meal
	if err := row.Scan(&m.ID, &m.MealType, &m.ItemsText, &m.Calories, &m.ProteinG, &m.CarbsG,
		&m.FatG, &m.FiberG, &m.WaterMl, &m.Notes, &m.LoggedOn, &m.LoggedAt); err != nil {
		return nil, err
	}
	return &m, nil
}

// listMeals returns the user's meals, optionally bounded by a date window
// (from/to as YYYY-MM-DD; "" = unbounded on that side).
func (s *store) listMeals(ctx context.Context, userID, from, to string) ([]meal, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+mealCols+`
		FROM nutrition_log
		WHERE user_id = $1
		  AND ($2 = '' OR logged_on >= $2::date)
		  AND ($3 = '' OR logged_on <= $3::date)
		ORDER BY logged_on DESC, logged_at DESC`, userID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []meal{}
	for rows.Next() {
		m, err := scanMeal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// createMeal inserts a meal then recomputes goals best-effort (a recompute error
// must not fail the log).
func (s *store) createMeal(ctx context.Context, userID, itemsText string, mealType *string,
	calories *int, proteinG, carbsG, fatG, fiberG *float64, waterMl *int, notes *string,
	loggedOn *time.Time) (*meal, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	m, err := scanMeal(s.pool.QueryRow(ctx, `
		INSERT INTO nutrition_log (user_id, items_text, meal_type, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml, notes, logged_on)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::date, now()::date))
		RETURNING `+mealCols, userID, itemsText, mealType, calories, proteinG, carbsG, fatG, fiberG, waterMl, notes, loggedOn))
	if err != nil {
		return nil, err
	}
	_ = s.recomputeGoals(ctx, userID)
	return m, nil
}

// patchMeal updates the mutable fields of a meal. Only provided (non-nil) fields
// change; the allow-list keeps the dynamic SET injection-free.
var mealUpdatable = []string{"meal_type", "items_text", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "water_ml", "notes", "logged_on"}

func (s *store) patchMeal(ctx context.Context, userID, id string, fields map[string]any) (*meal, error) {
	if !validUUID(userID) || !validUUID(id) {
		return nil, errNotFound
	}
	if len(fields) == 0 {
		m, err := scanMeal(s.pool.QueryRow(ctx, `SELECT `+mealCols+` FROM nutrition_log WHERE id = $1 AND user_id = $2`, id, userID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return m, err
	}
	set := ""
	args := []any{id, userID}
	n := 3
	for _, col := range mealUpdatable {
		if v, ok := fields[col]; ok {
			if set != "" {
				set += ", "
			}
			set += col + " = $" + strconv.Itoa(n)
			args = append(args, v)
			n++
		}
	}
	m, err := scanMeal(s.pool.QueryRow(ctx, `UPDATE nutrition_log SET `+set+` WHERE id = $1 AND user_id = $2 RETURNING `+mealCols, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return m, err
}

func (s *store) deleteMeal(ctx context.Context, userID, id string) error {
	if !validUUID(userID) || !validUUID(id) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `DELETE FROM nutrition_log WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

type nutritionToday struct {
	Calories float64 `json:"calories"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
	FiberG   float64 `json:"fiber_g"`
	WaterMl  float64 `json:"water_ml"`
}

type nutritionWeekAvg struct {
	Calories float64 `json:"calories"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

type nutritionStats struct {
	Today      nutritionToday   `json:"today"`
	WeekAvg    nutritionWeekAvg `json:"week_avg"`
	Targets    json.RawMessage  `json:"targets"`
	MealsToday int              `json:"meals_today"`
}

// nutritionStats rolls up today's macro sums, the 14-day average of per-DAY sums,
// the configured targets ({} if unset), and today's meal count.
func (s *store) nutritionStats(ctx context.Context, userID string) (nutritionStats, error) {
	var ns nutritionStats
	if !validUUID(userID) {
		return ns, errNotFound
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(calories),0), COALESCE(sum(protein_g),0), COALESCE(sum(carbs_g),0),
		       COALESCE(sum(fat_g),0), COALESCE(sum(fiber_g),0), COALESCE(sum(water_ml),0), count(*)
		FROM nutrition_log WHERE user_id = $1 AND logged_on = current_date`, userID).Scan(
		&ns.Today.Calories, &ns.Today.ProteinG, &ns.Today.CarbsG, &ns.Today.FatG,
		&ns.Today.FiberG, &ns.Today.WaterMl, &ns.MealsToday); err != nil {
		return ns, err
	}
	// Average of the per-day totals across the last 14 days (days with no meals are
	// not counted — the average is over days that have entries).
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(avg(dc),0), COALESCE(avg(dp),0), COALESCE(avg(dca),0), COALESCE(avg(df),0)
		FROM (
			SELECT sum(calories) dc, sum(protein_g) dp, sum(carbs_g) dca, sum(fat_g) df
			FROM nutrition_log WHERE user_id = $1 AND logged_on >= current_date - 13
			GROUP BY logged_on) d`, userID).Scan(
		&ns.WeekAvg.Calories, &ns.WeekAvg.ProteinG, &ns.WeekAvg.CarbsG, &ns.WeekAvg.FatG); err != nil {
		return ns, err
	}
	// Targets from config; {} when the user has no config row yet.
	ns.Targets = json.RawMessage("{}")
	var t json.RawMessage
	err := s.pool.QueryRow(ctx, `SELECT daily_macro_targets FROM fitness_config WHERE user_id = $1`, userID).Scan(&t)
	if err == nil && len(t) > 0 {
		ns.Targets = t
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ns, err
	}
	return ns, nil
}

func (s *server) listMealsHandler(w http.ResponseWriter, r *http.Request) {
	from := strings.TrimSpace(r.URL.Query().Get("date_from"))
	to := strings.TrimSpace(r.URL.Query().Get("date_to"))
	if _, ok := parseDay(from); !ok {
		writeErr(w, http.StatusBadRequest, "date_from must be a YYYY-MM-DD date")
		return
	}
	if _, ok := parseDay(to); !ok {
		writeErr(w, http.StatusBadRequest, "date_to must be a YYYY-MM-DD date")
		return
	}
	ms, err := s.store.listMeals(r.Context(), r.PathValue("uid"), from, to)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list meals")
		return
	}
	writeJSON(w, http.StatusOK, ms)
}

type createMealReq struct {
	ItemsText string   `json:"items_text"`
	MealType  *string  `json:"meal_type"`
	Calories  *int     `json:"calories"`
	ProteinG  *float64 `json:"protein_g"`
	CarbsG    *float64 `json:"carbs_g"`
	FatG      *float64 `json:"fat_g"`
	FiberG    *float64 `json:"fiber_g"`
	WaterMl   *int     `json:"water_ml"`
	Notes     *string  `json:"notes"`
	LoggedOn  string   `json:"logged_on"`
}

func (s *server) createMealHandler(w http.ResponseWriter, r *http.Request) {
	var req createMealReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	items := strings.TrimSpace(req.ItemsText)
	if items == "" || utf8.RuneCountInString(items) > 500 {
		writeErr(w, http.StatusBadRequest, "items_text must be 1..500 characters")
		return
	}
	loggedOn, ok := parseDay(req.LoggedOn)
	if !ok {
		writeErr(w, http.StatusBadRequest, "logged_on must be a YYYY-MM-DD date")
		return
	}
	m, err := s.store.createMeal(r.Context(), r.PathValue("uid"), items, req.MealType, req.Calories,
		req.ProteinG, req.CarbsG, req.FatG, req.FiberG, req.WaterMl, req.Notes, loggedOn)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to create meal")
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

type patchMealReq struct {
	ItemsText *string  `json:"items_text"`
	MealType  *string  `json:"meal_type"`
	Calories  *int     `json:"calories"`
	ProteinG  *float64 `json:"protein_g"`
	CarbsG    *float64 `json:"carbs_g"`
	FatG      *float64 `json:"fat_g"`
	FiberG    *float64 `json:"fiber_g"`
	WaterMl   *int     `json:"water_ml"`
	Notes     *string  `json:"notes"`
	LoggedOn  *string  `json:"logged_on"`
}

func (s *server) patchMealHandler(w http.ResponseWriter, r *http.Request) {
	var req patchMealReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	fields := map[string]any{}
	if req.ItemsText != nil {
		t := strings.TrimSpace(*req.ItemsText)
		if t == "" || utf8.RuneCountInString(t) > 500 {
			writeErr(w, http.StatusBadRequest, "items_text must be 1..500 characters")
			return
		}
		fields["items_text"] = t
	}
	if req.MealType != nil {
		fields["meal_type"] = *req.MealType
	}
	if req.Calories != nil {
		fields["calories"] = *req.Calories
	}
	if req.ProteinG != nil {
		fields["protein_g"] = *req.ProteinG
	}
	if req.CarbsG != nil {
		fields["carbs_g"] = *req.CarbsG
	}
	if req.FatG != nil {
		fields["fat_g"] = *req.FatG
	}
	if req.FiberG != nil {
		fields["fiber_g"] = *req.FiberG
	}
	if req.WaterMl != nil {
		fields["water_ml"] = *req.WaterMl
	}
	if req.Notes != nil {
		fields["notes"] = *req.Notes
	}
	if req.LoggedOn != nil {
		d, ok := parseDay(*req.LoggedOn)
		if !ok || d == nil {
			writeErr(w, http.StatusBadRequest, "logged_on must be a YYYY-MM-DD date")
			return
		}
		fields["logged_on"] = d
	}
	m, err := s.store.patchMeal(r.Context(), r.PathValue("uid"), r.PathValue("id"), fields)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "meal not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update meal")
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *server) deleteMealHandler(w http.ResponseWriter, r *http.Request) {
	if err := s.store.deleteMeal(r.Context(), r.PathValue("uid"), r.PathValue("id")); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "meal not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete meal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *server) nutritionStatsHandler(w http.ResponseWriter, r *http.Request) {
	ns, err := s.store.nutritionStats(r.Context(), r.PathValue("uid"))
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to compute nutrition stats")
		return
	}
	writeJSON(w, http.StatusOK, ns)
}

// ============================================================================
// FITNESS CONFIG (coach settings) — GET / PUT (upsert)
// ============================================================================

type fitnessConfig struct {
	Enabled           bool            `json:"enabled"`
	CheckinTime       string          `json:"checkin_time"`
	WorkoutSplit      json.RawMessage `json:"workout_split"`
	RestDays          json.RawMessage `json:"rest_days"`
	DailyMacroTargets json.RawMessage `json:"daily_macro_targets"`
	LastCheckinAt     *time.Time      `json:"last_checkin_at"`
	LastWeeklyAt      *time.Time      `json:"last_weekly_at"`
}

// getConfig returns the user's coach config, or the schema defaults when no row
// exists yet (so the UI always has a shape to render).
func (s *store) getConfig(ctx context.Context, userID string) (fitnessConfig, error) {
	fc := fitnessConfig{
		Enabled:           false,
		CheckinTime:       "20:00",
		WorkoutSplit:      json.RawMessage("{}"),
		RestDays:          json.RawMessage("[]"),
		DailyMacroTargets: json.RawMessage("{}"),
	}
	if !validUUID(userID) {
		return fc, errNotFound
	}
	err := s.pool.QueryRow(ctx, `
		SELECT enabled, checkin_time, workout_split, rest_days, daily_macro_targets, last_checkin_at, last_weekly_at
		FROM fitness_config WHERE user_id = $1`, userID).Scan(
		&fc.Enabled, &fc.CheckinTime, &fc.WorkoutSplit, &fc.RestDays, &fc.DailyMacroTargets,
		&fc.LastCheckinAt, &fc.LastWeeklyAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return fc, nil
	}
	return fc, err
}

// putConfig upserts the config, changing only the provided (non-nil) fields via
// COALESCE so a partial PUT leaves the rest intact.
func (s *store) putConfig(ctx context.Context, userID string, enabled *bool, checkinTime *string,
	workoutSplit, restDays, dailyMacroTargets *json.RawMessage) (fitnessConfig, error) {
	var fc fitnessConfig
	if !validUUID(userID) {
		return fc, errNotFound
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO fitness_config (user_id, enabled, checkin_time, workout_split, rest_days, daily_macro_targets)
		VALUES ($1, COALESCE($2, false), COALESCE($3, '20:00'),
			COALESCE($4, '{}'::jsonb), COALESCE($5, '[]'::jsonb), COALESCE($6, '{}'::jsonb))
		ON CONFLICT (user_id) DO UPDATE SET
			enabled = COALESCE($2, fitness_config.enabled),
			checkin_time = COALESCE($3, fitness_config.checkin_time),
			workout_split = COALESCE($4, fitness_config.workout_split),
			rest_days = COALESCE($5, fitness_config.rest_days),
			daily_macro_targets = COALESCE($6, fitness_config.daily_macro_targets)
		RETURNING enabled, checkin_time, workout_split, rest_days, daily_macro_targets, last_checkin_at, last_weekly_at`,
		userID, enabled, checkinTime, workoutSplit, restDays, dailyMacroTargets).Scan(
		&fc.Enabled, &fc.CheckinTime, &fc.WorkoutSplit, &fc.RestDays, &fc.DailyMacroTargets,
		&fc.LastCheckinAt, &fc.LastWeeklyAt)
	return fc, err
}

func (s *server) getConfigHandler(w http.ResponseWriter, r *http.Request) {
	fc, err := s.store.getConfig(r.Context(), r.PathValue("uid"))
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read config")
		return
	}
	writeJSON(w, http.StatusOK, fc)
}

type putConfigReq struct {
	Enabled           *bool            `json:"enabled"`
	CheckinTime       *string          `json:"checkin_time"`
	WorkoutSplit      *json.RawMessage `json:"workout_split"`
	RestDays          *json.RawMessage `json:"rest_days"`
	DailyMacroTargets *json.RawMessage `json:"daily_macro_targets"`
}

func (s *server) putConfigHandler(w http.ResponseWriter, r *http.Request) {
	var req putConfigReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.CheckinTime != nil {
		t := strings.TrimSpace(*req.CheckinTime)
		if _, err := time.Parse("15:04", t); err != nil {
			writeErr(w, http.StatusBadRequest, "checkin_time must be HH:MM (24h)")
			return
		}
		*req.CheckinTime = t
	}
	fc, err := s.store.putConfig(r.Context(), r.PathValue("uid"), req.Enabled, req.CheckinTime,
		req.WorkoutSplit, req.RestDays, req.DailyMacroTargets)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update config")
		return
	}
	writeJSON(w, http.StatusOK, fc)
}
