#!/usr/bin/env python3
"""
DeepAnalyze Agent Stress Test Suite - 30 challenging test cases
Tests across 10 dimensions: precision, cross-doc reasoning, multi-modal,
negative/anti-hallucination, large-scale, edge cases, unreasonable challenges,
efficiency, workflow, and completeness.

Usage:
  python3 benchmarks/run_stress_tests.py                  # Run all
  python3 benchmarks/run_stress_tests.py 1 5 10           # Run specific tests
  python3 benchmarks/run_stress_tests.py --batch 1        # Run batch 1 (tests 1-10)
  python3 benchmarks/run_stress_tests.py --batch 2        # Run batch 2 (tests 11-20)
  python3 benchmarks/run_stress_tests.py --batch 3        # Run batch 3 (tests 21-30)
  python3 benchmarks/run_stress_tests.py --analyze results.json  # Analyze results only
"""

import json
import sys
import time
import urllib.request
import urllib.error
import uuid
import os
from datetime import datetime

BASE_URL = os.environ.get("DEEPANALYZE_URL", "http://localhost:21000")
KB_ID = "89ee4db6-0626-4636-8c66-49a575d05832"
RESULTS_DIR = os.path.join(os.path.dirname(__file__), "stress-test-results")

# =============================================================================
# Test Case Definitions
# =============================================================================

