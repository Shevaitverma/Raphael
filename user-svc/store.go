package main

import (
	"context"
	"errors"
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

// getAssistantName returns the user's per-user assistant name (DEFAULT 'Raphael').
// errNotFound when the user row is absent or uid is not a uuid.
func (s *store) getAssistantName(ctx context.Context, userID string) (string, error) {
	if !validUUID(userID) {
		return "", errNotFound
	}
	var name string
	err := s.pool.QueryRow(ctx,
		`SELECT assistant_name FROM users WHERE id = $1`, userID).Scan(&name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errNotFound
		}
		return "", err
	}
	return name, nil
}

// setAssistantName updates the name scoped by id. Callers trim/validate first;
// the DB CHECK is a backstop. errNotFound when no row matches (missing user or
// non-uuid uid).
func (s *store) setAssistantName(ctx context.Context, userID, name string) error {
	if !validUUID(userID) {
		return errNotFound
	}
	ct, err := s.pool.Exec(ctx,
		`UPDATE users SET assistant_name = $1 WHERE id = $2`, name, userID)
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
