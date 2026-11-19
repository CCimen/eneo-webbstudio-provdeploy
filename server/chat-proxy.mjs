// POST /api/chat → Eneo. Nyckeln och assistentens id stannar på servern.
// Webbläsaren får en förenklad ström: {type:"session"|"text"|"sources"|"error"|"done"}.
// Används både av Vite i utveckling (vite.config.ts) och av serve.mjs i produktion.

const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUESTION_CHARS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ponytail: minnesbaserad gräns per IP i en process. Räcker för en container;
// flytta till Traefik-middleware eller Redis om sajten skalas ut.
const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

function clientIp(req) {
  // Traefik (Dokploy) skriver över X-Forwarded-For med klientens adress.
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "okänd";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function config(env) {
  const base = (env.ENEO_BASE_URL || "https://test.eneo.ai").replace(/\/+$/, "");
  const key = env.ENEO_CHAT_KEY;
  const assistantId = env.ENEO_ASSISTANT_ID;
  if (!key || !assistantId) return null;
  return { base, key, assistantId };
}

export async function handleChat(req, res, env = process.env) {
  if (req.method !== "POST") return sendJson(res, 405, { message: "Endast POST." });
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return sendJson(res, 415, { message: "Skicka JSON." });
  }
  const cfg = config(env);
  if (!cfg) {
    console.error("chat: ENEO_CHAT_KEY eller ENEO_ASSISTANT_ID saknas");
    return sendJson(res, 503, { message: "Chatten är inte konfigurerad." });
  }
  if (rateLimited(clientIp(req))) {
    return sendJson(res, 429, { message: "Du har skickat många frågor. Vänta en stund och försök igen." });
  }

  let input;
  try {
    input = await readBody(req);
  } catch {
    return sendJson(res, 400, { message: "Ogiltig förfrågan." });
  }
  const question = typeof input?.question === "string" ? input.question.trim() : "";
  const sessionId = input?.sessionId;
  if (!question || question.length > MAX_QUESTION_CHARS) {
    return sendJson(res, 400, { message: `Frågan måste vara 1–${MAX_QUESTION_CHARS} tecken.` });
  }
  if (sessionId !== undefined && sessionId !== null && !(typeof sessionId === "string" && UUID.test(sessionId))) {
    return sendJson(res, 400, { message: "Ogiltig konversation." });
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const timeout = setTimeout(() => abort.abort(), 120_000);

  let upstream;
  try {
    upstream = await fetch(`${cfg.base}/api/v1/conversations/?version=2`, {
      method: "POST",
      headers: { "X-API-Key": cfg.key, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(
        sessionId ? { session_id: sessionId, question, stream: true } : { assistant_id: cfg.assistantId, question, stream: true },
      ),
      signal: abort.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error("chat: Eneo svarar inte", error?.name);
    return sendJson(res, 502, { message: "Assistenten svarar inte just nu. Försök igen om en stund." });
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeout);
    const detail = await upstream.text().catch(() => "");
    const code = detail.match(/"code"\s*:\s*"([^"]+)"/)?.[1];
    console.error(`chat: Eneo ${upstream.status} ${code ?? ""}`);
    if (upstream.status === 429) return sendJson(res, 429, { message: "Assistenten har många frågor just nu. Försök igen om en stund." });
    return sendJson(res, 502, { message: "Assistenten kunde inte svara. Försök igen." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const sources = new Map();
  let sentSession = false;

  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = frame.match(/^event: ?(.*)$/m)?.[1];
        const data = frame.match(/^data: ?(.*)$/m)?.[1];
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (!sentSession && payload.session_id) {
          emit({ type: "session", id: payload.session_id });
          sentSession = true;
        }
        if (event === "text") {
          if (payload.answer) emit({ type: "text", text: payload.answer });
          for (const ref of payload.references ?? []) {
            const url = ref.metadata?.url;
            sources.set(String(ref.id).slice(0, 8), {
              id: String(ref.id).slice(0, 8),
              title: ref.metadata?.title || url || "Källa",
              url: typeof url === "string" && /^https?:\/\//.test(url) ? url : null,
            });
          }
        } else if (event === "error") {
          console.error(`chat: strömfel ${payload.code ?? ""}`);
          emit({ type: "error", message: "Svaret avbröts. Försök igen." });
        }
      }
    }
    if (sources.size) emit({ type: "sources", items: [...sources.values()] });
    emit({ type: "done" });
  } catch (error) {
    if (!abort.signal.aborted) console.error("chat: strömmen bröts", error?.name);
    emit({ type: "error", message: "Svaret avbröts. Försök igen." });
  } finally {
    clearTimeout(timeout);
    res.end();
  }
}
