process.env.OMCX_STORAGE_MEMORY_ONLY = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSecretStorage } = require("../services/secretStorage");
const storageService = require("../services/storageService");

test("secretStorage 支持 safeStorage 加密/解密与渲染脱敏掩码", () => {
  const mockSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`ENC(${plain})`, "utf-8"),
    decryptString: (buf) => {
      const s = buf.toString("utf-8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) throw new Error("bad cipher");
      return s.slice(4, -1);
    },
  };

  const sec = createSecretStorage(mockSafeStorage);
  const cipher = sec.encryptSecret("sk-1234567890abcdef");
  assert.ok(cipher.startsWith(sec.ENC_PREFIX));
  assert.notEqual(cipher, "sk-1234567890abcdef");
  assert.equal(sec.decryptSecret(cipher), "sk-1234567890abcdef");
  // 幂等再加密
  assert.equal(sec.encryptSecret(cipher), cipher);
  // 旧明文兼容读取
  assert.equal(sec.decryptSecret("sk-legacy-plain"), "sk-legacy-plain");

  const masked = sec.maskSecret(cipher);
  assert.equal(masked, "sk-••••cdef");
  assert.equal(sec.isMaskedSecret(masked), true);
  assert.equal(sec.isMaskedSecret("sk-1234567890abcdef"), false);

  const redacted = sec.redactModelForRenderer({
    id: "m1",
    model_id: "deepseek-chat",
    api_key: cipher,
    apiKey: "sk-1234567890abcdef",
  });
  assert.equal(redacted.api_key, "sk-••••cdef");
  assert.equal(redacted.apiKey, undefined);
  assert.equal(redacted.has_api_key, true);
  assert.equal(redacted.api_key_masked, true);
});

test("addModel 收到掩码密钥或 preserveApiKey 时保留原明文密钥，不覆盖破坏", () => {
  storageService.initStorage();
  const { maskSecret } = require("../services/secretStorage");

  storageService.addModel({
    id: "m_keep_test",
    name: "Test Model",
    provider: "openai",
    model_id: "gpt-4o",
    base_url: "https://api.openai.com/v1",
    api_key: "sk-real-secret-9988",
  });

  const maskedSentToUi = maskSecret("sk-real-secret-9988");
  storageService.addModel({
    id: "m_keep_test",
    name: "Test Model Renamed",
    provider: "openai",
    model_id: "gpt-4o",
    base_url: "https://api.openai.com/v1",
    api_key: maskedSentToUi,
  });

  const stored1 = storageService.getModels().find((m) => m.id === "m_keep_test");
  assert.equal(stored1.name, "Test Model Renamed");
  assert.equal(stored1.api_key, "sk-real-secret-9988");

  storageService.addModel({
    id: "m_keep_test",
    name: "Test Model Lite",
    provider: "openai",
    model_id: "gpt-4o",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    preserveApiKey: true,
    is_lite: true,
  });

  const stored2 = storageService.getModels().find((m) => m.id === "m_keep_test");
  assert.equal(stored2.is_lite, true);
  assert.equal(stored2.api_key, "sk-real-secret-9988");
});

test("searchSessionsAsync 支持标题与消息正文全文检索及上下文摘要裁剪", async () => {
  storageService.initStorage();
  const s1 = `sess_search_1_${Date.now()}`;
  const s2 = `sess_search_2_${Date.now()}`;

  storageService.saveSession({ id: s1, title: "讨论 Prompt Cache 优化方案" });
  storageService.saveSession({ id: s2, title: "普通前端样式调整" });

  storageService.addMessage(s1, {
    id: "msg_s1_1",
    role: "user",
    content: "为什么命中率偏低？",
  });
  storageService.addMessage(s2, {
    id: "msg_s2_1",
    role: "assistant",
    content: "我们在排查过程中发现了 AbortController 超时异常，导致 socket 提前断流。",
  });

  const hits = await storageService.searchSessionsAsync("AbortController");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, s2);
  assert.equal(hits[0].matchType, "message");
  assert.match(hits[0].matchSnippet, /AbortController/);

  const titleHits = await storageService.searchSessionsAsync("Prompt Cache");
  assert.equal(titleHits.length, 1);
  assert.equal(titleHits[0].sessionId, s1);
  assert.equal(titleHits[0].matchType, "title");
});
