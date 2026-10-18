import api from "./api";
import { handleQueue, handleScheduled } from "./background";
import type { Env, QueueMessage } from "./env";

export { PrepareApplicationWorkflow } from "./workflows/prepare";
export { SubmitApplicationWorkflow } from "./workflows/submit";

export default {
  // Static assets (the dashboard) are served without invoking the Worker; only /api/* lands here.
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(controller, env));
  },
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
