// Env-driven config for the single-owner WhatsApp bridge.
// ponytail: single owner via two env vars (JID + user_id). Multi-user would
// map many JIDs to many user_ids in a table; not built until there's a 2nd user.

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] ${name} is required but unset`);
    process.exit(1);
  }
  return v;
}

// Owner identity is what makes this a *personal* bridge. Without it there is no
// auth boundary, so refuse to half-run: exit 0 (clean, not a crash-loop).
const OWNER_JID = process.env.WHATSAPP_OWNER_JID;
const OWNER_USER_ID = process.env.WHATSAPP_OWNER_USER_ID;
if (!OWNER_JID || !OWNER_USER_ID) {
  console.log(
    "[config] WHATSAPP_OWNER_JID / WHATSAPP_OWNER_USER_ID not configured — bridge disabled, exiting."
  );
  process.exit(0);
}

export const config = {
  gatewayUrl: process.env.GATEWAY_URL || "http://gateway:8080",
  convSvcUrl: process.env.CONV_SVC_URL || "http://conv-svc:8082",
  internalToken: required("INTERNAL_TOKEN"),
  ownerJid: OWNER_JID,
  ownerUserId: OWNER_USER_ID,
  maxChars: Number(process.env.WHATSAPP_MAX_CHARS || 3500),
  dataDir: process.env.WHATSAPP_DATA_DIR || "/data",
};
