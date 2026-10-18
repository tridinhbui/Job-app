import { Buffer } from "node:buffer";
import { launch, type Page } from "@cloudflare/playwright";
import type { PreparedAnswer } from "../../shared/types";
import type { Env } from "../env";
import { errorMessage, truncate } from "../lib/util";

// Greenhouse application adapter (Cloudflare Browser Rendering + Playwright).
// Deterministic selectors only — no AI per click. The form is filled from prepared answers,
// the tailored resume is uploaded, and the submit button is clicked ONLY in live mode.
// Human-verification challenges (CAPTCHA) are detected and never bypassed: the run stops
// and the application is handed back to the user.

export type BrowserOutcome = "dry_run_ok" | "submitted" | "blocked" | "validation_failed" | "unverified" | "error";

export interface BrowserRunResult {
  outcome: BrowserOutcome;
  filled: string[];
  failed: { label: string; reason: string; required: boolean }[];
  screenshot: Uint8Array | null;
  confirmation: string | null;
  message: string;
}

export interface BrowserRunInput {
  applyUrl: string;
  answers: PreparedAnswer[];
  resume: { name: string; bytes: Uint8Array };
  phoneCountry: string;
  mode: "dry_run" | "live";
  /** Called immediately before the submit click; return false to abort (double-submit guard). */
  beforeClick: () => Promise<boolean>;
}

const CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha"][src*="bframe"]',
  'iframe[title*="recaptcha challenge" i]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="challenges.cloudflare.com"]',
];

const CONFIRMATION_TEXT = /thank you for applying|thanks for applying|application (has been |was )?(received|submitted)|we('|’)ve received your application|your application has been submitted/i;

const selectorFor = (key: string) => (/^[A-Za-z][\w-]*$/.test(key) ? `#${key}` : `[id="${key.replace(/"/g, '\\"')}"]`);

async function challengeVisible(page: Page): Promise<boolean> {
  for (const sel of CHALLENGE_SELECTORS) {
    const frames = page.locator(sel);
    const n = await frames.count();
    for (let i = 0; i < n; i++) {
      const box = await frames.nth(i).boundingBox().catch(() => null);
      if (box && box.width > 50 && box.height > 50) return true;
    }
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text currently shown by a react-select control (or a native select's selected label). */
async function comboValue(page: Page, key: string): Promise<string> {
  const control = page.locator(`xpath=//*[@id="${key}"]/ancestor::div[contains(@class,"control")][1]`);
  if (await control.count()) return ((await control.first().innerText().catch(() => "")) ?? "").trim();
  return "";
}

/**
 * Select an option in a react-select combobox and verify it stuck. Prefers an exact label
 * match, then an option that starts with the label (e.g. "United States +1"), else gives up.
 */
async function pickComboOption(page: Page, key: string, label: string): Promise<boolean> {
  const input = page.locator(selectorFor(key)).first();
  await input.scrollIntoViewIfNeeded().catch(() => {});
  const options = page.locator('[role="option"]');
  const exact = () => options.filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}\\s*$`, "i") });
  const prefix = () => options.filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}(?![\\w ]*[a-z])`, "i") });

  await input.click({ timeout: 5000 });
  await options.first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  let target = (await exact().count()) ? exact() : null;
  if (!target) {
    await input.pressSequentially(label, { delay: 15 });
    await page.waitForTimeout(400);
    target = (await exact().count()) ? exact() : (await prefix().count()) === 1 ? prefix() : (await options.count()) === 1 ? options : null;
  }
  if (!target) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await target.first().click();
  // Some controls display a short form after selection (e.g. "+1" for a phone country),
  // so accept any non-placeholder value.
  const shown = await comboValue(page, key);
  return shown.toLowerCase().includes(label.toLowerCase()) || (shown.length > 0 && !/^select/i.test(shown));
}

async function fillAnswer(page: Page, a: PreparedAnswer, input: BrowserRunInput): Promise<string | null> {
  const sel = selectorFor(a.key);
  if (a.type === "file") {
    if (a.key !== "resume") return "File uploads other than the resume are not automated";
    await page.locator(sel).setInputFiles({ name: input.resume.name, mimeType: "application/pdf", buffer: Buffer.from(input.resume.bytes) });
    // The UI shows the attached file name once React accepted the file.
    try {
      await page.getByText(input.resume.name, { exact: false }).first().waitFor({ state: "visible", timeout: 8000 });
      return null;
    } catch {
      // In dry-run mode the attachment upload request is deliberately blocked.
      return input.mode === "dry_run" ? null : "Resume attachment was not confirmed by the page";
    }
  }
  const el = page.locator(sel);
  if ((await el.count()) === 0) return "Field not found on the page";

  const role = await el.first().getAttribute("role");
  if (a.type === "select" || a.type === "multiselect" || a.type === "location" || role === "combobox") {
    const tag = await el.first().evaluate((n) => n.tagName.toLowerCase());
    const values = Array.isArray(a.value) ? a.value : [a.value];
    if (tag === "select") {
      await el.first().selectOption(values.map((v) => ({ label: v })));
      return null;
    }
    if (a.type === "location") {
      // Location autocomplete: type the city and accept the first suggestion.
      await el.first().click();
      await el.first().fill(values[0] ?? "");
      try {
        await page.locator('[role="option"]').first().waitFor({ state: "visible", timeout: 5000 });
        await page.locator('[role="option"]').first().click();
        return null;
      } catch {
        return "No location suggestion matched";
      }
    }
    for (const v of values) if (!(await pickComboOption(page, a.key, v))) return `Option "${v}" not found`;
    return null;
  }
  await el.first().fill(Array.isArray(a.value) ? a.value.join(", ") : a.value);
  return null;
}

