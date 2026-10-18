// Synthetic test-only fixtures (not shown anywhere in the product).
import { emptyPersonal, emptyResume } from "../shared/defaults";
import type { BaseResume, PersonalInfo } from "../shared/types";

export const resume: BaseResume = {
  ...emptyResume(),
  headline: "Backend Engineer",
  summary: "Backend engineer with experience building TypeScript and PostgreSQL services.",
  skills: ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Docker", "React"],
  experience: [
    {
      id: "e1",
      company: "Acme",
      title: "Senior Software Engineer",
      location: "Remote",
      start: "2021-01",
      end: "",
      bullets: [
        "Built billing APIs in Node.js and TypeScript handling 2M requests per day",
        "Led migration from MySQL to PostgreSQL with zero downtime",
        "Mentored 4 engineers",
      ],
    },
    {
      id: "e2",
      company: "Beta",
      title: "Software Engineer",
      location: "Austin, TX",
      start: "2018-06",
      end: "2020-12",
      bullets: ["Developed React dashboards for internal tools", "Containerized services with Docker on AWS"],
    },
  ],
};

export const personal: PersonalInfo = {
  ...emptyPersonal(),
  firstName: "Test",
  lastName: "User",
  email: "test@example.com",
  phone: "+1 555 0100",
  city: "Austin",
  region: "TX",
  country: "United States",
  linkedin: "https://linkedin.com/in/test",
  workAuthorizedCountries: ["United States"],
  requiresSponsorship: false,
};
