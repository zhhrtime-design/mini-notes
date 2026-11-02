// Start `npm run dev` first. This test uses the real Anna host and SDK.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });
try {
  const page = await browser.newPage();
  await page.goto(process.env.ANNA_HARNESS_URL || "http://localhost:5180/");
  const iframe = page.locator("iframe").first();
  const app = page.frameLocator("iframe").first();
  await app.locator("#conn.badge--on").waitFor();
  await app.locator("#audit li").first().waitFor();
  await app.locator("#add-btn").click();
  assert.equal(await app.locator(".note").count(), 0);
  assert.equal(await app.locator("#form-error").isVisible(), true);
  for (const [index, text] of ["Anna storage acceptance", "Delete this note"].entries()) {
    await app.locator("#note-input").fill(text);
    await app.locator("#add-btn").click();
    await app.locator(".note").nth(index).waitFor();
    assert.equal(await app.locator("#note-input").inputValue(), "");
  }
  await app.locator('button[aria-label="Delete note #2"]').click();
  await app.locator('button[aria-label="Delete note #2"]').waitFor({ state: "detached" });
  await app.locator("#reload-btn").click();
  await app.locator("#summarize-btn").click();
  await app.locator(".summary__error").waitFor();
  const error = await app.locator(".summary__error").innerText();
  assert.match(error, /\[-32603\] harness started with --no-llm/);
  assert.equal(await app.locator(".summary__hint").isVisible(), true);
  assert.deepEqual(await app.locator(".note__text").allTextContents(), ["Anna storage acceptance"]);
  const audit = await app.locator("#audit li").allTextContents();
  assert.equal(audit.filter(line => line.includes("storage.set")).length, 3);
  assert.equal(audit.filter(line => line.includes("tools.invoke")).length, 1);
  mkdirSync("logs", { recursive: true });
  await iframe.screenshot({ path: "logs/anna-app.png" });
  console.log(JSON.stringify({ result: "PASS", error, audit }, null, 2));
} finally {
  await browser.close();
}
