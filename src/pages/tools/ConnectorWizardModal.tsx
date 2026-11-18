import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  PlugZap,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  KeyRound,
} from "lucide-react";
import {
  CONNECTOR_CATEGORIES,
  CONNECTOR_PRESETS,
  type ConnectorCategory,
  type ConnectorPreset,
} from "./connectorPresets";

interface ConnectorWizardModalProps {
  isOpen: boolean;
  editingServer?: any | null;
  onClose: () => void;
  onSaved: (serverId: string) => Promise<void> | void;
}

export const ConnectorWizardModal: React.FC<ConnectorWizardModalProps> = ({
  isOpen,
  editingServer,
  onClose,
  onSaved,
}) => {
  const [category, setCategory] = useState<"all" | ConnectorCategory>("all");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("feishu");
  const [serverId, setServerId] = useState("feishu");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [extraDescription, setExtraDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = Boolean(editingServer?.id);

  const selectedPreset = useMemo<ConnectorPreset>(() => {
    return (
      CONNECTOR_PRESETS.find((p) => p.id === selectedPresetId) || CONNECTOR_PRESETS[0]
    );
  }, [selectedPresetId]);

  const applyPreset = (preset: ConnectorPreset) => {
    setSelectedPresetId(preset.id);
    setServerId(preset.defaultServerId);
    const defaults: Record<string, string> = {};
    for (const f of preset.fields) {
      if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
    }
    setFieldValues(defaults);
    setExtraDescription(preset.subtitle);
    setError(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (editingServer?.id) {
      setSelectedPresetId("custom");
      setServerId(editingServer.id);
      setFieldValues({
        transport: editingServer.url
          ? editingServer.transport === "sse"
            ? "sse"
            : "http"
          : "stdio",
        url: editingServer.url || "",
        authToken: editingServer.authToken || "",
        command: editingServer.command || "",
        argsText: Array.isArray(editingServer.args) ? editingServer.args.join(" ") : "",
      });
      setExtraDescription(editingServer.description || "");
      setError(null);
      return;
    }
    applyPreset(CONNECTOR_PRESETS[0]);
  }, [isOpen, editingServer]);

  if (!isOpen) return null;

  const filteredPresets =
    category === "all"
      ? CONNECTOR_PRESETS
      : CONNECTOR_PRESETS.filter((p) => p.category === category);

  const previewConfig = selectedPreset.buildConfig({
    ...fieldValues,
    description: extraDescription,
  });

  const handleSelectDirectory = async (fieldKey: string) => {
    if (!window.electronAPI?.selectWorkDirectory) return;
    const picked = await window.electronAPI.selectWorkDirectory();
    if (picked) {
      setFieldValues((prev) => ({ ...prev, [fieldKey]: picked }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanId = serverId.trim();
    if (!cleanId) {
      setError("请填写连接器标识（英文/数字/连字符）");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(cleanId)) {
      setError("连接器标识仅支持英文字母、数字、点(.)、下划线(_)与连字符(-)");
      return;
    }

    const built = selectedPreset.buildConfig({
      ...fieldValues,
      description: extraDescription,
    });

    if (built.url !== undefined && !String(built.url || "").trim() && fieldValues.mode !== "stdio" && fieldValues.transport !== "stdio") {
      setError("请填写有效的远程 MCP 服务 URL");
      return;
    }
    if (built.command !== undefined && !String(built.command || "").trim()) {
      setError("请填写启动命令（如 npx / uvx / node）");
      return;
    }

    if (!window.electronAPI?.upsertMcpServer) {
      setError("当前环境不支持连接器写入接口");
      return;
    }

    setSaving(true);
    try {
      const res = await window.electronAPI.upsertMcpServer(cleanId, built);
      if (!res?.success) {
        setError(res?.error || "保存连接器配置失败");
        return;
      }
      await onSaved(cleanId);
      onClose();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[99999] bg-[var(--ui-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[86vh] rounded-2xl bg-[var(--ui-panel-bg)] border border-[color:var(--ui-border-subtle)] shadow-2xl flex flex-col overflow-hidden text-[var(--ui-text-primary)]"
      >
        {/* 头部 */}
        <div className="px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] flex items-center justify-center text-[var(--ui-accent-emerald)]">
              <PlugZap size={16} />
            </div>
            <div>
              <h2 className="text-sm font-semibold">
                {isEditing ? `编辑连接器：${editingServer.id}` : "添加连接器 (Work Connectors)"}
              </h2>
              <p className="text-[11px] text-[var(--ui-text-muted)]">
                一键接入飞书、钉钉、企业微信、Jira、Notion 等主流办公与研发系统（保存至 ~/.omcx/mcp.json）
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体左右双栏 */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          {!isEditing && (
            <div className="w-full md:w-[300px] border-b md:border-b-0 md:border-r border-[color:var(--ui-divider-hairline)] flex flex-col bg-[var(--ui-card-inner-bg)] flex-shrink-0">
              {/* 分类过滤 */}
              <div className="px-3 py-2.5 border-b border-[color:var(--ui-divider-hairline)] flex flex-wrap gap-1">
                {CONNECTOR_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setCategory(cat.id)}
                    className={`px-2 py-1 rounded-md text-[11px] transition-colors cursor-pointer ${
                      category === cat.id
                        ? "bg-[var(--ui-accent-blue)] text-white font-medium"
                        : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]"
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {/* 预置连接器列表 */}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-2.5 flex flex-col gap-1.5">
                {filteredPresets.map((preset) => {
                  const active = preset.id === selectedPreset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all cursor-pointer ${
                        active
                          ? "bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)]"
                          : "bg-[var(--ui-card-bg)] border-[color:var(--ui-border-hairline)] hover:bg-[var(--ui-block-hover-bg)]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[var(--ui-text-primary)] truncate">
                          {preset.name}
                        </span>
                        {preset.badge && (
                          <span className="px-1.5 py-0.2 rounded text-[9.5px] bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] flex-shrink-0">
                            {preset.badge}
                          </span>
                        )}
                      </div>
                      <div className="text-[10.5px] text-[var(--ui-text-muted)] truncate mt-0.5">
                        {preset.subtitle}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 右侧配置表单 */}
          <form
            onSubmit={handleSubmit}
            className="flex-1 min-w-0 overflow-y-auto custom-scrollbar p-5 flex flex-col gap-4 select-text"
          >
            <div className="rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] p-3 flex items-start gap-2.5">
              <Sparkles size={14} className="text-[var(--ui-accent-amber)] mt-0.5 flex-shrink-0" />
              <div className="text-[11.5px] text-[var(--ui-text-secondary)] leading-relaxed">
                {isEditing
                  ? "更新当前连接器的端点 URL、启动命令或鉴权配置。留空的既有密码型环境变量会自动保留。"
                  : selectedPreset.description}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1">
                  连接器 ID（配置键名）
                </label>
                <input
                  type="text"
                  value={serverId}
                  disabled={isEditing}
                  onChange={(e) => setServerId(e.target.value)}
                  placeholder="例如 feishu / jira"
                  className="w-full px-3 py-1.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-subtle)] text-xs font-mono text-[var(--ui-text-primary)] focus:outline-none focus:border-[color:var(--ui-accent-blue)] disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1">
                  备注说明（可选）
                </label>
                <input
                  type="text"
                  value={extraDescription}
                  onChange={(e) => setExtraDescription(e.target.value)}
                  placeholder="简短描述该连接器用途"
                  className="w-full px-3 py-1.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-primary)] focus:outline-none focus:border-[color:var(--ui-accent-blue)]"
                />
              </div>
            </div>

            {selectedPreset.fields.length > 0 && (
              <div className="flex flex-col gap-3">
                {selectedPreset.fields.map((field) => {
                  const val = fieldValues[field.key] ?? field.defaultValue ?? "";
                  return (
                    <div key={field.key}>
                      <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1">
                        {field.label}
                        {field.required && <span className="text-[var(--ui-accent-rose)] ml-0.5">*</span>}
                      </label>
                      {field.type === "select" ? (
                        <select
                          value={val}
                          onChange={(e) =>
                            setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                          }
                          className="w-full px-3 py-1.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-primary)] focus:outline-none focus:border-[color:var(--ui-accent-blue)]"
                        >
                          {(field.options || []).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "directory" ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={val}
                            onChange={(e) =>
                              setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                            }
                            placeholder={field.placeholder}
                            className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-subtle)] text-xs font-mono text-[var(--ui-text-primary)] focus:outline-none focus:border-[color:var(--ui-accent-blue)]"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSelectDirectory(field.key)}
                            className="px-2.5 py-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] flex items-center gap-1 cursor-pointer"
                          >
                            <FolderOpen size={13} />
                            <span>浏览</span>
                          </button>
                        </div>
                      ) : (
                        <input
                          type={field.type === "password" ? "password" : "text"}
                          value={val}
                          onChange={(e) =>
                            setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                          }
                          placeholder={field.placeholder}
                          className="w-full px-3 py-1.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-subtle)] text-xs font-mono text-[var(--ui-text-primary)] focus:outline-none focus:border-[color:var(--ui-accent-blue)]"
                        />
                      )}
                      {field.helper && (
                        <div className="text-[10.5px] text-[var(--ui-text-faint)] mt-1">
                          {field.helper}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {previewConfig.oauth && (
              <div className="rounded-xl bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] px-3 py-2 flex items-center gap-2 text-[11px] text-[var(--ui-accent-blue)]">
                <KeyRound size={13} className="flex-shrink-0" />
                <span>保存后可在连接器卡片中点击「OAuth 授权」，直接通过浏览器登录授权。</span>
              </div>
            )}

            {/* 配置实时预览 */}
            <div>
              <div className="text-[10.5px] text-[var(--ui-text-faint)] mb-1">
                将写入 ~/.omcx/mcp.json 的配置预览：
              </div>
              <pre className="rounded-xl bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] p-3 text-[11px] font-mono text-[var(--ui-text-secondary)] overflow-x-auto custom-scrollbar">
                {JSON.stringify({ [serverId.trim() || "connector"]: previewConfig }, null, 2)}
              </pre>
            </div>

            {error && (
              <div className="rounded-xl bg-[var(--ui-accent-rose-soft)] border border-[color:var(--ui-accent-rose-border)] px-3 py-2 flex items-center gap-2 text-xs text-[var(--ui-accent-rose)]">
                <AlertCircle size={14} className="flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="pt-2 border-t border-[color:var(--ui-divider-hairline)] flex items-center justify-end gap-2 mt-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-lg border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)] cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-[var(--ui-accent-blue)] hover:opacity-90 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                <span>{isEditing ? "保存修改" : "保存并连接"}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined") {
    return createPortal(modalContent, document.body);
  }
  return modalContent;
};
