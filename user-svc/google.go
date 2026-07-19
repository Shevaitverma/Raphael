package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// googleTokenURL is Google's OAuth2 token endpoint. A package var (not a const)
// so tests can point it at an httptest fake instead of the real Google.
var googleTokenURL = "https://oauth2.googleapis.com/token"

// googleHTTPClient bounds the token-endpoint call so a hung Google can't hang
// the handler indefinitely.
var googleHTTPClient = &http.Client{Timeout: 15 * time.Second}

// googleConfig is read from the environment at request time rather than injected
// through main(), so the feature is inert-not-crashing when unset: user-svc still
// boots and the credential routes work, only the Google endpoints error cleanly.
type googleConfig struct {
	clientID, clientSecret, redirectURI string
}

func loadGoogleConfig() (googleConfig, error) {
	c := googleConfig{
		clientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		clientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		redirectURI:  os.Getenv("GOOGLE_REDIRECT_URI"),
	}
	if c.clientID == "" || c.clientSecret == "" {
		return c, errors.New("Google OAuth is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET unset)")
	}
	return c, nil
}

// googleTokenResp covers both the exchange and refresh responses, and Google's
// error JSON (error/error_description).
type googleTokenResp struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	IDToken      string `json:"id_token"`
	TokenType    string `json:"token_type"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

// postGoogleToken POSTs a form to the token endpoint and decodes the response. It
// always returns the parsed body (even on a Google error) so callers can inspect
// tr.Error (e.g. "invalid_grant") to decide whether the connection was revoked.
func postGoogleToken(ctx context.Context, form url.Values) (*googleTokenResp, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := googleHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tr googleTokenResp
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return nil, fmt.Errorf("decoding Google response: %w", err)
	}
	if tr.Error != "" {
		msg := tr.Error
		if tr.ErrorDesc != "" {
			msg += ": " + tr.ErrorDesc
		}
		return &tr, fmt.Errorf("Google rejected the request (%s)", msg)
	}
	if resp.StatusCode != http.StatusOK {
		return &tr, fmt.Errorf("Google token endpoint returned %d", resp.StatusCode)
	}
	return &tr, nil
}

// idTokenClaims reads email/sub from a Google id_token JWT WITHOUT verifying the
// signature: the token arrived over TLS directly from Google's token endpoint, so
// the channel is the trust boundary. Empty strings when the token is absent or
// malformed (we then simply store no display email). No Gmail/Drive claims.
func idTokenClaims(idToken string) (email, sub string) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return "", ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ""
	}
	var c struct {
		Email string `json:"email"`
		Sub   string `json:"sub"`
	}
	_ = json.Unmarshal(payload, &c)
	return c.Email, c.Sub
}

// googleStatus (PUBLIC): connected + display email + scope names. Never a token.
func (s *server) googleStatus(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	st, err := s.store.readGoogleStatus(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read Google status")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// googleDisconnect (PUBLIC): delete the row. Idempotent — deleting when absent
// still returns 200 {"connected":false}.
func (s *server) googleDisconnect(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if err := s.store.deleteGoogle(r.Context(), uid); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to disconnect Google")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": false})
}

type googleExchangeReq struct {
	Code string `json:"code"`
}

// googleExchange (INTERNAL): trade an authorization code for tokens, store them
// encrypted, and return the connected account email + granted scopes.
func (s *server) googleExchange(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !validUUID(uid) {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	var req googleExchangeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Code == "" {
		writeErr(w, http.StatusBadRequest, "code is required")
		return
	}
	cfg, err := loadGoogleConfig()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", req.Code)
	form.Set("client_id", cfg.clientID)
	form.Set("client_secret", cfg.clientSecret)
	form.Set("redirect_uri", cfg.redirectURI)

	tr, err := postGoogleToken(r.Context(), form)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Google token exchange failed: "+err.Error())
		return
	}
	if tr.RefreshToken == "" {
		// No refresh token = we'd have no durable access. Happens when the user
		// already consented; the consent URL must use access_type=offline&prompt=consent.
		writeErr(w, http.StatusBadRequest,
			"Google did not return a refresh token (re-consent with access_type=offline & prompt=consent)")
		return
	}

	email, sub := idTokenClaims(tr.IDToken)
	scopes := strings.Fields(tr.Scope)
	expiresAt := time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)

	if err := s.store.upsertGoogle(r.Context(), uid,
		tr.RefreshToken, tr.AccessToken, expiresAt, scopes, email, sub); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to store Google credentials")
		return
	}

	var emailOut *string
	if email != "" {
		emailOut = &email
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": emailOut, "scopes": scopes})
}

// googleToken (INTERNAL): return a valid access token, refreshing on expiry.
// If refresh fails with invalid_grant (revoked), the row is deleted and the
// caller gets a 404 so it re-runs the connect flow.
func (s *server) googleToken(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	tok, err := s.store.readGoogleTokens(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "no Google connection for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to read Google tokens")
		return
	}

	// Valid cached access token (60s skew guard) -> return without a network call.
	if tok.AccessToken != "" && tok.ExpiresAt != nil &&
		time.Now().Before(tok.ExpiresAt.Add(-60*time.Second)) {
		writeJSON(w, http.StatusOK, map[string]any{"access_token": tok.AccessToken, "scopes": tok.Scopes})
		return
	}

	cfg, err := loadGoogleConfig()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}

	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", tok.RefreshToken)
	form.Set("client_id", cfg.clientID)
	form.Set("client_secret", cfg.clientSecret)

	tr, err := postGoogleToken(r.Context(), form)
	if err != nil {
		if tr != nil && tr.Error == "invalid_grant" {
			// Revoked or expired refresh token: drop the dead connection.
			_ = s.store.deleteGoogle(r.Context(), uid)
			writeErr(w, http.StatusNotFound, "Google connection was revoked; reconnect required")
			return
		}
		writeErr(w, http.StatusBadRequest, "Google token refresh failed: "+err.Error())
		return
	}

	expiresAt := time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	scopes := tok.Scopes
	if tr.Scope != "" {
		scopes = strings.Fields(tr.Scope)
	}
	// tr.RefreshToken is usually empty on refresh; updateGoogleAccess keeps the
	// stored one when it is, and rotates when Google sends a new one.
	if err := s.store.updateGoogleAccess(r.Context(), uid,
		tr.AccessToken, expiresAt, tr.RefreshToken, scopes); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to persist refreshed Google token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"access_token": tr.AccessToken, "scopes": scopes})
}
