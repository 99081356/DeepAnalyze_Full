#!/usr/bin/env python3
"""DeepAnalyze 一键启动脚本 — 检查环境、启动容器、构建前端、启动后端

用法:
    python start.py                    # 一键启动（自动启动 PostgreSQL + Ollama + 后端）
    python start.py --port 8080        # 自定义端口
    python start.py --dev              # 开发模式（前端热重载 + 后端热重载）
    python start.py --skip-frontend    # 跳过前端构建
    python start.py --no-docker        # 不启动 Docker 容器（需自行提供 PostgreSQL）
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import socket
import shutil
import subprocess
import sys
import time
from pathlib import Path


# 项目根目录
PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data"
PID_FILE = DATA_DIR / ".deepanalyze.pid"

# 默认配置
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 21000
TOTAL_STEPS = 9

# 需要创建的目录
REQUIRED_DIRS = [
    DATA_DIR,
    DATA_DIR / "logs",
    DATA_DIR / "models",
    PROJECT_ROOT / "config",
    PROJECT_ROOT / "uploads",
]


# ============================================================================
# .env 文件加载
# ============================================================================


def load_dotenv(env_path: Path | None = None) -> dict[str, str]:
    """Load a .env file and return key-value pairs.
    Does NOT override existing environment variables (like python-dotenv)."""
    if env_path is None:
        env_path = PROJECT_ROOT / ".env"
    result: dict[str, str] = {}
    if not env_path.exists():
        return result
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        result[key] = value
    return result


def query_module_states() -> dict[str, dict]:
    """Read module_states table to decide which local services to launch.

    Returns dict keyed by module_id with status/mode/weights_path/gpu_required.
    Single source of truth — replaces directory-scanning heuristics.
    Returns an empty dict when psycopg2 is unavailable or the table cannot be
    queried (e.g., in CI without python deps, or before the migration is applied),
    which causes all local services to be skipped.
    """
    try:
        import psycopg2  # type: ignore
    except ImportError:
        # psycopg2 not available (e.g., in CI without python deps) — fall back to no services
        return {}

    # Load .env here (dotenv_vars is otherwise local to start_containers/start_server)
    env_vars = load_dotenv()
    pg_host = env_vars.get("PG_HOST", "localhost")
    pg_port = env_vars.get("PG_PORT", "5433")
    pg_db = env_vars.get("PG_DATABASE", "deepanalyze_hub")
    pg_user = env_vars.get("PG_USER", "deepanalyze_hub")
    pg_password = env_vars.get("PG_PASSWORD", "")

    try:
        conn = psycopg2.connect(
            host=pg_host, port=pg_port, dbname=pg_db,
            user=pg_user, password=pg_password,
            connect_timeout=5,
        )
        cur = conn.cursor()
        cur.execute("""
            SELECT module_id, status, mode, weights_path, gpu_required, process_type
            FROM module_states
            WHERE status = 'running' AND mode = 'local'
        """)
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return {
            r[0]: {
                "status": r[1], "mode": r[2], "weights_path": r[3],
                "gpu_required": r[4], "process_type": r[5],
            }
            for r in rows
        }
    except Exception as exc:
        print(f"[start] warning: cannot query module_states: {exc}", flush=True)
        return {}


# ============================================================================
# 工具函数
# ============================================================================


def _step(step: int, msg: str) -> None:
    print(f"  [{step}/{TOTAL_STEPS}] {msg}...", flush=True)


def _ok(msg: str = "OK") -> None:
    print(f"       [{msg}]", flush=True)


def _warn(msg: str) -> None:
    print(f"       [WARN] {msg}", flush=True)


def _fail(msg: str) -> None:
    print(f"       [FAIL] {msg}", flush=True)


def _info(msg: str) -> None:
    print(f"       {msg}", flush=True)


# ============================================================================
# Phase 1: 检查 Node.js 环境
# ============================================================================


def check_environment() -> None:
    _step(1, "检查运行环境")

    node_path = shutil.which("node")
    if not node_path:
        _fail("未安装 Node.js，请安装 Node.js >= 18")
        _info("  下载地址: https://nodejs.org/")
        sys.exit(1)

    result = subprocess.run(
        ["node", "-v"], capture_output=True, text=True
    )
    version = result.stdout.strip()
    major = int(version.lstrip("v").split(".")[0])

    if major < 18:
        _fail(f"Node.js 版本过低: {version}，需要 >= 18")
        sys.exit(1)

    _ok(f"Node.js {version}")


# ============================================================================
# Phase 2: 检查 Docker 环境
# ============================================================================


def check_docker() -> bool:
    """Check if Docker is available and running. Returns True if usable."""
    _step(2, "检查 Docker 环境")

    if sys.platform == "win32":
        docker_cmd = "docker.exe"
    else:
        docker_cmd = "docker"

    docker_path = shutil.which(docker_cmd)
    if not docker_path:
        _warn("Docker 未安装，需自行提供 PostgreSQL 数据库")
        _info("  安装 Docker 可启用向量检索和全文搜索")
        return False

    result = subprocess.run(
        [docker_cmd, "info"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        _warn("Docker 未运行，需自行提供 PostgreSQL 数据库")
        _info("  启动 Docker Desktop 可启用向量检索和全文搜索")
        return False

    _ok("Docker 就绪")
    return True


# ============================================================================
# Phase 3: 启动 Docker 容器（PostgreSQL + Ollama）
# ============================================================================


def start_containers() -> bool:
    """Start PostgreSQL + Ollama containers. Returns True if PG is available."""
    _step(3, "启动数据库和模型服务")

    compose_file = PROJECT_ROOT / "docker-compose.dev.yml"
    if not compose_file.exists():
        _warn("docker-compose.dev.yml 不存在，跳过")
        return False

    docker_cmd = "docker.exe" if sys.platform == "win32" else "docker"
    compose_cmd = [docker_cmd, "compose", "-f", str(compose_file)]

    # Build compose environment from .env file (docker compose reads .env natively,
    # but we also need the values in Python, so load them explicitly)
    dotenv_vars = load_dotenv()
    pg_port = dotenv_vars.get("PG_PORT", "5432")

    # Set PG_PORT in the environment so docker-compose uses it
    compose_env = {**os.environ}
    compose_env["PG_PORT"] = pg_port
    if "PG_DATABASE" in dotenv_vars:
        compose_env["PG_DATABASE"] = dotenv_vars["PG_DATABASE"]
    if "PG_USER" in dotenv_vars:
        compose_env["PG_USER"] = dotenv_vars["PG_USER"]
    if "PG_PASSWORD" in dotenv_vars:
        compose_env["PG_PASSWORD"] = dotenv_vars["PG_PASSWORD"]

    _info(f"  PostgreSQL 端口: {pg_port}")
    _info("  启动 PostgreSQL + Ollama 容器（首次需下载约 500MB，请耐心等待）...")
    _info("  ------ Docker 输出 ------")
    proc = subprocess.Popen(
        compose_cmd + ["up", "-d", "--build"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=compose_env,
    )
    # Stream output line-by-line
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(f"    {line}", flush=True)
    proc.wait()
    _info("  ------ Docker 输出结束 ------")

    if proc.returncode != 0:
        _warn(f"容器启动失败 (exit code {proc.returncode})，需自行提供 PostgreSQL")
        _info("  可手动排查: docker compose -f docker-compose.dev.yml up --build")
        return False

    # Wait for PostgreSQL to be healthy (check inside container first)
    _info("  等待 PostgreSQL 就绪...")
    retries = 0
    max_retries = 60
    while retries < max_retries:
        result = subprocess.run(
            compose_cmd + ["exec", "-T", "postgres",
                           "pg_isready", "-U", "deepanalyze", "-d", "deepanalyze"],
            capture_output=True, text=True, check=False,
            env=compose_env,
        )
        if result.returncode == 0:
            break
        if retries % 5 == 0:
            _info(f"  等待中... ({retries}/{max_retries}s)")
        time.sleep(1)
        retries += 1

    if retries >= max_retries:
        _warn("PostgreSQL 启动超时")
        return False

    _info(f"  PostgreSQL 容器就绪 (等待了 {retries}s)")

    # Verify PG is accessible from the host on the expected port
    _info(f"  验证主机端口 {pg_port} 可达...")
    host_retries = 0
    max_host_retries = 15
    pg_ok = False
    while host_retries < max_host_retries:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(2)
                s.connect(("127.0.0.1", int(pg_port)))
            pg_ok = True
            break
        except (OSError, ConnectionRefusedError, socket.timeout):
            time.sleep(1)
            host_retries += 1

    if not pg_ok:
        _warn(f"PostgreSQL 容器已启动但主机无法连接 127.0.0.1:{pg_port}")
        _info("  提示: 检查端口是否被占用或 Docker 端口映射是否正确")
        return False

    _info(f"  主机端口 {pg_port} 连接成功")

    # Check Ollama
    try:
        import urllib.request
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=3)
        _ok("PostgreSQL + Ollama 就绪")
    except Exception:
        _ok("PostgreSQL 就绪 (Ollama 首次启动需下载模型，请稍候)")

    return True


# ============================================================================
# Phase 2: 检查前端构建
# ============================================================================


def check_frontend(skip: bool = False, dev: bool = False) -> None:
    _step(4, "检查前端构建")

    if skip:
        _ok("SKIP")
        return

    frontend_dir = PROJECT_ROOT / "frontend"
    dist_dir = frontend_dir / "dist"
    src_dir = frontend_dir / "src"

    if not (frontend_dir / "package.json").exists():
        _warn("前端目录不完整，跳过")
        return

    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    npm_path = shutil.which(npm_cmd)
    if not npm_path:
        if not (dist_dir / "index.html").exists():
            _fail("未安装 npm，无法构建前端")
            sys.exit(1)
        _warn("未安装 npm，使用已有前端构建（可能过时）")
        return

    if dev:
        if not (frontend_dir / "node_modules").exists():
            _info("  安装前端依赖...")
            subprocess.run(
                [npm_cmd, "install"],
                cwd=str(frontend_dir),
                check=True,
            )
        _ok("开发模式，跳过构建")
        return

    needs_build = False
    dist_index = dist_dir / "index.html"

    if not dist_index.exists():
        needs_build = True
        _info("  前端未构建")
    else:
        dist_mtime = dist_index.stat().st_mtime
        src_mtime = _get_newest_mtime(src_dir)
        if src_mtime > dist_mtime:
            needs_build = True
            _info("  源文件已变更，需要重建")

    if not needs_build:
        _ok("前端已是最新")
        return

    if not (frontend_dir / "node_modules").exists():
        _info("  安装前端依赖...")
        result = subprocess.run(
            [npm_cmd, "install"],
            cwd=str(frontend_dir),
        )
        if result.returncode != 0:
            _fail("npm install 失败")
            sys.exit(1)

    _info("  构建前端...")
    result = subprocess.run(
        [npm_cmd, "run", "build"],
        cwd=str(frontend_dir),
    )
    if result.returncode != 0:
        _fail("前端构建失败")
        sys.exit(1)

    _ok("前端构建完成")


def _get_newest_mtime(directory: Path) -> float:
    newest = 0.0
    try:
        for entry in directory.rglob("*"):
            if entry.is_file():
                mtime = entry.stat().st_mtime
                if mtime > newest:
                    newest = mtime
    except OSError:
        pass
    return newest


# ============================================================================
# Phase 3: 创建目录
# ============================================================================


def setup_directories() -> None:
    _step(5, "创建目录结构")

    created = 0
    for d in REQUIRED_DIRS:
        if not d.exists():
            d.mkdir(parents=True, exist_ok=True)
            created += 1

    # 确保默认配置文件存在
    config_file = PROJECT_ROOT / "config" / "default.yaml"
    if not config_file.exists():
        config_file.write_text("""# DeepAnalyze fallback config
