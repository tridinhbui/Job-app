import { describe, expect, it } from "vitest";
import type { FormField } from "../shared/types";
import { chooseOption, missingRequired, prepareDeterministicAnswers } from "../worker/apply/answers";
import { parseGreenhouseUrl } from "../worker/apply/greenhouse-form";
import { personal, resume } from "./fixtures";

const f = (key: string, label: string, type: FormField["type"] = "text", required = true, options: string[] = [], section: FormField["section"] = "main"): FormField => ({
  key,
  label,
  type,
  required,
  options: options.map((o, i) => ({ label: o, value: String(i) })),
  description: "",
  section,
});

describe("answer engine", () => {
  const ctx = { personal, resume, library: [{ question: "Why do you want to work at PayCo?", answer: "Saved answer", updatedAt: 0 }], job: { company: "PayCo", title: "Engineer", location: "Austin, TX" } };
  const fields = [
    f("first_name", "First Name"),
    f("email", "Email"),
    f("resume", "Resume/CV", "file"),
    f("question_1", "LinkedIn Profile", "text", false),
    f("question_2", "Will you now or in the future require visa sponsorship?", "select", true, ["Yes", "No"]),
    f("question_3", "Are you legally authorized to work in the United States?", "select", true, ["Yes", "No"]),
    f("question_4", "Why do you want to work at PayCo?", "textarea"),
    f("question_5", "Please confirm that you have read our AI policy", "select", true, ["Yes"]),
    f("question_6", "Describe a hard technical problem you solved", "textarea"),
    f("veteran_status", "VeteranStatus", "select", false, ["I don't wish to answer", "I am not a protected veteran"], "compliance"),
  ];
  const { answers, needsAi } = prepareDeterministicAnswers(fields, { ...ctx, personal: { ...personal, eeo: { ...personal.eeo, veteran: "decline" } } });
  const by = (k: string) => answers.find((a) => a.key === k)!;

  it("fills profile fields", () => {
    expect(by("first_name").value).toBe("Test");
    expect(by("question_1").value).toBe("https://linkedin.com/in/test");
    expect(by("question_2").value).toBe("No");
    expect(by("question_3")).toMatchObject({ value: "Yes", needsReview: true });
    expect(by("resume").source).toBe("file");
    expect(by("veteran_status").value).toBe("I don't wish to answer");
  });
  it("reuses the answer library", () => {
    expect(by("question_4")).toMatchObject({ value: "Saved answer", source: "library" });
  });
  it("never auto-answers attestations and routes open questions to AI", () => {
    expect(by("question_5").value).toBe("");
    expect(needsAi.map((x) => x.key)).toEqual(["question_6"]);
    expect(missingRequired(answers)).toEqual(["Please confirm that you have read our AI policy", "Describe a hard technical problem you solved"]);
  });
  it("chooses options safely", () => {
    const opts = [{ label: "Yes, I am authorized", value: "1" }, { label: "No", value: "0" }];
    expect(chooseOption(opts, "yes")).toBe("Yes, I am authorized");
    expect(chooseOption(opts, "maybe")).toBeNull();
  });
  it("parses Greenhouse URLs", () => {
    expect(parseGreenhouseUrl("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123")).toEqual({ board: "acme", jobId: "123" });
    expect(parseGreenhouseUrl("https://job-boards.greenhouse.io/acme/jobs/456")).toEqual({ board: "acme", jobId: "456" });
  });
});

describe("answer engine safety rules", () => {
  const ctx = { personal, resume, library: [], job: { company: "PayCo", title: "Engineer", location: "Austin, TX" } };
  const { answers, needsAi } = prepareDeterministicAnswers(
    [
      f("q1", "What is the address from which you plan on working? If you would need to relocate, please type 'relocating'."),
      f("q2", "Have you ever interviewed at PayCo before?", "select", true, ["Yes", "No"]),
      f("q3", "Are you open to working in-person in one of our offices 25% of the time?", "select", true, ["Yes", "No"]),
      f("q4", "Are you open to relocation for this role?", "select", true, ["Yes", "No"]),
    ],
    ctx,
  );
  const by = (k: string) => answers.find((a) => a.key === k)!;
  it("answers address questions with the location, not yes/no", () => {
    expect(by("q1").value).toBe("Austin, TX, United States");
  });
  it("never sends personal facts or preferences to AI", () => {
    expect(by("q2").value).toBe("");
    expect(by("q3").value).toBe("");
    expect(needsAi).toHaveLength(0);
    expect(by("q4").value).toBe("No");
  });
});

describe("answer engine: job-location and experience questions", () => {
  const ctx = { personal, resume, library: [], job: { company: "PayCo", title: "Engineer", location: "San Francisco, CA" } };
  const { answers } = prepareDeterministicAnswers(
    [
      f("a1", "Are you authorized to work in the country where the job is located?", "select", true, ["Yes", "No"]),
      f("a2", "How many years of relevant, post college work experience do you have?", "select", true, ["0-2 years", "3-5 years", "6-10 years", "10+ years"]),
      f("_systemfield_name", "Legal Name"),
      f("a3", "When can you start a new role?", "date"),
    ],
    ctx,
  );
  const by = (k: string) => answers.find((a) => a.key === k)!;
  it("answers from the job's location and resume years", () => {
    expect(by("a1").value).toBe("Yes");
    expect(by("a2").value).toBe("6-10 years");
    expect(by("_systemfield_name").value).toBe("Test User");
    expect(by("a3")).toMatchObject({ value: "", note: "Pick a date (YYYY-MM-DD)" });
  });
});
