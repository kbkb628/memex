/**
 * wrangler 只会把 bindings 生成进 Env，secret 和 .dev.vars 里的变量不会自动出现。
 * 这里补上与配置合并的声明，避免代码里到处 `as any`。
 *
 * 注意：这个文件不能被 `wrangler types` 覆盖，所以单独放在 src 下。
 */
interface Env {
  /** DeepSeek 官方 key。本地写在 .dev.vars，线上用 `wrangler secret put`。 */
  DEEPSEEK_API_KEY?: string;
  /** 覆盖默认模型 id。例如 deepseek-v4-pro。 */
  AGENT_MODEL?: string;
  /**
   * 可选的多租户隔离。逗号分隔的 token 列表。
   * 不设 = 单用户模式；设了 = 每个 token 各自一个独立 Durable Object。
   */
  ACCESS_TOKENS?: string;
}
