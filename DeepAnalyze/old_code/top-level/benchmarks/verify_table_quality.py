#!/usr/bin/env python3
"""
Table Processing Quality Verification
======================================
Verifies that all uploaded table files were correctly processed by NativeTableProcessor.
Checks document status, L0 summaries, L1 metadata descriptions, and edge case handling.

Usage:
    python3 benchmarks/verify_table_quality.py
    python3 benchmarks/verify_table_quality.py --kb-id <KB_ID>
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("DEEPANALYZE_URL", "http://localhost:21000")
SUMMARY_FILE = Path(__file__).parent / "test-data" / "tables" / "upload_summary.json"

# ---------------------------------------------------------------------------
# HTTP Helpers
# ---------------------------------------------------------------------------

def api_request(method: str, path: str, data: dict | None = None, timeout: int = 30) -> dict:
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        return {"error": f"HTTP {e.code}: {error_body[:500]}"}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Verification Checks
# ---------------------------------------------------------------------------

class QualityReport:
    def __init__(self, filename: str):
        self.filename = filename
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.warnings: list[str] = []

    def ok(self, check: str):
        self.passed.append(check)

    def fail(self, check: str, detail: str = ""):
        self.failed.append(f"{check}: {detail}" if detail else check)

    def warn(self, check: str):
        self.warnings.append(check)

    @property
    def is_pass(self) -> bool:
        return len(self.failed) == 0

    def summary(self) -> str:
        status = "PASS" if self.is_pass else "FAIL"
        parts = [f"[{status}] {self.filename}"]
        if self.failed:
            for f in self.failed:
                parts.append(f"  FAIL: {f}")
        if self.warnings:
            for w in self.warnings:
                parts.append(f"  WARN: {w}")
        parts.append(f"  ({len(self.passed)} checks passed)")
        return "\n".join(parts)


def get_l1_content(kb_id: str, doc_id: str) -> str:
    """Get the L1 (structure_md/overview) content for a document."""
    expand_result = api_request("POST", f"/api/knowledge/{kb_id}/expand", {
        "docId": doc_id,
        "level": "L1",
    })
    if "error" in expand_result:
        return ""
    return expand_result.get("content", "")


def get_document_info(kb_id: str, doc_id: str) -> dict:
    """Get detailed document info including pages."""
    result = api_request("GET", f"/api/knowledge/kbs/{kb_id}/documents")
    if isinstance(result, list):
        for doc in result:
            if doc.get("id") == doc_id:
                return doc
    return {}


def verify_basic_status(doc: dict, report: QualityReport):
    """Check document status is ready with no errors."""
    status = doc.get("status")
    if status == "ready":
        report.ok("status=ready")
    else:
        report.fail("status", f"expected 'ready', got '{status}'")

    error = doc.get("processingError")
    if not error:
        report.ok("no processing error")
    else:
        report.fail("processing error", error)


def verify_l1_metadata(content: str, report: QualityReport, filename: str):
    """Verify L1 metadata description structure.

    Two possible formats:
    1. NativeTableProcessor output: markdown with '表格文件信息', column defs, pandas snippets
    2. Fallback/raw output: "# Document Overview (auto-generated)" + raw text/DocTags
    """
    if not content:
        report.fail("L1 content", "empty or missing")
        return

    # Detect which processor was used
    is_native = "表格文件信息" in content
    is_auto = "Document Overview (auto-generated)" in content
    is_doctags = "<doctag>" in content

    if is_native:
        report.ok("NativeTableProcessor format detected")

        # Check file format or pandas code (either is sufficient)
        has_format = ("CSV" in content and filename.endswith(".csv")) or ("Excel" in content and filename.endswith(".xlsx"))
        has_pandas_code = False
        if filename.endswith(".csv"):
            has_pandas_code = "read_csv" in content
        elif filename.endswith(".xlsx"):
            has_pandas_code = "read_excel" in content

        if has_format:
            report.ok("format correctly labeled")
        elif has_pandas_code:
            report.ok("pandas code identifies format (read_csv/read_excel)")
        else:
            report.warn("format not explicitly labeled, but metadata is present")

        # Check column definitions table
        if "列定义" in content:
            report.ok("has column definitions table")
        else:
            report.fail("L1 structure", "missing column definitions (列定义)")

        # Check sample data table
        if "样本数据" in content:
            report.ok("has sample data table")
        else:
            report.warn("no sample data section (may be empty table)")

        # Check pandas code snippet
        if filename.endswith(".csv"):
            if "read_csv" in content:
                report.ok("has pandas read_csv snippet")
        elif filename.endswith(".xlsx"):
            if "read_excel" in content:
                report.ok("has pandas read_excel snippet")

        # Check file path
        base_name = filename.rsplit(".", 1)[0]
        if filename in content or base_name in content:
            report.ok("file path referenced")

    elif is_auto or is_doctags:
        # Fallback format - content exists but may not have structured metadata
        report.warn("fallback format detected (LLM overview failed or Docling used)")
        report.ok("L1 content exists with data")

        # Still check that the content has the actual column headers
        base_name = filename.rsplit(".", 1)[0]
        if filename in content or base_name in content:
            report.ok("file content referenced")

    else:
        report.warn("unknown L1 format")
        report.ok("L1 content exists")


def verify_special_cases(content: str, report: QualityReport, filename: str):
    """Verify edge case specific requirements."""
    if filename == "empty_table.csv":
        # Should have only headers, no data rows
        if "id" in content and "name" in content and "value" in content:
            report.ok("empty table: column names present")
        else:
            report.fail("empty table columns", "expected id/name/value")

    elif filename == "single_row.csv":
        if "唯一记录" in content:
            report.ok("single row: Chinese content preserved")
        else:
            report.fail("single row", "Chinese content missing")

    elif filename == "wide_table.csv":
        # Should reference many columns
        col_matches = re.findall(r"col_\d{2}", content)
        unique_cols = set(col_matches)
        if len(unique_cols) >= 25:
            report.ok(f"wide table: {len(unique_cols)} columns referenced")
        else:
            report.fail("wide table columns", f"only {len(unique_cols)} columns found, expected 30")

    elif filename == "tab_separated.csv":
        # Should have correct column names, not one big field
        if "温度" in content and "湿度" in content and "天气" in content:
            report.ok("TSV: columns correctly parsed")
        else:
            report.fail("TSV parsing", "columns not correctly separated")

    elif filename == "products.csv":
        # Should handle commas/quotes correctly
        if "Art of Programming" in content or "Premium Quality" in content or "Product Item" in content:
            report.ok("products: fields correctly parsed")
        else:
            report.fail("products CSV", "fields not parsed correctly")

    elif filename == "sensor_data.csv":
        # Should show sensor data
        if "SENSOR" in content and "temperature" in content:
            report.ok("sensor data: data columns present")
        else:
            report.fail("sensor data", "data columns not found")

    elif filename == "financial_report.xlsx":
        # Should have 3 sheets
        sheet_count = content.count("工作表:")
        if sheet_count >= 3:
            report.ok(f"financial report: {sheet_count} sheets listed")
        else:
            report.fail("financial report sheets", f"expected 3 sheets, found {sheet_count}")

    elif filename == "department_hierarchy.xlsx":
        # Should have 3 sheets and foreign key references
        if "部门表" in content and "员工表" in content and "项目表" in content:
            report.ok("department hierarchy: all 3 sheets present")
        else:
            report.fail("department hierarchy", "missing sheet references")
        if "dept_id" in content:
            report.ok("department hierarchy: foreign key column present")
        else:
            report.fail("department hierarchy", "foreign key column missing")

    elif filename == "unicode_data.csv":
        # Should contain multilingual content
        has_multilingual = any(
            kw in content
            for kw in ["こんにちは", "안녕하세요", "مرحبا", "Привет", "Bonjour"]
        )
        if has_multilingual:
            report.ok("unicode: multilingual content preserved")
        else:
            report.fail("unicode", "multilingual content not preserved")

    elif filename == "crossref_orders.xlsx":
        # Should reference employee IDs
        if "employee_id" in content:
            report.ok("orders: employee_id column present for cross-reference")
        else:
            report.fail("orders", "employee_id column missing")


def get_doc_l0_abstract(kb_id: str, doc_id: str) -> str:
    """Get L0 abstract content."""
    expand_result = api_request("POST", f"/api/knowledge/{kb_id}/expand", {
        "docId": doc_id,
        "level": "L0",
    })
    if "error" in expand_result:
        return ""
    return expand_result.get("content", "")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Table Processing Quality Verification")
    parser.add_argument("--kb-id", type=str, default=None, help="KB ID (or read from upload_summary.json)")
    parser.add_argument("--verbose", action="store_true", help="Show passing checks")
    args = parser.parse_args()

    # Determine KB ID
    kb_id = args.kb_id
    if not kb_id:
        if SUMMARY_FILE.exists():
            summary = json.loads(SUMMARY_FILE.read_text(encoding="utf-8"))
            kb_id = summary.get("kb_id")
        if not kb_id:
            print("ERROR: No KB ID provided and no upload_summary.json found.")
            print("Usage: python3 benchmarks/verify_table_quality.py --kb-id <KB_ID>")
            sys.exit(1)

    print(f"Verifying table processing quality for KB: {kb_id}")
    print("=" * 60)

    # Get all documents
    docs_result = api_request("GET", f"/api/knowledge/kbs/{kb_id}/documents")
    if "error" in docs_result:
        print(f"ERROR: Failed to get documents: {docs_result['error']}")
        sys.exit(1)

    docs = docs_result if isinstance(docs_result, list) else docs_result.get("documents", docs_result.get("data", []))
    if not isinstance(docs, list):
        print(f"ERROR: Unexpected documents response format")
        sys.exit(1)

    print(f"Found {len(docs)} documents\n")

    # Track which files we expect
    expected_files = {
        "employee_basic.csv", "sales_monthly.csv", "products.csv",
        "inventory.xlsx", "financial_report.xlsx", "department_hierarchy.xlsx",
        "sensor_data.csv", "empty_table.csv", "single_row.csv",
        "wide_table.csv", "tab_separated.csv", "unicode_data.csv",
        "crossref_orders.xlsx", "athlete_events.xlsx",
    }

    reports: list[QualityReport] = []
    processed_files = set()

    for doc in docs:
        original_name = doc.get("filename", doc.get("originalName", doc.get("fileName", "")))
        doc_id = doc.get("id", "")

        # Only check table files
        if not original_name.endswith((".csv", ".xlsx", ".xls")):
            continue

        processed_files.add(original_name)
        report = QualityReport(original_name)

        # Check 1: Document status
        verify_basic_status(doc, report)

        # Check 2: Get L1 content and verify metadata
        # Always use expand API for full content (l1Preview is truncated to ~300 chars)
        l1_content = get_l1_content(kb_id, doc_id)
        verify_l1_metadata(l1_content, report, original_name)

        # Check 3: Special case verification
        verify_special_cases(l1_content, report, original_name)

        # Check 4: L0 abstract should mention table-related info
        l0_content = get_doc_l0_abstract(kb_id, doc_id)
        if l0_content:
            report.ok("L0 abstract exists")
            # L0 should mention the file or table
            if any(kw in l0_content for kw in ["表格", "数据", "CSV", "Excel", "表"]):
                report.ok("L0 abstract mentions table-related info")
            else:
                report.warn("L0 abstract may not describe table content well")
        else:
            report.warn("L0 abstract empty or missing")

        reports.append(report)

    # Check for missing files
    missing_files = expected_files - processed_files
    for mf in sorted(missing_files):
        report = QualityReport(mf)
        report.fail("file presence", "file not found in KB")
        reports.append(report)

    # Print results
    total = len(reports)
    passed = sum(1 for r in reports if r.is_pass)
    failed = total - passed

    for report in reports:
        print(report.summary())
        if args.verbose and report.passed:
            for p in report.passed:
                print(f"  OK: {p}")
        print()

    print("=" * 60)
    print(f"Results: {passed}/{total} passed, {failed} failed")

    if failed > 0:
        print("\nFailed checks summary:")
        for report in reports:
            if not report.is_pass:
                for f in report.failed:
                    print(f"  {report.filename}: {f}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
