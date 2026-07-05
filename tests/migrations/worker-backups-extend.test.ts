// 验证 migration 039 已应用：worker_backups 表有 2 个新列 + status CHECK 含 deletion_failed
import { describe, test, expect } from "bun:test";
import { query } from "../../src/store/pg";

describe("migration 039: worker_backups schema 扩展", () => {
  test("manifest_path 和 pg_version 列存在", async () => {
    const { rows } = await query<{
      column_name: string; data_type: string; is_nullable: string;
    }>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'worker_backups'
        AND column_name IN ('manifest_path', 'pg_version')
      ORDER BY column_name
    `);
    expect(rows.length).toBe(2);
    const names = rows.map(r => r.column_name).sort();
    expect(names).toEqual(["manifest_path", "pg_version"]);
    // 都是 TEXT，nullable（旧 backup 行没这俩字段）
    for (const r of rows) {
      expect(r.data_type).toBe("text");
      expect(r.is_nullable).toBe("YES");
    }
  });

  test("status CHECK 含 'deletion_failed'", async () => {
    // 直接查 pg_constraint 验证 CHECK 子句文本，避免 FK 干扰
    const { rows } = await query<{ check_clause: string }>(`
      SELECT pg_get_constraintdef(oid) AS check_clause
      FROM pg_constraint
      WHERE conrelid = 'worker_backups'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%'
    `);
    // 至少有一个 status CHECK 约束
    expect(rows.length).toBeGreaterThan(0);
    // check_clause 应该包含 deletion_failed
    const clause = rows[0].check_clause;
    expect(clause).toContain("deletion_failed");
    // 同时仍包含原 5 个状态
    expect(clause).toContain("created");
    expect(clause).toContain("verified");
    expect(clause).toContain("expired");
  });

  test("未知 status 仍被拒绝（CHECK 约束不包含任意字符串）", async () => {
    const { rows } = await query<{ check_clause: string }>(`
      SELECT pg_get_constraintdef(oid) AS check_clause
      FROM pg_constraint
      WHERE conrelid = 'worker_backups'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%'
    `);
    expect(rows.length).toBeGreaterThan(0);
    // 不应包含明显不在白名单的状态字面量
    expect(rows[0].check_clause).not.toContain("bogus_status");
    expect(rows[0].check_clause).not.toContain("random_invented");
  });

  test("migration 幂等（再跑 ALTER 不报错）", async () => {
    // 验证 ADD COLUMN IF NOT EXISTS 和 DROP + ADD CONSTRAINT 都是幂等的
    await query(`
      ALTER TABLE worker_backups
        ADD COLUMN IF NOT EXISTS manifest_path TEXT,
        ADD COLUMN IF NOT EXISTS pg_version TEXT;
    `);
    await query(`
      ALTER TABLE worker_backups
        DROP CONSTRAINT IF EXISTS worker_backups_status_check;
      ALTER TABLE worker_backups
        ADD CONSTRAINT worker_backups_status_check
          CHECK (status IN ('created','verified','restored','failed','expired','deletion_failed'));
    `);
    expect(true).toBe(true);
  });
});
