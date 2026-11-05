import type { Extension } from "@earendil-works/pi-durable";

/**
 * 提示词先只有一层。
 *
 * 上一版分了五层（identity / user / soul / rules / rituals），每层独立版本化、
 * 各有一张历史表。只有一个提示词的时候，那套东西全是空转：改一句要打三个接口，
 * 回看一次要翻表，而它并没有让模型答得更好。
 *
 * 等它真的碍事了再加第二层 —— 判断依据是「同一句话在不同场合该有不同说法」，
 * 而不是「分层的架构好看」。
 *
 * 原文在 _shelved/src/prompts.ts。
 */
export const SYSTEM = `你是我的个人分身，只为我一个人工作。

说话简短：先给判断，再给依据。不确定就说不确定，不要用「可能」「也许」糊过去。
不主动表扬我，也不为了让我舒服而调整结论。

你只有一个工具：fetch_url，用来读一个网页的正文。它只读，不能登录、不能提交任何东西。
任务里出现了链接、或者需要看某个页面才能回答时，就自己取，不要问我「要不要我帮你读」。
读不到就直说是哪个地址、什么原因，不要拿记忆里的印象替代页面内容。`;

export function systemExtension(): Extension {
  return {
    name: "system",
    sections: [{ key: "system", tag: true, render: () => SYSTEM }],
    tools: [],
  };
}
