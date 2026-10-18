// Workers AI list prices (USD per 1M tokens), from developers.cloudflare.com/workers-ai/platform/pricing
// (checked Oct 2026). Unknown models fall back to a deliberately conservative price.

const PRICES: Record<string, { input: number; output: number }> = {
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": { input: 0.045, output: 0.384 },
  "@cf/meta/llama-3.2-3b-instruct": { input: 0.051, output: 0.335 },
  "@cf/meta/llama-3.2-1b-instruct": { input: 0.027, output: 0.201 },
  "@cf/meta/llama-3.1-8b-instruct": { input: 0.282, output: 0.827 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
  "@cf/meta/llama-3.1-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { input: 0.27, output: 0.85 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 0.051, output: 0.335 },
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 },
  "@cf/openai/gpt-oss-20b": { input: 0.2, output: 0.3 },
  "@cf/openai/gpt-oss-120b": { input: 0.35, output: 0.75 },
  "@cf/zai-org/glm-4.7-flash": { input: 0.06, output: 0.4 },
  "@cf/ibm-granite/granite-4.0-h-micro": { input: 0.017, output: 0.112 },
};

const FALLBACK = { input: 1.0, output: 4.0 };

export function priceOf(model: string) {
  return PRICES[model] ?? FALLBACK;
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Rough token estimate (≈4 chars/token for English) used for pre-call budget checks. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
