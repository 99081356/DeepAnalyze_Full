/**
 * Migration 001: Initial schema
 *
 * Creates all core tables for DeepAnalyze Hub.
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // ─── Users ───────────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      display_name TEXT,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      sso_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
      assigned_worker_id TEXT,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ─── Workers ─────────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      endpoint TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      capabilities JSONB,
      status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'draining')),
      worker_token TEXT NOT NULL UNIQUE,
      last_heartbeat TIMESTAMPTZ,
      active_sessions INT DEFAULT 0,
      active_tasks INT DEFAULT 0,
      resource_usage JSONB,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
    CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers(last_heartbeat);
  `);

  // ─── Config Versions ─────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS config_versions (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'global',
      config_data JSONB NOT NULL,
      description TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ─── Marketplace Skills ──────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS marketplace_skills (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,
      tools TEXT[] DEFAULT '{"*"}',
      model_role TEXT DEFAULT 'main',
      anti_hallucination_level TEXT,
      tags TEXT[],
      version TEXT NOT NULL DEFAULT '1.0.0',
      author_id TEXT REFERENCES users(id),
      submitter_id TEXT REFERENCES users(id),
      download_count INT DEFAULT 0,
      rating_avg NUMERIC(3,2) DEFAULT 0,
      review_count INT DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'deprecated')),
      reviewer_id TEXT REFERENCES users(id),
      review_notes TEXT,
      published_at TIMESTAMPTZ,
      compatibility JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_skills_status ON marketplace_skills(review_status);
    CREATE INDEX IF NOT EXISTS idx_marketplace_skills_slug ON marketplace_skills(slug);
  `);

  // ─── Marketplace Plugins ─────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS marketplace_plugins (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      manifest JSONB NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      author_id TEXT REFERENCES users(id),
      download_count INT DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'deprecated')),
      reviewer_id TEXT REFERENCES users(id),
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ─── Skill Reviews ───────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS skill_reviews (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES marketplace_skills(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      rating INT CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ─── Audit Log ───────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details JSONB,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ─── SSO Sessions ────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS sso_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ─── Default admin user ──────────────────────────────────────────────────

  // Password: "admin" (bcrypt hash will be set on first run)
  // Admin should change this immediately after first login
  await query(`
    INSERT INTO users (id, username, display_name, role, status)
    VALUES ('system', 'system', 'System', 'admin', 'active')
    ON CONFLICT (id) DO NOTHING;
  `);
}
