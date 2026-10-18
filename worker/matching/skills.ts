// Deterministic skill extraction. A curated dictionary (canonical -> aliases) is matched
// against n-grams of the text, so extraction is O(tokens) rather than O(skills x text).

const SKILLS: Record<string, string[]> = {
  // Languages
  JavaScript: ["javascript", "js", "es6", "ecmascript"],
  TypeScript: ["typescript", "ts"],
  Python: ["python"],
  Java: ["java"],
  Kotlin: ["kotlin"],
  Scala: ["scala"],
  Go: ["golang", "go lang"],
  Rust: ["rust"],
  "C++": ["c++", "cpp"],
  C: ["c language", "ansi c"],
  "C#": ["c#", "csharp", "c sharp"],
  Ruby: ["ruby"],
  PHP: ["php"],
  Swift: ["swift"],
  "Objective-C": ["objective-c", "objective c"],
  Elixir: ["elixir"],
  Haskell: ["haskell"],
  Clojure: ["clojure"],
  R: ["r programming", "r language"],
  Julia: ["julia"],
  Dart: ["dart"],
  Bash: ["bash", "shell scripting", "shell script"],
  SQL: ["sql"],
  GraphQL: ["graphql"],
  Solidity: ["solidity"],
  // Frontend
  React: ["react", "react.js", "reactjs"],
  "React Native": ["react native"],
  "Next.js": ["next.js", "nextjs"],
  Vue: ["vue", "vue.js", "vuejs"],
  Angular: ["angular", "angularjs"],
  Svelte: ["svelte", "sveltekit"],
  Redux: ["redux"],
  "HTML/CSS": ["html", "css", "html5", "css3"],
  "Tailwind CSS": ["tailwind", "tailwindcss", "tailwind css"],
  Webpack: ["webpack"],
  Vite: ["vite"],
  // Backend / runtime
  "Node.js": ["node.js", "nodejs", "node js"],
  Deno: ["deno"],
  Express: ["express.js", "expressjs"],
  NestJS: ["nestjs", "nest.js"],
  Django: ["django"],
  Flask: ["flask"],
  FastAPI: ["fastapi"],
  Rails: ["rails", "ruby on rails"],
  Spring: ["spring boot", "spring framework", "springboot"],
  ".NET": [".net", "dotnet", "asp.net"],
  gRPC: ["grpc"],
  "REST APIs": ["rest api", "rest apis", "restful", "rest"],
  Microservices: ["microservices", "microservice", "service-oriented architecture"],
  "Distributed Systems": ["distributed systems", "distributed system", "distributed computing"],
  // Data stores
  PostgreSQL: ["postgresql", "postgres"],
  MySQL: ["mysql"],
  SQLite: ["sqlite"],
  MongoDB: ["mongodb", "mongo"],
  Redis: ["redis"],
  Cassandra: ["cassandra"],
  DynamoDB: ["dynamodb"],
  Elasticsearch: ["elasticsearch", "opensearch", "elastic search"],
  Snowflake: ["snowflake"],
  BigQuery: ["bigquery", "big query"],
  Redshift: ["redshift"],
  ClickHouse: ["clickhouse"],
  Databricks: ["databricks"],
  // Data engineering
  Spark: ["spark", "pyspark", "apache spark"],
  Kafka: ["kafka", "apache kafka"],
  Airflow: ["airflow", "apache airflow"],
  dbt: ["dbt"],
  Flink: ["flink", "apache flink"],
  Hadoop: ["hadoop"],
  ETL: ["etl", "elt", "data pipelines", "data pipeline"],
  "Data Modeling": ["data modeling", "data modelling"],
  // Cloud / infra
  AWS: ["aws", "amazon web services"],
  GCP: ["gcp", "google cloud", "google cloud platform"],
  Azure: ["azure", "microsoft azure"],
  Cloudflare: ["cloudflare", "cloudflare workers"],
  Kubernetes: ["kubernetes", "k8s"],
  Docker: ["docker", "containers", "containerization"],
  Terraform: ["terraform"],
  Pulumi: ["pulumi"],
  Ansible: ["ansible"],
  Helm: ["helm"],
  Linux: ["linux", "unix"],
  "CI/CD": ["ci/cd", "continuous integration", "continuous delivery", "continuous deployment", "github actions", "jenkins", "circleci", "gitlab ci"],
  Git: ["git"],
  Serverless: ["serverless", "lambda", "aws lambda"],
  Observability: ["observability", "prometheus", "grafana", "datadog", "opentelemetry"],
  SRE: ["sre", "site reliability", "site reliability engineering"],
  Networking: ["networking", "tcp/ip", "dns", "bgp"],
  Security: ["security", "appsec", "application security", "infosec"],
  // ML / AI
  "Machine Learning": ["machine learning", "ml"],
  "Deep Learning": ["deep learning"],
  PyTorch: ["pytorch"],
  TensorFlow: ["tensorflow"],
  JAX: ["jax"],
  "scikit-learn": ["scikit-learn", "sklearn"],
  Pandas: ["pandas"],
  NumPy: ["numpy"],
  LLMs: ["llm", "llms", "large language models", "large language model", "generative ai", "genai"],
  NLP: ["nlp", "natural language processing"],
  "Computer Vision": ["computer vision"],
  MLOps: ["mlops", "ml ops", "model deployment"],
  RAG: ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
  CUDA: ["cuda"],
  Statistics: ["statistics", "statistical modeling", "statistical analysis"],
  "A/B Testing": ["a/b testing", "ab testing", "experimentation"],
  // Mobile
  iOS: ["ios"],
  Android: ["android"],
  Flutter: ["flutter"],
  SwiftUI: ["swiftui"],
  // Product / design / analytics
  Figma: ["figma"],
  "UX Design": ["ux design", "user experience", "ux research", "interaction design"],
  "Product Management": ["product management", "product strategy", "roadmapping", "product roadmap"],
  Analytics: ["analytics", "data analysis", "data analytics"],
  Tableau: ["tableau"],
  Looker: ["looker"],
  "Power BI": ["power bi", "powerbi"],
  Excel: ["excel", "spreadsheets"],
  // Business
  Salesforce: ["salesforce", "sfdc"],
  HubSpot: ["hubspot"],
  "B2B Sales": ["b2b sales", "enterprise sales", "saas sales"],
  "Account Management": ["account management"],
  SEO: ["seo", "search engine optimization"],
  "Project Management": ["project management", "program management"],
  Agile: ["agile", "scrum", "kanban"],
  "Technical Writing": ["technical writing", "documentation"],
  Leadership: ["people management", "team leadership", "managing engineers", "engineering management"],
  "System Design": ["system design", "systems design", "software architecture"],
  Testing: ["unit testing", "integration testing", "test automation", "tdd", "jest", "pytest", "playwright", "cypress", "selenium"],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9+#./-]+/)
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ""))
    .filter(Boolean);
}

