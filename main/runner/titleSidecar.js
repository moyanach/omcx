const { getModelConfig, pickLiteModel, getStorageService, getAnthropicClient } = require("../shared");

async function generateSessionTitleSidecar(sessionId, userPrompt, currentModelId, webContents) {
  const storageService = getStorageService();
  const { isAnthropicProvider, completeAnthropicMessage } = getAnthropicClient();

  try {
    const session = storageService.getSessions().find((s) => s.id === sessionId);
    if (!session || session.title_source === "custom") {
      return;
    }

    let cleanPrompt = String(userPrompt || "").trim();
    cleanPrompt = cleanPrompt
      .replace(/\[image\s*#?\d+\]/gi, "")
      .replace(/@\S+/g, "")
      .trim();
    if (!cleanPrompt || cleanPrompt.length < 2) return;

    const applyLocalFallbackTitle = () => {
      let snippet = cleanPrompt
        .replace(/^(请问|帮我|请帮我|如何|怎么|麻烦|想问下|我想|分析一下|看一下|看看)[：:，,\s]*/i, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      if (snippet.length > 15) {
        snippet = snippet.slice(0, 15);
      }
      if (snippet.length >= 2) {
        const updated = storageService.updateSessionGeneratedTitle(sessionId, snippet);
        if (updated && webContents && !webContents.isDestroyed()) {
          webContents.send("session-title-updated", { sessionId, title: snippet });
          console.log(`[title-sidecar:fallback] applied local fallback title for ${sessionId}: "${snippet}"`);
        }
      }
    };

    let { modelBaseUrl, modelApiKey, apiModelId, provider } = getModelConfig(
      currentModelId,
      "gpt-4o"
    );
    if (!modelBaseUrl || (!modelApiKey && currentModelId !== "ollama")) {
      const liteChoice = pickLiteModel(currentModelId);
      const liteCfg = getModelConfig(liteChoice, "gpt-4o");
      if (liteCfg.modelBaseUrl && (liteCfg.modelApiKey || liteChoice === "ollama")) {
        modelBaseUrl = liteCfg.modelBaseUrl;
        modelApiKey = liteCfg.modelApiKey;
        apiModelId = liteCfg.apiModelId;
        provider = liteCfg.provider;
      } else {
        applyLocalFallbackTitle();
        return;
      }
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 6000);

    let rawTitle = "";
    try {
      if (isAnthropicProvider(provider, modelBaseUrl)) {
        const anthropicTitle = await completeAnthropicMessage({
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
          model: apiModelId,
          system:
            "你是会话命名助手。根据用户提问的核心意图，提炼出一个简短、精准的中文标题（4到10个汉字）。禁止回答问题，禁止输出任何标点符号、引号、书名号或“标题：”等前缀，直接输出纯文本标题本身。",
          messages: [
            {
              role: "user",
              content: `<message>\n${cleanPrompt.slice(0, 400)}\n</message>`,
            },
          ],
          maxTokens: 40,
          temperature: 0.2,
          signal: controller.signal,
        });
        rawTitle = String(anthropicTitle.content || "").trim();
      } else {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (modelApiKey) {
          headers["Authorization"] = `Bearer ${modelApiKey}`;
        }

        const response = await fetch(`${modelBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: apiModelId,
            messages: [
              {
                role: "system",
                content:
                  "你是会话命名助手。根据用户提问的核心意图，提炼出一个简短、精准的中文标题（4到10个汉字）。禁止回答问题，禁止输出任何标点符号、引号、书名号或“标题：”等前缀，直接输出纯文本标题本身。",
              },
              {
                role: "user",
                content: `<message>\n${cleanPrompt.slice(0, 400)}\n</message>`,
              },
            ],
            max_tokens: 30,
            temperature: 0.2,
            stream: false,
          }),
        });

        if (!response.ok) {
          console.warn(`[title-sidecar] AI 标题接口返回 HTTP ${response.status}，切换本地规则提纯命名`);
          clearTimeout(timeoutTimer);
          applyLocalFallbackTitle();
          return;
        }

        const data = await response.json();
        rawTitle = data?.choices?.[0]?.message?.content?.trim() || "";
      }
    } finally {
      clearTimeout(timeoutTimer);
    }

    if (!rawTitle) {
      applyLocalFallbackTitle();
      return;
    }

    let title = rawTitle
      .replace(/^[`"'“‘《【\[(（\s]+|[`"'”’》】\])）\s]+$/g, "")
      .replace(/^(会话标题|会话名称|标题|Title|Topic)[：:]\s*/i, "")
      .trim();

    title = title.split(/\r?\n/)[0].trim().slice(0, 20);

    if (title.length >= 2) {
      const updated = storageService.updateSessionGeneratedTitle(sessionId, title);
      if (updated && webContents && !webContents.isDestroyed()) {
        webContents.send("session-title-updated", { sessionId, title });
        console.log(`[title-sidecar] generated AI title for ${sessionId}: "${title}"`);
      }
    } else {
      applyLocalFallbackTitle();
    }
  } catch (err) {
    console.warn(`[title-sidecar] 异常 (${err.message})，使用本地规则提纯命名`);
    try {
      let snippet = String(userPrompt || "")
        .replace(/\[image\s*#?\d+\]/gi, "")
        .replace(/@\S+/g, "")
        .replace(/^(请问|帮我|请帮我|如何|怎么|麻烦|想问下|我想|分析一下|看一下|看看)[：:，,\s]*/i, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      if (snippet.length > 15) snippet = snippet.slice(0, 15);
      if (snippet.length >= 2) {
        const updated = storageService.updateSessionGeneratedTitle(sessionId, snippet);
        if (updated && webContents && !webContents.isDestroyed()) {
          webContents.send("session-title-updated", { sessionId, title: snippet });
        }
      }
    } catch {}
  }
}

module.exports = { generateSessionTitleSidecar };
