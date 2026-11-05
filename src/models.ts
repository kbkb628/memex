import type { Api, CredentialInfo, CredentialStore, Model } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

/**
 * 模型层与部署平台解耦。
 *
 * 之前把 agent 焊死在 Workers AI binding 上，后果是 `wrangler dev` 必须走
 * remote 模式 —— 而 remote 模式要求账号先注册 workers.dev 子域名，于是本地
 * 连一行代码都跑不起来。个人 agent 用哪个模型，本来就不该由部署平台决定。
 *
 * 现在只有一条路径：DeepSeek 官方 API。少一条分支，就少一类「为什么本地起不来」
 * 的问题。想换 Anthropic / OpenAI，把下面的 provider 换掉即可 —— pi-ai 自带
 * 四十多个 provider，接口是同一个。
 */

const DEFAULT_MODEL = "deepseek-flash";

/**
 * 只读凭据存储。pi-ai 默认从 auth.json 读并且允许写入，但 Worker 里没有可写的
 * 文件系统，也不该让运行时改凭据 —— 只从 env 取。
 */
function credentialStore(env: Env): CredentialStore {
  const key = env.DEEPSEEK_API_KEY?.trim();
  const known: CredentialInfo[] = key ? [{ providerId: "deepseek", type: "api_key" }] : [];

  return {
    async read(providerId) {
      if (providerId !== "deepseek" || !key) return undefined;
      return { type: "api_key", key };
    },
    async list() {
      return known;
    },
    async modify() {
      throw new Error("凭据只读：本地改 .dev.vars，线上用 `wrangler secret put`");
    },
    async delete() {
      throw new Error("凭据只读：本地改 .dev.vars，线上用 `wrangler secret put`");
    },
  };
}

export interface ModelSetup {
  models: MutableModels;
  model: Model<Api>;
  /** 给 /status 看的人类可读标识。 */
  label: string;
  /** false 表示能启动、能读记忆，但一发消息就会失败。 */
  ready: boolean;
  hint?: string;
}

export function buildModels(env: Env): ModelSetup {
  const models = createModels({ credentials: credentialStore(env) });
  models.setProvider(deepseekProvider());

  const wanted = env.AGENT_MODEL?.trim();
  const model = models.getModel("deepseek", wanted || DEFAULT_MODEL) ?? models.getModel("deepseek", DEFAULT_MODEL);
  if (!model) throw new Error("pi-ai 里找不到 deepseek 的默认模型，检查包版本是否被换过");

  if (env.DEEPSEEK_API_KEY?.trim()) {
    return { models, model, label: `deepseek/${model.id}`, ready: true };
  }

  // 没配 key 也照样把 provider 装上：DO 能启动、能建表、能读提示词和记忆，
  // 只在真正调用模型时给出可读错误，而不是整个服务起不来。
  return {
    models,
    model,
    label: `deepseek/${model.id}（未配置 key）`,
    ready: false,
    hint: "缺 DEEPSEEK_API_KEY。本地：cp .dev.vars.example .dev.vars 并填入 key；线上：npx wrangler secret put DEEPSEEK_API_KEY",
  };
}
