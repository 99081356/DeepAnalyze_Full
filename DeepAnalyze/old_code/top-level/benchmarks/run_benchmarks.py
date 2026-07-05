#!/usr/bin/env python3
"""
DeepAnalyze Benchmark Test Runner
==================================
Runs test cases through the DeepAnalyze API, collects all process data,
and evaluates results with LLM-based assessment.

Usage:
    python3 benchmarks/run_benchmarks.py [--batch 1] [--config benchmarks/test_cases.json]
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import signal
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("DEEPANALYZE_URL", "http://localhost:21000")
EVAL_MODEL = os.environ.get("EVAL_MODEL", "glm-5.1")
EVAL_ENDPOINT = os.environ.get("EVAL_ENDPOINT", "https://api.z.ai/api/anthropic")
EVAL_API_KEY = os.environ.get("EVAL_API_KEY", "59a816c2acd54338a773936fefc0cb77.FgAcgymYXgYQmEbk")

# KB IDs for different test categories
KB_IDS = {
    "newbigtest2": "681aa199-134b-4812-8559-2f20e3b58ab3",
    "bigtest": "d6975eaf-802f-4839-bb1c-499ae17d8dff",
    "剧情杀库": "cb83edb8-0623-4d4f-87b5-40cacf0d0baa",
    "学术论文库": "1c50caef-db45-416c-afde-1ffbb54de2be",
    "DeepAnalyze需求库": "0be3e6fc-9762-49d7-b592-996ecb23d5d4",
    "回归测试KB": "34e5e5f9-30ca-4dbd-9ed5-b8363b8cf23a",
    "表格处理测试库": os.environ.get("TABLE_TEST_KB_ID", "70aa232a-cbb6-4221-8b61-198ad2b3b235"),
}

RESULTS_DIR = Path(__file__).parent / "results"

# ---------------------------------------------------------------------------
# HTTP Helpers
# ---------------------------------------------------------------------------

def api_request(method: str, path: str, data: dict | None = None, timeout: int = 30) -> Any:
    """Make an API request and return parsed JSON response."""
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


def sse_stream(path: str, data: dict, timeout: int = 600):
    """Send a request and yield SSE events as (event_type, data_dict) tuples."""
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            event_type = None
            data_buf = ""
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
                if line.startswith(":"):
                    continue  # comment / keepalive
                if line.startswith("event: "):
                    event_type = line[7:].strip()
                elif line.startswith("data: "):
                    data_buf += line[6:]
                elif line == "":
                    # End of event
                    if event_type and data_buf:
                        try:
                            parsed = json.loads(data_buf)
                        except json.JSONDecodeError:
                            parsed = {"raw": data_buf}
                        yield event_type, parsed
                    event_type = None
                    data_buf = ""
    except Exception as e:
        yield "error", {"error": str(e)}

# ---------------------------------------------------------------------------
# Test Case Definitions
# ---------------------------------------------------------------------------

def get_test_cases() -> list[dict]:
    """Return the full test case suite."""
    kb = KB_IDS["newbigtest2"]
    kb_legal = KB_IDS["剧情杀库"]
    kb_paper = KB_IDS["学术论文库"]

    cases = [
        # ---- Category 1: Search & Retrieval (Tool Decathlon style) ----
        {
            "id": "SR-01",
            "name": "简单事实检索 - 文档数量",
            "category": "search_retrieval",
            "kb_scope": [kb],
            "input": "这个知识库里有多少个文档？请列出各类型文档的数量统计。",
            "eval_criteria": "回答中应包含文档总数和按类型分类的数量（如PDF、图片、音频等）。允许数量有小幅偏差（±5%）。",
            "ground_truth": "约239个文档，包含PNG、JPG、PDF、WebP、MP3、MP4、DOCX、XLSX、WAV等类型",
        },
        {
            "id": "SR-02",
            "name": "关键词搜索 - 查找特定内容",
            "category": "search_retrieval",
            "kb_scope": [kb],
            "input": "请搜索知识库中所有与「运动员」相关的内容，找到包含运动员信息的Excel文件，列出前5条数据记录。",
            "eval_criteria": "应找到athlete_events.xlsx文件，能列出具体的运动员数据（如姓名、运动项目、年份等）。数据条目需要准确。",
            "ground_truth": "athlete_events.xlsx包含运动员参赛记录",
        },
        {
            "id": "SR-03",
            "name": "跨文档关联搜索",
            "category": "search_retrieval",
            "kb_scope": [kb],
            "input": "搜索知识库中所有与「柯南」相关的内容。有哪些文档提到了柯南？请列出所有相关文档及其中的关键信息。",
            "eval_criteria": "应找到多个与柯南相关的文档（PDF/MD等），能正确归纳各文档中关于柯南的信息要点。不能遗漏明显相关的文档。",
            "ground_truth": "包含《柯南之死》剧本杀相关文档",
        },
        {
            "id": "SR-04",
            "name": "语义搜索 - 模糊查询",
            "category": "search_retrieval",
            "kb_scope": [kb],
            "input": "请帮我找到知识库中讨论「人工智能在医疗领域应用」的相关文档，总结其中的主要观点。",
            "eval_criteria": "应能找到与AI医疗相关的文档，总结的观点应反映文档实际内容而非幻觉。引用要准确。",
            "ground_truth": None,
        },

        # ---- Category 2: Data Analysis (SpreadsheetBench style) ----
        {
            "id": "DA-01",
            "name": "Excel数据分析 - 基础统计",
            "category": "data_analysis",
            "kb_scope": [kb],
            "input": "请展开知识库中的Excel文件（athlete_events.xlsx），分析数据特征：1）共有多少行数据？2）包含哪些列？3）数据的时间范围是什么？4）列出所有不同的运动项目。",
            "eval_criteria": "应正确展开XLSX文件，准确报告行数、列名、时间范围、运动项目列表。数字必须与文件实际内容一致。",
            "ground_truth": "athlete_events.xlsx包含奥运会运动员参赛数据",
        },
        {
            "id": "DA-02",
            "name": "Excel数据分析 - 聚合计算",
            "category": "data_analysis",
            "kb_scope": [kb],
            "input": "请分析athlete_events.xlsx中的数据：1）哪个国家获得的金牌最多？2）哪位运动员参加的奥运会次数最多？3）最早和最晚的记录分别是哪一年的什么赛事？",
            "eval_criteria": "应通过展开文件获取实际数据进行计算，给出具体数字和名称。不能用猜测代替实际数据分析。",
            "ground_truth": None,
        },
        {
            "id": "DA-03",
            "name": "CSV数据分析 - 对比分析",
            "category": "data_analysis",
            "kb_scope": [kb],
            "input": "请找到知识库中的CSV文件，分析其数据结构和内容特征。如果有多个CSV文件，请对比它们的异同。",
            "eval_criteria": "应找到所有CSV文件，准确描述数据结构（列名、行数、数据类型），对比分析合理。",
            "ground_truth": None,
        },

        # ---- Category 3: Document Comprehension (Long Context / FActScore) ----
        {
            "id": "DC-01",
            "name": "PDF文档深度理解",
            "category": "document_comprehension",
            "kb_scope": [kb],
            "input": "请找到知识库中名为「antigravity-rag-2026.pdf」的论文，阅读全文后回答：1）这篇论文的核心贡献是什么？2）提出了什么方法？3）在哪些数据集上做了实验？4）主要结果如何？",
            "eval_criteria": "回答应基于论文实际内容，准确概括核心贡献、方法名称、实验数据集和量化结果。不能编造论文中没有的信息。",
            "ground_truth": "antigravity-rag论文，关于RAG系统的改进研究",
        },
        {
            "id": "DC-02",
            "name": "多文档综合理解",
            "category": "document_comprehension",
            "kb_scope": [kb],
            "input": "请找到知识库中所有的PDF学术论文，对每篇论文简要概括：标题、核心主题、主要方法。以表格形式呈现。",
            "eval_criteria": "应找到所有PDF学术论文（非图片），表格应包含准确的标题和主题概括。不应将非学术PDF列入。",
            "ground_truth": None,
        },

        # ---- Category 4: Complex Reasoning (Deep Research / Agent Long Bench) ----
        {
            "id": "CR-01",
            "name": "综合分析任务 - 多源信息整合",
            "category": "complex_reasoning",
            "kb_scope": [kb],
            "input": "请全面分析这个知识库的内容构成：1）知识库包含哪些主要类别的内容？2）每类内容的关键信息是什么？3）内容之间存在什么关联？请给出结构化的分析报告。",
            "eval_criteria": "分析应覆盖知识库的主要内容类别（学术论文、剧本杀、数据文件、图片等），能发现内容间的关联关系。报告结构清晰，信息准确。",
            "ground_truth": "newbigtest2库包含学术论文、剧本杀文档、运动员数据、各类图片等",
        },
        {
            "id": "CR-02",
            "name": "剧本杀推理分析",
            "category": "complex_reasoning",
            "kb_scope": [kb],
            "input": "请搜索知识库中与剧本杀相关的内容，找到关于《柯南之死》的所有文档，分析：1）案件的基本情况 2）各角色的秘密和动机 3）核心诡计 4）完整的推理过程。",
            "eval_criteria": "应找到相关文档并基于实际内容进行推理分析。角色信息、时间线、诡计描述需要与原文一致。不能凭空编造情节。",
            "ground_truth": "《柯南之死》是全员凶手本，7人本，核心诡计是分尸伪装自杀",
        },
        {
            "id": "CR-03",
            "name": "证据链分析 - 交叉验证",
            "category": "complex_reasoning",
            "kb_scope": [kb],
            "input": "在知识库的剧本杀相关文档中，请找出关于「追凶手记」的所有信息，回答：1）拘留室杀人的真凶是谁？2）有什么证据证明？3）动机是什么？4）六名警察各自的特征和习惯是什么？",
            "eval_criteria": "应准确识别真凶（马铭），列出关键证据（拳头伤痕、监控关闭、结案报告异常等），正确描述六名警察的特征。信息需要来自文档而非猜测。",
            "ground_truth": "真凶是马铭，关键证据包括拳头上的红色伤痕、监控被关闭、结案报告完成度异常",
        },

        # ---- Category 5: Image Understanding ----
        {
            "id": "IU-01",
            "name": "图片内容识别",
            "category": "image_understanding",
            "kb_scope": [kb],
            "input": "请找到知识库中的PNG和JPG图片，选择3-5张进行内容描述：每张图片展示的是什么？有什么关键信息？",
            "eval_criteria": "应通过展开图片获取VLM描述或实际内容，描述应具体而非泛泛而谈。不能描述不存在的图片内容。",
            "ground_truth": None,
        },

        # ---- Category 6: Multi-step Workflow (Toolathlon style) ----
        {
            "id": "MW-01",
            "name": "多步骤工具调用 - 搜索→分析→报告",
            "category": "multi_step_workflow",
            "kb_scope": [kb],
            "input": "请完成以下任务：1）搜索知识库中所有与「实验」或「数据」相关的文档 2）从中选择最有价值的3个文档详细分析 3）生成一份综合分析报告，包含发现和结论。",
            "eval_criteria": "应执行搜索→展开→分析→报告的完整流程。每一步都要有实际工具调用，报告内容要基于搜索到的实际文档。",
            "ground_truth": None,
        },
        {
            "id": "MW-02",
            "name": "多步骤工具调用 - 对比分析",
            "category": "multi_step_workflow",
            "kb_scope": [kb],
            "input": "请完成以下任务：1）分别找到知识库中的学术论文和非学术论文 2）对论文进行摘要 3）对非学术内容进行分类 4）制作一份知识库内容目录。",
            "eval_criteria": "应正确区分学术和非学术内容，摘要准确，分类合理，目录格式清晰。",
            "ground_truth": None,
        },

        # ---- Category 7: Edge Cases & Robustness ----
        {
            "id": "EC-01",
            "name": "空结果处理 - 不存在的搜索",
            "category": "edge_case",
            "kb_scope": [kb],
            "input": "请搜索知识库中关于「量子计算机商业化进展」的内容，并给出详细分析。",
            "eval_criteria": "如果知识库中没有相关内容，应明确告知而非编造。可以搜索后说没有找到，不应幻觉出不存在的文档。",
            "ground_truth": "知识库中可能没有量子计算相关内容",
        },
        {
            "id": "EC-02",
            "name": "模糊查询处理",
            "category": "edge_case",
            "kb_scope": [kb],
            "input": "告诉我这个知识库里有什么有趣的东西？",
            "eval_criteria": "应通过搜索工具探索知识库内容，列出主要类别和代表性内容，而非凭猜测回答。回答应有信息量。",
            "ground_truth": None,
        },

        # ---- Category 8: Cross-KB reasoning ----
        {
            "id": "CK-01",
            "name": "跨知识库搜索",
            "category": "cross_kb",
            "kb_scope": [kb, kb_paper],
            "input": "请在所有可用的知识库中搜索关于「RAG」（检索增强生成）的内容，汇总各知识库中的相关发现。",
            "eval_criteria": "应搜索多个知识库，汇总各库中的相关内容。不能只搜索一个库就停止。",
            "ground_truth": None,
        },

        # ============================================================
        # Category 9: Anti-Hallucination (FActScore-style)
        # Tests that agent only reports facts verifiable from documents
        # ============================================================
        {
            "id": "AH-01",
            "name": "反幻觉 - PDF精确事实抽取",
            "category": "anti_hallucination",
            "kb_scope": [kb],
            "input": "请找到知识库中名为「antigravity-rag-2026.pdf」的论文，仅根据论文原文回答以下问题（如果论文中没有相关信息，请明确说明「论文中未提及」）：1）系统处理了多少条Telegram消息？2）跨越了多少个聊天？3）系统使用了什么硬件配置？4）语义查询路由器有几个意图分类？",
            "eval_criteria": "每个数字必须与论文原文完全一致。论文中明确提到：725,521条Telegram消息、812个聊天、8 vCPU AMD EPYC 32GB RAM、7个意图分类。任何偏离这些数字的回答都算幻觉。对于论文中确实未提及的信息，必须说「论文中未提及」。",
            "ground_truth": "725,521条消息; 812个聊天; 8 vCPU AMD EPYC, 32GB RAM, 无GPU; 7个意图分类",
        },
        {
            "id": "AH-02",
            "name": "反幻觉 - 学术论文精确引用",
            "category": "anti_hallucination",
            "kb_scope": [kb],
            "input": "请找到名为「BDCC-08-00115.pdf」或标题包含「QA-RAG」的论文，仅根据论文原文回答：1）论文测试了哪两个LLM模型？2）系统在哪个能力上达到了83.3%的准确率？3）论文考察的三个关键RAG能力分别是什么？4）请不要编造论文中没有的信息。",
            "eval_criteria": "必须精确回答两个模型：Llama 2 7b和13b；准确率83.3%（需说明是哪个场景的准确率，如整体TriviaQA或noise robustness）；三个能力名称正确即可（noise robustness, knowledge gap detection, external truth integration，大小写不限）。编造模型名称或不存在的数字算幻觉。",
            "ground_truth": "Llama 2 7b和13b; noise robustness 83.3%; noise robustness / knowledge gap detection / external truth integration",
        },
        {
            "id": "AH-03",
            "name": "反幻觉 - 图片OCR内容验证",
            "category": "anti_hallucination",
            "kb_scope": [kb],
            "input": "请在知识库中找到一张名为「询问笔录」的图片（WEBP格式），通过展开获取其完整内容后回答：1）案件名称是什么？2）被询问人是谁？身份证号是多少？3）询问的时间和地点？4）询问人是谁及其警号？仅根据图片实际内容回答，不要编造。",
            "eval_criteria": "必须精确回答：案件「四港新河床非法取土案」；被询问人张鹏，身份证13092319861004051X；时间2024年6月6日15:57-16:29，地点王寺镇人民政府；询问人郭超（警号03041097040）和张永生（警号03091097021）。任何姓名、数字、日期的偏差都算幻觉。",
            "ground_truth": "案件：四港新河床非法取土案; 张鹏/13092319861004051X; 2024年6月6日15:57-16:29/王寺镇人民政府; 郭超03041097040、张永生03091097021",
        },
        {
            "id": "AH-04",
            "name": "反幻觉 - 虚构内容拒绝",
            "category": "anti_hallucination",
            "kb_scope": [kb],
            "input": "请找到知识库中名为「antigravity-rag-2026.pdf」的论文，告诉我这篇论文在ImageNet数据集上的实验结果。请仔细阅读论文后再回答。",
            "eval_criteria": "这篇论文是关于个人知识图谱RAG系统的，未在ImageNet上做实验。Agent应该明确指出论文中没有ImageNet实验结果，而不是编造数字。如果Agent编造了任何ImageNet相关的实验结果（如准确率、F1分数等），则此测试失败。",
            "ground_truth": "论文中未提及ImageNet实验，Agent应明确说明没有找到相关信息",
        },
        {
            "id": "AH-05",
            "name": "反幻觉 - Excel精确数值",
            "category": "anti_hallucination",
            "kb_scope": [kb],
            "input": "请展开知识库中的athlete_events.xlsx文件，回答以下精确问题：1）数据总共有多少行（不含表头）？2）数据包含几列？3）第2行（即第1条数据记录）的运动员姓名是什么？性别是什么？参加了什么运动项目？4）请确认你的每一个数字都来自文件内容而非估算。",
            "eval_criteria": "必须精确回答：271,117行（含表头）或271,116行（不含表头）均可；15列；第1条记录是A Dijiang（或第一个实际出现的名字），M（Male），Basketball（或实际对应的项目）。列数必须与L1内容中记录的完全一致。行数取决于是否包含表头，两种回答都算正确。",
            "ground_truth": "271,117行(含表头)/271,116行(不含表头); 15列; 第1条：A Dijiang, M, Basketball",
        },

        # ============================================================
        # Category 10: Completeness (No Omission)
        # Tests that agent retrieves ALL relevant information
        # ============================================================
        {
            "id": "CO-01",
            "name": "完整性 - DOCX角色信息全列举",
            "category": "completeness",
            "kb_scope": [kb],
            "input": "请找到知识库中的「剪烛夜行组织者手册.docx」文件，列出文档中提到的所有玩家角色的完整信息，包括：姓名、年龄、职业/身份、人物关系。请确保不遗漏任何一个角色。",
            "eval_criteria": "必须完整列出6个玩家角色：裴世春(35,画家/地狱画师)、林森(28,警察/小说家)、海洋(21,美院学生)、于恩琪(20,美院学生)、端木云(30,家庭主妇/裴世春之妻)、南皓月(26,记者/林森女友)。遗漏任何一个角色扣分。年龄、职业必须与文档一致。",
            "ground_truth": "裴世春35画家, 林森28警察小说家, 海洋21美院学生, 于恩琪20美院学生, 端木云30主妇裴世春妻, 南皓月26记者林森女友",
        },
        {
            "id": "CO-02",
            "name": "完整性 - 文件类型全覆盖",
            "category": "completeness",
            "kb_scope": [kb],
            "input": "请分析这个知识库，列出知识库中包含的所有不同文件类型（按扩展名分类），以及每种类型的文件数量。请确保不遗漏任何类型。",
            "eval_criteria": "应列出所有文件类型：PNG(95), JPG(75), PDF(46), WEBP(8), MP3(5), MP4(3), DOCX(3), XLSX(1), WAV(1), JPEG(1)。每种类型的数量允许±3的误差。遗漏任何文件类型都扣分。",
            "ground_truth": "PNG~95, JPG~75, PDF~46, WEBP~8, MP3~5, MP4~3, DOCX~3, XLSX~1, WAV~1, JPEG~1",
        },
        {
            "id": "CO-03",
            "name": "完整性 - 证据编号系统",
            "category": "completeness",
            "kb_scope": [kb],
            "input": "请找到「剪烛夜行组织者手册.docx」中关于证据编号系统的说明，列出所有证据编号的字母代号及其含义，以及游戏的证据发放规则。",
            "eval_criteria": "应完整列出：D=端木云, H=海洋, N=南皓月, L=林森, P=裴世春, Y=于恩琪, S=舒漫, A=画廊, B=画室, C=尸体。以及游戏规则：2轮搜证，42张证据卡，每人7行动点。遗漏任何代号或规则细节扣分。",
            "ground_truth": "证据编号: D端木云/H海洋/N南皓月/L林森/P裴世春/Y于恩琪/S舒漫/A画廊/B画室/C尸体; 2轮42张证据卡每人7行动点",
        },

        # ============================================================
        # Category 11: No Redundancy
        # Tests that agent answers are concise without repetition
        # ============================================================
        {
            "id": "NR-01",
            "name": "无冗余 - 精确数字提取",
            "category": "no_redundancy",
            "kb_scope": [kb],
            "input": "请找到「antigravity-rag-2026.pdf」，只回答一个数字：系统处理了多少条Telegram消息？不需要任何解释或额外信息。",
            "eval_criteria": "回答应简洁精确，直接给出725,521这个数字。如果回答包含大量无关信息（如论文全文摘要、背景介绍等冗余内容），应扣分。核心标准：给出正确数字+简短引用来源即可。",
            "ground_truth": "725,521",
        },
        {
            "id": "NR-02",
            "name": "无冗余 - 简短事实确认",
            "category": "no_redundancy",
            "kb_scope": [KB_IDS["回归测试KB"]],
            "input": "请确认知识库中是否存在名为「test.txt」的文件？如果存在，其第三行的内容是什么？只需直接回答。",
            "eval_criteria": "回答应简洁：确认存在，第三行是'Line three has some special characters: 中文 English 日本語'。不需要列出整个文件内容或做额外的分析。冗长的回答扣分。",
            "ground_truth": "存在; 第三行：Line three has some special characters: 中文 English 日本語",
        },

        # ============================================================
        # Category 12: Cross-Document Synthesis
        # Tests information integration across multiple documents
        # ============================================================
        {
            "id": "CS-01",
            "name": "跨文档综合 - RAG论文对比",
            "category": "cross_document",
            "kb_scope": [kb],
            "input": "请找到知识库中所有与「RAG」（检索增强生成）相关的PDF论文，对比它们的研究方向、方法和主要结论的异同。请用表格形式展示对比结果。",
            "eval_criteria": "应找到至少2篇RAG相关论文（antigravity-rag-2026.pdf和BDCC-08-00115.pdf即QA-RAG），正确对比它们的方法差异。antigravity是个人知识图谱，QA-RAG是噪声鲁棒性研究。对比维度合理，信息来自文档而非猜测。",
            "ground_truth": "至少2篇: antigravity-rag(个人知识图谱/混合检索), QA-RAG(LLM对外部知识的依赖/噪声鲁棒性)",
        },
        {
            "id": "CS-02",
            "name": "跨文档综合 - 剧本杀角色关系网",
            "category": "cross_document",
            "kb_scope": [kb],
            "input": "请在知识库中找到与「剪烛夜行」相关的所有文档，综合所有文档内容，构建完整的角色关系网络图。列出：1）所有角色之间的已知关系 2）每个角色的核心秘密 3）案件的关键时间线。请确保从多个文档中交叉验证信息。",
            "eval_criteria": "应找到组织者手册和角色深入证据等多个文档，从中综合构建关系网络。裴世春与端木云是夫妻、与舒漫是情人关系；林森与南皓月是情侣；案件发生在9月10日画廊2号。信息应来自实际文档交叉验证。",
            "ground_truth": "裴世春-端木云(夫妻), 裴世春-舒漫(情人), 林森-南皓月(情侣); 案件9月10日画廊2号; 舒漫是被害人",
        },
        {
            "id": "CS-03",
            "name": "跨文档综合 - 数据与论文关联",
            "category": "cross_document",
            "kb_scope": [kb],
            "input": "请完成以下分析：1）找到知识库中的athlete_events.xlsx，统计中国（China/Chinese Taipei）在不同年代的金牌数量变化 2）找到知识库中的学术论文，确认是否有任何论文讨论了与体育或奥运会相关的主题 3）将两者结合给出综合结论。",
            "eval_criteria": "应正确分析Excel数据并给出中国金牌数量统计。对于学术论文部分，应如实说明没有体育相关论文，而不是编造。分析应区分事实数据（来自Excel）和推理结论。",
            "ground_truth": "Excel中有中国参赛数据; 知识库中的学术论文（RAG、数学等）与体育无关",
        },

        # ============================================================
        # Category 13: Multi-Format Robustness
        # Tests correct handling of different file types
        # ============================================================
        {
            "id": "MF-01",
            "name": "多格式 - TXT基础检索",
            "category": "multi_format",
            "kb_scope": [KB_IDS["回归测试KB"]],
            "input": "请找到知识库中的TXT文件，展开并读取其完整内容，然后逐行复述文件中的每一行内容。",
            "eval_truth": "test.txt内容：第1行空行, 第2行'Test content for DeepAnalyze regression testing.', 第3行'This is a simple text file with multiple lines.', 第4行'Line three has some special characters: 中文 English 日本語'",
            "eval_criteria": "应找到test.txt文件，完整复述其3行内容（不含空行和标题行）。内容必须与原文逐字一致，不能有遗漏或修改。特殊字符（中文/日文）必须正确。",
            "ground_truth": "3行文本：Test content... / This is a simple text file... / Line three has some special characters: 中文 English 日本語",
        },
        {
            "id": "MF-02",
            "name": "多格式 - XLSX结构化查询",
            "category": "multi_format",
            "kb_scope": [kb],
            "input": "请展开知识库中的athlete_events.xlsx文件，列出文件的所有列名（表头），并回答数据的时间跨度是从哪一年到哪一年？数据涵盖了几届夏季奥运会和几届冬季奥运会？",
            "eval_criteria": "应正确列出15个列名：ID, Name, Sex, Age, Height, Weight, Team, NOC, Games, Year, Season, City, Sport, Event, Medal。时间跨度应从1896年开始。夏季和冬季奥运会的届数应基于实际数据计算。",
            "ground_truth": "15列; 1896年起; 数据涵盖夏季和冬季奥运会",
        },
        {
            "id": "MF-03",
            "name": "多格式 - 图片VLM内容提取",
            "category": "multi_format",
            "kb_scope": [kb],
            "input": "请在知识库中搜索「询问笔录」相关的图片，展开该图片获取VLM分析结果，提取其中所有的姓名、日期和证件号码，以结构化格式列出。",
            "eval_criteria": "应找到WEBP格式的询问笔录图片，通过VLM+OCR提取到：被询问人张鹏（身份证13092319861004051X）、询问人郭超（警号03041097040）和张永生（警号03091097021）、日期2024年6月6日。所有姓名和号码必须与VLM输出一致。",
            "ground_truth": "张鹏/13092319861004051X; 郭超/03041097040; 张永生/03091097021; 2024-06-06",
        },

        # ============================================================
        # Category 14: Hallucination Stress Tests
        # Tests resistance to various hallucination triggers
        # ============================================================
        {
            "id": "HS-01",
            "name": "幻觉压力 - 诱导性问题",
            "category": "hallucination_stress",
            "kb_scope": [kb],
            "input": "我听说知识库里有一篇关于BERT在医学影像诊断中应用的论文，请帮我找到并总结它的主要发现。",
            "eval_criteria": "知识库中没有BERT医学影像论文。Agent应搜索后明确告知没有找到这样的论文，而不是编造一篇不存在的论文。搜索了但没有结果是正确行为，编造内容是严重错误。",
            "ground_truth": "知识库中不存在BERT医学影像相关论文，应如实告知",
        },
        {
            "id": "HS-02",
            "name": "幻觉压力 - 混淆文档归属",
            "category": "hallucination_stress",
            "kb_scope": [kb],
            "input": "请找到QA-RAG论文（BDCC-08-00115.pdf），告诉我这篇论文中关于「个人知识图谱」和「Telegram消息处理」的内容。",
            "eval_criteria": "QA-RAG论文讨论的是LLM对RAG外部知识的依赖，不涉及个人知识图谱和Telegram。这些内容来自antigravity-rag-2026.pdf。Agent应指出QA-RAG论文中没有这些内容，或者说明这些信息来自另一篇论文。将两篇论文内容混淆是严重错误。",
            "ground_truth": "QA-RAG论文不涉及个人知识图谱或Telegram; 应指出该论文无此内容",
        },
        {
            "id": "HS-03",
            "name": "幻觉压力 - 虚假细节填充",
            "category": "hallucination_stress",
            "kb_scope": [kb],
            "input": "请详细描述antigravity-rag-2026.pdf论文中的用户界面设计，包括界面截图描述和交互流程。",
            "eval_criteria": "如果论文中确实没有界面截图和交互流程的详细描述，Agent应如实说明。如果论文只有文字描述而没有UI截图，不应编造截图内容。Agent的回答应忠实于论文实际内容。",
            "ground_truth": "论文可能没有UI截图和详细交互流程描述; 应如实说明论文中实际有什么",
        },

        # ============================================================
        # Category 15: Table Processing (TP)
        # Tests NativeTableProcessor + Agent table analysis capabilities
        # ============================================================
        {
            "id": "TP-01",
            "name": "表格处理 - CSV基础聚合",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请找到知识库中的employee_basic.csv文件，分析并回答：1）共有多少条员工记录？2）平均薪资是多少？3）哪个部门的员工最多？4）薪资最高和最低的分别是哪位员工？",
            "eval_criteria": "应通过展开文件或使用pandas读取数据，准确回答：50条记录；平均薪资应接近28500（±2000）；部门人数需基于实际数据统计；最高/最低薪资员工名字需与文件内容一致。数字必须来自实际数据分析。",
            "ground_truth": "50行数据; 平均薪资约28500; 6个部门; 需通过pandas实际计算",
        },
        {
            "id": "TP-02",
            "name": "表格处理 - XLSX单sheet查询",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析知识库中的inventory.xlsx文件，回答：1）总共多少条库存记录？2）哪些类别的商品库存最多（按总数量排序）？3）总价值最高的前3个商品是什么？",
            "eval_criteria": "应准确报告200条库存记录。类别排序需基于实际数据计算。总价值最高的商品应通过数量×单价计算得出。所有数字需来自文件内容而非猜测。",
            "ground_truth": "200条记录; 8个类别; 需通过pandas实际计算排序",
        },
        {
            "id": "TP-03",
            "name": "表格处理 - 多sheet查询",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析financial_report.xlsx文件，回答：1）这个Excel文件包含几个工作表？分别叫什么名字？2）每个工作表分别有多少行数据（不含表头）？3）利润表中2024-01月份的营业收入是多少？",
            "eval_criteria": "应正确识别3个工作表：资产负债表、利润表、现金流量表。行数应接近60、80、50（不含表头）。利润表中2024-01的营业收入应为具体数值，来自实际数据。",
            "ground_truth": "3个sheet: 资产负债表(~60行)、利润表(~80行)、现金流量表(~50行)",
        },
        {
            "id": "TP-04",
            "name": "表格处理 - XLSX内跨sheet关联",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析department_hierarchy.xlsx文件，回答：1）「技术研发部」(dept_id=D001)有多少名员工？请列出这些员工的姓名和职位。2）哪些部门有正在进行中的项目？",
            "eval_criteria": "应通过展开文件或pandas读取两个sheet的数据，通过dept_id关联员工表和部门表。技术研发部员工人数需与实际数据一致。项目状态筛选应正确。",
            "ground_truth": "部门表6条+员工表50条+项目表20条; 通过dept_id关联",
        },
        {
            "id": "TP-05",
            "name": "表格处理 - 跨文件关联分析",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析crossref_orders.xlsx和department_hierarchy.xlsx两个文件，回答：1）员工E0001的所有订单总金额是多少？2）哪个部门的员工产生的订单总额最高？（需要跨文件通过employee_id关联订单表和员工表）",
            "eval_criteria": "应能发现两个文件通过employee_id关联。应使用pandas读取两个文件并合并数据。E0001的订单总额需从实际数据计算。部门订单总额需通过JOIN后聚合计算。数字应来自实际计算而非猜测。",
            "ground_truth": "orders有500条记录, employee_id引用department_hierarchy的员工表",
        },
        {
            "id": "TP-06",
            "name": "表格处理 - 特殊字符CSV",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析products.csv文件，回答：1）有多少种不同的产品分类(category)？2）请列出所有产品名称中包含逗号或引号的产品。3）所有产品的平均价格是多少？",
            "eval_criteria": "应正确解析含逗号/引号的CSV字段。应找到5个分类。含特殊字符的产品名应包括如'T-Shirt, \"Premium Quality\"'等。平均价格需从实际数据计算。如果CSV解析不正确（字段错位），此测试失败。",
            "ground_truth": "5个分类; 约10个含特殊字符的产品名; 平均价格约250±50",
        },
        {
            "id": "TP-07",
            "name": "表格处理 - TSV格式",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析tab_separated.csv文件，回答：1）这个文件有多少列？列名分别是什么？2）所有记录的平均温度是多少？3）哪种天气出现次数最多？",
            "eval_criteria": "应正确识别6列（日期、城市、温度、湿度、天气、风速）。如果列名显示为整行作为一个字段，说明TSV解析失败。平均温度需从实际数据计算。天气类型统计需正确。",
            "ground_truth": "6列: 日期/城市/温度/湿度/天气/风速; 50行数据",
        },
        {
            "id": "TP-08",
            "name": "表格处理 - 多语言内容",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析unicode_data.csv文件，回答：1）文件包含多少条记录？2）请列出所有不同的多语言文字（multilingual列中的不同值）。3）multilingual列中是否有日文、韩文、阿拉伯文内容？",
            "eval_criteria": "应正确报告30条记录。multilingual列应包含至少日语(こんにちは)、韩语(안녕하세요)、阿拉伯语(مرحبا)等不同语言的内容。如果所有非中文内容都丢失或乱码，说明编码处理有问题。",
            "ground_truth": "30条记录; multilingual列含日/韩/阿拉伯/俄/法/德/西/葡/意语",
        },
        {
            "id": "TP-09",
            "name": "表格处理 - 大型CSV聚合",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析sensor_data.csv文件，回答：1）数据总共有多少行？2）所有传感器的平均温度是多少？3）温度的最高值和最低值分别是多少？4）哪个传感器记录的数据最多？",
            "eval_criteria": "应准确报告10,000行数据。平均温度应在15-45范围内。最高/最低温度需来自实际数据计算。5个传感器每个记录数量应大致相等（各约2000条）。数字必须来自实际计算。",
            "ground_truth": "10,000行; 5个传感器; 温度范围15-45; 每个传感器约2000条",
        },
        {
            "id": "TP-10",
            "name": "表格处理 - 空表格处理",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析empty_table.csv文件，这个文件中有什么数据？",
            "eval_criteria": "应正确识别这是一个只有表头没有数据的空表格。应列出列名（id, name, value）并说明没有数据行。不应编造不存在的数据。不应报错或拒绝回答。",
            "ground_truth": "空表格, 3列(id/name/value), 0行数据",
        },
        {
            "id": "TP-11",
            "name": "表格处理 - 宽表查询",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析wide_table.csv文件，回答：1）这个文件有多少列？请列出所有列名。2）有多少行数据？3）第8列(col_08)的数据类型是什么？",
            "eval_criteria": "应正确报告30列和20行数据。30个列名(col_01到col_30)应完整列出，不能遗漏。col_08应为数值类型。如果列名不完整或数量不对，说明元数据提取有问题。",
            "ground_truth": "30列(col_01~col_30); 20行数据; col_08是数值类型",
        },
        {
            "id": "TP-12",
            "name": "表格处理 - 单行数据",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析single_row.csv文件，列出其中所有的数据。",
            "eval_criteria": "应正确报告该文件只有1行数据，4个字段：id=1, name=唯一记录, status=active, amount=999.99。内容必须与文件完全一致，中文字符不能丢失。",
            "ground_truth": "1行数据: id=1, name=唯一记录, status=active, amount=999.99",
        },
        {
            "id": "TP-13",
            "name": "表格处理 - 预处理血缘验证",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请查看知识库的预处理目录(_preprocessing/tables/)，列出所有预处理表格的来源文档信息。每个表格来自哪个原始文件？使用了什么提取方法？",
            "eval_criteria": "应能找到_preprocessing/tables/目录下的manifest.json或相关文件。每个表格条目应包含sourceDocId/sourceDocName/extractionMethod等血缘信息。如果预处理未执行，应说明而非编造。",
            "ground_truth": "预处理应在_preprocessing/tables/下生成manifest.json，含血缘信息",
        },
        {
            "id": "TP-14",
            "name": "表格处理 - 预处理数据交叉验证",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请对比预处理表格目录中的数据与原始employee_basic.csv的内容，验证预处理后的数据与原始数据是否一致。行数是否匹配？列名是否相同？",
            "eval_criteria": "应同时读取预处理表格和原始文件，进行交叉对比。行数、列名应完全匹配。如果预处理数据与原始数据不一致，应指出差异。如果预处理未生成表格数据，应如实说明。",
            "ground_truth": "预处理数据应与原始数据行数(50)和列数(8)一致",
        },
        {
            "id": "TP-15",
            "name": "表格处理 - 反幻觉验证",
            "category": "table_processing",
            "kb_scope": [KB_IDS["表格处理测试库"]] if KB_IDS.get("表格处理测试库") else [],
            "input": "请分析employee_basic.csv文件，回答：1）「家庭住址」这一列的内容是什么？2）员工EMP0099的薪资是多少？3）有多少员工的星座是处女座？",
            "eval_criteria": "employee_basic.csv没有「家庭住址」列——Agent应指出该列不存在。EMP0099不存在（只有50名员工EMP0001-EMP0050）——Agent应说明。文件没有星座列——Agent应指出没有此信息。如果Agent编造了任何不存在的内容，此测试严重失败。",
            "ground_truth": "无「家庭住址」列; 无EMP0099(只有50人); 无星座列; Agent应如实说明",
        },
    ]
    return cases

# ---------------------------------------------------------------------------
# Test Execution
# ---------------------------------------------------------------------------

def create_session(title: str, kb_scope: list[str]) -> str:
    """Create a test session and return its ID."""
    result = api_request("POST", "/api/sessions", {
        "title": title,
        "kbScope": kb_scope,
    })
    if "error" in result:
        raise RuntimeError(f"Failed to create session: {result['error']}")
    return result["id"]


def run_single_test(case: dict) -> dict:
    """Execute a single test case and collect all process data."""
    session_id = create_session(
        f"bench-{case['id']}-{datetime.now().strftime('%H%M%S')}",
        case["kb_scope"],
    )

    result = {
        "case_id": case["id"],
        "case_name": case["name"],
        "category": case["category"],
        "session_id": session_id,
        "input": case["input"],
        "ground_truth": case.get("ground_truth"),
        "started_at": datetime.now().isoformat(),
        "tool_calls": [],
        "push_contents": [],
        "content_deltas": [],
        "turns": 0,
        "full_content": "",
        "errors": [],
        "completed": False,
    }

    print(f"  Session: {session_id}")
    print(f"  Query: {case['input'][:80]}...")

    try:
        for event_type, event_data in sse_stream(
            "/api/agents/run-stream",
            {
                "sessionId": session_id,
                "input": case["input"],
            },
            timeout=600,
        ):
            if event_type == "start":
                result["task_id"] = event_data.get("taskId")
            elif event_type == "content_delta":
                delta = event_data.get("delta", "")
                result["content_deltas"].append(delta)
                result["full_content"] += delta
            elif event_type == "turn":
                result["turns"] = event_data.get("turn", 0)
            elif event_type == "tool_call":
                result["tool_calls"].append({
                    "tool": event_data.get("toolName"),
                    "input": event_data.get("input"),
                    "status": "running",
                })
            elif event_type == "tool_result":
                tool_name = event_data.get("toolName", "")
                # Update matching tool_call
                for tc in reversed(result["tool_calls"]):
                    if tc["tool"] == tool_name and tc["status"] == "running":
                        tc["status"] = "completed"
                        tc["output_preview"] = str(event_data.get("output", ""))[:200]
                        break
            elif event_type == "push_content":
                result["push_contents"].append({
                    "type": event_data.get("type"),
                    "title": event_data.get("title"),
                    "data_length": event_data.get("dataLength", 0),
                })
            elif event_type == "complete":
                result["completed"] = True
                result["turns"] = event_data.get("turns", result["turns"])
            elif event_type == "error":
                result["errors"].append(event_data.get("error", "unknown"))
            elif event_type == "compaction":
                result.setdefault("compactions", []).append(event_data)

    except Exception as e:
        result["errors"].append(f"Stream error: {str(e)}")

    result["finished_at"] = datetime.now().isoformat()
    result["duration_seconds"] = (
        datetime.fromisoformat(result["finished_at"])
        - datetime.fromisoformat(result["started_at"])
    ).total_seconds()

    # Tool call summary
    tool_counts = {}
    for tc in result["tool_calls"]:
        tool_counts[tc["tool"]] = tool_counts.get(tc["tool"], 0) + 1
    result["tool_call_summary"] = tool_counts

    print(f"  Turns: {result['turns']}, Tools: {tool_counts}, Duration: {result['duration_seconds']:.1f}s")
    print(f"  Output length: {len(result['full_content'])} chars")
    if result["errors"]:
        print(f"  Errors: {result['errors']}")
    print(f"  Push contents: {len(result['push_contents'])}")

    return result

# ---------------------------------------------------------------------------
# LLM-based Evaluation
# ---------------------------------------------------------------------------

def evaluate_result(case: dict, result: dict) -> dict:
    """Evaluate a test result using LLM assessment."""
    if not result["completed"] and not result["full_content"]:
        return {
            "score": 0,
            "verdict": "FAIL",
            "reason": "Agent failed to produce any output",
        }

    # Build the full answer text: content + finish summary
    answer_text = result["full_content"]
    finish_summary = ""
    for tc in result.get("tool_calls", []):
        if tc.get("tool") == "finish" and tc.get("input", {}).get("summary"):
            finish_summary = tc["input"]["summary"]
            break
    if finish_summary and len(finish_summary) > 10:
        # If the answer is only in the finish summary (no text content),
        # use the finish summary as the primary answer
        if not answer_text.strip():
            answer_text = f"[Agent's final answer (via finish tool)]:\n{finish_summary}"
        else:
            answer_text += f"\n\n[Agent's final answer summary]:\n{finish_summary}"

    # Build evaluation prompt
    eval_prompt = f"""你是一个严格的测试评估员。请评估以下AI Agent的输出质量。

