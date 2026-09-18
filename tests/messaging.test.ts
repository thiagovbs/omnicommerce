import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { handleDispatchJob, handleOrderJob } from "../lib/messaging/job-handlers";
import { qstashPublisher } from "../lib/messaging/qstash";
import { OrderError } from "../lib/domain/order-input";

test("endpoints e publicação QStash sem chamadas externas", async (t) => {
  const names = ["APP_URL", "QSTASH_URL", "QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "CRON_SECRET"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const url = "https://example.invalid/api/jobs/marketplace-events";
  const key = "test-signing-key-with-at-least-32-characters";
  const body = JSON.stringify({ eventId: "test-event" });
  const sign = (payloadBody: string, subject = url, exp = Math.floor(Date.now() / 1000) + 60, signingKey = key) => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "Upstash", sub: subject, exp, nbf: 0,
      body: createHash("sha256").update(payloadBody).digest("base64url"),
    })).toString("base64url");
    const content = `${header}.${payload}`;
    return `${content}.${createHmac("sha256", signingKey).update(content).digest("base64url")}`;
  };
  const request = (signature?: string, payload = body) => new Request(url, { method: "POST", body: payload,
    headers: signature ? { "upstash-signature": signature } : {},
  });
  try {
    for (const name of names) delete process.env[name];
    await t.test("sem configuração retorna 503 e não processa", async () => {
      assert.equal((await handleOrderJob(request(), async () => { assert.fail("should not run"); })).status, 503);
    });
    process.env.APP_URL = "https://example.invalid";
    process.env.QSTASH_TOKEN = "test-token";
    process.env.QSTASH_CURRENT_SIGNING_KEY = key;
    process.env.QSTASH_NEXT_SIGNING_KEY = key + "-next";
    process.env.CRON_SECRET = "test-cron-secret-with-at-least-32-characters";
    await t.test("rejeita assinatura ausente, corpo alterado, URL incorreta e token expirado", async () => {
      for (const input of [request(), request("invalid"), request(sign("different body")), request(sign(body, "https://wrong.invalid")), request(sign(body, url, 1))]) {
        assert.equal((await handleOrderJob(input, async () => { assert.fail("should not run"); })).status, 401);
      }
    });
    await t.test("assinatura válida e rotação de chave permitem consumir só o ID", async () => {
      for (const signingKey of [key, key + "-next"]) {
        const response = await handleOrderJob(request(sign(body, url, undefined, signingKey)), async (id) => {
          assert.equal(id, "test-event"); return "PROCESSED";
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "PROCESSED" });
      }
    });
    await t.test("limita tamanho e diferencia falha transitória de falha de domínio", async () => {
      assert.equal((await handleOrderJob(request("invalid", "x".repeat(5000)), async () => "PROCESSED")).status, 413);
      assert.equal((await handleOrderJob(request(sign(body)), async () => { throw new Error("db private details"); })).status, 500);
      const permanent = await handleOrderJob(request(sign(body)), async () => { throw new OrderError("invalid state"); });
      assert.deepEqual(await permanent.json(), { status: "FAILED" });
    });
    await t.test("dispatcher exige segredo de serviço", async () => {
      assert.equal((await handleDispatchJob(new Request(url), async () => { assert.fail("should not run"); })).status, 401);
      const response = await handleDispatchJob(new Request(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), async () => ({ published: 1 }));
      assert.equal(response.status, 200);
    });
    await t.test("publicação usa destino fixo, corpo mínimo e timeout; erro remoto é rejeitado", async () => {
      const publisher = qstashPublisher(async (input, init) => {
        assert.equal(input, `https://qstash.upstash.io/v2/publish/${url}`);
        assert.deepEqual(JSON.parse(String(init?.body)), { eventId: "test-event" });
        assert(init?.signal);
        assert.equal(new Headers(init?.headers).get("Upstash-Deduplication-Id"), "delivery-1");
        return Response.json({ messageId: "published-1" });
      });
      await publisher({ eventId: "test-event", deduplicationId: "delivery-1" });
      await assert.rejects(qstashPublisher(async () => new Response("private details", { status: 429 }))({ eventId: "test-event", deduplicationId: "delivery-2" }));
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
