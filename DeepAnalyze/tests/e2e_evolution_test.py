#!/usr/bin/env python3
"""
DeepAnalyze Self-Evolution Feature End-to-End Test Suite
=========================================================
10 test scenarios covering:
  - Frontend UI (Playwright): button, panel, toggles, parameter editing
  - Backend API: config CRUD, memory CRUD, stats, error handling
  - Integration: config persistence, panel-to-API sync

Usage:
  python3 tests/e2e_evolution_test.py [--base-url http://localhost:21000]
"""

import json
import sys
import time
from dataclasses import dataclass
from typing import Any

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = "http://localhost:21000"
TIMEOUT = 15

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@dataclass
class TestResult:
    name: str
    passed: bool
    details: str = ""
    duration_ms: float = 0


def api_get(path: str) -> tuple[int, Any]:
    r = requests.get(f"{BASE_URL}{path}", timeout=TIMEOUT)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def api_put(path: str, body: dict) -> tuple[int, Any]:
    r = requests.put(f"{BASE_URL}{path}", json=body, timeout=TIMEOUT)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def api_delete(path: str) -> tuple[int, Any]:
    r = requests.delete(f"{BASE_URL}{path}", timeout=TIMEOUT)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


# ---------------------------------------------------------------------------
# Test Suite
# ---------------------------------------------------------------------------

