"""Harbor 自定义 Agent 适配器：用于评测 OMCX Headless CLI。"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = Path("/tmp/omcx-harbor-cache")
BUNDLE_PATH = CACHE_DIR / "omcx-headless-bundle.tar.gz"
NODE_VERSION = "v20.18.1"

FORWARDED_ENV_KEYS = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "OMCX_MODEL",
    "OMCX_PROVIDER",
    "OMCX_BASE_URL",
    "OMCX_API_KEY",
    "OMCX_MAX_ROUNDS",
    "OMCX_REASONING_EFFORT",
)


def _ensure_headless_bundle() -> Path:
    """在宿主机生成或刷新自包含无头运行包。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["node", str(PROJECT_ROOT / "scripts" / "build-headless-bundle.js")],
        env={**os.environ, "OMCX_BUNDLE_PATH": str(BUNDLE_PATH)},
        check=True,
    )
    return BUNDLE_PATH


def _ensure_cached_node_tarball(arch: str) -> Path:
    """在宿主机缓存对应 Linux 架构的 Node.js 静态二进制包。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"node-{NODE_VERSION}-linux-{arch}.tar.gz"
    target = CACHE_DIR / filename
    if target.exists() and target.stat().st_size > 1_000_000:
        return target

    urls = [
        f"https://nodejs.org/dist/{NODE_VERSION}/{filename}",
        f"https://npmmirror.com/mirrors/node/{NODE_VERSION}/{filename}",
    ]
    last_err: Exception | None = None
    tmp_path = CACHE_DIR / f".{filename}.tmp"
    for url in urls:
        try:
            urllib.request.urlretrieve(url, tmp_path)
            tmp_path.replace(target)
            return target
        except Exception as err:
            last_err = err
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

    raise RuntimeError(f"下载 Node.js ({arch}) 失败: {last_err}")


class OmcxAgent(BaseAgent):
    """接入 Harbor 评测框架的 OMCX Agent 适配器。"""

    @staticmethod
    def name() -> str:
        return "omcx"

    def version(self) -> str | None:
        return "2.1.11"

    async def setup(self, environment: BaseEnvironment) -> None:
        bundle_path = _ensure_headless_bundle()
        await environment.upload_file(
            source_path=str(bundle_path),
            target_path="/tmp/omcx-headless-bundle.tar.gz",
        )
        await environment.exec(
            command=(
                "mkdir -p /opt/omcx && "
                "tar -xzf /tmp/omcx-headless-bundle.tar.gz -C /opt/omcx && "
                "chmod +x /opt/omcx/bin/omcx-cli.js && "
                "ln -sf /opt/omcx/bin/omcx-cli.js /usr/local/bin/omcx-cli && "
                "rm -f /tmp/omcx-headless-bundle.tar.gz"
            )
        )

        # 检查容器内 Node.js 是否满足 >= 18，缺失则从宿主机缓存上传静态包
        check_res = await environment.exec(
            command=(
                'command -v node >/dev/null 2>&1 && '
                'node -e "process.exit(Number(process.versions.node.split(\'.\')[0]) >= 18 ? 0 : 1)"'
            )
        )
        if getattr(check_res, "return_code", 1) != 0:
            uname_res = await environment.exec(command="uname -m")
            raw_arch = (getattr(uname_res, "stdout", "") or "").strip().lower()
            node_arch = "arm64" if raw_arch in ("aarch64", "arm64") else "x64"
            node_tar = _ensure_cached_node_tarball(node_arch)
            await environment.upload_file(
                source_path=str(node_tar),
                target_path="/tmp/node-linux.tar.gz",
            )
            await environment.exec(
                command=(
                    "tar -xzf /tmp/node-linux.tar.gz -C /usr/local --strip-components=1 && "
                    "rm -f /tmp/node-linux.tar.gz"
                )
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as tf:
            tf.write(instruction or "")
            local_instruction = Path(tf.name)

        try:
            await environment.upload_file(
                source_path=str(local_instruction),
                target_path="/tmp/omcx-instruction.txt",
            )
        finally:
            local_instruction.unlink(missing_ok=True)

        env_vars = {
            k: os.environ[k]
            for k in FORWARDED_ENV_KEYS
            if k in os.environ and os.environ[k]
        }
        env_vars.setdefault("OMCX_STORAGE_MEMORY_ONLY", "1")

        model_arg = (
            getattr(self, "model_name", None)
            or os.environ.get("OMCX_MODEL")
            or "gpt-4o"
        )

        cmd = (
            'node /opt/omcx/bin/omcx-cli.js '
            '--prompt-file /tmp/omcx-instruction.txt '
            '--workspace "$(pwd)" '
            f'--model {shlex.quote(model_arg)} '
            '--json-output /tmp/omcx-result.json'
        )
        exec_res = await environment.exec(command=cmd, env=env_vars)

        logs_dir = getattr(self, "logs_dir", None)
        if logs_dir:
            log_path = Path(logs_dir) / "omcx-cli.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            stdout_text = getattr(exec_res, "stdout", "") or ""
            stderr_text = getattr(exec_res, "stderr", "") or ""
            rc = getattr(exec_res, "return_code", "")
            log_path.write_text(
                f"[return_code] {rc}\n\n[stdout]\n{stdout_text}\n\n[stderr]\n{stderr_text}\n",
                encoding="utf-8",
            )

        cat_res = await environment.exec(command="cat /tmp/omcx-result.json 2>/dev/null || true")
        raw_json = (getattr(cat_res, "stdout", "") or "").strip()
        if raw_json:
            try:
                data = json.loads(raw_json)
                usage = data.get("usage") or {}
                context.n_input_tokens = int(usage.get("prompt_tokens") or 0)
                context.n_cache_tokens = int(usage.get("cached_tokens") or 0)
                context.n_output_tokens = int(usage.get("completion_tokens") or 0)
                context.cost_usd = float(data.get("costUsd") or 0.0)
                if logs_dir:
                    (Path(logs_dir) / "omcx-result.json").write_text(
                        json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
            except Exception:
                pass
        await environment.exec(command="rm -f /tmp/omcx-instruction.txt /tmp/omcx-result.json")
