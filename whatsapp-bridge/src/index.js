import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { getConversationId } from "./conversation.js";
import { ask } from "./pipeline.js";
import { splitMessage } from "./split.js";

// Baileys ships CommonJS; default-import then destructure is the interop-safe
// form (named ESM imports can miss its defineProperty exports).
import Baileys from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
} = Baileys;

const OWNER = jidNormalizedUser(config.ownerJid);
const APOLOGY = "Sorry, something went wrong on my end. Please try again.";
const DEGRADED_BANNER = "(answered on the local fallback model)";

// --- rate limit: token bucket on the owner JID ----------------------------
// ponytail: in-memory bucket, single owner. Refill 1 token / 3s, burst 5.
// Resets on restart, which is fine for one human. Move to Redis if the bridge
// ever fans out to many senders (it won't while GUARD 1 stands).
const bucket = { tokens: 5, last: Date.now() };
function allow() {
  const now = Date.now();
  bucket.tokens = Math.min(5, bucket.tokens + (now - bucket.last) / 3000);
  bucket.last = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// --- helpers ---------------------------------------------------------------
function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation ?? m.extendedTextMessage?.text ?? null;
}

async function sendReply(sock, jid, text) {
  for (const part of splitMessage(text, config.maxChars)) {
    await sock.sendMessage(jid, { text: part });
  }
}

// --- socket lifecycle ------------------------------------------------------
let backoff = 1000;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(join(config.dataDir, "auth"));
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("[wa] scan this QR with WhatsApp on the owner's phone:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log(`[wa] connected. Owner: ${OWNER}`);
      backoff = 1000;
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Session is dead — reconnecting would just crash-loop. Stop and wait
        // for the human to re-scan (clear the auth volume, restart).
        console.error("[wa] logged out — re-scan required. Not reconnecting.");
        return;
      }
      console.warn(`[wa] connection closed (code ${code}); reconnecting in ${backoff}ms`);
      setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (e) {
        console.error("[wa] handler error:", e);
        // An owner message we accepted must get *some* reply. Only apologise if
        // we know it was the owner (GUARD 1 already passed inside handleMessage
        // before any throw that matters); safest is to attempt the apology to
        // the owner JID only.
        if (jidNormalizedUser(msg.key?.remoteJid || "") === OWNER && !msg.key?.fromMe) {
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: APOLOGY });
          } catch {}
        }
      }
    }
  });
}

async function handleMessage(sock, msg) {
  const rawJid = msg.key?.remoteJid;
  if (!rawJid) return;
  if (msg.key.fromMe) return;
  if (rawJid.endsWith("@g.us")) return; // groups
  if (rawJid === "status@broadcast") return;

  const jid = jidNormalizedUser(rawJid);

  // GUARD 1 — the trust + anti-abuse boundary. Only the owner is ever answered;
  // every other sender is dropped in silence (no reply, no user provisioned).
  if (jid !== OWNER) return;

  const text = extractText(msg);
  if (text == null) {
    // Owner sent non-text (image/audio/etc). Tell them once, don't drop silent.
    await sock.sendMessage(rawJid, { text: "I can only read text right now." });
    return;
  }

  if (!allow()) {
    console.warn("[wa] owner rate-limited, dropping burst");
    return; // burst protection; owner will just resend
  }

  // Keep a 'composing' presence alive while the pipeline works.
  await sock.sendPresenceUpdate("composing", rawJid).catch(() => {});
  const presence = setInterval(
    () => sock.sendPresenceUpdate("composing", rawJid).catch(() => {}),
    8000
  );

  try {
    const conversationId = await getConversationId(jid);
    const { text: reply, degraded, error } = await ask({
      user_id: config.ownerUserId,
      conversation_id: conversationId,
      message: text,
    });

    if (error || !reply) {
      await sock.sendMessage(rawJid, { text: APOLOGY });
      return;
    }
    const body = degraded ? `${DEGRADED_BANNER}\n\n${reply}` : reply;
    await sendReply(sock, rawJid, body);
  } finally {
    clearInterval(presence);
    await sock.sendPresenceUpdate("paused", rawJid).catch(() => {});
  }
}

// Only connect when run directly (not when imported by the self-check).
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error("[wa] fatal:", e);
    process.exit(1);
  });
}
