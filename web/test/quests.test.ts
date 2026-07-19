import { test } from "node:test";
import assert from "node:assert/strict";
import {
  XP_BY_PRIORITY,
  questXp,
  totalXp,
  levelForXp,
  rankForLevel,
  RANKS,
} from "../lib/quests.ts";
import type { Task } from "../lib/gateway.ts";

const q = (
  priority: Task["priority"],
  status: Task["status"],
): Pick<Task, "priority" | "status"> => ({ priority, status });

test("questXp maps each priority", () => {
  assert.equal(questXp({ priority: "none" }), 10);
  assert.equal(questXp({ priority: "low" }), 20);
  assert.equal(questXp({ priority: "medium" }), 40);
  assert.equal(questXp({ priority: "high" }), 80);
  for (const p of ["none", "low", "medium", "high"] as const)
    assert.equal(questXp({ priority: p }), XP_BY_PRIORITY[p]);
});

test("totalXp counts only done and sums by priority", () => {
  const tasks = [
    q("high", "done"), // 80
    q("medium", "done"), // 40
    q("high", "open"), // ignored
    q("low", "in_progress"), // ignored
    q("none", "done"), // 10
  ];
  assert.equal(totalXp(tasks), 130);
  assert.equal(totalXp([]), 0);
  assert.equal(totalXp([q("high", "open")]), 0);
});

test("level 1 starts at 0 XP", () => {
  const l = levelForXp(0);
  assert.equal(l.level, 1);
  assert.equal(l.xpIntoLevel, 0);
  assert.equal(l.progress, 0);
});

test("levelForXp is monotonic and progress stays in [0,1]", () => {
  let prevLevel = 0;
  for (let xp = 0; xp <= 5000; xp += 7) {
    const l = levelForXp(xp);
    assert.ok(l.level >= prevLevel, `level dropped at xp=${xp}`);
    prevLevel = l.level;
    assert.ok(l.progress >= 0 && l.progress <= 1, `progress oob at xp=${xp}`);
    assert.ok(l.xpForNext >= 0);
    // xpIntoLevel + xpForNext accounts for the whole level band.
    assert.equal(l.xpIntoLevel + l.xpForNext, l.xpForThisLevel);
  }
});

test("remainder carries across a level boundary", () => {
  // Level 1 floor 0, gap to level 2 is 100 (100*1). Level 2 floor 100, gap 200.
  assert.equal(levelForXp(99).level, 1);
  assert.equal(levelForXp(99).xpIntoLevel, 99);
  const at100 = levelForXp(100);
  assert.equal(at100.level, 2);
  assert.equal(at100.xpIntoLevel, 0); // remainder reset to new floor, not lost
  const at150 = levelForXp(150);
  assert.equal(at150.level, 2);
  assert.equal(at150.xpIntoLevel, 50);
  assert.equal(at150.xpForThisLevel, 200);
});

test("rankForLevel steps up at the right thresholds", () => {
  assert.equal(rankForLevel(1).name, "Novice");
  assert.equal(rankForLevel(4).name, "Novice");
  assert.equal(rankForLevel(5).name, "Apprentice");
  assert.equal(rankForLevel(9).name, "Apprentice");
  assert.equal(rankForLevel(10).name, "Adept");
  assert.equal(rankForLevel(20).name, "Expert");
  assert.equal(rankForLevel(35).name, "Master");
  assert.equal(rankForLevel(50).name, "Grandmaster");
  assert.equal(rankForLevel(75).name, "Ascendant");
  assert.equal(rankForLevel(999).name, "Ascendant");
  // Every rank boundary yields exactly that rank.
  for (const r of RANKS) assert.equal(rankForLevel(r.minLevel).name, r.name);
});