## 测试任务
{case["name"]}
输入: {case["input"]}

## 评估标准
{case["eval_criteria"]}
"""

    if case.get("ground_truth"):
        eval_prompt += f"""
## 参考答案（可用于验证，但Agent的回答不一定要完全一致）
{case["ground_truth"]}
"""

    eval_prompt += f"""
## Agent的输出
{answer_text[:16000]}
"""

    if result["push_contents"]:
        pushed_text = "\n".join(
            f"### {pc.get('title', 'Untitled')} ({pc.get('type', 'unknown')})\n"
            f"[Data length: {pc.get('data_length', 0)} chars]"
            for pc in result["push_contents"]
        )
        eval_prompt += f"""
## Agent还通过push_content输出了以下内容卡片（这些也是Agent结果的一部分）
{pushed_text}
注意：如果Agent将主要内容放在卡片中而非文本输出中，卡片的内容也应视为有效输出，但应检查信息的可追溯性。
"""

    eval_prompt += """
## 评估要求
请按以下标准打分（0-100分）：
1. **准确性** (40分): 信息是否准确？有没有幻觉或编造？
2. **完整性** (30分): 是否完整回答了问题？有无遗漏？
3. **有用性** (20分): 回答是否有价值？结构是否清晰？
4. **工具使用** (10分): 是否正确使用了搜索/分析工具？工具调用是否合理？

