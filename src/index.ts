import { Home } from "./home";

export { Home };

/**
 * 唯一的入口。所有渠道（网页、手机、IM webhook、定时任务）
 * 都写进同一个 Durable Object —— 这就是「同一个懂前因后果的分身」的实现，
 * 不需要 Router 单独转发。
 */

/**
 * 可选的多租户隔离。
 *
 * 不配 ACCESS_TOKENS：单用户模式，一切进同一个对象，零配置。
 * 配了：每个 token 派生一个独立的 Durable Object，互相看不到对方的记忆。
 *
 * 用「token 的 hash 当对象名」而不是建一张用户表，是因为这两件事本来
 * 就是同一件事——谁的数据在哪个命名空间里。多一张表，就多一次写不一致的机会。
 */
async function resolveTenant(request: Request, env: Env): Promise<{ tenant: string } | Response> {
  const raw = env.ACCESS_TOKENS?.trim();
  if (!raw) return { tenant: "me" };

  const allowed = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const given = bearer || new URL(request.url).searchParams.get("token") || "";

  if (!given || !allowed.includes(given)) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="personal-agent"' },
    });
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(given));
  const tenant = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { tenant };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");

    const auth = await resolveTenant(request, env);
    if (auth instanceof Response) return auth;

    const stub = env.HOME.get(env.HOME.idFromName(auth.tenant));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