TEST_CASES = [
    # =========================================================================
    # Group A: 压缩恢复能力 (inevitable compaction, test recovery)
    # Tasks so large that context WILL be compacted. Tests:
    # - CollapseStore overlap resolution
    # - Compaction summary preserves document list + working files
    # - Agent reads working file to resume after compaction
    # =========================================================================
    {
        "id": 1,
        "name": "压缩恢复-全KB图片VLM审计",
        "category": "compaction",
        "difficulty": 5,
        "query": "审计知识库中所有图片文档的VLM描述质量。要求：1)先用wiki_browse获取所有图片文档列表 2)分批expand查看L1内容（每批20个） 3)将每张图片的VLM质量评级写入工作文件 tmp/vlm_audit.md 4)最终统计：空白/模板文本/质量差/质量好的各多少张。注意：图片有179张，分批处理时如果上下文被压缩，先读工作文件恢复进度再继续。严禁遗漏任何一张图片。",
        "ground_truth": "~179 images, must survive multiple compactions",
        "verification": "vlm_audit_completeness",
    },
    {
        "id": 2,
        "name": "压缩恢复-全量文档摘要目录",
        "category": "compaction",
        "difficulty": 5,
        "query": "为知识库中所有243个文档各写一句话摘要，组成完整文档目录。要求：1)先用wiki_browse获取完整文档列表 2)分批expand查看内容（图片用L1，PDF用L0/L1） 3)每批处理完将结果追加到工作文件 tmp/doc_catalog.md 4)按文件夹分组。如果上下文被压缩导致丢失进度，必须先read_file恢复工作文件再继续。最终输出必须覆盖243个文档，一个不漏。",
        "ground_truth": "243 entries required, will need 12+ expand batches",
        "verification": "count_entries",
    },
    {
        "id": 3,
        "name": "压缩恢复-四游戏线索全展开",
        "category": "compaction",
        "difficulty": 5,
        "query": "展开知识库中四个剧本杀游戏的所有线索卡图片（自杀派对40张+追凶手记44张+柯南之死线索+剪烛夜行线索），查看每张线索卡的VLM描述。要求：1)使用expand(docIds=[...])批量展开 2)每批处理后将关键发现写入工作文件 tmp/all_clues.md 3)按游戏分组记录。共100+张线索图片，如果上下文被压缩必须断点续传。最终列出每张线索卡的核心内容。",
        "ground_truth": "100+ clue images across 4 games",
        "verification": "clue_count_completeness",
    },
    {
        "id": 4,
        "name": "压缩恢复-所有学术论文方法提取",
        "category": "compaction",
        "difficulty": 4,
        "query": "阅读知识库中所有16篇学术论文的完整L1内容，提取每篇论文的技术方法。要求：1)先获取PDF文档列表 2)逐一expand每篇论文的L1内容 3)将每篇的方法摘要写入工作文件 tmp/paper_methods.md 4)提取维度：检索策略/知识组织/压缩方法/记忆机制/评估方法。如果上下文被压缩，先读工作文件恢复。最终输出16篇论文的方法对比表。",
        "ground_truth": "16 papers, each needing full L1 expand",
        "verification": "paper_count_completeness",
    },

    # =========================================================================
    # Group B: 超长输出管理 (output exceeds context, needs multi-step)
    # Tests:
    # - push_content(filePath=...) direct push without reading
    # - write_file for working file
    # - Multi-chapter output with resume
    # =========================================================================
    {
        "id": 5,
        "name": "超长输出-全KB结构化详尽报告",
        "category": "long_output",
        "difficulty": 5,
        "query": "生成一份覆盖知识库全部243个文档的详细结构化报告。要求：1)按主题分6章（学术论文、自杀派对、追凶手记、柯南之死、剪烛夜行、其他）2)每章包含该主题下所有文档的详细分析（不能只有一句话）3)每章写完后用push_content推送（不要累积在上下文中）4)写完后push_content推送完整报告文件。预计输出超过2万字，必须分步输出。",
        "ground_truth": "6 chapters, 243 docs, multi-step output required",
        "verification": "chapter_completeness",
    },
    {
        "id": 6,
        "name": "超长输出-四游戏完整人物档案",
        "category": "long_output",
        "difficulty": 5,
        "query": "为四个剧本杀游戏的所有角色建立完整人物档案。要求：1)每个角色必须包含：基本信息、背景故事、关键秘密、与其他角色的关系、涉案动机 2)信息必须来自展开的剧本原文，不能只靠摘要 3)每个游戏一章，写完一章push_content推送 4)自杀派对6人+追凶手记6人+柯南之死8人+剪烛夜行6人=26个角色。输出预计超过1.5万字。",
        "ground_truth": "26 characters, each needing detailed profile from expanded scripts",
        "verification": "character_count",
    },
    {
        "id": 7,
        "name": "超长输出-学术论文深度综述报告",
        "category": "long_output",
        "difficulty": 5,
        "query": "为知识库中16篇学术论文撰写深度综述报告。要求：1)每篇论文详细分析方法（不少于300字）2)按技术路线分4章（检索增强/记忆机制/上下文压缩/注意力架构）3)每章末尾有跨论文对比分析 4)最终章为技术演进趋势和未来方向 5)分章节输出，每章完成后push_content推送。必须阅读每篇论文L1全文，不能只看摘要。",
        "ground_truth": "16 papers deep analysis, 4+ chapters",
        "verification": "paper_coverage",
    },

    # =========================================================================
    # Group C: 工作流引擎压测 (workflow_run multi-agent)
    # Tests:
    # - Task decomposition atomicity
    # - Sub-agent progressive workflow
    # - Direct push from sub-agents
    # - Main agent synthesis without re-reading
    # =========================================================================
    {
        "id": 8,
        "name": "工作流-四剧本杀并行深度分析",
        "category": "workflow",
        "difficulty": 5,
        "query": "使用workflow_run并行分析四个剧本杀游戏。要求：1)每个游戏分配一个子Agent，每个子Agent负责该游戏的所有角色剧本+线索+音频 2)子Agent必须将分析结果写入工作文件并push_content推送 3)主Agent只负责综合各子Agent的结论，不要重复读取子Agent已分析的内容 4)最终输出：四游戏的对比分析（主题/复杂度/推理难度/角色关系复杂度）。",
        "ground_truth": "4 sub-agents, ~130 documents total",
        "verification": "workflow_result",
    },
    {
        "id": 9,
        "name": "工作流-学术论文分主题并行分析",
        "category": "workflow",
        "difficulty": 4,
        "query": "使用workflow_run将16篇学术论文分3组并行分析。分组要求：1)检索增强组(RAG相关)：QA-RAG, Antigravity RAG, xRAG, REPLUG 2)记忆机制组：HippoRAG, Memorizing Transformers, Memory Augmentation等 3)压缩与注意力组：Context Compression, Sentinel Tokens, KIMI LINEAR等。每组子Agent需展开论文全文、提取方法细节、找出组内论文的关联。主Agent综合三组结论，生成技术路线对比。",
        "ground_truth": "3 sub-agents, 16 papers",
        "verification": "workflow_result",
    },
    {
        "id": 10,
        "name": "工作流-金融法律图片信息提取",
        "category": "workflow",
        "difficulty": 4,
        "query": "使用workflow_run分析知识库中所有金融/法律类图片。要求：1)先用wiki_browse找到所有金融法律图片（约19张） 2)启动子Agent批量展开这些图片的L1内容 3)从VLM描述中提取：机构名称、金额、日期、人员姓名、文书类型等关键信息 4)输出结构化的金融法律文档信息汇总表。子Agent必须使用批量expand，不要逐个展开。",
        "ground_truth": "~19 financial/legal images",
        "verification": "financial_doc_completeness",
    },

    # =========================================================================
    # Group D: 搜索完整性 (search tool coverage comparison)
    # Tests:
    # - doc_grep vs kb_search coverage difference
    # - Cross-tool validation
    # - Exhaustive search patterns
    # =========================================================================
    {
        "id": 11,
        "name": "搜索完整性-银行关键词全量对比",
        "category": "search",
        "difficulty": 4,
        "query": "搜索知识库中所有包含\"银行\"关键词的内容。要求：1)先用kb_search搜索\"银行\"，记录返回了多少结果 2)再用doc_grep搜索\"银行\"，记录返回了多少结果 3)对比两者结果，找出kb_search遗漏了哪些文档 4)最后用bash(grep)在磁盘文件中搜索，验证是否还有doc_grep也没搜到的 5)输出三者的覆盖度对比分析。这个测试的目的是验证搜索工具的覆盖差异。",
        "ground_truth": "doc_grep should find more than kb_search",
        "verification": "search_coverage_comparison",
    },
    {
        "id": 12,
        "name": "搜索完整性-人名穷举搜索",
        "category": "search",
        "difficulty": 4,
        "query": "在知识库中搜索以下角色名在哪些文档中出现：丁一、全明欢、刘小军、何小冰、余恩琪。要求：1)每个名字都必须用doc_grep精确搜索（因为kb_search会遗漏） 2)列出每个名字出现的所有文档（包括剧本、线索卡、结局等） 3)验证是否有文档同时包含多个角色名（跨文档关联）。不要用kb_search代替doc_grep。",
        "ground_truth": "each name appears in multiple documents",
        "verification": "name_search_completeness",
    },
    {
        "id": 13,
        "name": "搜索完整性-多工具交叉验证",
        "category": "search",
        "difficulty": 3,
        "query": "分别用三种方式搜索知识库中包含\"死亡\"或\"被害\"关键词的内容：1)kb_search语义搜索 2)doc_grep精确搜索 3)run_sql查询wiki_pages表。对比三种方法的：搜索结果数量、覆盖文档范围、搜索耗时。分析哪种方法最完整，以及各自遗漏了什么。",
        "ground_truth": "three methods should have different coverage",
        "verification": "three_way_comparison",
    },

    # =========================================================================
    # Group E: 跨文档深度关联 (deep cross-document reasoning)
    # Tests:
    # - Multi-step tool chaining
    # - Working file for progressive analysis
    # - Cross-document evidence linking
    # =========================================================================
    {
        "id": 14,
        "name": "跨文档关联-四游戏所有死亡事件汇总",
        "category": "cross_doc",
        "difficulty": 4,
        "query": "汇总四个剧本杀游戏中所有涉及死亡的事件。要求：1)每个游戏展开组织手册和所有角色剧本 2)找出每个游戏的：死者姓名、死因、死亡时间、发现死亡的人、死亡地点 3)跨游戏对比：四个游戏的死亡类型有什么模式？ 4)信息分散在角色剧本、线索卡、卷宗等多种文档中，必须全部展开才能完整回答。",
        "ground_truth": "4 games, each with death events requiring multi-doc reading",
        "verification": "death_event_completeness",
    },
    {
        "id": 15,
        "name": "跨文档关联-全KB人名实体网络",
        "category": "cross_doc",
        "difficulty": 5,
        "query": "从知识库中提取所有出现的人名/角色名，构建人物关系网络。要求：1)学术论文中提取作者名 2)剧本杀中提取所有角色名 3)金融法律文档中提取人名 4)分析是否有跨文档出现的人物（如某论文作者名和游戏角色名相同） 5)输出完整人物清单和关系图谱。必须用doc_grep搜索确认每个名字的出处，不能凭记忆。",
        "ground_truth": "requires reading across all document types",
        "verification": "entity_extraction_completeness",
    },
    {
        "id": 16,
        "name": "跨文档关联-追凶手记完整证据链重建",
        "category": "cross_doc",
        "difficulty": 5,
        "query": "重建追凶手记的完整证据链。需要阅读：6个角色剧本(PDF) + 44张线索卡(图片) + 10张卷宗(图片) + 凶手自白音频(MP3) + 组织手册(PDF) = 62个文档。要求：1)按时间线排列所有证据 2)标注每条证据来自哪个文档 3)标注哪些证据互相矛盾 4)标注哪些证据是关键转折点 5)最终推理：凶手是谁，证据链如何闭合。",
        "ground_truth": "62 documents requiring deep cross-referencing",
        "verification": "evidence_chain_completeness",
    },

    # =========================================================================
    # Group F: 反幻觉与精确性 (anti-hallucination under pressure)
    # Tests:
    # - Agent refuses to fabricate when data is missing
    # - Precise counting vs vague estimates
    # - Cross-verification of claims
    # =========================================================================
    {
        "id": 17,
        "name": "反幻觉-虚构角色陷阱(压力版)",
        "category": "anti_hallucination",
        "difficulty": 4,
        "query": "分析自杀派对游戏的角色关系。特别注意分析以下角色之间的互动：丁一和张三、权明欢和李四、白十三和王五。列出这些角色在剧本中的具体互动场景和对话内容。",
        "ground_truth": "张三/李四/王五不存在，agent必须发现并报告",
        "verification": "no_hallucination_on_fake_names",
    },
    {
        "id": 18,
        "name": "反幻觉-精确计数vs估计",
        "category": "anti_hallucination",
        "difficulty": 3,
        "query": "精确回答以下问题（每个数字必须用run_sql或wiki_browse验证，不允许估计）：1)知识库总共有多少个文档？ 2)PNG图片有多少张？ 3)PDF文件有多少个？ 4)MP3音频有多少个？ 5)文件夹（folder_path去重）有多少个？ 6)wiki_pages表总共有多少条记录？ 列出每个查询的SQL或工具调用过程。",
        "ground_truth": "243 docs, 95 PNG, 46 PDF, 5 MP3, 24 folders, 1037 pages",
        "verification": "exact_counts",
    },
    {
        "id": 19,
        "name": "反幻觉-跨游戏角色混淆陷阱",
        "category": "anti_hallucination",
        "difficulty": 4,
        "query": "分析丁一在追凶手记游戏中的角色。展开追凶手记的所有角色剧本，找出丁一这个角色的剧本，详细分析其背景和动机。",
        "ground_truth": "丁一属于自杀派对, 不在追凶手记中, agent必须发现角色归属错误",
        "verification": "correct_game_attribution",
    },

    # =========================================================================
    # Group G: 大数据处理 (large data handling via run_sql/bash)
    # Tests:
    # - run_sql for large datasets
    # - bash python3 for programmatic analysis
    # - Token budget management for large documents
    # =========================================================================
    {
        "id": 20,
        "name": "大数据-运动员数据集多维度分析",
        "category": "large_data",
        "difficulty": 4,
        "query": "分析athlete_events.xlsx数据集（27万行）。要求：1)先用run_sql查询数据集的行数、列名、年份范围 2)查询：金牌数前10的国家 3)查询：中国历届金牌数变化趋势 4)查询：年龄最大的运动员和年龄最小的运动员 5)查询：参赛运动员数增长最快的3届奥运会。所有查询必须用run_sql执行，不能用估计值。",
        "ground_truth": "271117 rows, specific SQL queries required",
        "verification": "sql_query_results",
    },
    {
        "id": 21,
        "name": "大数据-tokenBudget大文档浏览",
        "category": "large_data",
        "difficulty": 3,
        "query": "知识库中最大的PDF文档是什么？请先用run_sql查询wiki_pages表找出token_count最大的前5个页面。然后对最大的文档使用expand(tokenBudget=2000)快速浏览，总结其主要内容。验证tokenBudget参数是否生效（返回内容不应超过约2000 tokens）。",
        "ground_truth": "should use tokenBudget to control output size",
        "verification": "token_budget_effectiveness",
    },

    # =========================================================================
    # Group H: 多模态协调 (multi-modal tool coordination)
    # Tests:
    # - Image VLM content via expand L1
    # - Audio ASR content via expand L1
    # - Video frame/ASR status handling
    # - Cross-modal information synthesis
    # =========================================================================
    {
        "id": 22,
        "name": "多模态-自杀派对全文件展开",
        "category": "multimodal",
        "difficulty": 5,
        "query": "完整展开自杀派对游戏的全部文件（约74个文档）：6个角色剧本(PDF) + 6封信件(图片) + 7张封面(图片) + 40张线索(图片) + 13张结局(图片) + 3段音频(MP3) + 1个视频(MP4) + 2个组织手册(PDF)。要求：1)先用wiki_browse获取完整列表 2)按文件类型分批expand（PDF批、图片批、音频批） 3)每批将发现写入工作文件 4)最终生成该游戏的完整资料汇编。必须覆盖所有74个文件。",
        "ground_truth": "~74 files across PDF/image/audio/video",
        "verification": "file_coverage_completeness",
    },
    {
        "id": 23,
        "name": "多模态-音频内容与文本交叉验证",
        "category": "multimodal",
        "difficulty": 4,
        "query": "展开追凶手记游戏的凶手自白音频(MP3)的L1内容，同时展开该游戏的组织手册(PDF)。验证：1)音频ASR转写的内容与组织手册中描述的真相是否一致 2)音频中提到了哪些具体细节（人名、时间、地点）3)组织手册中是否有音频未提到的额外信息。这测试的是跨模态信息的交叉验证能力。",
        "ground_truth": "MP3 ASR vs PDF text comparison",
        "verification": "cross_modal_consistency",
    },
    {
        "id": 24,
        "name": "多模态-批量图片expand与直接推送",
        "category": "multimodal",
        "difficulty": 3,
        "query": "展开自杀派对「信」文件夹的6封信件图片和「封面」文件夹的7张封面图片的L1内容（共13张）。要求使用expand的docIds数组参数批量展开。展开后，对每张图片写一句摘要，然后将完整结果用push_content推送。这个测试验证：1)批量expand是否返回所有图片的VLM描述 2)图片VLM描述是否为空。",
        "ground_truth": "13 images, all should have non-empty VLM descriptions",
        "verification": "batch_expand_completeness",
    },

    # =========================================================================
    # Group I: 渐进式工作流与断点续传 (progressive workflow)
    # Tests:
    # - Working file write + read for checkpoint
    # - Compaction recovery
    # - Non-redundant processing
    # =========================================================================
    {
        "id": 25,
        "name": "渐进式-分批处理所有PDF",
        "category": "progressive",
        "difficulty": 4,
        "query": "展开知识库中所有46个PDF文档的L1内容，为每个PDF写100字摘要。要求采用渐进式方法：1)先获取所有PDF文档列表 2)每次expand 10个PDF的L1内容 3)每批处理完后，将摘要追加到工作文件 tmp/pdf_summaries.md 4)如果上下文被压缩，读工作文件确认已处理的文档，只继续处理未完成的部分 5)最终确认46个PDF全覆盖。",
        "ground_truth": "46 PDFs, must use working file + batch expand",
        "verification": "pdf_coverage_completeness",
    },
    {
        "id": 26,
        "name": "渐进式-分批处理追凶手记全部线索",
        "category": "progressive",
        "difficulty": 4,
        "query": "展开追凶手记游戏的44张线索卡图片和10张卷宗图片（共54张）的L1内容。要求：1)先用wiki_browse获取线索和卷宗的文档ID列表 2)每次expand(docIds=[...])批量展开10-15张 3)每批将关键发现写入工作文件 tmp/chaser_clues.md 4)标注哪些线索指向同一事件 5)如果上下文被压缩，从工作文件恢复进度。严禁重复展开已处理的图片。",
        "ground_truth": "54 images, 4 batches, working file checkpoint",
        "verification": "clue_batch_completeness",
    },

    # =========================================================================
    # Group J: 不合理挑战 (unreasonable/extreme edge cases)
    # Tests framework limits, error handling, and graceful degradation
    # =========================================================================
    {
        "id": 27,
        "name": "极端-全KB跨域关联发现",
        "category": "extreme",
        "difficulty": 5,
        "query": "找出知识库中所有文档之间的文本级关联。要求：1)提取学术论文中的所有人名、机构名、技术术语 2)提取剧本杀中的所有人名、地名、关键物品 3)提取金融法律文档中的机构名、金额、人名 4)检查这些实体是否有跨文档重复出现 5)输出所有确实存在的跨域关联。必须用doc_grep验证每个关联，不能凭记忆猜测。",
        "ground_truth": "cross-domain entity matching, doc_grep verified",
        "verification": "cross_domain_verified",
    },
    {
        "id": 28,
        "name": "极端-零结果查询处理",
        "category": "extreme",
        "difficulty": 2,
        "query": "依次执行以下搜索，记录每个查询的结果数量：1)kb_search('量子计算') 2)doc_grep('区块链') 3)kb_search('恐龙化石') 4)doc_grep('火星探测') 5)run_sql(\"SELECT COUNT(*) FROM documents WHERE filename LIKE '%加密%'\")。每个查询都应该返回0结果。如果任何查询返回了结果，请验证该结果是否真实。",
        "ground_truth": "all should return 0 results",
        "verification": "zero_result_accuracy",
    },
    {
        "id": 29,
        "name": "极端-错误文档恢复能力",
        "category": "extreme",
        "difficulty": 3,
        "query": "尝试展开以下文档：1)test_audio.wav（已知error状态） 2)任意一个视频文件（已知帧分析失败） 3)一个正常的PDF文档。对比三者的expand结果，说明：error文档expand返回了什么？视频文档的VLM/ASR内容状态如何？正常文档是否完整？这测试框架对错误文档的优雅降级。",
        "ground_truth": "error doc should return error info, not crash",
        "verification": "error_handling",
    },
    {
        "id": 30,
        "name": "极端-重复与矛盾检测",
        "category": "extreme",
        "difficulty": 4,
        "query": "检查知识库中是否存在以下问题：1)重复文档（相同内容的不同文件）2)同一文档的多次处理记录 3)wiki_pages中内容矛盾的记录。要求：1)用run_sql查询是否有重复filename 2)用run_sql查询同一doc_id下是否有多个相同page_type的记录 3)如果发现重复，展开对比内容是否真的一致。输出问题清单和修复建议。",
        "ground_truth": "should detect duplicate DeepSieve paper if present",
        "verification": "duplicate_detection",
    },
]