# Provider settings are managed via the web UI (Settings tab).
# This file is only used if no database settings exist.
models:
  main:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: qwen2.5-14b
    maxTokens: 32768
    supportsToolUse: true
defaults:
  main: main
""")
        created += 1

    if created > 0:
        _ok(f"创建了 {created} 个项目")
    else:
        _ok("所有目录就绪")


# ============================================================================
# Phase 4: 清理残留进程
# ============================================================================


def cleanup_orphan() -> None:
    _step(6, "清理残留进程")

    # Clean up orphan Docker containers from production compose
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=deepanalyze-socat-embedding",
             "--filter", "status=exited", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=5,
        )
        orphan_containers = result.stdout.strip().split("\n") if result.stdout.strip() else []
        for name in orphan_containers:
            if name:
                subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=5)
                _info(f"  已清理孤儿容器: {name}")
    except Exception:
        pass

    if not PID_FILE.exists():
        _ok("无残留进程")
        return

    try:
        pid = int(PID_FILE.read_text().strip())
    except (ValueError, OSError):
        PID_FILE.unlink(missing_ok=True)
        _ok("PID 文件无效，已清理")
        return

    if not _is_process_alive(pid):
        PID_FILE.unlink(missing_ok=True)
        _ok("无残留进程")
        return

    _info(f"  发现残留进程 (PID: {pid})，正在终止...")
    _kill_process(pid)
    time.sleep(1)

    if _is_process_alive(pid):
        _warn(f"进程 {pid} 未能终止")
    else:
        _ok(f"已终止进程 {pid}")

    PID_FILE.unlink(missing_ok=True)


def _is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _kill_process(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True, check=False
        )
    else:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.5)
            if _is_process_alive(pid):
                os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _kill_port_user(port: int) -> bool:
    """Find and kill processes occupying the given port. Returns True if any were killed."""
    pids = _get_port_pids(port)
    if not pids:
        return False

    for pid in pids:
        _info(f"  终止占用端口的进程 (PID: {pid})")
        _kill_process(pid)

    # Also kill any child processes
    time.sleep(0.5)
    for pid in pids:
        _kill_child_processes(pid)

    return True


def _get_port_pids(port: int) -> list[int]:
    """Get list of PIDs that are listening on the given port."""
    pids: list[int] = []
    if sys.platform == "win32":
        result = subprocess.run(
            ["netstat", "-aon"],
            capture_output=True, text=True, check=False,
        )
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                if parts:
                    try:
                        pids.append(int(parts[-1]))
                    except ValueError:
                        pass
    else:
        # Try lsof first (works on macOS and some Linux)
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().splitlines():
                try:
                    pids.append(int(line.strip()))
                except ValueError:
                    pass

        # Try fuser if lsof didn't find anything
        if not pids:
            result = subprocess.run(
                ["fuser", f"{port}/tcp"],
                capture_output=True, text=True, check=False,
            )
            if result.stdout.strip():
                for token in result.stdout.strip().split():
                    try:
                        pids.append(int(token.strip()))
                    except ValueError:
                        pass

        # Try ss as last resort (common on Linux)
        if not pids:
            result = subprocess.run(
                ["ss", "-tlnp", f"sport = :{port}"],
                capture_output=True, text=True, check=False,
            )
            for line in result.stdout.splitlines():
                # Extract pid from output like: users:(("node",pid=12345,fd=18))
                import re as _re
                match = _re.search(r'pid=(\d+)', line)
                if match:
                    try:
                        pids.append(int(match.group(1)))
                    except ValueError:
                        pass

    return list(dict.fromkeys(pids))  # deduplicate while preserving order


def _kill_child_processes(parent_pid: int) -> None:
    """Kill child processes of a given parent PID (Linux/macOS only)."""
    if sys.platform == "win32":
        return
    try:
        result = subprocess.run(
            ["pgrep", "-P", str(parent_pid)],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().splitlines():
                try:
                    child_pid = int(line.strip())
                    _kill_process(child_pid)
                except ValueError:
                    pass
    except Exception:
        pass


# ============================================================================
# Phase 5: 检查端口
# ============================================================================


def check_port(host: str, port: int) -> None:
    _step(7, f"检查端口 {port}")

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
        _ok("端口空闲")
    except OSError:
        # Port is occupied — try to find and kill the process using it
        _info(f"  端口 {port} 已被占用，尝试释放...")
        killed = _kill_port_user(port)
        if killed:
            # Wait a moment for the port to be released
            time.sleep(1.5)
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    s.bind((host, port))
                _ok(f"已释放端口 {port}")
            except OSError:
                _fail(f"端口 {port} 释放后仍被占用")
                _info("  解决方法:")
                _info(f"    使用 --port 指定其他端口")
                _info(f"    或手动执行: fuser -k {port}/tcp")
                sys.exit(1)
        else:
            _fail(f"端口 {port} 已被占用，无法自动释放")
            _info("  解决方法:")
            _info(f"    使用 --port 指定其他端口")
            _info(f"    或手动执行: fuser -k {port}/tcp")
            sys.exit(1)


# ============================================================================
# Phase 6: 验证数据库
# ============================================================================


def validate_database() -> None:
    _step(8, "验证数据库")

    # Check PostgreSQL connectivity (used by the backend)
    dotenv_vars = load_dotenv()
    pg_host = os.environ.get("PG_HOST", dotenv_vars.get("PG_HOST", "localhost"))
    pg_port = int(os.environ.get("PG_PORT", dotenv_vars.get("PG_PORT", "5432")))

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(3)
            s.connect((pg_host, pg_port))
        _ok(f"PostgreSQL 可达 ({pg_host}:{pg_port})")
    except (OSError, ConnectionRefusedError, socket.timeout):
        _warn(f"PostgreSQL {pg_host}:{pg_port} 不可达")
        _info("  后端启动后将自动重试连接并运行迁移")


# ============================================================================
# Phase 7: 启动服务
# ============================================================================


def start_server(host: str, port: int, dev: bool = False, pg_available: bool = False) -> None:
    _step(9, "启动服务")

    vite_proc = None
    embedding_proc = None
    whisper_http_proc = None
    npx_cmd = "npx.cmd" if sys.platform == "win32" else "npx"
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    frontend_dir = PROJECT_ROOT / "frontend"

    # Load .env file values (does not override existing env vars)
    dotenv_vars = load_dotenv()

    # ── Start local BGE-M3 embedding server ──────────────────────────
    # Module launch is governed by the module_states PostgreSQL table
    # (single source of truth — see unified module deployment design).
    # Services launch only when status='running' AND mode='local'.
    embedding_port = int(dotenv_vars.get("EMBEDDING_PORT", "11435"))
    embedding_server_path = PROJECT_ROOT / "embedding_server.py"
    module_states = query_module_states()
    embedding_state = module_states.get("embedding")

    if embedding_state and embedding_server_path.is_file():
        # Resolve model directory from module_states.weights_path if present,
        # falling back to the historical default location.
        if embedding_state.get("weights_path"):
            bge_model_dir = Path(embedding_state["weights_path"])
            if not bge_model_dir.is_absolute():
                bge_model_dir = PROJECT_ROOT / bge_model_dir
        else:
            bge_model_dir = DATA_DIR / "models" / "bge-m3"
        _info("  启动本地 BGE-M3 嵌入服务 (module_states: running/local)...")
        # Clean up stale embedding server process on the port
        _kill_port_user(embedding_port)
        embedding_proc = subprocess.Popen(
            [sys.executable, str(embedding_server_path),
             "--host", "127.0.0.1",
             "--port", str(embedding_port),
             "--model-path", str(bge_model_dir)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        # Wait for embedding server to be ready (up to 120s for model loading)
        emb_ready = False
        for attempt in range(120):
            try:
                import urllib.request
                # Build a proxy-less opener to bypass system http_proxy
                # which can break localhost connections (e.g. VPN/proxy tools on WSL2)
                proxy_handler = urllib.request.ProxyHandler({})
                opener = urllib.request.build_opener(proxy_handler)
                opener.open(f"http://127.0.0.1:{embedding_port}/health", timeout=3)
                emb_ready = True
                break
            except Exception:
                # Check if process died
                if embedding_proc.poll() is not None:
                    stderr_out = embedding_proc.stderr.read().decode("utf-8", errors="replace")
                    _warn(f"嵌入服务启动失败: {stderr_out[:2000]}")
                    embedding_proc = None
                    break
                time.sleep(1)
        if emb_ready:
            _ok(f"BGE-M3 嵌入服务就绪 (port {embedding_port}, dim=1024)")
        elif embedding_proc is not None:
            _warn("BGE-M3 嵌入服务启动超时，将使用哈希后备")
    else:
        _info("  embedding 模块未处于 running/local 状态，跳过本地嵌入服务")

    # ── Start local Whisper HTTP server ──────────────────────────────
    # Also governed by module_states — launches only when asr module is
    # status='running' AND mode='local'.
    whisper_script = PROJECT_ROOT / "whisper-service" / "main.py"
    whisper_port = int(dotenv_vars.get("WHISPER_HTTP_PORT", "9877"))
    asr_state = module_states.get("asr")

    if asr_state and whisper_script.is_file():
        # Check if whisper is installed
        whisper_check = subprocess.run(
            [sys.executable, "-c", "import whisper"],
            capture_output=True, text=True,
        )
        if whisper_check.returncode == 0:
            _info("  启动本地 Whisper 语音转写服务 (module_states: running/local)...")
            _kill_port_user(whisper_port)
            whisper_http_proc = subprocess.Popen(
                [sys.executable, str(whisper_script), "--http", "--host", "127.0.0.1", "--port", str(whisper_port)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            # Wait briefly for whisper HTTP to be ready
            whisper_ready = False
            for attempt in range(15):
                try:
                    import urllib.request
                    proxy_handler = urllib.request.ProxyHandler({})
                    opener = urllib.request.build_opener(proxy_handler)
                    opener.open(f"http://127.0.0.1:{whisper_port}/health", timeout=2)
                    whisper_ready = True
                    break
                except Exception:
                    if whisper_http_proc.poll() is not None:
                        stderr_out = whisper_http_proc.stderr.read().decode("utf-8", errors="replace")
                        _warn(f"Whisper HTTP 启动失败: {stderr_out[:1000]}")
                        whisper_http_proc = None
                        break
                    time.sleep(1)
            if whisper_ready:
                _ok(f"Whisper 语音转写就绪 (port {whisper_port})")
            elif whisper_http_proc is not None:
                _warn("Whisper HTTP 启动超时，将使用子进程后备模式")
        else:
            _info("  openai-whisper 未安装，跳过本地语音转写服务")
    else:
        _info("  asr 模块未处于 running/local 状态，跳过 Whisper 服务")

    # 启动后端
    _info("  启动后端服务...")
    # Merge .env file (low priority) with OS environment (high priority).
    # This propagates ALL .env variables (DA_SERVER_URL, HTTPS_PROXY,
    # SEARCH_BACKEND, etc.) to the backend subprocess, while still allowing
    # OS env to override. Previously only PG_*/EMBEDDING_PORT/WHISPER_HTTP_PORT
    # were explicitly forwarded, silently dropping every other .env entry.
    backend_env = {**dotenv_vars, **os.environ, "PORT": str(port)}
    if pg_available:
        # Apply PG defaults only if neither OS env nor .env provided them
        backend_env.setdefault("PG_HOST", "localhost")
        backend_env.setdefault("PG_PORT", "5432")
        backend_env.setdefault("PG_DATABASE", "deepanalyze")
        backend_env.setdefault("PG_USER", "deepanalyze")
        backend_env.setdefault("PG_PASSWORD", "deepanalyze_dev")
        _info(f"  PG: {backend_env['PG_HOST']}:{backend_env['PG_PORT']}/{backend_env['PG_DATABASE']}")
    if embedding_proc is not None:
        backend_env["EMBEDDING_PORT"] = str(embedding_port)
    if whisper_http_proc is not None:
        backend_env["WHISPER_HTTP_PORT"] = str(whisper_port)

    backend_proc = subprocess.Popen(
        [npx_cmd, "tsx", "--loader", "./bun-loader.mjs", "src/main.ts"],
        cwd=str(PROJECT_ROOT),
        env=backend_env,
    )

    # 写入 PID 文件
    PID_FILE.write_text(str(backend_proc.pid))

    # 开发模式：启动 Vite 开发服务器
    if dev and (frontend_dir / "package.json").exists():
        _info("  启动前端开发服务器...")
        vite_proc = subprocess.Popen(
            [npm_cmd, "run", "dev"],
            cwd=str(frontend_dir),
        )

    # 等待后端就绪
    _info("  等待后端就绪...")
    retries = 0
    while retries < 30:
        try:
            import urllib.request
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2)
            break
        except Exception:
            time.sleep(1)
            retries += 1

    print()
    print("=" * 55)
    print(f"  DeepAnalyze - 深度分析系统{' (开发模式)' if dev else ''}")
    print(f"  后端地址: http://{host}:{port}")
    print(f"  API 文档: http://{host}:{port}/api/health")
    if pg_available:
        print(f"  数据库:   PostgreSQL (向量检索 + 全文搜索)")
    else:
        print(f"  数据库:   PostgreSQL (未连接)")
    if dev:
        print(f"  前端开发: http://127.0.0.1:3000")
    else:
        print(f"  前端页面: http://{host}:{port}")
    print("=" * 55)
    print()
    print("  提示: 按 Ctrl+C 停止所有服务")
    print()

    def _cleanup(signum=None, frame=None):
        print()
        _info("正在停止服务...")
        if vite_proc is not None:
            vite_proc.terminate()
            try:
                vite_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                vite_proc.kill()
        backend_proc.terminate()
        try:
            backend_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            backend_proc.kill()
        if embedding_proc is not None:
            embedding_proc.terminate()
            try:
                embedding_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                embedding_proc.kill()
        if whisper_http_proc is not None:
            whisper_http_proc.terminate()
            try:
                whisper_http_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                whisper_http_proc.kill()
        # Stop Docker containers
        if pg_available:
            _info("停止数据库和模型容器...")
            docker_cmd = "docker.exe" if sys.platform == "win32" else "docker"
            compose_file = PROJECT_ROOT / "docker-compose.dev.yml"
            subprocess.run(
                [docker_cmd, "compose", "-f", str(compose_file), "down"],
                capture_output=True, check=False,
            )
        PID_FILE.unlink(missing_ok=True)
        _ok("所有服务已停止")
        sys.exit(0)

    signal.signal(signal.SIGINT, _cleanup)
    signal.signal(signal.SIGTERM, _cleanup)

    try:
        backend_proc.wait()
    except KeyboardInterrupt:
        _cleanup()


# ============================================================================
# Banner + main
# ============================================================================


def print_banner() -> None:
    print()
    print("  ╔═══════════════════════════════════════╗")
    print("  ║  DeepAnalyze - 深度分析系统 v0.7.7    ║")
    print("  ╚═══════════════════════════════════════╝")
    print()
    print("  正在启动...\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="DeepAnalyze 一键启动脚本",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"监听地址 (默认: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口 (默认: {DEFAULT_PORT})")
    parser.add_argument("--dev", action="store_true", help="开发模式（前端热重载）")
    parser.add_argument("--skip-frontend", action="store_true", help="跳过前端构建")
    parser.add_argument("--no-docker", action="store_true", help="不启动 Docker 容器（需自行提供 PostgreSQL）")
    args = parser.parse_args()

    print_banner()

    check_environment()

    pg_available = False
    if not args.no_docker:
        docker_ok = check_docker()
        if docker_ok:
            pg_available = start_containers()

    check_frontend(skip=args.skip_frontend, dev=args.dev)
    setup_directories()
    cleanup_orphan()
    check_port(args.host, args.port)
    validate_database()
    start_server(args.host, args.port, dev=args.dev, pg_available=pg_available)


if __name__ == "__main__":
    main()
