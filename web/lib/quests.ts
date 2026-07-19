// Gamification core — pure, deterministic, dependency-free (no Date/random).
//
// The XP model is DERIVED, never stored: total XP = sum of the reward of every
// quest (task) whose status is "done". Un-completing a quest removes its reward
// for free. There is no counter to keep in sync, no new write path.
//
// "Quest" is UI language; the underlying entity stays a Task (status
// open|in_progress|done). We only read its priority here.

import type { Task } from "./gateway";

// EXP reward for completing a quest, by its priority.
export const XP_BY_PRIORITY: Record<Task["priority"], number> = {
  none: 10,
  low: 20,
  medium: 40,
  high: 80,
};

// Reward for one quest, by its priority.
export function questXp(task: Pick<Task, "priority">): number {
  return XP_BY_PRIORITY[task.priority];
}

// The whole XP model: sum questXp over completed quests only.
export function totalXp(tasks: Pick<Task, "priority" | "status">[]): number {
  return tasks.reduce(
    (sum, t) => (t.status === "done" ? sum + questXp(t) : sum),
    0,
  );
}

// Escalating level curve. The XP gap to go from level L to L+1 is 100*L, so the
// cumulative XP needed to REACH level L is 100 * (1+2+...+(L-1)) = 50*L*(L-1).
// Level 1 starts at 0 XP. Remainder carries across boundaries (Habitica-style):
// xpIntoLevel is measured from the current level's floor, not reset by clamping.
const cumXpForLevel = (level: number): number => 50 * level * (level - 1);
const xpGapForLevel = (level: number): number => 100 * level;

export type LevelInfo = {
  level: number;
  xpIntoLevel: number; // XP earned past this level's floor
  xpForThisLevel: number; // gap from this level's floor to the next
  xpForNext: number; // XP still needed to reach the next level
  progress: number; // 0..1 toward the next level
};

export function levelForXp(xp: number): LevelInfo {
  const total = Math.max(0, Math.floor(xp));
  // Largest level whose floor is <= total. cumXp is monotonic, so climb.
  let level = 1;
  while (cumXpForLevel(level + 1) <= total) level++;

  const floor = cumXpForLevel(level);
  const xpForThisLevel = xpGapForLevel(level);
  const xpIntoLevel = total - floor;
  return {
    level,
    xpIntoLevel,
    xpForThisLevel,
    xpForNext: xpForThisLevel - xpIntoLevel,
    progress: xpIntoLevel / xpForThisLevel,
  };
}

// Ascending rank tiers — original generic names, not from any franchise.
export const RANKS: { minLevel: number; name: string }[] = [
  { minLevel: 1, name: "Novice" },
  { minLevel: 5, name: "Apprentice" },
  { minLevel: 10, name: "Adept" },
  { minLevel: 20, name: "Expert" },
  { minLevel: 35, name: "Master" },
  { minLevel: 50, name: "Grandmaster" },
  { minLevel: 75, name: "Ascendant" },
];

export function rankForLevel(level: number): { name: string } {
  let name = RANKS[0].name;
  for (const r of RANKS) {
    if (level >= r.minLevel) name = r.name;
    else break;
  }
  return { name };
}