# =============================================================================
# API Helpers
# =============================================================================

def api_request(method, path, data=None, timeout=600):
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def create_session(title="Stress test"):
    result = api_request("POST", "/api/sessions", {
        "title": title,
        "kbScope": [KB_ID],
    })
    if "error" in result:
        print(f"  ERROR creating session: {result['error']}")
        return None
    return result.get("id")


def run_agent_streaming(session_id, query, timeout=600):
    """Run agent via SSE streaming, collecting all events."""
    url = f"{BASE_URL}/api/agents/run-stream"
    body = json.dumps({
        "sessionId": session_id,
        "input": query,
    }).encode()

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")

    events = []
    output_text = ""
    tool_calls = []
    push_contents = []
    compaction_events = []
    turns_used = 0
    total_input_tokens = 0
    total_output_tokens = 0
    status = "unknown"
    task_id = None
    start_time = time.time()

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            event_type = None
            data_buf = ""
            for raw_line in resp:
                elapsed = time.time() - start_time
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
                if line.startswith(":"):
                    continue  # keepalive
                if line.startswith("event: "):
                    event_type = line[7:].strip()
                elif line.startswith("data: "):
                    data_buf += line[6:]
                elif line == "":
                    if event_type and data_buf:
                        try:
                            event_data = json.loads(data_buf)
                        except json.JSONDecodeError:
                            event_data = {"raw": data_buf}

                        events.append({"type": event_type, "data": event_data, "elapsed": round(elapsed, 1)})

                        if event_type == "start":
                            task_id = event_data.get("taskId")
                        elif event_type == "content_delta":
                            output_text += event_data.get("delta", "")
                        elif event_type == "tool_call":
                            tool_calls.append({
                                "tool": event_data.get("toolName"),
                                "status": event_data.get("status"),
                                "input_preview": str(event_data.get("input", ""))[:200],
                            })
                        elif event_type == "tool_result":
                            if tool_calls:
                                tool_calls[-1]["output_preview"] = str(event_data.get("output", ""))[:200]
                        elif event_type == "push_content":
                            push_contents.append({
                                "type": event_data.get("type"),
                                "title": event_data.get("title"),
                                "data_length": event_data.get("dataLength"),
                            })
                        elif event_type == "compaction":
                            compaction_events.append(event_data)
                        elif event_type == "turn":
                            turns_used = event_data.get("turn", turns_used + 1)
                        elif event_type == "turn_usage":
                            usage = event_data.get("usage", {})
                            total_input_tokens += usage.get("inputTokens", 0)
                            total_output_tokens += usage.get("outputTokens", 0)
                        elif event_type == "done":
                            status = event_data.get("status", status)
                            turns_used = event_data.get("turnsUsed", turns_used)
                            # Don't override accumulated output - content_delta has full text
                            # The done event's output field may be truncated or just the last turn

                    event_type = None
                    data_buf = ""
    except Exception as e:
        status = "error"
        output_text += f"\n\n[STREAM ERROR: {str(e)}]"

    elapsed = round(time.time() - start_time, 1)

    return {
        "status": status,
        "task_id": task_id,
        "output": output_text,
        "tool_calls": tool_calls,
        "push_contents": push_contents,
        "compaction_events": compaction_events,
        "turns_used": turns_used,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "elapsed_seconds": elapsed,
        "event_count": len(events),
    }


