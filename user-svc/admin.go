package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"
)

// Admin surface — allowlist + user management. Every handler here is mounted
// behind requireInternal: the gateway is the ONLY caller and it re-reads the
// caller's role from users.role (never a stale JWT claim) BEFORE proxying. So
// these handlers do NOT re-authorize; the requireInternal secret plus the
// gateway's server-side role check are the gate. They are thin wrappers over the
// store methods, reusing the same writeJSON/writeErr helpers as handlers.go.
//
// No provider/model-config handlers live here on purpose: admin editing of the
// SYSTEM provider config reuses the EXISTING credential handlers, proxied by the
// gateway rooted at SYSTEM_CONFIG_UID instead of the JWT uid.

// normalizeEmail lowercases and validates via the stdlib parser, returning the
// bare address (no display name) so "A@B.com" and "Foo <a@b.com>" both normalize
// to "a@b.com" — one canonical form for the allowlist key and the login match.
// ok is false for anything mail.ParseAddress rejects (blank, no @, etc.).
func normalizeEmail(raw string) (string, bool) {
	addr, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	return strings.ToLower(addr.Address), true
}

// validRole mirrors the users.role CHECK so a bad role is a clean 400 here, never
// a DB CHECK surfacing as a 500.
func validRole(role string) bool {
	return role == "admin" || role == "member"
}

type emailReq struct {
	Email string `json:"email"`
}

// allowlistAdd adds an email to the sign-in allowlist. Adding the email is what
// permits that person's first Google login to become a member (fail closed:
// uninvited emails are rejected at the callback). Idempotent at the store layer.
func (s *server) allowlistAdd(w http.ResponseWriter, r *http.Request) {
	var req emailReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		writeErr(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	if err := s.store.allowlistAdd(r.Context(), email); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to add to allowlist")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"email": email})
}

// allowlistList returns every allowlisted email. No secrets, so it is a plain
// pass-through of the store rows.
func (s *server) allowlistList(w http.ResponseWriter, r *http.Request) {
	entries, err := s.store.allowlistList(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to list allowlist")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"allowlist": entries})
}

// allowlistRemove drops an email from the allowlist. The email comes from the
// path and is normalized the same way it was stored so the delete matches. 404
// when the email was not on the list.
func (s *server) allowlistRemove(w http.ResponseWriter, r *http.Request) {
	email, ok := normalizeEmail(r.PathValue("email"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	if err := s.store.allowlistRemove(r.Context(), email); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "email not on the allowlist")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to remove from allowlist")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// usersList returns every user (id/email/role/...) for the admin User Management
// view. No secrets, so it is a plain pass-through of the store rows.
func (s *server) usersList(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.usersList(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

type roleReq struct {
	Role string `json:"role"`
}

// userSetRole promotes/demotes a user. The role is validated in Go (400 on a bad
// value); the store enforces the single-admin invariant and returns errLastAdmin
// when this change would leave zero admins -> 409 (never let the system lock
// itself out of its own admin surface).
func (s *server) userSetRole(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")

	var req roleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !validRole(req.Role) {
		writeErr(w, http.StatusBadRequest, "role must be 'admin' or 'member'")
		return
	}

	if err := s.store.userSetRole(r.Context(), uid, req.Role); err != nil {
		switch {
		case errors.Is(err, errNotFound):
			writeErr(w, http.StatusNotFound, "user not found")
		case errors.Is(err, errLastAdmin):
			writeErr(w, http.StatusConflict, "cannot demote the last admin")
		default:
			writeErr(w, http.StatusInternalServerError, "failed to change role")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": uid, "role": req.Role})
}

// userRemove deletes a user (cascading their isolated data). The store refuses to
// remove protected accounts (DEV_UID / the SYSTEM_CONFIG owner) -> errProtectedUser
// -> 403, returns errNotFound -> 404 when the user does not exist, and errLastAdmin
// -> 409 when removing the target would leave zero loginable admins (mirrors the
// demote guard in userSetRole; the store already refused via tx rollback).
func (s *server) userRemove(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")

	if err := s.store.userRemove(r.Context(), uid); err != nil {
		switch {
		case errors.Is(err, errNotFound):
			writeErr(w, http.StatusNotFound, "user not found")
		case errors.Is(err, errProtectedUser):
			writeErr(w, http.StatusForbidden, "this user is protected and cannot be removed")
		case errors.Is(err, errLastAdmin):
			writeErr(w, http.StatusConflict, "cannot remove the last admin")
		default:
			writeErr(w, http.StatusInternalServerError, "failed to remove user")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
