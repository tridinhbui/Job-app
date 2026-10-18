import { launch, type Locator, type Page } from "@cloudflare/playwright";
import type { PreparedAnswer } from "../../shared/types";
import type { Env } from "../env";
import { errorMessage, truncate } from "../lib/util";

// Shared browser engine for ATS adapters (Cloudflare Browser Rendering + Playwright).
// Deterministic selectors only — no AI per click. Safety properties enforced here, for every
// adapter: dry-run blocks all outgoing writes, values are verified after filling, CAPTCHA
// challenges stop the run (never bypassed), and submit is clicked at most once via beforeClick().

export type BrowserOutcome = "dry_run_ok" | "submitted" | "blocked" | "validation_failed" | "unverified" | "error";

export interface BrowserRunResult {
  outcome: BrowserOutcome;
  filled: string[];
  failed: { label: string; reason: string; required: boolean }[];
  screenshot: Uint8Array | null;
  confirmation: string | null;
  message: string;
  blockedWrites: number;
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

export interface FormAdapter {
  /** Element that proves the application form rendered. */
  readySelector: string;
  /** Fill one answer; return an error message or null. */
  fill(page: Page, a: PreparedAnswer, input: BrowserRunInput): Promise<string | null>;
  /** Locator for an answer's text input (used by the verification pass), or null to skip. */
  textInput(page: Page, a: PreparedAnswer): Locator | null;
  /** Optional extra step after all answers are filled. */
  afterFill?(page: Page, input: BrowserRunInput, result: BrowserRunResult): Promise<void>;
  submitButton(page: Page): Locator;
  /**
   * Non-GET requests that only read data (e.g. GraphQL queries that render the form) and may
   * pass in dry-run mode. Everything else that writes is blocked.
   */
  isReadOnlyRequest?(method: string, url: string, postData: string | null): boolean;
  /** Selector for client-side validation errors shown after submit. */
  errorSelector: string;
}

const CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha"][src*="bframe"]',
  'iframe[title*="recaptcha challenge" i]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="challenges.cloudflare.com"]',
];

