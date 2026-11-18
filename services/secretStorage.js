/**
 * secretStorage.js — 凭据加密与渲染层脱敏工具
 *
 * 1. 桌面端使用 Electron safeStorage（委托 macOS Keychain / 系统凭据库）加密落盘；
 * 2. Headless CLI 或无图形环境自动降级为纯文本直通，严禁顶层硬 require("electron")；
 * 3. 向渲染进程下发模型列表时统一脱敏为不可逆掩码，同时保留 has_api_key / api_key_masked 标记。
 */

const ENC_PREFIX = "enc:v1:";
const MASK_MARKER = "••••";

function getDefaultSafeStorage() {
  try {
    const electron = require("electron");
    if (electron && typeof electron === "object" && electron.safeStorage) {
      return electron.safeStorage;
    }
  } catch {}
  return null;
}

function createSecretStorage(customSafeStorage) {
  const resolveSafeStorage = () => {
    const s = customSafeStorage !== undefined ? customSafeStorage : getDefaultSafeStorage();
    if (!s || typeof s.isEncryptionAvailable !== "function") return null;
    try {
      return s.isEncryptionAvailable() ? s : null;
    } catch {
      return null;
    }
  };

  function isEncrypted(value) {
    return typeof value === "string" && value.startsWith(ENC_PREFIX);
  }

  function encryptSecret(plain) {
    if (typeof plain !== "string") return "";
    const trimmed = plain.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith(ENC_PREFIX)) return trimmed;

    const safeStorage = resolveSafeStorage();
    if (!safeStorage || typeof safeStorage.encryptString !== "function") {
      return trimmed;
    }
    try {
      const buf = safeStorage.encryptString(trimmed);
      return `${ENC_PREFIX}${Buffer.from(buf).toString("base64")}`;
    } catch {
      return trimmed;
    }
  }

  function decryptSecret(stored) {
    if (typeof stored !== "string" || !stored) return "";
    if (!stored.startsWith(ENC_PREFIX)) {
      return stored;
    }
    const safeStorage = resolveSafeStorage();
    if (!safeStorage || typeof safeStorage.decryptString !== "function") {
      return "";
    }
    try {
      const rawBuf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      return safeStorage.decryptString(rawBuf);
    } catch {
      return "";
    }
  }

  function isMaskedSecret(value) {
    return typeof value === "string" && value.includes(MASK_MARKER);
  }

  function maskSecret(value) {
    const plain = decryptSecret(String(value || "")).trim();
    if (!plain) return "";
    if (plain.length <= 8) return `${MASK_MARKER}${MASK_MARKER}`;
    return `${plain.slice(0, 3)}${MASK_MARKER}${plain.slice(-4)}`;
  }

  function redactModelForRenderer(model) {
    if (!model || typeof model !== "object") return model;
    const plain = decryptSecret(String(model.api_key ?? model.apiKey ?? "")).trim();
    const masked = plain ? maskSecret(plain) : "";
    const copy = { ...model };
    delete copy.apiKey;
    copy.api_key = masked;
    copy.has_api_key = Boolean(plain);
    copy.api_key_masked = Boolean(plain);
    return copy;
  }

  function redactModelsForRenderer(models) {
    if (!Array.isArray(models)) return [];
    return models.map(redactModelForRenderer);
  }

  return {
    ENC_PREFIX,
    MASK_MARKER,
    isEncrypted,
    encryptSecret,
    decryptSecret,
    isMaskedSecret,
    maskSecret,
    redactModelForRenderer,
    redactModelsForRenderer,
    isEncryptionAvailable: () => Boolean(resolveSafeStorage()),
  };
}

const defaultSecretStorage = createSecretStorage();

module.exports = {
  createSecretStorage,
  ...defaultSecretStorage,
};