以JSON格式输出：
```json
{
  "accuracy_score": 0-40,
  "completeness_score": 0-30,
  "usefulness_score": 0-20,
  "tool_usage_score": 0-10,
  "total_score": 0-100,
  "verdict": "PASS" or "FAIL",
  "reason": "简短评价",
  "issues": ["问题1", "问题2"]
}
```
"""

    # Call LLM for evaluation
    try:
        payload = {
            "model": EVAL_MODEL,
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": eval_prompt}],
        }
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{EVAL_ENDPOINT}/v1/messages",
            data=body,
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", EVAL_API_KEY)
        req.add_header("anthropic-version", "2023-06-01")

        with urllib.request.urlopen(req, timeout=60) as resp:
            response = json.loads(resp.read().decode())
            # Extract text from response
            text = ""
            for block in response.get("content", []):
                if block.get("type") == "text":
                    text += block.get("text", "")

            # Parse JSON from response
            eval_result = extract_json(text)
            if eval_result and "total_score" in eval_result:
                return eval_result
            return {
                "score": 50,
                "verdict": "UNCERTAIN",
                "reason": f"Could not parse eval response: {text[:200]}",
                "raw_eval": text[:500],
            }
    except Exception as e:
        return {
            "score": -1,
            "verdict": "EVAL_ERROR",
            "reason": str(e),
        }


def extract_json(text: str) -> dict | None:
    """Extract JSON from text that may contain markdown code blocks."""
    import re
    # Try to find JSON in code blocks
    match = re.search(r'```json\s*(\{.*?\})\s*```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # Try to find any JSON object
    match = re.search(r'\{[^{}]*"total_score"[^{}]*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return None

# ---------------------------------------------------------------------------
# Batch Runner
# ---------------------------------------------------------------------------

def run_batch(cases: list[dict], batch_num: int) -> list[dict]:
    """Run a batch of test cases and return results with evaluations."""
    results = []
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    batch_file = RESULTS_DIR / f"batch_{batch_num:03d}.json"
    if batch_file.exists():
        print(f"Loading existing batch {batch_num} from {batch_file}")
        return json.loads(batch_file.read_text())

    print(f"\n{'='*60}")
    print(f"Batch {batch_num}: Running {len(cases)} test cases")
    print(f"{'='*60}")

    for i, case in enumerate(cases):
        print(f"\n[{i+1}/{len(cases)}] {case['id']}: {case['name']}")
        result = run_single_test(case)

        # Run evaluation
        print(f"  Evaluating...")
        eval_result = evaluate_result(case, result)
        result["evaluation"] = eval_result
        print(f"  Score: {eval_result.get('total_score', 'N/A')} - {eval_result.get('verdict', 'N/A')}")
        if eval_result.get("issues"):
            for issue in eval_result["issues"]:
                print(f"    Issue: {issue}")

        results.append(result)

        # Save intermediate results
        batch_file.write_text(json.dumps(results, ensure_ascii=False, indent=2))

    # Print batch summary
    print(f"\n{'='*60}")
    print(f"Batch {batch_num} Summary")
    print(f"{'='*60}")
    total = len(results)
    passed = sum(1 for r in results if r["evaluation"].get("verdict") == "PASS")
    failed = sum(1 for r in results if r["evaluation"].get("verdict") == "FAIL")
    errors = sum(1 for r in results if r["evaluation"].get("verdict") in ("EVAL_ERROR", "UNCERTAIN"))
    avg_score = sum(r["evaluation"].get("total_score", 0) for r in results) / total if total else 0

    print(f"Total: {total}, Passed: {passed}, Failed: {failed}, Errors: {errors}")
    print(f"Average Score: {avg_score:.1f}/100")

    for r in results:
        ev = r["evaluation"]
        status_icon = "PASS" if ev.get("verdict") == "PASS" else "FAIL"
        print(f"  [{status_icon}] {r['case_id']}: {ev.get('total_score', 'N/A')} - {ev.get('reason', '')[:80]}")

    return results


def main():
    parser = argparse.ArgumentParser(description="DeepAnalyze Benchmark Runner")
    parser.add_argument("--batch", type=int, default=1, help="Batch number (1-based)")
    parser.add_argument("--batch-size", type=int, default=10, help="Cases per batch")
    parser.add_argument("--category", type=str, default=None, help="Filter by category")
    parser.add_argument("--case-id", type=str, default=None, help="Run specific case ID")
    parser.add_argument("--skip-eval", action="store_true", help="Skip LLM evaluation")
    parser.add_argument("--list", action="store_true", help="List all test cases")
    args = parser.parse_args()

    cases = get_test_cases()

    if args.list:
        for c in cases:
            print(f"  {c['id']:8} [{c['category']:20}] {c['name']}")
        print(f"\nTotal: {len(cases)} cases")
        return

    # Filter cases
    if args.case_id:
        cases = [c for c in cases if c["id"] == args.case_id]
        if not cases:
            print(f"Case {args.case_id} not found")
            return
    elif args.category:
        cases = [c for c in cases if c["category"] == args.category]

    # Select batch
    start = (args.batch - 1) * args.batch_size
    batch_cases = cases[start:start + args.batch_size]

    if not batch_cases:
        print(f"No cases in batch {args.batch} (start={start}, total={len(cases)})")
        return

    results = run_batch(batch_cases, args.batch)

    # Return exit code based on pass rate
    failed = [r for r in results if r["evaluation"].get("verdict") != "PASS"]
    if failed:
        sys.exit(1)

if __name__ == "__main__":
    main()
