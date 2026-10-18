import { Buffer } from "node:buffer";
import type { Page } from "@cloudflare/playwright";
import type { PreparedAnswer } from "../../shared/types";
import type { Env } from "../env";
import { type BrowserRunInput, type BrowserRunResult, type FormAdapter, pickComboOption, runFormApplication, selectorFor } from "./browser-common";

// Greenhouse embedded application form (job-boards.greenhouse.io/embed/job_app).
// Inputs use the API field name as their id; selects are react-select comboboxes.

const shownValue = (page: Page, key: string) => async () =>
  ((await page
    .locator(`xpath=//*[@id="${key}"]/ancestor::div[contains(@class,"control")][1]`)
    .first()
    .innerText()
    .catch(() => "")) ?? "");

async function fill(page: Page, a: PreparedAnswer, input: BrowserRunInput): Promise<string | null> {
  if (a.type === "location" || a.key === "location") return fillLocation(page, Array.isArray(a.value) ? (a.value[0] ?? "") : a.value);
  const sel = selectorFor(a.key);
  if (a.type === "file") {
    if (a.key !== "resume") return "File uploads other than the resume are not automated";
    await page.locator(sel).setInputFiles({ name: input.resume.name, mimeType: "application/pdf", buffer: Buffer.from(input.resume.bytes) });
    // The UI shows the attached file name once the upload succeeded.
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
  if (a.type === "select" || a.type === "multiselect" || role === "combobox") {
    const tag = await el.first().evaluate((n) => n.tagName.toLowerCase());
    const values = Array.isArray(a.value) ? a.value : [a.value];
    if (tag === "select") {
      await el.first().selectOption(values.map((v) => ({ label: v })));
      return null;
    }
    for (const v of values) if (!(await pickComboOption(page, el.first(), v, shownValue(page, a.key)))) return `Option "${v}" not found`;
    return null;
  }
  await el.first().fill(Array.isArray(a.value) ? a.value.join(", ") : a.value);
  return null;
}

/**
 * Greenhouse's "location" question renders as a geocoder-backed react-select with id
 * "candidate-location". Type real keystrokes and pick from that field's own options only.
 */
async function fillLocation(page: Page, text: string): Promise<string | null> {
  const id = (await page.locator("#location").count()) ? "location" : "candidate-location";
  const input = page.locator(`#${id}`).first();
  if (!(await input.count())) return "Field not found on the page";
  await page.keyboard.press("Escape").catch(() => {});
  await input.click();
  // City first: geocoders match "San Francisco" better than a full "City, ST, Country" string.
  await input.pressSequentially(text.split(",")[0]!.trim(), { delay: 40 });
  const options = page.locator(`[id^="react-select-${id}-option"]`);
  try {
    await options.first().waitFor({ state: "visible", timeout: 8000 });
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return "No location suggestion matched";
  }
  const region = text.split(",")[1]?.trim();
  const best = region ? options.filter({ hasText: region }) : options;
  await ((await best.count()) ? best.first() : options.first()).click();
  return null;
}

export const greenhouseAdapter: FormAdapter = {
  readySelector: "#first_name",
  fill,
  textInput: (page, a) => page.locator(selectorFor(a.key)).first(),
  async afterFill(page, input, result) {
    // Phone country selector that accompanies the phone field on the new Greenhouse UI.
    if (input.phoneCountry && (await page.locator("#country").count())) {
      const ok = await pickComboOption(page, page.locator("#country").first(), input.phoneCountry, shownValue(page, "country")).catch(() => false);
      if (!ok) result.failed.push({ label: "Phone country", reason: `Option "${input.phoneCountry}" not found`, required: false });
    }
  },
  submitButton: (page) => page.locator('button[type="submit"], input[type="submit"]').filter({ hasText: /submit/i }).first(),
  errorSelector: '[id$="-error"]:not(:empty), .error-message',
};

export function runGreenhouseApplication(env: Env, input: BrowserRunInput): Promise<BrowserRunResult> {
  return runFormApplication(env, input, greenhouseAdapter);
}