class EvolutionTestSuite:
    results: list[TestResult] = []

    def _record(self, name: str, passed: bool, details: str = "", duration_ms: float = 0):
        self.results.append(TestResult(name=name, passed=passed, details=details, duration_ms=duration_ms))
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}" + (f" ({duration_ms:.0f}ms)" if duration_ms else ""))
        if not passed and details:
            print(f"         {details}")

    def _ensure_disabled(self):
        """Reset evolution to disabled state."""
        api_put("/api/settings/evolution", {"enabled": False})

    # ------------------------------------------------------------------
    # Test 1: Health Check + Server Running
    # ------------------------------------------------------------------
    def test_01_health_check(self):
        t0 = time.time()
        try:
            code, data = api_get("/api/health")
            ok = code == 200 and data.get("status") == "ok"
            self._record("T01: Health check", ok,
                         f"status={code}, data={data}" if not ok else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T01: Health check", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 2: Evolution Config GET — verify structure matches backend
    # ------------------------------------------------------------------
    def test_02_config_get_structure(self):
        t0 = time.time()
        try:
            code, data = api_get("/api/settings/evolution")
            ok = code == 200
            if ok:
                ok = (
                    isinstance(data.get("enabled"), bool)
                    and isinstance(data.get("modules"), dict)
                    and isinstance(data.get("params"), dict)
                    # Check actual field names from evolution-config.ts
                    and "memoryAccumulation" in data["modules"]
                    and "skillEvolution" in data["modules"]
                    and "skillMaintenance" in data["modules"]
                    and "historyRecall" in data["modules"]
                    and "nudgeInterval" in data["params"]
                    and "curatorIntervalDays" in data["params"]
                    and "archiveAfterDays" in data["params"]
                    and "staleAfterDays" in data["params"]
                )
            self._record("T02: Config GET structure", ok,
                         f"code={code}, data={data}" if not ok else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T02: Config GET structure", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 3: Config PUT — enable, modify params, verify persistence
    # ------------------------------------------------------------------
    def test_03_config_put_persist(self):
        t0 = time.time()
        try:
            # Enable evolution
            code1, data1 = api_put("/api/settings/evolution", {"enabled": True})
            ok1 = code1 == 200 and data1.get("success") is True

            # Verify persisted
            code2, data2 = api_get("/api/settings/evolution")
            ok2 = data2.get("enabled") is True

            # Modify nudgeInterval
            code3, data3 = api_put("/api/settings/evolution", {"params": {"nudgeInterval": 15}})
            ok3 = code3 == 200 and data3.get("success") is True

            # Verify parameter persisted
            code4, data4 = api_get("/api/settings/evolution")
            ok4 = data4.get("params", {}).get("nudgeInterval") == 15

            # Restore default
            self._ensure_disabled()
            api_put("/api/settings/evolution", {"params": {"nudgeInterval": 10}})

            ok = ok1 and ok2 and ok3 and ok4
            details = []
            if not ok1: details.append(f"enable: code={code1}")
            if not ok2: details.append(f"verify-enable: enabled={data2.get('enabled')}")
            if not ok3: details.append(f"modify-param: code={code3}")
            if not ok4: details.append(f"verify-param: {data4.get('params', {})}")
            self._record("T03: Config PUT enable/modify/persist", ok,
                         "; ".join(details) if details else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T03: Config PUT enable/modify/persist", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 4: Module Toggle — individual modules on/off
    # ------------------------------------------------------------------
    def test_04_module_toggle(self):
        t0 = time.time()
        try:
            # Enable with all modules on
            code1, _ = api_put("/api/settings/evolution", {
                "enabled": True,
                "modules": {
                    "memoryAccumulation": True,
                    "skillEvolution": True,
                    "skillMaintenance": True,
                    "historyRecall": True,
                }
            })
            ok1 = code1 == 200

            # Disable just skillMaintenance
            code2, _ = api_put("/api/settings/evolution", {
                "modules": {"skillMaintenance": False}
            })
            ok2 = code2 == 200

            # Verify only skillMaintenance is off
            code3, data3 = api_get("/api/settings/evolution")
            modules = data3.get("modules", {})
            ok3 = (
                modules.get("memoryAccumulation") is True
                and modules.get("skillEvolution") is True
                and modules.get("skillMaintenance") is False
                and modules.get("historyRecall") is True
            )

            self._ensure_disabled()

            self._record("T04: Module individual toggle", ok1 and ok2 and ok3,
                         f"modules={modules}" if not ok3 else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T04: Module individual toggle", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 5: Stats endpoint — correct structure
    # ------------------------------------------------------------------
    def test_05_stats_endpoint(self):
        t0 = time.time()
        try:
            code, data = api_get("/api/settings/evolution/stats")
            ok = code == 200
            if ok:
                ok = (
                    "memoryCount" in data
                    and "skillStats" in data
                    and isinstance(data["skillStats"], dict)
                    and all(k in data["skillStats"] for k in ["active", "stale", "archived", "agentCreated"])
                )
            self._record("T05: Stats endpoint structure", ok,
                         f"code={code}, data={data}" if not ok else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T05: Stats endpoint structure", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 6: Memory endpoints — list and clear
    # ------------------------------------------------------------------
    def test_06_memory_endpoints(self):
        t0 = time.time()
        try:
            # Enable evolution
            api_put("/api/settings/evolution", {"enabled": True, "modules": {"memoryAccumulation": True}})

            # Clear all memories
            code0, data0 = api_delete("/api/settings/evolution/memories")
            ok0 = code0 == 200

            # List should be empty
            code1, data1 = api_get("/api/settings/evolution/memories")
            ok1 = code1 == 200 and len(data1.get("memories", [])) == 0

            # Stats should show 0 memories
            code2, data2 = api_get("/api/settings/evolution/stats")
            ok2 = code2 == 200 and data2.get("memoryCount") == 0

            self._ensure_disabled()

            self._record("T06: Memory list/clear endpoints", ok0 and ok1 and ok2,
                         f"clear={code0}; list={code1},{data1}; stats={code2}" if not (ok0 and ok1 and ok2) else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T06: Memory list/clear endpoints", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 7: Error handling — invalid inputs don't crash server
    # ------------------------------------------------------------------
    def test_07_error_handling(self):
        t0 = time.time()
        try:
            # Send garbage data — should not crash
            code1, _ = api_put("/api/settings/evolution", {"invalid_key": True, "enabled": "not_a_bool"})
            ok1 = code1 in (200, 400, 422)

            # Send extreme param values
            code2, _ = api_put("/api/settings/evolution", {"params": {"nudgeInterval": -1}})
            ok2 = code2 in (200, 400, 422)

            # Server should still work after bad inputs
            code3, _ = api_get("/api/settings/evolution")
            ok3 = code3 == 200

            # Delete non-existent memory (invalid UUID format)
            code4, _ = api_delete("/api/settings/evolution/memories/non-existent-uuid")
            ok4 = code4 in (200, 404)  # Now returns 404 after fix

            # Reset to clean state
            self._ensure_disabled()
            api_put("/api/settings/evolution", {"params": {"nudgeInterval": 10}})

            self._record("T07: Error handling (invalid inputs)", ok1 and ok2 and ok3 and ok4,
                         f"garbage={code1}; extreme={code2}; sanity={code3}; del_fake={code4}" if not (ok1 and ok2 and ok3 and ok4) else "",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T07: Error handling (invalid inputs)", False, str(e), (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 8: Frontend — Brain button opens EvolutionPanel
    # ------------------------------------------------------------------
    def test_08_frontend_brain_button(self):
        t0 = time.time()
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()

                page.goto(f"{BASE_URL}", wait_until="networkidle", timeout=15000)

                # Check for Brain icon button
                brain_btn = page.locator('button[title="自进化"]')
                ok1 = brain_btn.count() >= 1

                if ok1:
                    brain_btn.first.click()

                    # Wait for lazy-loaded panel content (toggle switches appear)
                    page.wait_for_selector('.toggle-switch', timeout=10000)
                    ok2 = True

                    # Check key text elements (wait for render)
                    page.wait_for_selector('text=自进化系统', timeout=5000)
                    ok3 = page.locator('text=自进化系统').count() >= 1
                    ok4 = page.locator('text=功能模块').count() >= 1
                    ok5 = page.locator('text=统计概览').count() >= 1

                    # Close with Escape
                    page.keyboard.press("Escape")
                    time.sleep(0.5)
                else:
                    ok2 = ok3 = ok4 = ok5 = False

                browser.close()

                ok = ok1 and ok2 and ok3 and ok4 and ok5
                details = []
                if not ok1: details.append("brain button not found")
                if not ok2: details.append("no toggle switches")
                if not ok3: details.append("missing 自进化系统")
                if not ok4: details.append("missing 功能模块")
                if not ok5: details.append("missing 统计概览")

                self._record("T08: Frontend Brain button + EvolutionPanel", ok,
                             "; ".join(details) if details else "",
                             (time.time() - t0) * 1000)
        except ImportError:
            self._record("T08: Frontend Brain button + EvolutionPanel", False,
                         "Playwright not installed",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T08: Frontend Brain button + EvolutionPanel", False, str(e),
                         (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 9: Frontend — Master toggle syncs with API
    # ------------------------------------------------------------------
    def test_09_frontend_toggle_sync(self):
        t0 = time.time()
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()

                # Ensure evolution is OFF before test
                api_put("/api/settings/evolution", {"enabled": False})

                page.goto(f"{BASE_URL}", wait_until="networkidle", timeout=15000)

                # Open evolution panel
                page.locator('button[title="自进化"]').first.click()
                page.wait_for_selector('.toggle-switch', timeout=10000)

                # Find master toggle using aria-label
                master = page.locator('.toggle-switch[aria-label="启用自进化"]')
                ok0 = master.count() >= 1
                if not ok0:
                    # Fallback: try first toggle
                    master = page.locator('.toggle-switch').first
                    ok0 = True

                # Should be unchecked (disabled)
                is_on = master.get_attribute("aria-checked") == "true"
                ok1 = not is_on

                # Click to enable (wait for stability)
                time.sleep(0.5)
                master.click()
                time.sleep(1.5)

                # Re-locate master (panel may have re-rendered)
                master = page.locator('.toggle-switch[aria-label="启用自进化"]').first

                # Check UI state changed
                now_on = master.get_attribute("aria-checked") == "true"
                ok2 = now_on is True

                # Check API reflects change
                code, data = api_get("/api/settings/evolution")
                ok3 = data.get("enabled") is True

                # Click to disable
                master.click()
                time.sleep(1)

                # Re-locate again
                master = page.locator('.toggle-switch[aria-label="启用自进化"]').first
                back_off = master.get_attribute("aria-checked") == "true"
                ok4 = back_off is False

                # API should be disabled again
                code2, data2 = api_get("/api/settings/evolution")
                ok5 = data2.get("enabled") is False

                # Count toggles (1 master + 4 modules = 5)
                all_toggles = page.locator('.toggle-switch')
                ok6 = all_toggles.count() >= 5

                browser.close()

                ok = ok0 and ok1 and ok2 and ok3 and ok4 and ok5 and ok6
                details = []
                if not ok0: details.append("master toggle not found")
                if not ok1: details.append("initial state not OFF")
                if not ok2: details.append(f"toggle did not turn ON ({now_on})")
                if not ok3: details.append(f"API not synced ON: {data.get('enabled')}")
                if not ok4: details.append(f"toggle did not turn OFF ({back_off})")
                if not ok5: details.append(f"API not synced OFF: {data2.get('enabled')}")
                if not ok6: details.append(f"expected >=5 toggles, got {all_toggles.count()}")

                self._record("T09: Frontend toggle syncs with API", ok,
                             "; ".join(details) if details else "",
                             (time.time() - t0) * 1000)
        except ImportError:
            self._record("T09: Frontend toggle syncs with API", False,
                         "Playwright not installed",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T09: Frontend toggle syncs with API", False, str(e),
                         (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Test 10: Frontend — Params editing + Memory list expand
    # ------------------------------------------------------------------
    def test_10_frontend_params_memory(self):
        t0 = time.time()
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()

                page.goto(f"{BASE_URL}", wait_until="networkidle", timeout=15000)

                # Open evolution panel
                page.locator('button[title="自进化"]').first.click()
                page.wait_for_selector('.toggle-switch', timeout=10000)

                # Enable so params section is interactive
                master = page.locator('.toggle-switch[aria-label="启用自进化"]').first
                if master.get_attribute("aria-checked") != "true":
                    master.click()
                    time.sleep(1)

                # Check parameter section
                ok1 = page.locator('text=参数设置').count() >= 1

                # Check number inputs (4 params)
                inputs = page.locator('input[type="number"]')
                ok2 = inputs.count() >= 4

                # Check memory list section (collapsed)
                ok3 = page.locator('text=记忆列表').count() >= 1

                # Click to expand memory list
                page.locator('text=记忆列表').first.click()
                time.sleep(1)

                # After expand, should show empty state or items without crash
                ok4 = True  # no crash = pass

                # Check stat labels rendered
                ok5 = page.locator('text=记忆条目').count() >= 1 or page.locator('text=活跃技能').count() >= 1

                browser.close()

                ok = ok1 and ok2 and ok3 and ok4 and ok5
                details = []
                if not ok1: details.append("missing 参数设置")
                if not ok2: details.append(f"expected >=4 number inputs, got {inputs.count()}")
                if not ok3: details.append("missing 记忆列表")
                if not ok5: details.append("missing stat labels")

                self._record("T10: Frontend params + memory list", ok,
                             "; ".join(details) if details else "",
                             (time.time() - t0) * 1000)
        except ImportError:
            self._record("T10: Frontend params + memory list", False,
                         "Playwright not installed",
                         (time.time() - t0) * 1000)
        except Exception as e:
            self._record("T10: Frontend params + memory list", False, str(e),
                         (time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # Run all tests
    # ------------------------------------------------------------------
    def run_all(self):
        print("\n" + "=" * 70)
        print("  DeepAnalyze Self-Evolution E2E Test Suite")
        print("  10 Scenarios — Frontend + Backend + Error Handling")
        print("=" * 70 + "\n")

        tests = [
            self.test_01_health_check,
            self.test_02_config_get_structure,
            self.test_03_config_put_persist,
            self.test_04_module_toggle,
            self.test_05_stats_endpoint,
            self.test_06_memory_endpoints,
            self.test_07_error_handling,
            self.test_08_frontend_brain_button,
            self.test_09_frontend_toggle_sync,
            self.test_10_frontend_params_memory,
        ]

        for test_fn in tests:
            test_fn()

        # Print summary
        print("\n" + "-" * 70)
        passed = sum(1 for r in self.results if r.passed)
        failed = len(self.results) - passed
        total_ms = sum(r.duration_ms for r in self.results)
        print(f"  Results: {passed}/{len(self.results)} passed, {failed} failed ({total_ms:.0f}ms total)")
        print("-" * 70)

        if failed > 0:
            print("\n  Failed tests:")
            for r in self.results:
                if not r.passed:
                    print(f"    - {r.name}: {r.details}")
            print()

        return failed == 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:21000")
    args = parser.parse_args()
    BASE_URL = args.base_url

    suite = EvolutionTestSuite()
    success = suite.run_all()
    sys.exit(0 if success else 1)
