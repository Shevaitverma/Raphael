import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

// ponytail: flat JSON file as the jid->conversation_id map. One owner = one or
// two entries, so a file in the auth volume beats a table. Move to conv-svc /
// a DB row when this stops being single-user.
const MAP_PATH = join(config.dataDir, "conversation-map.json");

async function readMap() {
  try {
    return JSON.parse(await readFile(MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeMap(map) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(MAP_PATH, JSON.stringify(map, null, 2));
}

// Reuse conv-svc rather than inventing our own conversation store. Cache the id
// forever so every owner message lands in the same WhatsApp thread.
export async function getConversationId(jid) {
  const map = await readMap();
  if (map[jid]) return map[jid];

  const res = await fetch(`${config.convSvcUrl}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: config.ownerUserId, title: "WhatsApp" }),
  });
  if (!res.ok) {
    throw new Error(`conv-svc /conversations failed: ${res.status}`);
  }
  const { id } = await res.json();
  if (!id) throw new Error("conv-svc /conversations returned no id");

  map[jid] = id;
  await writeMap(map);
  return id;
}