# =============================================================================
# Test Runner
# =============================================================================

def run_single_test(test_case):
    """Run a single test case and return results."""
    tc_id = test_case["id"]
    name = test_case["name"]
    query = test_case["query"]
    category = test_case["category"]
    difficulty = test_case["difficulty"]

    print(f"\n{'='*70}")
    print(f"Test #{tc_id}: {name} [{category}] difficulty={difficulty}")
    print(f"{'='*70}")
    print(f"Query: {query[:120]}...")

    # Create fresh session for each test
    session_id = create_session(f"Stress test #{tc_id}: {name}")
    if not session_id:
        return {
            "id": tc_id,
            "name": name,
            "category": category,
            "difficulty": difficulty,
            "query": query,
            "ground_truth": test_case.get("ground_truth", ""),
            "status": "session_error",
            "error": "Failed to create session",
            "elapsed_seconds": 0,
        }

    print(f"Session: {session_id}")

    # Run the agent
    result = run_agent_streaming(session_id, query, timeout=900)  # 15 min max

    # Build result record
    record = {
        "id": tc_id,
        "name": name,
        "category": category,
        "difficulty": difficulty,
        "query": query,
        "ground_truth": test_case.get("ground_truth", ""),
        "session_id": session_id,
        "status": result["status"],
        "output": result["output"],
        "output_length": len(result["output"]),
        "tool_calls": result["tool_calls"],
        "tool_call_count": len(result["tool_calls"]),
        "tool_names": list(dict.fromkeys(tc["tool"] for tc in result["tool_calls"])),
        "push_contents": result["push_contents"],
        "push_count": len(result["push_contents"]),
        "compaction_events": result["compaction_events"],
        "compaction_count": len(result["compaction_events"]),
        "turns_used": result["turns_used"],
        "total_input_tokens": result["total_input_tokens"],
        "total_output_tokens": result["total_output_tokens"],
        "elapsed_seconds": result["elapsed_seconds"],
        "event_count": result["event_count"],
    }

    # Print summary
    print(f"\n--- Result ---")
    print(f"Status: {record['status']}")
    print(f"Time: {record['elapsed_seconds']}s | Turns: {record['turns_used']} | "
          f"Tools: {record['tool_call_count']} calls ({', '.join(record['tool_names'])})")
    print(f"Tokens: {record['total_input_tokens']}in / {record['total_output_tokens']}out")
    print(f"Push: {record['push_count']} | Compaction: {record['compaction_count']}")
    print(f"Output length: {record['output_length']} chars")
    if record['output']:
        preview = record['output'][:500].replace('\n', ' ')
        print(f"Output preview: {preview}...")

    return record


