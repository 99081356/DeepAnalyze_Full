import { test } from "@playwright/test";
import { openHub } from "../tests/e2e/helpers/hubUi";
import { adminLogin, shot, request as makeReq } from "../tests/e2e/helpers/hubApi";

test("snapshot", async ({ page, request }) => {
  const admin = await adminLogin(await makeReq.newContext());
  await openHub(page, admin.token!, "/");
  await page.waitForTimeout(500);
  await shot(page, "hub_now_dash", true);
  for (const p of ["/orgs", "/users", "/skills", "/sharings"]) {
    await page.goto("http://localhost:22000" + p);
    await page.waitForTimeout(500);
    await shot(page, `hub_now${p.replace("/", "_")}`, true);
  }
});
