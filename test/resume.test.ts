import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { renderResumeDocx } from "../worker/resume/docx";
import { normalizeDate } from "../worker/resume/import";
import { renderResumePdf, toWinAnsi } from "../worker/resume/pdf";
import { guardAiTailoring, tailorDeterministic } from "../worker/resume/tailor";
import { personal, resume } from "./fixtures";

describe("deterministic tailoring", () => {
  it("reorders without adding content", () => {
    const t = tailorDeterministic(resume, "job1", ["PostgreSQL", "Docker", "Kubernetes"]);
    expect(t.skills[0]).toBe("PostgreSQL");
    expect(new Set(t.skills)).toEqual(new Set(resume.skills));
    expect(t.matchedKeywords).toEqual(["PostgreSQL", "Docker"]);
    expect(t.matchedKeywords).not.toContain("Kubernetes");
    expect(t.experience[0]!.bullets[0]).toMatch(/PostgreSQL/);
    const allBase = new Set(resume.experience.flatMap((e) => e.bullets));
    for (const b of t.experience.flatMap((e) => e.bullets)) expect(allBase.has(b)).toBe(true);
  });
});

describe("fabrication guard", () => {
  const fallback = tailorDeterministic(resume, "job1", ["PostgreSQL"]);
  it("accepts faithful rephrasing", () => {
    const out = guardAiTailoring(
      resume,
      { summary: "Backend engineer building TypeScript and PostgreSQL services.", skills: ["PostgreSQL", "TypeScript"], experience: [{ id: "e1", bullets: [{ source: 1, text: "Led a zero-downtime MySQL to PostgreSQL migration" }, { source: 0, text: "Built Node.js and TypeScript billing APIs serving 2M requests per day" }] }] },
      fallback,
    );
    expect(out.method).toBe("ai");
    expect(out.experience[0]!.bullets[0]).toBe("Led a zero-downtime MySQL to PostgreSQL migration");
    expect(out.skills.slice(0, 2)).toEqual(["PostgreSQL", "TypeScript"]);
  });
  it("reverts invented numbers, tools and skills", () => {
    const out = guardAiTailoring(
      resume,
      {
        summary: "Engineer with 15 years of Kubernetes expertise.",
        skills: ["Kubernetes", "TypeScript"],
        experience: [{ id: "e1", bullets: [{ source: 0, text: "Built billing APIs handling 50M requests per day" }, { source: 2, text: "Mentored 4 engineers on Kubernetes" }] }],
      },
      fallback,
    );
    expect(out.summary).toBe(resume.summary);
    expect(out.skills).not.toContain("Kubernetes");
    const b = resume.experience[0]!.bullets;
    // Reverted bullets first (AI order), then the omitted original bullet is restored.
    expect(out.experience[0]!.bullets).toEqual([b[0], b[2], b[1]]);
    expect(out.changes.join(" ")).toMatch(/rejected by the fabrication guard/);
  });
});

describe("rendering", () => {
  it("produces a valid PDF and DOCX", async () => {
    const pdf = await renderResumePdf({ ...resume, summary: "Uses “smart quotes” — and émojis 🚀" }, personal, "Backend Engineer");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const docx = await renderResumeDocx(resume, personal);
    expect(docx[0]).toBe(0x50); // "PK" zip header
    expect(docx[1]).toBe(0x4b);
  });
  it("sanitizes to WinAnsi", () => {
    expect(toWinAnsi("“Hi” – café 🚀")).toBe('"Hi" - cafe ');
  });
  it("normalizes dates", () => {
    expect(normalizeDate("Jan 2021")).toBe("2021-01");
    expect(normalizeDate("03/2019")).toBe("2019-03");
    expect(normalizeDate("Present")).toBe("");
    expect(normalizeDate("2018")).toBe("2018");
  });
});

describe("guard: filler and novelty", () => {
  const fallback = tailorDeterministic(resume, "job1", ["PostgreSQL"]);
  it("rejects promotional padding and keeps omitted bullets", () => {
    const out = guardAiTailoring(
      resume,
      {
        summary: "Backend engineer with a proven track record of driving technical standards and best practices.",
        skills: [],
        experience: [{ id: "e1", bullets: [{ source: 1, text: "Led migration from MySQL to PostgreSQL with zero downtime, demonstrating strong leadership" }, { source: 0, text: resume.experience[0]!.bullets[0]! }] }],
      },
      fallback,
    );
    expect(out.summary).toBe(resume.summary);
    expect(out.experience[0]!.bullets[0]).toBe(resume.experience[0]!.bullets[1]);
    expect(out.experience[0]!.bullets).toHaveLength(3);
  });
});