def run_tests(test_ids):
    """Run specified tests and save results."""
    os.makedirs(RESULTS_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    results = []
    test_map = {tc["id"]: tc for tc in TEST_CASES}

    for tid in test_ids:
        tc = test_map.get(tid)
        if not tc:
            print(f"Test #{tid} not found, skipping")
            continue

        record = run_single_test(tc)
        results.append(record)

        # Save intermediate results after each test
        result_file = os.path.join(RESULTS_DIR, f"run_{timestamp}.json")
        with open(result_file, "w", encoding="utf-8") as f:
            json.dump({
                "timestamp": timestamp,
                "total_tests": len(test_ids),
                "completed": len(results),
                "results": results,
            }, f, ensure_ascii=False, indent=2)

    # Print final summary
    print(f"\n{'='*70}")
    print(f"FINAL SUMMARY ({len(results)} tests)")
    print(f"{'='*70}")
    print(f"{'ID':>3} {'Name':<30} {'Cat':<15} {'Diff':>3} {'Status':<12} {'Time':>6} {'Turns':>5} {'Tools':>5}")
    print(f"{'-'*3} {'-'*30} {'-'*15} {'-'*3} {'-'*12} {'-'*6} {'-'*5} {'-'*5}")
    for r in results:
        print(f"{r['id']:>3} {r['name']:<30} {r['category']:<15} {r['difficulty']:>3} "
              f"{r['status']:<12} {r.get('elapsed_seconds',0):>5.0f}s "
              f"{r.get('turns_used',0):>5} {r.get('tool_call_count',0):>5}")

    # Category breakdown
    cats = {}
    for r in results:
        cat = r["category"]
        if cat not in cats:
            cats[cat] = {"count": 0, "total_time": 0, "total_turns": 0, "total_tools": 0}
        cats[cat]["count"] += 1
        cats[cat]["total_time"] += r.get("elapsed_seconds", 0)
        cats[cat]["total_turns"] += r.get("turns_used", 0)
        cats[cat]["total_tools"] += r.get("tool_call_count", 0)

    print(f"\nCategory breakdown:")
    for cat, stats in sorted(cats.items()):
        print(f"  {cat:<20} {stats['count']} tests, {stats['total_time']:.0f}s total, "
              f"{stats['total_turns']} turns, {stats['total_tools']} tool calls")

    return results


def analyze_results(result_file):
    """Analyze a results file and print detailed findings."""
    with open(result_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    results = data["results"]
    print(f"Analyzing {len(results)} test results from {result_file}")

    # Quality indicators
    issues = []
    for r in results:
        rid = r["id"]
        name = r["name"]

        # Check for errors
        if r["status"] not in ("completed", "done"):
            issues.append(f"  #{rid} {name}: status={r['status']}")

        # Check for excessive turns
        if r.get("turns_used", 0) > 40:
            issues.append(f"  #{rid} {name}: excessive turns ({r['turns_used']})")

        # Check for compaction
        if r.get("compaction_count", 0) > 2:
            issues.append(f"  #{rid} {name}: {r['compaction_count']} compactions (context pressure)")

        # Check for duplicate tool calls
        tool_calls = r.get("tool_calls", [])
        expand_calls = [tc for tc in tool_calls if tc.get("tool") == "expand"]
        if len(expand_calls) > 15:
            issues.append(f"  #{rid} {name}: {len(expand_calls)} expand calls (inefficient?)")

        # Check for no tool usage (might indicate hallucination)
        if len(tool_calls) == 0:
            issues.append(f"  #{rid} {name}: ZERO tool calls (likely hallucinated answer)")

        # Check for very short output
        if r.get("output_length", 0) < 100:
            issues.append(f"  #{rid} {name}: very short output ({r['output_length']} chars)")

    if issues:
        print(f"\n⚠️ Issues found ({len(issues)}):")
        for issue in issues:
            print(issue)
    else:
        print("\n✓ No obvious issues detected")

    # Tool usage patterns
    tool_usage = {}
    for r in results:
        for tc in r.get("tool_calls", []):
            tool = tc.get("tool", "unknown")
            if tool not in tool_usage:
                tool_usage[tool] = 0
            tool_usage[tool] += 1

    print(f"\nTool usage across all tests:")
    for tool, count in sorted(tool_usage.items(), key=lambda x: -x[1]):
        print(f"  {tool:<25} {count:>4} calls")


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print(f"  {sys.argv[0]} 1 5 10           # Run specific tests")
        print(f"  {sys.argv[0]} --batch 1        # Run batch 1 (1-10)")
        print(f"  {sys.argv[0]} --batch 2        # Run batch 2 (11-20)")
        print(f"  {sys.argv[0]} --batch 3        # Run batch 3 (21-30)")
        print(f"  {sys.argv[0]} --all             # Run all 30 tests")
        print(f"  {sys.argv[0]} --analyze FILE    # Analyze results")
        sys.exit(1)

    if sys.argv[1] == "--analyze":
        if len(sys.argv) < 3:
            print("Please specify results file to analyze")
            sys.exit(1)
        analyze_results(sys.argv[2])
    elif sys.argv[1] == "--all":
        run_tests(list(range(1, 31)))
    elif sys.argv[1] == "--batch":
        batch_num = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        start = (batch_num - 1) * 10 + 1
        end = start + 10
        run_tests(list(range(start, end)))
    else:
        test_ids = [int(x) for x in sys.argv[1:]]
        run_tests(test_ids)
