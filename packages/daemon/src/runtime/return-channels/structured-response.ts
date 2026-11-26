import type { ZodType, ZodTypeDef } from "zod";

/**
 * 强类型 JSON 回传解析与自动纠错重试闭环（通道四：StructuredResponse）
 * 免疫模型在 JSON 前后夹带解释性文字，利用括号深度状态机精确提取并做 Zod 校验自愈重试
 */

/**
 * 从混杂 Markdown 或自然语言的字符串中提取第一个平衡的 JSON 对象 {...} 或数组 [...]
 */
export function extractBalancedJsonBlock(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw.trim();

  let startIdx = -1;
  let openChar = "";
  let closeChar = "";
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (ch === "{" || ch === "[") {
      startIdx = i;
      openChar = ch;
      closeChar = ch === "{" ? "}" : "]";
      break;
    }
  }
  if (startIdx < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * 执行带 Zod Schema 校验与错误反馈自愈重试的结构化大模型调用
 */
export async function generateStructuredWithRetry<T>(params: {
  schema: ZodType<T, ZodTypeDef, unknown>;
  schemaHint: string;
  initialPrompt: string;
  invokeModel: (prompt: string) => Promise<string>;
  maxRetries?: number;
}): Promise<T> {
  const maxRetries = params.maxRetries ?? 2;
  let currentPrompt = [
    params.initialPrompt,
    "",
    "请严格且仅输出符合以下 JSON 结构的合法 JSON 对象（不要包裹无关解释）：",
    params.schemaHint,
  ].join("\n");

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const rawOutput = await params.invokeModel(currentPrompt);
    const jsonSlice = extractBalancedJsonBlock(rawOutput);
    if (!jsonSlice) {
      lastError = `未在输出中找到合法 JSON 对象或数组。原始输出片段: ${rawOutput.slice(0, 300)}`;
    } else {
      try {
        const parsedJson: unknown = JSON.parse(jsonSlice);
        const validated = params.schema.safeParse(parsedJson);
        if (validated.success) {
          return validated.data;
        }
        lastError = validated.error.issues
          .map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`)
          .join("; ");
      } catch (err) {
        lastError = `JSON 语法解析错误: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (attempt < maxRetries) {
      currentPrompt = [
        params.initialPrompt,
        "",
        `你上一轮输出的 JSON 未通过校验，错误详情：${lastError}`,
        "请立即修正上述字段问题，仅重新输出完整合法的 JSON：",
        params.schemaHint,
      ].join("\n");
    }
  }

  throw new Error(`结构化 JSON 输出校验失败（已重试 ${maxRetries} 次）: ${lastError}`);
}
