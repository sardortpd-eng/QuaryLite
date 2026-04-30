import type { AISettings } from "../App";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type StreamChunk =
  | { type: "token"; text: string }
  | { type: "status"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done" }
  | { type: "error"; text: string };

async function* parseSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) yield trimmed.slice(6);
    }
  }
}

async function* parseNDJSON(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield line.trim();
    }
  }
}

export async function* streamChat(
  settings: AISettings,
  history: ChatMessage[],
  schema: string,
): AsyncGenerator<StreamChunk> {
  yield { type: "status", text: "Thinking…" };

  try {
    if (settings.provider === "anthropic") {
      yield* streamAnthropic(settings, history, schema);
    } else if (settings.provider === "openai") {
      yield* streamOpenAI(settings, history, schema);
    } else if (settings.provider === "ollama") {
      yield* streamOllama(settings, history, schema);
    } else if (settings.provider === "openrouter") {
      yield* streamOpenRouter(settings, history, schema);
    } else {
      yield { type: "error", text: "No provider configured. Open Settings to set up an AI provider." };
      return;
    }
  } catch (e) {
    yield { type: "error", text: String(e) };
    return;
  }

  yield { type: "done" };
}

function buildSystemPrompt(schema: string): string {
  return `You are a SQLite data analyst embedded in QueryLite, a desktop SQL IDE.

Database schema:
${schema}

Rules:
- Be extremely concise. No unnecessary explanations.
- For data questions ("show me…", "what are…", "top N…"): write the SQL query only, then say one short sentence like "Here are the results." — nothing more.
- Only explain concepts or schema details if the user explicitly asks "why", "how", or "explain".
- Always use valid SQLite syntax and wrap SQL in \`\`\`sql blocks.
- Never narrate what the query does unless asked.`;
}

async function* streamAnthropic(
  s: AISettings,
  history: ChatMessage[],
  schema: string,
): AsyncGenerator<StreamChunk> {
  if (!s.anthropic_key) {
    yield { type: "error", text: "Anthropic API key not set. Open Settings to add it." };
    return;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": s.anthropic_key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: s.anthropic_model,
      max_tokens: 4096,
      stream: true,
      system: buildSystemPrompt(schema),
      messages: history,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    yield { type: "error", text: `Anthropic error ${response.status}: ${err}` };
    return;
  }

  yield { type: "status", text: "Generating response…" };

  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of parseSSE(response)) {
    if (data === "[DONE]") break;
    try {
      const obj = JSON.parse(data);
      if (obj.type === "message_start") {
        inputTokens = obj.message?.usage?.input_tokens ?? 0;
      } else if (obj.type === "message_delta") {
        outputTokens = obj.usage?.output_tokens ?? 0;
      } else if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
        yield { type: "token", text: obj.delta.text };
      }
    } catch { /* ignore non-JSON */ }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield { type: "usage", promptTokens: inputTokens, completionTokens: outputTokens };
  }
}

async function* streamOpenAI(
  s: AISettings,
  history: ChatMessage[],
  schema: string,
): AsyncGenerator<StreamChunk> {
  if (!s.openai_key) {
    yield { type: "error", text: "OpenAI API key not set. Open Settings to add it." };
    return;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${s.openai_key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: s.openai_model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: buildSystemPrompt(schema) },
        ...history,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    yield { type: "error", text: `OpenAI error ${response.status}: ${err}` };
    return;
  }

  yield { type: "status", text: "Generating response…" };
  yield* parseOpenAISSE(response);
}

async function* streamOpenRouter(
  s: AISettings,
  history: ChatMessage[],
  schema: string,
): AsyncGenerator<StreamChunk> {
  if (!s.openrouter_key) {
    yield { type: "error", text: "OpenRouter API key not set. Open Settings to add it." };
    return;
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${s.openrouter_key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: s.openrouter_model,
      stream: true,
      messages: [
        { role: "system", content: buildSystemPrompt(schema) },
        ...history,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    yield { type: "error", text: `OpenRouter error ${response.status}: ${err}` };
    return;
  }

  yield { type: "status", text: "Generating response…" };
  yield* parseOpenAISSE(response);
}

async function* parseOpenAISSE(response: Response): AsyncGenerator<StreamChunk> {
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of parseSSE(response)) {
    if (data === "[DONE]") break;
    try {
      const obj = JSON.parse(data);
      const text = obj.choices?.[0]?.delta?.content;
      if (text) yield { type: "token", text };
      if (obj.usage) {
        inputTokens = obj.usage.prompt_tokens ?? 0;
        outputTokens = obj.usage.completion_tokens ?? 0;
      }
    } catch { /* ignore */ }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield { type: "usage", promptTokens: inputTokens, completionTokens: outputTokens };
  }
}

async function* streamOllama(
  s: AISettings,
  history: ChatMessage[],
  schema: string,
): AsyncGenerator<StreamChunk> {
  const base = s.ollama_base_url.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s.ollama_key) headers["Authorization"] = `Bearer ${s.ollama_key}`;

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: s.ollama_model,
      stream: true,
      messages: [
        { role: "system", content: buildSystemPrompt(schema) },
        ...history,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    yield { type: "error", text: `Ollama error ${response.status}: ${err}` };
    return;
  }

  yield { type: "status", text: "Generating response…" };

  for await (const line of parseNDJSON(response)) {
    try {
      const obj = JSON.parse(line);
      if (obj.done) break;
      const text = obj.message?.content;
      if (text) yield { type: "token", text };
    } catch { /* ignore */ }
  }
}
