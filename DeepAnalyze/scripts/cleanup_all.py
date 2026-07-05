#!/usr/bin/env python3
"""
DeepAnalyze — One-shot cleanup script for all knowledge bases, sessions, and auxiliary data.

Uses docker exec + psql to TRUNCATE all data tables directly.
Run this when you need a completely clean slate.

Usage:
    python scripts/cleanup_all.py              # Full cleanup (interactive confirmation)
    python scripts/cleanup_all.py --force      # Skip confirmation
    python scripts/cleanup_all.py --local      # Connect to local PG directly (no Docker)
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"

# Tables to TRUNCATE, in dependency order (CASCADE handles most, but order helps)
# Group 1: Tables with CASCADE on session/KB delete
CASCADE_TABLES = [
    "wiki_links",
    "anchors",
    "wiki_pages",
    "embeddings",
    "documents",
    "session_memory",
    "messages",
    "agent_tasks",
    "knowledge_bases",
    "sessions",
]

# Group 2: Independent tables without CASCADE
INDEPENDENT_TABLES = [
    "reports",
    "report_references",
    "workflow_logs",
    "agent_skills",
    "agent_team_members",
    "agent_teams",
]

ALL_TABLES = CASCADE_TABLES + INDEPENDENT_TABLES


def load_env() -> dict[str, str]:
    """Load .env file values (does not override existing env vars)."""
    env = {}
    if not ENV_FILE.exists():
        return env
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def get_psql_cmd(use_docker: bool) -> list[str]:
    """Build the psql command prefix."""
    env = load_env()
    pg_host = os.environ.get("PG_HOST", env.get("PG_HOST", "localhost"))
    pg_port = os.environ.get("PG_PORT", env.get("PG_PORT", "5432"))
    pg_db = os.environ.get("PG_DATABASE", env.get("PG_DATABASE", "deepanalyze"))
    pg_user = os.environ.get("PG_USER", env.get("PG_USER", "deepanalyze"))
    pg_pass = os.environ.get("PG_PASSWORD", env.get("PG_PASSWORD", "deepanalyze_dev"))

    if use_docker:
        return [
            "docker", "exec", "-i",
            "deepanalyze-postgres-1",
            "psql",
            "-U", pg_user,
            "-d", pg_db,
        ]
    else:
        # Set PGPASSWORD for local psql
        os.environ["PGPASSWORD"] = pg_pass
        return [
            "psql",
            "-h", pg_host,
            "-p", pg_port,
            "-U", pg_user,
            "-d", pg_db,
        ]


def run_sql(psql_cmd: list[str], sql: str) -> subprocess.CompletedProcess:
    """Execute a SQL statement via psql."""
    return subprocess.run(
        psql_cmd,
        input=sql,
        capture_output=True,
        text=True,
        timeout=30,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean all DeepAnalyze data")
    parser.add_argument("--force", action="store_true", help="Skip confirmation prompt")
    parser.add_argument("--local", action="store_true", help="Use local psql instead of docker exec")
    args = parser.parse_args()

    if not args.force:
        print("⚠  This will DELETE ALL data from the following tables:")
        for t in ALL_TABLES:
            print(f"   - {t}")
        print()
        answer = input("Are you sure? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Cancelled.")
            return

    use_docker = not args.local
    psql_cmd = get_psql_cmd(use_docker)

    # Check connectivity
    print("Testing database connection...")
    result = run_sql(psql_cmd, "SELECT 1;")
    if result.returncode != 0:
        print(f"Database connection failed:\n{result.stderr}")
        if use_docker:
            print("Hint: try --local flag if running psql directly, or check if the postgres container is running")
        sys.exit(1)
    print("Database connection OK.")

    # Build TRUNCATE statement
    table_list = ", ".join(ALL_TABLES)
    sql = f"TRUNCATE TABLE {table_list} CASCADE;"

    print(f"\nTruncating {len(ALL_TABLES)} tables...")
    result = run_sql(psql_cmd, sql)
    if result.returncode != 0:
        print(f"TRUNCATE failed:\n{result.stderr}")
        sys.exit(1)

    print(result.stdout.strip())
    print(f"\n✓ All {len(ALL_TABLES)} tables truncated successfully.")

    # Verify
    print("\nVerifying tables are empty...")
    for table in ALL_TABLES:
        result = run_sql(psql_cmd, f"SELECT COUNT(*) FROM {table};")
        if result.returncode == 0:
            count = result.stdout.strip().split("\n")[-2].strip()
            status = "✓" if count == "0" else f"⚠ ({count} rows remaining)"
            print(f"  {table}: {status}")
        else:
            print(f"  {table}: ? (query failed)")

    # Clean up disk files — KB-related directories
    import shutil

    data_dir = PROJECT_ROOT / "data"
    uploads_dir = PROJECT_ROOT / "uploads"

    # Directories that hold KB-generated content (clear contents, keep the directory)
    kb_dirs = [
        data_dir / "original",
        data_dir / "wiki",
        data_dir / "desensitized_documents",
        data_dir / "analysis",
        data_dir / "knowledge_bases",
        uploads_dir,
    ]

    # Top-level files in data/ that are KB analysis artifacts (not config/system files)
    # Keep: models/, logs/, tmp/, testdata/, test-output/, data/data/, and config files
    data_keep_dirs = {"models", "logs", "tmp", "testdata", "test-output", "data"}

    total_bytes = 0
    cleaned_items = 0

    for clean_dir in kb_dirs:
        if not clean_dir.exists():
            continue
        for item in clean_dir.iterdir():
            try:
                if item.is_dir():
                    size = sum(f.stat().st_size for f in item.rglob("*") if f.is_file())
                    shutil.rmtree(item, ignore_errors=True)
                    total_bytes += size
                    cleaned_items += 1
                elif item.is_file():
                    total_bytes += item.stat().st_size
                    item.unlink(missing_ok=True)
                    cleaned_items += 1
            except Exception as e:
                print(f"  ⚠ Failed to clean {item}: {e}")

    # Clean stray KB-related files in data/ root (reports, summaries, etc.)
    for item in data_dir.iterdir():
        if item.is_file():
            # Skip system files
            if item.name.startswith(".") or item.suffix in (".yaml", ".yml", ".json", ".ts", ".db"):
                continue
            # Remove analysis/report artifacts
            if item.suffix in (".md", ".txt", ".csv", ".py", ".pdf", ".xlsx", ".json"):
                try:
                    total_bytes += item.stat().st_size
                    item.unlink(missing_ok=True)
                    cleaned_items += 1
                except Exception:
                    pass

    # Human-readable size
    if total_bytes > 1024 * 1024 * 1024:
        size_str = f"{total_bytes / (1024*1024*1024):.1f} GB"
    elif total_bytes > 1024 * 1024:
        size_str = f"{total_bytes / (1024*1024):.1f} MB"
    elif total_bytes > 1024:
        size_str = f"{total_bytes / 1024:.1f} KB"
    else:
        size_str = f"{total_bytes} B"

    if cleaned_items > 0:
        print(f"\n✓ Cleaned {cleaned_items} items from disk ({size_str})")
        print(f"  Directories cleaned: {', '.join(d.name for d in kb_dirs if d.exists())}")
    else:
        print("\n✓ No disk files to clean")

    print("\nDone. System is now clean.")


if __name__ == "__main__":
    main()
