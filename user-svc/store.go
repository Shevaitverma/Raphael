package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PgError SQLSTATE codes we translate into clean HTTP responses.
const (
	sqlUniqueViolation = "23505" // one_active_credential / one_row_per_user_provider
	sqlCheckViolation  = "23514" // oauth_is_anthropic_only
)

// store wraps the connection pool and the cryptor. It owns all SQL and all
// encrypt/decrypt: no plaintext key ever leaves this file except through the
// dedicated internal-active path.
type store struct {
	pool   *pgxpool.Pool
	crypto *cryptor
}

// credential is the neutral row shape used across the service.
type credential struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Provider  string    `json:"provider"`
	AuthType  string    `json:"auth_type"`
	BaseURL    *string   `json:"base_url"`
	ModelID    string    `json:"model_id"`
	IsActive   bool      `json:"is_active"`
	IsLifeboat bool      `json:"is_lifeboat"`
	CreatedAt  time.Time `json:"created_at"`
}

// listCredentials returns every credential for a user. It never selects
// api_key_enc, so a leak is impossible on this path by construction.
func (s *store) listCredentials(ctx context.Context, userID string) ([]credential, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, provider, auth_type, base_url, model_id, is_active, is_lifeboat, created_at
		FROM provider_credentials
		WHERE user_id = $1
		ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []credential{}
	for rows.Next() {
		var c credential
		if err := rows.Scan(&c.ID, &c.UserID, &c.Provider, &c.AuthType,
			&c.BaseURL, &c.ModelID, &c.IsActive, &c.IsLifeboat, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// createCredential inserts a row, encrypting apiKey when present. When activate
// is true it deactivates the user's other rows in the same transaction first,
// so the partial-unique "one active" index is never violated by this path.
func (s *store) createCredential(ctx context.Context, userID, provider, authType,
	apiKey string, baseURL *string, modelID string, activate bool) (*credential, error) {

	var encKey []byte
	if apiKey != "" {
		b, err := s.crypto.encrypt(apiKey)
		if err != nil {
			return nil, err
		}
		encKey = b
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if activate {
		if _, err := tx.Exec(ctx,
			`UPDATE provider_credentials SET is_active = false WHERE user_id = $1 AND is_active`,
			userID); err != nil {
			return nil, err
		}
	}

	var c credential
	err = tx.QueryRow(ctx, `
		INSERT INTO provider_credentials
			(user_id, provider, auth_type, api_key_enc, base_url, model_id, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, user_id, provider, auth_type, base_url, model_id, is_active, is_lifeboat, created_at`,
		userID, provider, authType, encKey, baseURL, modelID, activate).
		Scan(&c.ID, &c.UserID, &c.Provider, &c.AuthType, &c.BaseURL,
			&c.ModelID, &c.IsActive, &c.IsLifeboat, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

// activateCredential flips is_active for one row, deactivating the user's other
// rows in the same transaction so activating a second credential deactivates
// the first rather than colliding with the one-active index.
func (s *store) activateCredential(ctx context.Context, userID, credID string) (*credential, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Ensure the target belongs to this user before touching anything.
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT true FROM provider_credentials WHERE id = $1 AND user_id = $2`,
		credID, userID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}

	if _, err := tx.Exec(ctx,
		`UPDATE provider_credentials SET is_active = false WHERE user_id = $1 AND is_active`,
		userID); err != nil {
		return nil, err
	}

	var c credential
	err = tx.QueryRow(ctx, `
		UPDATE provider_credentials SET is_active = true, is_lifeboat = false
		WHERE id = $1 AND user_id = $2
		RETURNING id, user_id, provider, auth_type, base_url, model_id, is_active, is_lifeboat, created_at`,
		credID, userID).
		Scan(&c.ID, &c.UserID, &c.Provider, &c.AuthType, &c.BaseURL,
			&c.ModelID, &c.IsActive, &c.IsLifeboat, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

// errLifeboatActive is returned when the caller tries to designate the currently
// active credential as the lifeboat — a row cannot be both the brain and the
// fallback (active_is_not_lifeboat CHECK), and it maps to a clean 409.
var errLifeboatActive = errors.New("credential is active; the active credential cannot also be the lifeboat")

// designateLifeboat marks one credential as the user's lifeboat, clearing any
// prior lifeboat in the same transaction (one_lifeboat_credential is a partial-
// unique index). The target must not be the active row.
func (s *store) designateLifeboat(ctx context.Context, userID, credID string) (*credential, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// The row must belong to the user, and must not be active.
	var isActive bool
	if err := tx.QueryRow(ctx,
		`SELECT is_active FROM provider_credentials WHERE id = $1 AND user_id = $2`,
		credID, userID).Scan(&isActive); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	if isActive {
		return nil, errLifeboatActive
	}

	// Clear any existing lifeboat, then set this one.
	if _, err := tx.Exec(ctx,
		`UPDATE provider_credentials SET is_lifeboat = false WHERE user_id = $1 AND is_lifeboat`,
		userID); err != nil {
		return nil, err
	}

	var c credential
	err = tx.QueryRow(ctx, `
		UPDATE provider_credentials SET is_lifeboat = true
		WHERE id = $1 AND user_id = $2
		RETURNING id, user_id, provider, auth_type, base_url, model_id, is_active, is_lifeboat, created_at`,
		credID, userID).
		Scan(&c.ID, &c.UserID, &c.Provider, &c.AuthType, &c.BaseURL,
			&c.ModelID, &c.IsActive, &c.IsLifeboat, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

// clearLifeboat removes the lifeboat flag from one credential. errNotFound when
// the row does not belong to the user.
func (s *store) clearLifeboat(ctx context.Context, userID, credID string) (*credential, error) {
	var c credential
	err := s.pool.QueryRow(ctx, `
		UPDATE provider_credentials SET is_lifeboat = false
		WHERE id = $1 AND user_id = $2
		RETURNING id, user_id, provider, auth_type, base_url, model_id, is_active, is_lifeboat, created_at`,
		credID, userID).
		Scan(&c.ID, &c.UserID, &c.Provider, &c.AuthType, &c.BaseURL,
			&c.ModelID, &c.IsActive, &c.IsLifeboat, &c.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	return &c, nil
}

// decryptedCredential is the internal-only shape carrying the plaintext key.
type decryptedCredential struct {
	Provider string  `json:"provider"`
	AuthType string  `json:"auth_type"`
	APIKey   string  `json:"api_key"`
	BaseURL  *string `json:"base_url"`
	ModelID  string  `json:"model_id"`
}

// activeDecrypted returns the user's single active credential with the key
// decrypted. errNotFound when there is no active row.
func (s *store) activeDecrypted(ctx context.Context, userID string) (*decryptedCredential, error) {
	return s.oneDecrypted(ctx,
		`SELECT provider, auth_type, api_key_enc, base_url, model_id
		 FROM provider_credentials WHERE user_id = $1 AND is_active`, userID)
}

// lifeboatDecrypted returns the user's DESIGNATED lifeboat credential, decrypted.
// It is whichever row is flagged is_lifeboat — a local Ollama row on a laptop, an
// OpenRouter row in the cloud — never hardcoded to provider='local' (there is no
// localhost Ollama in ECS/K8s). It excludes the active row: falling back to the
// credential that just died is not a fallback. errNotFound when none is set.
func (s *store) lifeboatDecrypted(ctx context.Context, userID string) (*decryptedCredential, error) {
	return s.oneDecrypted(ctx,
		`SELECT provider, auth_type, api_key_enc, base_url, model_id
		 FROM provider_credentials
		 WHERE user_id = $1 AND is_lifeboat AND NOT is_active`, userID)
}

func (s *store) oneDecrypted(ctx context.Context, query, userID string) (*decryptedCredential, error) {
	var d decryptedCredential
	var encKey []byte
	err := s.pool.QueryRow(ctx, query, userID).
		Scan(&d.Provider, &d.AuthType, &encKey, &d.BaseURL, &d.ModelID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	if len(encKey) > 0 {
		pt, err := s.crypto.decrypt(encKey)
		if err != nil {
			return nil, err
		}
		d.APIKey = pt
	}
	return &d, nil
}

// validUUID reports whether s parses as a uuid. The gateway forces uid from the
// JWT, but a malformed one must 404 here, never reach the DB as a 22P02 → 500.
func validUUID(s string) bool {
	var u pgtype.UUID
	return u.Scan(s) == nil
}

// getProfile returns the user's per-user assistant name (DEFAULT 'Raphael') and
// onboarded flag. errNotFound when the user row is absent or uid is not a uuid.
func (s *store) getProfile(ctx context.Context, userID string) (name string, onboarded bool, err error) {
	if !validUUID(userID) {
		return "", false, errNotFound
	}
	err = s.pool.QueryRow(ctx,
		`SELECT assistant_name, onboarded FROM users WHERE id = $1`, userID).Scan(&name, &onboarded)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, errNotFound
		}
		return "", false, err
	}
	return name, onboarded, nil
}

// setProfile updates the name scoped by id, and onboarded too when non-nil (a
// nil onboarded leaves the column untouched, so Settings name edits don't reset
// onboarding). Callers trim/validate the name first; the DB CHECK is a backstop.
// errNotFound when no row matches (missing user or non-uuid uid).
func (s *store) setProfile(ctx context.Context, userID, name string, onboarded *bool) error {
	if !validUUID(userID) {
		return errNotFound
	}
	var ct pgconn.CommandTag
	var err error
	if onboarded != nil {
		ct, err = s.pool.Exec(ctx,
			`UPDATE users SET assistant_name = $1, onboarded = $2 WHERE id = $3`, name, *onboarded, userID)
	} else {
		ct, err = s.pool.Exec(ctx,
			`UPDATE users SET assistant_name = $1 WHERE id = $2`, name, userID)
	}
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// --- google_credentials -----------------------------------------------------
// Same cryptor as provider_credentials: the refresh token is AES-256-GCM at rest
// and is decrypted ONLY on the internal token path. The public status reader
// never selects a token column, so a leak on that path is impossible by
// construction (mirrors listCredentials never selecting api_key_enc).

// googleStatusResult is the PUBLIC shape: booleans + display email + scope names,
// never a token.
type googleStatusResult struct {
	Connected bool     `json:"connected"`
	Email     *string  `json:"email"`
	Scopes    []string `json:"scopes"`
}

// readGoogleStatus reports whether the user has a connected Google account, with
// the display email and granted scopes. It selects no token column. validUUID
// guard -> errNotFound (like getProfile); an absent row is connected:false, 200.
func (s *store) readGoogleStatus(ctx context.Context, userID string) (*googleStatusResult, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	var email *string
	var scopes []string
	err := s.pool.QueryRow(ctx,
		`SELECT google_email, scopes FROM google_credentials WHERE user_id = $1`, userID).
		Scan(&email, &scopes)
	if errors.Is(err, pgx.ErrNoRows) {
		return &googleStatusResult{Connected: false, Scopes: []string{}}, nil
	}
	if err != nil {
		return nil, err
	}
	if scopes == nil {
		scopes = []string{}
	}
	return &googleStatusResult{Connected: true, Email: email, Scopes: scopes}, nil
}

// googleTokenRow is the INTERNAL-only shape carrying decrypted tokens.
type googleTokenRow struct {
	RefreshToken string
	AccessToken  string
	ExpiresAt    *time.Time
	Scopes       []string
}

// readGoogleTokens returns the decrypted tokens for the internal refresh path.
// errNotFound when there is no row (or uid is not a uuid).
func (s *store) readGoogleTokens(ctx context.Context, userID string) (*googleTokenRow, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	var refreshEnc, accessEnc []byte
	var expiresAt *time.Time
	var scopes []string
	err := s.pool.QueryRow(ctx,
		`SELECT refresh_token_enc, access_token_enc, access_token_expires_at, scopes
		 FROM google_credentials WHERE user_id = $1`, userID).
		Scan(&refreshEnc, &accessEnc, &expiresAt, &scopes)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	out := &googleTokenRow{ExpiresAt: expiresAt, Scopes: scopes}
	rt, err := s.crypto.decrypt(refreshEnc)
	if err != nil {
		return nil, err
	}
	out.RefreshToken = rt
	if len(accessEnc) > 0 {
		at, err := s.crypto.decrypt(accessEnc)
		if err != nil {
			return nil, err
		}
		out.AccessToken = at
	}
	return out, nil
}

// upsertGoogle stores (or replaces) the connection after an exchange. Both tokens
// are encrypted before they touch the DB.
func (s *store) upsertGoogle(ctx context.Context, userID, refreshToken, accessToken string,
	expiresAt time.Time, scopes []string, email, sub string) error {
	if !validUUID(userID) {
		return errNotFound
	}
	refreshEnc, err := s.crypto.encrypt(refreshToken)
	if err != nil {
		return err
	}
	var accessEnc []byte
	if accessToken != "" {
		if accessEnc, err = s.crypto.encrypt(accessToken); err != nil {
			return err
		}
	}
	if scopes == nil {
		scopes = []string{}
	}
	var emailPtr, subPtr *string
	if email != "" {
		emailPtr = &email
	}
	if sub != "" {
		subPtr = &sub
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO google_credentials
			(user_id, refresh_token_enc, access_token_enc, access_token_expires_at, scopes, google_email, google_sub, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (user_id) DO UPDATE SET
			refresh_token_enc = EXCLUDED.refresh_token_enc,
			access_token_enc = EXCLUDED.access_token_enc,
			access_token_expires_at = EXCLUDED.access_token_expires_at,
			scopes = EXCLUDED.scopes,
			google_email = EXCLUDED.google_email,
			google_sub = EXCLUDED.google_sub,
			updated_at = now()`,
		userID, refreshEnc, accessEnc, expiresAt, scopes, emailPtr, subPtr)
	return err
}

// updateGoogleAccess persists a refreshed access token (and a rotated refresh
// token when Google returns one — refresh_token_enc is only overwritten when
// newRefresh is non-empty, so an unchanged refresh token is preserved).
func (s *store) updateGoogleAccess(ctx context.Context, userID, accessToken string,
	expiresAt time.Time, newRefresh string, scopes []string) error {
	if !validUUID(userID) {
		return errNotFound
	}
	accessEnc, err := s.crypto.encrypt(accessToken)
	if err != nil {
		return err
	}
	if scopes == nil {
		scopes = []string{}
	}
	if newRefresh != "" {
		refreshEnc, err := s.crypto.encrypt(newRefresh)
		if err != nil {
			return err
		}
		_, err = s.pool.Exec(ctx, `
			UPDATE google_credentials
			SET access_token_enc = $2, access_token_expires_at = $3, refresh_token_enc = $4, scopes = $5, updated_at = now()
			WHERE user_id = $1`, userID, accessEnc, expiresAt, refreshEnc, scopes)
		return err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE google_credentials
		SET access_token_enc = $2, access_token_expires_at = $3, scopes = $4, updated_at = now()
		WHERE user_id = $1`, userID, accessEnc, expiresAt, scopes)
	return err
}

// deleteGoogle removes the connection. Idempotent: no RowsAffected check, so
// deleting when absent is still a success (the handler returns 200).
func (s *store) deleteGoogle(ctx context.Context, userID string) error {
	if !validUUID(userID) {
		return errNotFound
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM google_credentials WHERE user_id = $1`, userID)
	return err
}

// --- tasks -------------------------------------------------------------------
// Per-user application data, no secrets. Every query is scoped WHERE user_id, so
// one user can never read or mutate another's rows. due_date is a Postgres date;
// it round-trips as a *string ("YYYY-MM-DD" or null) via to_char on read and a
// $n::date placeholder on write, which keeps the JSON contract exact without a
// custom time type.

// task is the neutral row shape. due_date is a *string so absent (null) is
// distinct from any real date; created_at/updated_at marshal as RFC3339.
type task struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Notes     string    `json:"notes"`
	Status    string    `json:"status"`
	DueDate   *string   `json:"due_date"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

const taskCols = `id, title, notes, status, to_char(due_date, 'YYYY-MM-DD'), created_at, updated_at`

func scanTask(row pgx.Row) (*task, error) {
	var t task
	if err := row.Scan(&t.ID, &t.Title, &t.Notes, &t.Status, &t.DueDate, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	return &t, nil
}

// listTasks returns the user's tasks ordered open-before-done, then due_date
// ASC NULLS LAST, then newest first. validUUID guard -> errNotFound.
func (s *store) listTasks(ctx context.Context, userID string) ([]task, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+taskCols+`
		FROM tasks
		WHERE user_id = $1
		ORDER BY status = 'done', due_date ASC NULLS LAST, created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// createTask inserts a task for the user. Title is validated by the caller; the
// DB CHECK is only a backstop. dueDate is nil to leave the date unset.
func (s *store) createTask(ctx context.Context, userID, title, notes string, dueDate *string) (*task, error) {
	if !validUUID(userID) {
		return nil, errNotFound
	}
	return scanTask(s.pool.QueryRow(ctx, `
		INSERT INTO tasks (user_id, title, notes, due_date)
		VALUES ($1, $2, $3, $4::date)
		RETURNING `+taskCols, userID, title, notes, dueDate))
}

// updateTask sets only the provided columns (plus updated_at), scoped to the
// owning user. sets maps column name -> value; keys come from a fixed whitelist
// in the handler, so the dynamic SQL carries no user input as identifiers. No
// matching row (wrong id or not owned) -> errNotFound.
func (s *store) updateTask(ctx context.Context, userID, taskID string, sets map[string]any) (*task, error) {
	if !validUUID(userID) || !validUUID(taskID) {
		return nil, errNotFound
	}
	clauses := make([]string, 0, len(sets)+1)
	args := make([]any, 0, len(sets)+2)
	i := 1
	for col, val := range sets {
		ph := fmt.Sprintf("$%d", i)
		if col == "due_date" {
			ph += "::date"
		}
		clauses = append(clauses, col+" = "+ph)
		args = append(args, val)
		i++
	}
	clauses = append(clauses, "updated_at = now()")
	query := fmt.Sprintf(`
		UPDATE tasks SET %s
		WHERE id = $%d AND user_id = $%d
		RETURNING `+taskCols, strings.Join(clauses, ", "), i, i+1)
	args = append(args, taskID, userID)

	t, err := scanTask(s.pool.QueryRow(ctx, query, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return t, err
}

// deleteTask removes one task scoped to the owning user. RowsAffected 0 (wrong
// id or not owned) -> errNotFound.
func (s *store) deleteTask(ctx context.Context, userID, taskID string) error {
	if !validUUID(userID) || !validUUID(taskID) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx, `DELETE FROM tasks WHERE id = $1 AND user_id = $2`, taskID, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// errNotFound signals an absent row so handlers can pick 404 vs 204.
var errNotFound = errors.New("not found")

// pgErrorCode extracts the SQLSTATE from a pgx error, or "" if not a PgError.
func pgErrorCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}
