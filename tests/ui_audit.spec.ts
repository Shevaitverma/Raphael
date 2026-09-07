import { test, expect } from '@playwright/test';
import * as path from 'path';

const ARTIFACT_DIR = '/Users/shevaitverma/.gemini/antigravity-ide/brain/69a30e0f-6f9d-43a8-9767-2d493dc556e4';

test('UI/UX audit of Raphael web app at http://localhost:3000', async ({ page }) => {
  // 1. Navigate to http://localhost:3000
  const response = await page.goto('http://localhost:3000');
  expect(response?.status()).toBe(200);

  // 2. Wait for page load
  await page.waitForLoadState('networkidle');

  // 3. Take full page screenshot of initial landing / auth page
  const landingPath = path.join(ARTIFACT_DIR, 'landing_page.png');
  await page.screenshot({ path: landingPath, fullPage: true });
  console.log(`Saved landing page screenshot to ${landingPath}`);

  // 4. Log page title and main elements
  const title = await page.title();
  console.log(`Page title: "${title}"`);

  // 5. Inspect visible text and headers
  const textContent = await page.evaluate(() => document.body.innerText);
  console.log(`Page text length: ${textContent.length} chars`);
  console.log(`Snippet of page text:\n${textContent.slice(0, 500)}`);

  // 6. Check interactive buttons / links
  const buttons = await page.locator('button, a').allInnerTexts();
  console.log(`Found ${buttons.length} interactive controls:`, buttons.filter(b => b.trim().length > 0));

  // 7. Check for theme toggle or auth buttons
  const googleBtn = page.locator('button:has-text("Google"), a:has-text("Google"), [aria-label*="Google"]');
  if (await googleBtn.count() > 0) {
    console.log('Google Sign-In button detected.');
  }

  // 8. Capture mobile viewport screenshot
  await page.setViewportSize({ width: 375, height: 812 });
  const mobilePath = path.join(ARTIFACT_DIR, 'mobile_page.png');
  await page.screenshot({ path: mobilePath, fullPage: true });
  console.log(`Saved mobile screenshot to ${mobilePath}`);
});
