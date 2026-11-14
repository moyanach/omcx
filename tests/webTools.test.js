const test = require("node:test");
const assert = require("node:assert/strict");
const { scrapePageContent, WebFetchTool } = require("../utils/tools/webTools");

test("webTools SSRF 防护拦截本机、内网、链路本地与非 HTTP 协议", async () => {
  const blockedUrls = [
    "http://127.0.0.1:8080/secret",
    "http://localhost:3000/api",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/admin",
    "http://192.168.1.1/",
    "http://[::1]:9000/",
    "file:///etc/passwd",
  ];

  for (const url of blockedUrls) {
    const res = await scrapePageContent(url);
    assert.equal(res.success, false, `应当拦截 URL: ${url}`);
    assert.ok(res.error, `应当返回错误信息: ${url}`);
  }

  const tool = new WebFetchTool();
  const nonHttp = JSON.parse(await tool.call({ url: "ftp://example.com/a" }));
  assert.equal(nonHttp.success, false);
  assert.match(nonHttp.error, /http:\/\/ 或 https:\/\//);
});
