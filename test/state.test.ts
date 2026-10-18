import { describe, expect, it } from "vitest";
import { defaultSettings } from "../shared/defaults";
import { budgetMode } from "../worker/ai/client";
import { canTransition } from "../worker/db/applications";
import { renderDigest } from "../worker/email/digest";

describe("application state machine", () => {
  it("allows the normal path and blocks unsafe jumps", () => {
    expect(canTransition("shortlisted", "preparing")).toBe(true);
    expect(canTransition("prepared", "approved")).toBe(true);
    expect(canTransition("approved", "submitting")).toBe(true);
    expect(canTransition("submitting", "submitted")).toBe(true);
    expect(canTransition("submitted", "interview")).toBe(true);
    // never straight to submission, never back from submitted to a submittable state
    expect(canTransition("shortlisted", "approved")).toBe(false);
    expect(canTransition("shortlisted", "submitting")).toBe(false);
    expect(canTransition("submitted", "prepared")).toBe(false);
    expect(canTransition("submitted", "approved")).toBe(false);
  });
});

describe("AI budget tiers", () => {
  const s = { ...defaultSettings(10) };
  it("degrades gracefully as spend grows", () => {
    expect(budgetMode(s, 1)).toBe("normal");
    expect(budgetMode(s, 6.5)).toBe("conserve");
    expect(budgetMode(s, 9)).toBe("essential");
    expect(budgetMode(s, 10)).toBe("exhausted");
    expect(budgetMode({ ...s, aiEnabled: false }, 0)).toBe("disabled");
  });
});

describe("daily digest", () => {
  const data = {
    waiting: [{ id: "a1", title: "Backend Engineer", company: "Acme <Inc>" }],
    attention: 1,
    fresh: [{ job_id: "j1", score: 82, title: "Platform Engineer", company: "Beta", location: "Remote" }],
  };
  it("renders both languages with escaped content and deep links", () => {
    const vi = renderDigest(data, "vi", "https://app.example")!;
    expect(vi.subject).toContain("1 hồ sơ chờ bạn duyệt");
    expect(vi.html).toContain("https://app.example/review/a1");
    expect(vi.html).toContain("Acme &lt;Inc&gt;");
    expect(vi.html).not.toContain("Acme <Inc>");
    expect(vi.text).toContain("https://app.example/jobs?job=j1");
    expect(renderDigest(data, "en", "https://app.example")!.subject).toContain("application(s) to review");
  });
  it("sends nothing when there is nothing new", () => {
    expect(renderDigest({ waiting: [], attention: 0, fresh: [] }, "vi", "x")).toBeNull();
  });
});
