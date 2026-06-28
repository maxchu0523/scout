/** Minimal OpenAI-compatible chat client — works for LM Studio and Ollama. */

function baseOf(url: string): string {
  // Accept either a base ("http://host:1234") or a full endpoint; normalize to base.
  return url.replace(/\/(v1(\/.*)?|api(\/.*)?)?$/, "").replace(/\/$/, "");
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* leave null */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Pick the first available model id from /v1/models. */
async function firstModel(base: string, timeoutMs: number): Promise<string> {
  const { body } = await fetchJson(`${base}/v1/models`, {}, timeoutMs);
  const data = (body as { data?: Array<{ id?: string }> } | null)?.data;
  const id = Array.isArray(data) ? data[0]?.id : undefined;
  if (!id) throw new Error("no models available; pass --model");
  return id;
}

export interface ChatResult {
  model: string;
  text: string;
  raw: unknown;
}

/**
 * Send a single user prompt to an OpenAI-compatible chat endpoint and return the
 * assistant's reply. The AI half of the invoke loop ("talk to LM Studio/Ollama").
 */
export async function chat(
  url: string,
  prompt: string,
  opts: { model?: string; timeoutMs: number },
): Promise<ChatResult> {
  const base = baseOf(url);
  const model = opts.model ?? (await firstModel(base, opts.timeoutMs));

  const { status, body } = await fetchJson(
    `${base}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    opts.timeoutMs,
  );

  if (status !== 200) {
    throw new Error(`chat request failed (HTTP ${status})`);
  }
  const text =
    (body as { choices?: Array<{ message?: { content?: string } }> } | null)
      ?.choices?.[0]?.message?.content ?? "";
  return { model, text, raw: body };
}
