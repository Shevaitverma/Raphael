// Responsive screenshot harness.
//
// Renders every view at phone/large-phone/tablet/desktop widths so a human (or
// Claude) can actually LOOK at the layout instead of inferring it from CSS.
// Dev-only: playwright is a devDependency and this is never part of a build.
//
// Auth: the app is behind Google Sign-In and the passwordless dev-login is
// deliberately disabled (the devtunnel makes it internet-reachable). So the caller
// mints a throwaway session id straight into Redis — the same {uid,role} JSON the
// gateway writes — and passes it in via SESSION_ID. Nothing here bypasses the
// gateway's checks; it just presents a session the operator created locally.
//
//   node scripts/shots.mjs            # all views, all widths
//   VIEWS=graph,chat node scripts/shots.mjs
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SESSION_ID = process.env.SESSION_ID ?? "";
const OUT = process.env.OUT ?? "shots";

// The four that matter: smallest phone still in use, the common phone, the
// tablet/md: switch, and desktop.
const SIZES = [
  { name: "320", width: 320, height: 720 },
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 900 },
];

const ALL = ["dashboard", "chat", "graph", "tasks", "reminders", "fitness", "settings", "admin"];
const VIEWS = (process.env.VIEWS ? process.env.VIEWS.split(",") : ALL).map((v) => v.trim());

const browser = await chromium.launch();
const problems = [];

for (const size of SIZES) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    isMobile: size.width < 768,
    hasTouch: size.width < 768,
  });
  if (SESSION_ID) {
    await ctx.addCookies([
      { name: "raphael_session", value: SESSION_ID, url: BASE, httpOnly: true, sameSite: "Lax" },
    ]);
  }
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

  for (const view of VIEWS) {
    // The shell persists the active tab in localStorage; set it, then load.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate((v) => localStorage.setItem("raphael.view", v), view);
    await page.goto(BASE, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(1200);

    // This app scrolls an INNER container, not the document — so fullPage:true
    // captures a single viewport and the document scroll position is always 0.
    // Reset every scroller to the top so a shot shows the top of the view, and
    // record how tall the content is so a reviewer knows what is below the fold.
    const scrollH = await page.evaluate(() => {
      let tallest = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 200) {
          el.scrollTop = 0;
          tallest = Math.max(tallest, el.scrollHeight);
        }
      }
      return tallest;
    });
    await page.waitForTimeout(400);

    await mkdir(`${OUT}/${size.name}`, { recursive: true });
    await page.screenshot({ path: `${OUT}/${size.name}/${view}.png`, fullPage: false });
    if (scrollH > size.height * 3) {
      // Not a failure, just worth knowing: a very long view may need a second look.
      problems.push({ view, size: size.name, note: `content ${scrollH}px tall in ${size.height}px viewport` });
    }

    // Nothing should hold focus on load — least of all a destructive control.
    const focused = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      return { tag: a.tagName, label: a.getAttribute("aria-label") ?? a.textContent?.trim().slice(0, 40) };
    });
    if (focused) problems.push({ view, size: size.name, autofocused: focused });

    // The bug this whole pass exists to prevent: the PAGE scrolling sideways.
    // scrollWidth > clientWidth on the document means something overflowed.
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      const over = d.scrollWidth - d.clientWidth;
      if (over <= 1) return null;
      // Name the widest offenders so the fix is actionable, not a scavenger hunt.
      const guilty = [...document.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > d.clientWidth + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
      return { over, guilty };
    });
    if (overflow) problems.push({ view, size: size.name, ...overflow });
  }

  if (consoleErrors.length) {
    problems.push({ size: size.name, view: "(console)", errors: [...new Set(consoleErrors)].slice(0, 5) });
  }
  await ctx.close();
}

await browser.close();

if (problems.length) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log(" ", JSON.stringify(p));
} else {
  console.log("no horizontal overflow, no console errors, at any width");
}
console.log(`shots in ${OUT}/<width>/<view>.png`);