export async function runGreenhouseApplication(env: Env, input: BrowserRunInput): Promise<BrowserRunResult> {
  const result: BrowserRunResult = { outcome: "error", filled: [], failed: [], screenshot: null, confirmation: null, message: "" };
  const browser = await launch(env.BROWSER, { keep_alive: 60_000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    // Keep browser time (and cost) down: skip images, media and fonts. In dry-run mode also
    // block every non-GET request, so nothing (not even an attachment upload) reaches the employer.
    let blockedWrites = 0;
    await page.route("**/*", (route) => {
      const req = route.request();
      if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
      if (input.mode === "dry_run" && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
        blockedWrites++;
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(input.applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    try {
      await page.locator("#first_name").waitFor({ state: "visible", timeout: 20_000 });
      // The form is server-rendered; wait for hydration so React does not reset filled values.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(800);
    } catch {
      result.message = "Application form not found (job may be closed or the page layout changed)";
      return result;
    }
    if (await challengeVisible(page)) {
      result.outcome = "blocked";
      result.message = "The site is showing a human-verification challenge. ApplyPilot never bypasses these — please apply manually.";
      return result;
    }

    for (const a of input.answers) {
      const empty = Array.isArray(a.value) ? a.value.length === 0 : !a.value.trim();
      if (empty) {
        if (a.required) result.failed.push({ label: a.label, reason: "No answer", required: true });
        continue;
      }
      try {
        const err = await fillAnswer(page, a, input);
        if (err) result.failed.push({ label: a.label, reason: err, required: a.required });
        else result.filled.push(a.label);
      } catch (e) {
        result.failed.push({ label: a.label, reason: truncate(errorMessage(e), 160), required: a.required });
      }
    }
    // Verification pass: re-read text fields and refill any that were reset by a re-render.
    for (const a of input.answers) {
      if ((a.type !== "text" && a.type !== "textarea") || !result.filled.includes(a.label) || Array.isArray(a.value)) continue;
      const el = page.locator(selectorFor(a.key)).first();
      const current = await el.inputValue().catch(() => null);
      if (current === a.value) continue;
      await el.fill(a.value).catch(() => {});
      if ((await el.inputValue().catch(() => null)) !== a.value) {
        result.filled = result.filled.filter((l) => l !== a.label);
        result.failed.push({ label: a.label, reason: "Value did not persist", required: a.required });
      }
    }
    // Phone country selector that accompanies the phone field on the new Greenhouse UI.
    if (input.phoneCountry && (await page.locator("#country").count())) {
      const ok = await pickComboOption(page, "country", input.phoneCountry).catch(() => false);
      if (!ok) result.failed.push({ label: "Phone country", reason: `Option "${input.phoneCountry}" not found`, required: false });
    }

    const requiredFailures = result.failed.filter((f) => f.required);
    if (input.mode === "dry_run" || requiredFailures.length) {
      result.screenshot = await page.screenshot({ fullPage: true, type: "jpeg", quality: 55 });
      result.outcome = requiredFailures.length ? "validation_failed" : "dry_run_ok";
      result.message = requiredFailures.length
        ? `Could not fill ${requiredFailures.length} required field(s): ${requiredFailures.map((f) => f.label).join("; ")}`
        : `Dry run: filled ${result.filled.length} field(s). Submit was NOT clicked${blockedWrites ? `; ${blockedWrites} outgoing request(s) blocked` : ""}.`;
      return result;
    }

    if (!(await input.beforeClick())) {
      result.outcome = "unverified";
      result.message = "Submission was already attempted for this application; not clicking again.";
      return result;
    }
    const submit = page.locator('button[type="submit"], input[type="submit"]').filter({ hasText: /submit/i });
    await ((await submit.count()) ? submit.first() : page.locator('button[type="submit"]').first()).click({ timeout: 10_000 });

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const url = page.url();
      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
      const conf = body.match(CONFIRMATION_TEXT);
      if (/confirmation/i.test(url) || conf) {
        result.outcome = "submitted";
        result.confirmation = conf?.[0] ?? "Confirmation page reached";
        result.message = "Application submitted and confirmation detected.";
        break;
      }
      if (await challengeVisible(page)) {
        result.outcome = "blocked";
        result.message = "A human-verification challenge appeared after clicking submit. Not bypassed — please complete the application manually.";
        break;
      }
      const invalid = await page.locator('[aria-invalid="true"]').count();
      if (invalid > 0) {
        const errors = await page.locator('[id$="-error"]:not(:empty), .error-message').allInnerTexts().catch(() => []);
        result.outcome = "validation_failed";
        result.message = `The form reported ${invalid} invalid field(s)${errors.length ? `: ${truncate(errors.join("; "), 300)}` : ""}`;
        break;
      }
    }
    if (result.outcome === "error") {
      result.outcome = "unverified";
      result.message = "Submit was clicked but no confirmation was detected within 25s. Check your email before retrying.";
    }
    result.screenshot = await page.screenshot({ fullPage: true, type: "jpeg", quality: 55 }).catch(() => null);
    return result;
  } catch (e) {
    result.outcome = "error";
    result.message = truncate(errorMessage(e), 400);
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
