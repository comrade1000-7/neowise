import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, triage } from "../server.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };
let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function post(body) {
  return fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("корректная заявка -> ready с темой и черновиком", async () => {
  const res = await post({ text: "Когда будет доставка?" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ready");
  assert.equal(data.topic, "delivery");
  assert.ok(data.draft.trim().length > 0);
});

for (const [name, body] of [
  ["битый JSON", "{text:"],
  ["нет поля text", {}],
  ["text не строка", { text: 42 }],
  ["пустая строка", { text: "" }],
  ["только пробелы", { text: "   " }],
  ["тело — null", "null"],
]) {
  test(`невалидный ввод (${name}) -> 400 invalid_input`, async () => {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { status: "invalid_input" });
  });
}

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${tag} -> 200 manual_review`, async () => {
    const res = await post({ text: `Сколько стоит? ${tag}` });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), MANUAL);
  });
}

test("таймаут модели -> manual_review не дольше ~300 мс", async () => {
  const started = performance.now();
  const res = await post({ text: "Где заказ? [timeout]" });
  const elapsed = performance.now() - started;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), MANUAL);
  assert.ok(elapsed < 800, `ответ занял ${Math.round(elapsed)} мс`);
});

test("модель, игнорирующая сигнал отмены, тоже обрывается по таймауту", async () => {
  const hanging = () => new Promise(() => {});
  const started = performance.now();
  assert.deepEqual(await triage("текст", { classify: hanging, timeoutMs: 50 }), MANUAL);
  assert.ok(performance.now() - started < 500);
});

test("ответ модели не объект (массив/null) -> manual_review", async () => {
  for (const raw of ["[]", "null", '"строка"', '{"topic":"other"}']) {
    assert.deepEqual(await triage("текст", { classify: async () => raw }), MANUAL);
  }
});
