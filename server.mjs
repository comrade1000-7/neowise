import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class InvalidInput extends Error {}

// Читаем тело и достаём непустую строку text. Любая проблема со входом -> InvalidInput.
async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("broken json");
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text must be a non-empty string");
  return text;
}

// Проверка ответа модели: это главное место, где мы не доверяем AI.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

// Вызов модели с жёстким лимитом: abort-сигнал + гонка с таймером,
// чтобы не зависеть от того, уважает ли провайдер сигнал.
export async function callModel(classify, text, timeoutMs = MODEL_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function triage(text, { classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  let raw;
  try {
    raw = await callModel(classify, text, timeoutMs);
  } catch {
    return MANUAL_REVIEW;
  }
  const parsed = parseModelOutput(raw);
  return parsed ? { status: "ready", ...parsed } : MANUAL_REVIEW;
}

export function createApp(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    let text;
    try {
      text = await readText(request);
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, INVALID_INPUT);
      return json(response, 500, { status: "server_error" });
    }
    try {
      json(response, 200, await triage(text, options));
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
}
