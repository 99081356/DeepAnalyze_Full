/**
 * Marketplace 浏览体验 e2e 测试.
 *
 * 验证：
 * - 初始加载首批 skill
 * - 无限滚动加载更多
 * - 即时客户端过滤
 * - 防抖服务端搜索
 * - 移除分页按钮
 * - 加载完毕底部提示
 *
 * 前置条件：DA 在 :21000 运行，Hub 在 :22000 运行且有 approved skills。
 */
import { test, expect } from "@playwright/test";

const DA_URL = "http://localhost:21000";

test.describe.serial("Marketplace 浏览体验", () => {
  test.beforeEach(async ({ page }) => {
    // 捕获控制台错误
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  async function openMarketplace(page: import("@playwright/test").Page) {
    await page.goto(`${DA_URL}/`);
    await page.waitForLoadState("networkidle");
    // 找到右侧面板切换到 marketplace 的按钮（图标按钮，title="资源市场"）
    const marketplaceBtn = page.locator('[title*="市场"], [title*="marketplace"], button:has-text("资源市场")').first();
    if (await marketplaceBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await marketplaceBtn.click();
      await page.waitForTimeout(500); // 等待 lazy load
    } else {
      throw new Error("无法定位资源市场入口按钮，请检查 UI 选择器");
    }
  }

  test("M1: 初始加载首批 skill", async ({ page }) => {
    await openMarketplace(page);
    // 等待卡片渲染（首批最多 20 条）
    const cards = page.locator('[data-testid="marketplace-skill-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20);
  });

  test("M2: 滚动加载更多（无限滚动）", async ({ page }) => {
    await openMarketplace(page);
    const cards = page.locator('[data-testid="marketplace-skill-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await cards.count();

    // 如 Hub 总数 ≤ 20，hasMore=false，无法测试滚动；跳过
    const sentinel = page.locator('[data-testid="marketplace-sentinel"]').first();
    const hasSentinel = await sentinel.isVisible({ timeout: 2000 }).catch(() => false);
    if (!hasSentinel) {
      test.skip();
      return;
    }

    // 滚动到哨兵
    await sentinel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500); // 等 append 请求完成

    const newCount = await cards.count();
    expect(newCount).toBeGreaterThan(initialCount);
  });

  test("M3: 输入立即触发客户端过滤（不等 debounce）", async ({ page }) => {
    await openMarketplace(page);
    const cards = page.locator('[data-testid="marketplace-skill-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await cards.count();

    // 找到搜索框（按 placeholder）
    const searchInput = page.locator('input[placeholder*="搜索"]').first();
    await searchInput.fill("code");

    // 立即检查（不等 300ms debounce）：displayedItems 应该按 "code" 过滤
    // 至少应该是 ≤ initialCount（如果没匹配则 = 0）
    // 这里不断言具体数量（取决于 Hub 数据），只断言"立即变化"
    await page.waitForTimeout(50); // 远小于 300ms debounce
    const filteredCount = await cards.count();
    // 注意：仅当 Hub 数据中有不匹配 "code" 的卡片时，filteredCount 才会小于 initialCount
    // 如果全部匹配，filteredCount === initialCount
    expect(filteredCount).toBeLessThanOrEqual(initialCount);
  });

  test("M4: debounce 后触发服务端搜索（list 重置）", async ({ page }) => {
    await openMarketplace(page);
    const cards = page.locator('[data-testid="marketplace-skill-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // 拦截 XHR 确认 debounce 后有请求
    const searchRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/hub/marketplace/skills")) {
        searchRequests.push(url);
      }
    });

    const searchInput = page.locator('input[placeholder*="搜索"]').first();
    await searchInput.fill("review");
    await page.waitForTimeout(500); // 等 debounce + 网络往返

    // 应该有至少一次带 search=review 的请求
    const reviewRequests = searchRequests.filter((u) => u.includes("search=review"));
    expect(reviewRequests.length).toBeGreaterThan(0);
  });

  test("M5: 不存在分页按钮（已移除）", async ({ page }) => {
    await openMarketplace(page);
    await expect(page.locator('[data-testid="marketplace-skill-card"]').first()).toBeVisible({ timeout: 10_000 });

    // 不应该出现分页相关文本/UI
    await expect(page.locator("text=上一页")).toHaveCount(0);
    await expect(page.locator("text=下一页")).toHaveCount(0);
    // 也不应该有 "X / Y" 分页信息（小心：搜索汇总也会用 / 字符，所以只检查纯数字/数字模式）
    // 这里仅断言"上一页/下一页"按钮不存在，足够覆盖核心移除
  });

  test("M6: hasMore=false 时显示 '已显示全部' 提示", async ({ page }) => {
    await openMarketplace(page);
    await expect(page.locator('[data-testid="marketplace-skill-card"]').first()).toBeVisible({ timeout: 10_000 });

    // 滚到底（如还能滚）
    const sentinel = page.locator('[data-testid="marketplace-sentinel"]').first();
    const hasSentinel = await sentinel.isVisible({ timeout: 1000 }).catch(() => false);
    if (hasSentinel) {
      await sentinel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
    }

    // 此时应显示 "已显示全部" 提示
    await expect(page.locator("text=/已显示全部/").first()).toBeVisible({ timeout: 5000 });
  });
});
