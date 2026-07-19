# WhatsApp bridge

A single-user edge that links **the owner's** WhatsApp number and relays their
messages to Raphael and the reply back. It is an ingress/egress edge — it does
not sit between other services. It only ever answers one number (the owner);
every other sender is dropped silently.

## ⚠️ READ THIS FIRST — ban risk

This service uses **Baileys**, an *unofficial* WhatsApp Web automation library.
It is **NOT** the official WhatsApp Business API. Running it:

- **Violates WhatsApp's Terms of Service.**
- **Can get the linked number BANNED without warning** — permanently, with no
  appeal and no notice.

Therefore:

- **Use a number you can afford to lose. Never your primary line.**
- **Single-user personal use only** — this is your own bridge to your own
  assistant, not a product, not a bot for others.
- **By running it you accept the ban risk.** No one is liable but you.

## How it works

1. On first start it prints a **QR code to the container logs**.
2. You scan it from WhatsApp on the owner's phone (Settings → Linked Devices →
   Link a Device). The session is saved to a volume and reused.
3. Any text the owner sends to that number is forwarded to Raphael's pipeline;
   the buffered reply comes back as a WhatsApp message.
4. If the answer came from the local fallback model, the reply is prefixed with
   a one-line `(answered on the local fallback model)` note.
5. Non-text messages get one "I can only read text right now." reply.

The bridge never sends unsolicited messages, never provisions a user for an
unknown number, and never forwards a raw pipeline error to WhatsApp (you get a
fixed apology instead; the real error is in the logs).

## Enable it

It runs behind a compose **profile**, so a plain `docker compose up` skips it —
the rest of the stack runs fine without WhatsApp.

1. Find the owner's JID. It is the WhatsApp number in international format
   (no `+`, no spaces) followed by `@s.whatsapp.net`, e.g.
   `919812345678@s.whatsapp.net`.

2. Set these in `.env` at the repo root:

   ```
   WHATSAPP_OWNER_JID=919812345678@s.whatsapp.net
   WHATSAPP_OWNER_USER_ID=<the owner's Raphael user uuid>
   ```

   (`INTERNAL_TOKEN` must already be set — the bridge and gateway share it.)
   If either WhatsApp var is empty the bridge logs "not configured" and exits
   cleanly — it never half-runs.

3. Start it with the profile:

   ```
   docker compose --profile whatsapp up -d whatsapp-bridge
   ```

4. Show the QR and scan it:

   ```
   docker compose logs -f whatsapp-bridge
   ```

   Scan the QR with the owner's phone. Once it prints `connected`, message that
   number from the owner's WhatsApp and you'll get Raphael's reply.

## Re-linking

If WhatsApp logs the session out, the bridge stops (it does not crash-loop) and
logs `re-scan required`. Remove the saved session and restart:

```
docker volume rm raphael_wa_auth   # or: docker compose down -v (nukes all volumes)
docker compose --profile whatsapp up -d whatsapp-bridge
```

Then scan the new QR from the logs.

## Config (env)

| var | default | meaning |
|-----|---------|---------|
| `WHATSAPP_OWNER_JID` | — | owner's WhatsApp JID; **required** or the bridge exits |
| `WHATSAPP_OWNER_USER_ID` | — | owner's Raphael user uuid; **required** |
| `INTERNAL_TOKEN` | — | shared secret for the gateway's internal ingress |
| `GATEWAY_URL` | `http://gateway:8080` | pipeline ingress |
| `CONV_SVC_URL` | `http://conv-svc:8082` | conversation service |
| `WHATSAPP_MAX_CHARS` | `3500` | long replies split into a few messages at this size |

The Baileys session lives in the `wa_auth` volume (`/data/auth`) alongside the
jid→conversation map. **It is effectively a login credential** — it is
gitignored and volume-mounted, never committed.