export const CONFIRMATION_TEXT =
  /thank you for applying|thanks for applying|application (has been |was )?(successfully )?(received|submitted)|we('|’)ve received your application|your application has been submitted/i;

export const selectorFor = (key: string) => (/^[A-Za-z][\w-]*$/.test(key) ? `#${key}` : `[id="${key.replace(/"/g, '\\"')}"]`);

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isEmptyAnswer = (a: PreparedAnswer) => (Array.isArray(a.value) ? a.value.length === 0 : !a.value.trim());

export async function challengeVisible(page: Page): Promise<boolean> {
  for (const sel of CHALLENGE_SELECTORS) {
    const frames = page.locator(sel);
    const n = await frames.count();
    for (let i = 0; i < n; i++) {
      // reCAPTCHA preloads its challenge frame hidden and off-screen; only a frame that is
      // actually visible on the page counts as a challenge.
      const frame = frames.nth(i);
      if (!(await frame.isVisible().catch(() => false))) continue;
      const box = await frame.boundingBox().catch(() => null);
      if (box && box.width > 50 && box.height > 50 && box.y > -1000 && box.x > -1000) return true;
    }
  }
  return false;
}

/**
 * Pick an option in a combobox (react-select style) and verify a value is shown afterwards.
 * Prefers an exact label match, then a single option starting with the label (e.g. "United States+1").
 */
export async function pickComboOption(page: Page, input: Locator, label: string, shownValue: () => Promise<string>): Promise<boolean> {
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
  // Some controls show a short form after selection (e.g. "+1" for a phone country).
  const shown = (await shownValue()).trim();
  return shown.toLowerCase().includes(label.toLowerCase()) || (shown.length > 0 && !/^select/i.test(shown));
}

/** Type into an autocomplete (location) field and accept the first suggestion. */
export async function pickFirstSuggestion(page: Page, input: Locator, text: string): Promise<string | null> {
  await input.click();
  await input.fill(text);
  try {
    await page.locator('[role="option"]').first().waitFor({ state: "visible", timeout: 5000 });
    await page.locator('[role="option"]').first().click();
    return null;
  } catch {
    return "No location suggestion matched";
  }
}

export async function runFormApplication(env: Env, input: BrowserRunInput, adapter: FormAdapter): Promise<BrowserRunResult> {
  const result: BrowserRunResult = { outcome: "error", filled: [], failed: [], screenshot: null, confirmation: null, message: "", blockedWrites: 0 };
  const browser = await launch(env.BROWSER, { keep_alive: 60_000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    // Keep browser time (and cost) down: skip images, media and fonts. In dry-run mode also
    // block every non-GET request, so nothing (not even an attachment upload) reaches the employer.
    await page.route("**/*", (route) => {
      const req = route.request();
      if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
      if (input.mode === "dry_run" && !["GET", "HEAD", "OPTIONS"].includes(req.method()) && !adapter.isReadOnlyRequest?.(req.method(), req.url(), req.postData())) {
        result.blockedWrites++;
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(input.applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    try {
      await page.locator(adapter.readySelector).first().waitFor({ state: "visible", timeout: 20_000 });
      // Forms are often server-rendered; wait for hydration so React does not reset values.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(800);
    } catch {
      result.message = "Application form not found (job may be closed or the page layout changed)";
      return result;
    }
    if (await challengeVisible(page)) {
      result.outcome = "blocked";
      result.message = "The site is showing a human-verification challenge. ApplyPilot never bypasses these — please apply manually.";
      result.screenshot = await page.screenshot({ fullPage: true, type: "jpeg", quality: 55 }).catch(() => null);
      return result;
    }

    for (const a of input.answers) {
      if (isEmptyAnswer(a)) {
        if (a.required) result.failed.push({ label: a.label, reason: "No answer", required: true });
        continue;
      }
      try {
        const err = await adapter.fill(page, a, input);
        if (err) result.failed.push({ label: a.label, reason: err, required: a.required });
        else result.filled.push(a.label);
      } catch (e) {
        result.failed.push({ label: a.label, reason: truncate(errorMessage(e), 160), required: a.required });
      }
    }
    // Verification pass: re-read text fields and refill any that were reset by a re-render.
    for (const a of input.answers) {
      if ((a.type !== "text" && a.type !== "textarea") || !result.filled.includes(a.label) || Array.isArray(a.value)) continue;
      const el = adapter.textInput(page, a);
      if (!el) continue;
      if ((await el.inputValue().catch(() => null)) === a.value) continue;
      await el.fill(a.value).catch(() => {});
      if ((await el.inputValue().catch(() => null)) !== a.value) {
        result.filled = result.filled.filter((l) => l !== a.label);
        result.failed.push({ label: a.label, reason: "Value did not persist", required: a.required });
      }
    }
    await adapter.afterFill?.(page, input, result);

    const requiredFailures = result.failed.filter((f) => f.required);
    if (input.mode === "dry_run" || requiredFailures.length) {
      result.screenshot = await page.screenshot({ fullPage: true, type: "jpeg", quality: 55 });
      result.outcome = requiredFailures.length ? "validation_failed" : "dry_run_ok";
      result.message = requiredFailures.length
        ? `Could not fill ${requiredFailures.length} required field(s): ${requiredFailures.map((f) => f.label).join("; ")}`
        : `Dry run: filled ${result.filled.length} field(s). Submit was NOT clicked${result.blockedWrites ? `; ${result.blockedWrites} outgoing request(s) blocked` : ""}.`;
      return result;
    }

    if (!(await input.beforeClick())) {
      result.outcome = "unverified";
      result.message = "Submission was already attempted for this application; not clicking again.";
      return result;
    }
    await adapter.submitButton(page).click({ timeout: 10_000 });

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
      const conf = body.match(CONFIRMATION_TEXT);
      if (/confirmation|\/thanks|success/i.test(page.url()) || conf) {
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
      const errors = (await page.locator(adapter.errorSelector).allInnerTexts().catch(() => [])).map((s) => s.trim()).filter(Boolean);
      if (errors.length) {
        result.outcome = "validation_failed";
        result.message = `The form reported errors: ${truncate(errors.join("; "), 300)}`;
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

/** True for a GraphQL POST whose operations are all queries (no mutations). */
export function isGraphqlQuery(postData: string | null): boolean {
  if (!postData) return false;
  try {
    const body = JSON.parse(postData) as { query?: string } | { query?: string }[];
    const ops = Array.isArray(body) ? body : [body];
    return ops.length > 0 && ops.every((o) => typeof o.query === "string" && /^\s*query\b/.test(o.query));
  } catch {
    return false;
  }
}
