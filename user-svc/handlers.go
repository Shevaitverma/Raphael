package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

type server struct {
	store *store
	// internalToken guards /internal/* (which returns DECRYPTED keys). Network
	// isolation is not a control in K8s — pods can reach each other — so these
	// endpoints require a shared secret that only the agent service holds.
	internalToken string
}

// requireInternal rejects any /internal/* request lacking the shared secret.
// Constant-time compare so the check can't be timing-probed.
func (s *server) requireInternal(h http.HandlerFunc) http.HandlerFunc {
	want := []byte(s.internalToken)
	return func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("X-Internal-Token"))
		if len(want) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
			writeErr(w, http.StatusUnauthorized, "internal endpoint")
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)

	// Public routes — never return a key.
	mux.HandleFunc("GET /users/{uid}/credentials", s.listCredentials)
	mux.HandleFunc("POST /users/{uid}/credentials", s.createCredential)
	mux.HandleFunc("POST /users/{uid}/credentials/{id}/activate", s.activateCredential)
	mux.HandleFunc("POST /users/{uid}/credentials/{id}/lifeboat", s.designateLifeboat)
	mux.HandleFunc("DELETE /users/{uid}/credentials/{id}/lifeboat", s.clearLifeboat)
	mux.HandleFunc("GET /users/{uid}/profile", s.getProfile)
	mux.HandleFunc("PUT /users/{uid}/profile", s.putProfile)

	// Internal routes — return the decrypted key. Shared-secret gated, and never
	// routed by the gateway.
	mux.HandleFunc("GET /internal/users/{uid}/credential/active", s.requireInternal(s.internalActive))
	mux.HandleFunc("GET /internal/users/{uid}/credential/lifeboat", s.requireInternal(s.internalLifeboat))
	return mux
}

func (s *server) healthz(w http.ResponseWriter, r *http.Request) {
	if err := s.store.pool.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"status": "degraded", "deps": map[string]string{"postgres": "down"}})
		return
	}
	writeJSON(w, http.StatusOK,
		map[string]any{"status": "ok", "deps": map[string]string{"postgres": "ok"}})
}

func (s *server) listCredentials(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	creds, err := s.store.listCredentials(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to list credentials")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credentials": creds})
}

type createCredentialReq struct {
	Provider string  `json:"provider"`
	AuthType string  `json:"auth_type"`
	APIKey   string  `json:"api_key"`
	BaseURL  *string `json:"base_url"`
	ModelID  string  `json:"model_id"`
	Activate bool    `json:"activate"`
}

func (s *server) createCredential(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")

	var req createCredentialReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	switch req.Provider {
	case "anthropic", "openai_compat", "local":
	default:
		writeErr(w, http.StatusBadRequest, "provider must be anthropic, openai_compat, or local")
		return
	}
	switch req.AuthType {
	case "api_key", "oauth":
	default:
		writeErr(w, http.StatusBadRequest, "auth_type must be api_key or oauth")
		return
	}
	if req.ModelID == "" {
		writeErr(w, http.StatusBadRequest, "model_id is required")
		return
	}
	// Mirror the DB CHECK so we return a clean 409 instead of relying on a 500.
	if req.AuthType == "oauth" && req.Provider != "anthropic" {
		writeErr(w, http.StatusConflict, "auth_type 'oauth' is only valid with provider 'anthropic'")
		return
	}

	cred, err := s.store.createCredential(r.Context(), uid, req.Provider, req.AuthType,
		req.APIKey, req.BaseURL, req.ModelID, req.Activate)
	if err != nil {
		s.writeDBError(w, err, "failed to create credential")
		return
	}
	writeJSON(w, http.StatusCreated, cred)
}

func (s *server) activateCredential(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	id := r.PathValue("id")

	cred, err := s.store.activateCredential(r.Context(), uid, id)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "credential not found for this user")
			return
		}
		s.writeDBError(w, err, "failed to activate credential")
		return
	}
	writeJSON(w, http.StatusOK, cred)
}

func (s *server) designateLifeboat(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	id := r.PathValue("id")

	cred, err := s.store.designateLifeboat(r.Context(), uid, id)
	if err != nil {
		switch {
		case errors.Is(err, errNotFound):
			writeErr(w, http.StatusNotFound, "credential not found for this user")
		case errors.Is(err, errLifeboatActive):
			writeErr(w, http.StatusConflict,
				"the active credential cannot also be the lifeboat; pick a different provider as the fallback")
		default:
			s.writeDBError(w, err, "failed to designate lifeboat")
		}
		return
	}
	writeJSON(w, http.StatusOK, cred)
}

func (s *server) clearLifeboat(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	id := r.PathValue("id")

	cred, err := s.store.clearLifeboat(r.Context(), uid, id)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "credential not found for this user")
			return
		}
		s.writeDBError(w, err, "failed to clear lifeboat")
		return
	}
	writeJSON(w, http.StatusOK, cred)
}

func (s *server) getProfile(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	name, onboarded, err := s.store.getProfile(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read profile")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"assistant_name": name, "onboarded": onboarded})
}

type updateProfileReq struct {
	AssistantName string `json:"assistant_name"`
	// Pointer so an absent onboarded is distinguishable from false: nil leaves
	// the flag unchanged (Settings name edits must not reset onboarding).
	Onboarded *bool `json:"onboarded"`
}

func (s *server) putProfile(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")

	var req updateProfileReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	// Validate in Go so the DB CHECK is only a backstop — a CHECK violation must
	// never surface as a 500. char_length counts runes, so match with utf8.
	name := strings.TrimSpace(req.AssistantName)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "assistant_name must not be blank")
		return
	}
	if utf8.RuneCountInString(name) > 40 {
		writeErr(w, http.StatusBadRequest, "assistant_name must be at most 40 characters")
		return
	}

	if err := s.store.setProfile(r.Context(), uid, name, req.Onboarded); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update profile")
		return
	}
	// Echo the persisted onboarded value: the one just set, else the stored one.
	onboarded := false
	if req.Onboarded != nil {
		onboarded = *req.Onboarded
	} else if _, cur, err := s.store.getProfile(r.Context(), uid); err == nil {
		onboarded = cur
	}
	writeJSON(w, http.StatusOK, map[string]any{"assistant_name": name, "onboarded": onboarded})
}

func (s *server) internalActive(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	d, err := s.store.activeDecrypted(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			// No active credential: the agent is disabled until a key is added.
			writeErr(w, http.StatusConflict, "no active credential; add a provider key")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read active credential")
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *server) internalLifeboat(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	d, err := s.store.lifeboatDecrypted(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read lifeboat credential")
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// writeDBError maps Postgres constraint violations to clean 409s instead of 500s.
func (s *server) writeDBError(w http.ResponseWriter, err error, fallback string) {
	switch pgErrorCode(err) {
	case sqlUniqueViolation:
		writeErr(w, http.StatusConflict,
			"credential conflicts with an existing row (one active credential and one row per provider are enforced)")
	case sqlCheckViolation:
		writeErr(w, http.StatusConflict, "credential violates a provider/auth_type rule")
	default:
		writeErr(w, http.StatusInternalServerError, fallback)
	}
}
