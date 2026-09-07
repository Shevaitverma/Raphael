package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Telegram delivery. One HTTPS POST, no SDK.
//
// FORMATTING IS HTML, NOT MARKDOWNV2, and that is a correctness decision rather
// than taste. MarkdownV2 requires escaping EIGHTEEN characters under three
// different context-dependent rulesets, and the set includes '.', '-', '(', ')'
// and '!' — every character that appears in an ordinary subject line, sender
// name and URL. Getting it wrong returns "can't parse entities" and the alert is
// silently lost. Telegram's HTML mode needs exactly three ('<', '>', '&'), one
// rule everywhere, and Go has it in the standard library.
//
// Every interpolated field is attacker-chosen — a subject line is written by
// whoever sent the email — so nothing reaches Telegram without html.EscapeString.
//
// The bot token is a full-control credential: anyone holding it can read messages
// sent to the bot and post as it. It is env-only, never logged, and never
// returned by any route. The blast radius is bounded though: a bot cannot start
// a conversation, so a thief can only reach chats that already pressed /start.

const telegramAPI = "https://api.telegram.org"

// Telegram's own limit is 4096 characters after entity parsing. notifications.text
// is CHECKed at 500, so this is a backstop for the assembled digest, not the
// common path.
const telegramMaxChars = 4000

var errTelegramPermanent = errors.New("telegram rejected the message permanently")

// telegramConfigured reports whether a bot token exists at all. Empty = the
// channel is off, exactly like the search and Google integrations: unset means
// inert, not broken.
func telegramConfigured() bool { return os.Getenv("TELEGRAM_BOT_TOKEN") != "" }

type telegramResult struct {
	messageID  string
	retryAfter time.Duration // set only on 429
	permanent  bool          // 400/403: retrying cannot help
}

type tgResponse struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	Result      struct {
		MessageID int64 `json:"message_id"`
	} `json:"result"`
	Parameters struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// sendTelegram delivers one alert. silent=true uses disable_notification, which
// is how quiet hours work here: the message still arrives INSTANTLY and is
// visible on the lock screen, it just makes no sound. That beats deferring it to
// a queue, which risks the 06:00 alert landing at 09:00.
func sendTelegram(ctx context.Context, chatID, text, linkURL string, silent bool) (telegramResult, error) {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" || chatID == "" {
		return telegramResult{}, errors.New("telegram not configured")
	}

	body := map[string]any{
		"chat_id":    chatID,
		"text":       renderTelegramHTML(text, linkURL),
		"parse_mode": "HTML",
		// Without this a link in the body renders a preview card that buries the
		// alert under someone else's OpenGraph image.
		"link_preview_options": map[string]any{"is_disabled": true},
		"disable_notification": silent,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return telegramResult{}, err
	}

	url := fmt.Sprintf("%s/bot%s/sendMessage", telegramAPI, token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return telegramResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return telegramResult{}, err // transport: retryable
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))

	var tr tgResponse
	_ = json.Unmarshal(raw, &tr)

	switch {
	case resp.StatusCode == http.StatusOK && tr.OK:
		return telegramResult{messageID: fmt.Sprint(tr.Result.MessageID)}, nil
	case resp.StatusCode == http.StatusTooManyRequests:
		// Telegram states exactly how long to wait. Honour it verbatim — adding
		// our own backoff on top of a server-supplied number just delays the
		// alert further for no benefit.
		d := time.Duration(tr.Parameters.RetryAfter) * time.Second
		if d <= 0 {
			d = 5 * time.Second
		}
		return telegramResult{retryAfter: d}, errors.New("telegram rate limited")
	case resp.StatusCode == http.StatusBadRequest, resp.StatusCode == http.StatusForbidden:
		// 400 means our formatter is broken; 403 means the user blocked the bot
		// or never pressed /start. Retrying either burns quota forever. Never log
		// tr.Description at info level — it echoes the message content.
		return telegramResult{permanent: true}, fmt.Errorf("%w: HTTP %d", errTelegramPermanent, resp.StatusCode)
	default:
		return telegramResult{}, fmt.Errorf("telegram HTTP %d", resp.StatusCode)
	}
}

// renderTelegramHTML turns a plain-text alert into Telegram HTML.
//
// The FIRST LINE becomes the push notification preview, so it is bolded and kept
// first. Everything else is escaped verbatim. No Markdown, no user-supplied
// markup survives — html.EscapeString runs before a single tag is added, so a
// subject line containing "<b>" arrives as text, not formatting.
func renderTelegramHTML(text, linkURL string) string {
	text = strings.TrimSpace(text)
	if len(text) > telegramMaxChars {
		text = text[:telegramMaxChars] + "…"
	}
	lines := strings.SplitN(text, "\n", 2)

	var b strings.Builder
	b.WriteString("<b>")
	b.WriteString(html.EscapeString(lines[0]))
	b.WriteString("</b>")
	if len(lines) > 1 && strings.TrimSpace(lines[1]) != "" {
		b.WriteString("\n")
		b.WriteString(html.EscapeString(strings.TrimSpace(lines[1])))
	}
	if linkURL != "" && isSafeURL(linkURL) {
		b.WriteString("\n\n<a href=\"")
		b.WriteString(html.EscapeString(linkURL))
		b.WriteString("\">Open in Gmail</a>")
	}
	return b.String()
}

// isSafeURL keeps javascript:, data: and friends out of an href. The link is
// built by us today, but a link column is exactly the kind of thing a later
// feature populates from somewhere less careful.
func isSafeURL(u string) bool {
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")
}