/** Set of 1-3 word n-grams for fast phrase lookup. */
export function ngramSet(text: string): Set<string> {
  const toks = tokenize(text);
  const set = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    set.add(toks[i]!);
    if (i + 1 < toks.length) set.add(`${toks[i]} ${toks[i + 1]}`);
    if (i + 2 < toks.length) set.add(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  }
  return set;
}

const normPhrase = (s: string) => tokenize(s).join(" ");

// alias (normalized) -> canonical
const ALIAS_INDEX = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(SKILLS)) {
  for (const a of [canonical, ...aliases]) {
    const n = normPhrase(a);
    if (n) ALIAS_INDEX.set(n, canonical);
  }
}

// Aliases too ambiguous to count in free text ("go to market", "rest of the team").
// Unambiguous aliases of the same skill ("golang", "rest api") still match, and the
// candidate's own skill list may still contain them.
const AMBIGUOUS = new Set(["rest", "go", "r", "c", "ts", "express", "dart", "julia", "swift", "security", "documentation", "containers", "experimentation", "lambda", "networking", "analytics"]);

export function canonicalSkill(s: string): string {
  return ALIAS_INDEX.get(normPhrase(s)) ?? s.trim();
}

export function extractSkills(text: string, grams = ngramSet(text)): string[] {
  const found = new Set<string>();
  for (const [alias, canonical] of ALIAS_INDEX) {
    if (!grams.has(alias)) continue;
    if (AMBIGUOUS.has(alias)) continue;
    found.add(canonical);
  }
  return [...found];
}

/** Does a candidate (skills list + resume n-grams) have this skill? */
export function hasSkill(skill: string, candidateSkills: Set<string>, resumeGrams: Set<string>): boolean {
  const canonical = canonicalSkill(skill);
  if (candidateSkills.has(canonical.toLowerCase())) return true;
  const aliases = SKILLS[canonical];
  if (aliases) return [canonical, ...aliases].some((a) => resumeGrams.has(normPhrase(a)));
  return resumeGrams.has(normPhrase(skill));
}

/** Known technical vocabulary (normalized aliases) — used by the anti-fabrication guard. */
export function knownTermsIn(text: string): Set<string> {
  const grams = ngramSet(text);
  const out = new Set<string>();
  for (const [alias, canonical] of ALIAS_INDEX) if (grams.has(alias) && !AMBIGUOUS.has(alias)) out.add(canonical);
  return out;
}
