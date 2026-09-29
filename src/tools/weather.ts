// 天气：沿用 wttr.in 的纯文本接口（无 key、无依赖）。

import { tool } from "ai";
import { z } from "zod";

export function weatherTools() {
  return {
    weather: tool({
      description: "查询某个城市的实时天气。",
      inputSchema: z.object({
        city: z.string().describe("城市名，中文或英文均可"),
      }),
      execute: async ({ city }) => {
        const r = await fetch(
          `https://wttr.in/${encodeURIComponent(city)}?format=4&m&lang=zh`,
        );
        if (!r.ok) return `天气查询失败：HTTP ${r.status}`;
        const text = (await r.text()).trim();
        return text ? `📍 ${city}：${text}` : `查不到「${city}」的天气。`;
      },
    }),
  };
}
