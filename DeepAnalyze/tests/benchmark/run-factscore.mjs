#!/usr/bin/env node
// =============================================================================
// FActScore Benchmark Runner
// Runs FActScore fact-verification tests via DA's /run-stream endpoint
// Strict 100-point scoring per test
// Usage:
//   node run-factscore.mjs                    # Run all 10 FActScore tests
//   node run-factscore.mjs --ids FAct-01,FAct-02  # Run specific tests
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = 'http://localhost:21000';
const RESULTS_DIR = path.resolve(import.meta.dirname, 'iteration-results', 'factscore');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ─── FActScore Test Cases ─────────────────────────────────────────────────
const FACTSCORE_TESTS = [
  {
    id: "FAct-01",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Kazuo Ishiguro OBE (born 8 November 1954) is a British novelist, born in Nagasaki, Japan; his family moved to England in 1960. Yukio Mishima (1925-1970) is a Japanese author, poet, playwright who is considered one of the most important Japanese authors of the 20th century. He was active as a nationalist and founded his own right-wing militia.

问题：Did Kazuo Ishiguro and Yukio Mishima both move from Japan to England?
待验证答案：Yes, Kazuo Ishiguro and Yukio Mishima both moved to England for their education.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "no",
    expectedAnalysis: "石黑一雄确实从日本移居英格兰（1960年），但三岛由纪夫从未移居英格兰——他是日本民族主义者，一生主要在日本。待验证答案错误。",
  },
  {
    id: "FAct-02",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Guy "Arc Angel" Waters is an Australian professional boxer who won multiple titles including OPBF light heavyweight and Commonwealth light heavyweight. Virgil Eugene Hill (born January 18, 1964) is an American former professional boxer, a two-weight world champion who held the WBA light heavyweight title twice.

问题：Guy Walters competed against which former professional boxer that is a two-weight world champion?
待验证答案：Guy Walters competed against Mike Tyson.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "Virgil Hill",
    expectedAnalysis: "根据知识，Guy Waters是澳大利亚拳击手，Virgil Hill是双量级世界冠军。待验证答案说Mike Tyson是错误的，正确答案应该是Virgil Hill。",
  },
  {
    id: "FAct-03",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Around 1830, charismatic experiences such as speaking in tongues were reported in the parish of Rosneath. John Nelson Darby and Benjamin Wills Newton were sent by the Plymouth Brethren to investigate these events. Darby (1800-1882) was the founder of the Exclusive Brethren.

问题：Apart from the founder of the Exclusive Brethren, what is the name of the second person who was sent by the Plymouth Brethren to investigate the outbreak of supernatural gifts of the Holy Spirit in Scotland?
待验证答案：The founder of the Exclusive Brethren was the only person sent by the Plymouth Brethren to investigate.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "Benjamin Wills Newton",
    expectedAnalysis: "根据知识，被派去调查的两人是John Nelson Darby和Benjamin Wills Newton。Darby是Exclusive Brethren的创始人，所以除了他之外的另一个人是Benjamin Wills Newton。待验证答案错误。",
  },
  {
    id: "FAct-04",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：BBMak (Barry, Burns, McNally) were an English pop/rock group. The band guest starred on ABC's "All My Children" in 2000. Moonbabies is a Swedish duo formed in 1997 by Ola Frick and Carina Johansson.

问题：Who guest starred on All My Children, BBMak or Moonbabies?
待验证答案：Moonbabies guest starred on All My Children.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "BBMak",
    expectedAnalysis: "根据知识，BBMak客串出演了All My Children（2000年），而非Moonbabies。待验证答案错误。",
  },
  {
    id: "FAct-05",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：William Joseph Toti (born 1957) is a retired US Navy captain who was the final captain of USS Indianapolis (SSN-697). Charles B. McVay III (1898-1968) was the commanding officer of USS Indianapolis (CA-35) when it was lost in action in 1945. McVay was court-martialed for losing the ship but was posthumously exonerated in 2000.

问题：Name the World War II cruiser whose captain was court-martialed for losing it in action in 1945 and was later exonerated through efforts by William Joseph Toti.
待验证答案：William Joseph Toti was the captain of the USS Indianapolis, which was lost in action in 1945.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "USS Indianapolis",
    expectedAnalysis: "问题问的是巡洋舰的名字。CA-35是二战巡洋舰，其舰长McVay因沉船被军事法庭审判。Toti是SSN-697（潜艇）的最后一任舰长，后来为McVay平反。待验证答案把两艘USS Indianapolis搞混了，但正确答案就是USS Indianapolis (CA-35)。",
  },
  {
    id: "FAct-06",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Martin & Orloff is a 2002 film written by and starring Matt Walsh and Ian Roberts. The film features David Cross. David Cross is known for his role as Tobias Funke in "Arrested Development" and voiced Crane in the "Kung Fu Panda" film franchise.

问题：Martin & Orloff is a film featuring a cast member who also voiced Crane in what film franchise?
待验证答案：David Cross played a prominent role in Martin & Orloff and also voiced a character in Kung Fu Panda.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "Kung Fu Panda",
    expectedAnalysis: "David Cross出演了Martin & Orloff，并为Kung Fu Panda中的Crane配音。问题问的是'what film franchise'，答案是Kung Fu Panda。待验证答案虽然没有明确说错，但没有直接回答问题，说了'voiced a character in Kung Fu Panda'而不是直接说Kung Fu Panda。应该算部分正确。",
  },
  {
    id: "FAct-07",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Travis is a Scottish rock band formed in Glasgow in 1990. Shiny Toy Guns is an American rock band that formed in 2002 in Los Angeles, California.

问题：Are the rock bands Travis and Shiny Toy Guns from the same country?
待验证答案：Travis and Shiny Toy Guns have different origin countries.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "no",
    expectedAnalysis: "Travis来自苏格兰（英国），Shiny Toy Guns来自美国。它们确实来自不同国家。所以答案是'no, they are not from the same country'。待验证答案'have different origin countries'实质上正确。",
  },
  {
    id: "FAct-08",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Freddie Highmore (born 14 February 1992) is an English actor who starred in "August Rush" (2007). August Rush is a 2007 American drama film that concludes with a major instrumental composition called "August's Rhapsody".

问题：The film "August Rush" both stars actor Freddie Highmore and concludes with a major instrumental composition under what name?
待验证答案："August's Symphony of Dreams"

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "August's Rhapsody",
    expectedAnalysis: "根据知识，该器乐作品名为'August's Rhapsody'。待验证答案'August's Symphony of Dreams'是错误的。",
  },
  {
    id: "FAct-09",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Zootopia is a 2016 American animated comedy-adventure film by Walt Disney. Stylianos "Stelios" Kyriakides (1910-1987) was a marathon runner who won the Boston Marathon in 1946.

问题：Which has more to do with the Boston Marathon, Zootopia or Stylianos Kyriakides?
待验证答案：Zootopia has a deep connection to the Boston Marathon.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "Stylianos Kyriakides",
    expectedAnalysis: "Stylianos Kyriakides是1946年波士顿马拉松冠军，与波士顿马拉松直接相关。Zootopia是迪士尼动画电影，与波士顿马拉松无关。待验证答案完全错误。",
  },
  {
    id: "FAct-10",
    benchmark: "FActScore",
    category: "事实核查-复杂知识",
    question: `请基于以下知识判断问题的答案是否正确。如果给出的答案有误，请指出正确答案。

知识：Andre Thysse is a South African professional boxer who challenged for multiple titles. Mikkel Kessler (born 1 March 1979) is a Danish professional boxer. Thysse challenged Kessler for the World Boxing Council International super middleweight title.

问题：What is the nationality of the man who Andre Thysse challenged for the World Boxing Council International super middleweight title?
待验证答案：Andry Thysse challenged an Irish boxer.

请判断这个答案是否正确，给出你的分析过程和最终结论。`,
    expectedAnswer: "Danish",
    expectedAnalysis: "根据知识，Thysse挑战的是Mikkel Kessler，他是Danish（丹麦）拳击手。待验证答案说是Irish（爱尔兰）是错误的。",
  },
];

// ─── Parse CLI args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const idsArg = getArg('--ids');

let tests = FACTSCORE_TESTS;
if (idsArg) {
  const ids = idsArg.split(',');
  tests = FACTSCORE_TESTS.filter(t => ids.includes(t.id));
}
console.log(`Running ${tests.length} FActScore tests`);

// ─── Helpers ──────────────────────────────────────────────────────────────
async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await resp.json();
  return data.id;
}

async function deleteSession(sessionId) {
  await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
}

function parseSSEEvents(body) {
  const events = [];
  const lines = body.split('\n');
  let currentEvent = null;
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = { type: line.slice(7).trim(), data: {} };
    } else if (line.startsWith('data: ') && currentEvent) {
      try {
        currentEvent.data = JSON.parse(line.slice(6));
      } catch {
        currentEvent.data = { raw: line.slice(6) };
      }
    } else if (line === '' && currentEvent) {
      events.push(currentEvent);
      currentEvent = null;
    }
  }
  return events;
}

// ─── Scoring ──────────────────────────────────────────────────────────────
function scoreAnswer(test, agentOutput) {
  const text = (agentOutput || '').toLowerCase();
  const expected = test.expectedAnswer.toLowerCase();

  // 1. Did the agent correctly identify if the candidate answer was right or wrong?
  //    Most FActScore tests have WRONG candidate answers
  const candidateWrong = test.expectedAnalysis.includes('待验证答案错误') ||
                          test.expectedAnalysis.includes('待验证答案完全错误');
  const candidateCorrect = !candidateWrong;

  let score = 0;
  const details = [];

  // Check if agent gave the correct expected answer (fuzzy matching)
  const answerCorrect = checkAnswerMatch(text, expected, test.expectedAnswer);
  if (answerCorrect) {
    score += 40;
    details.push('+40 答案正确');
  } else {
    details.push('+0 答案不正确');
  }

  // Check if agent correctly judged the candidate answer
  if (candidateWrong) {
    if (text.includes('错误') || text.includes('不正确') || text.includes('wrong') ||
        text.includes('incorrect') || text.includes('不是') || text.includes('否定') ||
        text.includes('不成立') || text.includes('❌')) {
      score += 30;
      details.push('+30 正确判断候选答案错误');
    } else {
      details.push('+0 未正确判断候选答案错误');
    }
  } else {
    if (text.includes('正确') || text.includes('对的') || text.includes('correct') ||
        text.includes('right') || text.includes('成立') || text.includes('✅') ||
        text.includes('一致')) {
      score += 30;
      details.push('+30 正确判断候选答案正确');
    } else {
      details.push('+0 未正确判断候选答案正确');
    }
  }

  // Check if agent provided analysis/reasoning
  if (text.length > 100) {
    score += 15;
    details.push('+15 有分析过程');
  } else {
    details.push('+0 缺少分析过程');
  }

  // Check if key entities from the knowledge were referenced
  const knowledgeKeywords = test.question.split('知识：')[1]?.split('\n')[0]?.split(/[\s,;.]/) || [];
  const keyEntities = knowledgeKeywords.filter(w => w.length > 4 && /^[A-Z]/.test(w));
  let entityHits = 0;
  for (const entity of keyEntities.slice(0, 5)) {
    if (text.includes(entity.toLowerCase())) entityHits++;
  }
  if (entityHits >= 2) {
    score += 15;
    details.push(`+15 引用了知识中的关键实体 (${entityHits}/${keyEntities.slice(0, 5).length})`);
  } else if (entityHits >= 1) {
    score += 8;
    details.push(`+8 部分引用了知识中的实体 (${entityHits}/${keyEntities.slice(0, 5).length})`);
  } else {
    details.push('+0 未引用知识中的关键实体');
  }

  return { score: Math.min(100, score), details };
}

// Fuzzy answer matching — handles partial names, "no" equivalents, etc.
function checkAnswerMatch(text, expectedLower, expectedOriginal) {
  // Direct substring match
  if (text.includes(expectedLower)) return true;

  // For "no" answers — check various formulations
  if (expectedLower === 'no') {
    return text.includes('不正确') || text.includes('错误') || text.includes('不是') ||
           text.includes('incorrect') || text.includes('wrong') || text.includes('不是') ||
           text.includes('不同') || text.includes('different') || text.includes('not from the same');
  }

  // For "yes" answers
  if (expectedLower === 'yes') {
    return text.includes('正确') || text.includes('对的') || text.includes('correct') ||
           text.includes('同') || text.includes('same');
  }

  // For name answers — split into parts and check if all parts are present
  // e.g., "Virgil Hill" → check "virgil" AND "hill"
  const parts = expectedLower.split(/\s+/);
  if (parts.length >= 2) {
    const allPartsPresent = parts.every(p => p.length > 2 && text.includes(p));
    if (allPartsPresent) return true;
    // Also check if any significant part appears with the answer context
    const significantParts = parts.filter(p => p.length > 3);
    if (significantParts.length > 0 && significantParts.every(p => text.includes(p))) return true;
  }

  return false;
}

// ─── Run single test ──────────────────────────────────────────────────────
async function runTest(test) {
  const result = {
    testId: test.id,
    category: test.category,
    expectedAnswer: test.expectedAnswer,
    agentOutput: '',
    score: 0,
    scoreDetails: [],
    status: 'pending',
    toolCalls: [],
    turnsUsed: 0,
    durationMs: 0,
    sessionId: null,
    error: null,
  };

  const sessionId = await createSession(`FActScore-${test.id}`);
  result.sessionId = sessionId;
  console.log(`  Session: ${sessionId}`);

  const startTime = Date.now();

  try {
    const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        input: test.question,
      }),
    });

    if (!resp.ok) {
      result.error = `HTTP ${resp.status}`;
      result.status = 'error';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const body = await resp.text();
    const events = parseSSEEvents(body);

    const toolCallMap = new Map();
    let output = '';
    let finishSummary = '';

    for (const event of events) {
      switch (event.type) {
        case 'content':
        case 'content_delta':
          if (event.data.accumulated) {
            output = event.data.accumulated;
          } else if (event.data.delta) {
            output += event.data.delta;
          } else if (event.data.content) {
            output = event.data.content;
          }
          break;

        case 'tool_call': {
          const tc = {
            toolName: event.data.toolName,
            input: event.data.input || {},
          };
          toolCallMap.set(event.data.id, tc);
          break;
        }

        case 'tool_result': {
          const existing = toolCallMap.get(event.data.id);
          if (existing) {
            existing.output = (event.data.output || '').slice(0, 500);
            result.toolCalls.push(existing);
            if (existing.toolName === 'finish') {
              try {
                const parsed = JSON.parse(event.data.output || '{}');
                finishSummary = parsed.summary || '';
              } catch {}
            }
          }
          break;
        }

        case 'done':
          result.turnsUsed = event.data.turnsUsed || 0;
          if (event.data.output) {
            output = event.data.output;
          }
          break;

        case 'error':
          result.error = event.data.error;
          break;
      }
    }

    // Determine the best answer source:
    // For FActScore, we want the full analysis, so prefer longer output
    // But if finish summary has useful content, include it
    let finalOutput;
    if (finishSummary && finishSummary.trim().length > 0) {
      // Combine both — use finish summary as the answer prefix, output as analysis
      finalOutput = finishSummary + '\n\n' + output;
    } else {
      finalOutput = output;
    }

    result.agentOutput = finalOutput;
    result.durationMs = Date.now() - startTime;

    // Score the answer
    const { score, details } = scoreAnswer(test, finalOutput);
    result.score = score;
    result.scoreDetails = details;
    result.status = 'evaluated';

  } catch (err) {
    result.error = err.message;
    result.status = 'error';
    result.durationMs = Date.now() - startTime;
  }

  await deleteSession(sessionId).catch(() => {});
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────
const results = [];
let totalScore = 0;

for (let i = 0; i < tests.length; i++) {
  const test = tests[i];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${i + 1}/${tests.length}] ${test.id} | ${test.category}`);
  console.log(`Expected: ${test.expectedAnswer}`);
  console.log(`${'='.repeat(60)}`);

  const result = await runTest(test);
  results.push(result);
  totalScore += result.score;

  console.log(`  Score: ${result.score}/100`);
  for (const d of result.scoreDetails) {
    console.log(`    ${d}`);
  }
  console.log(`  Output length: ${result.agentOutput.length} chars`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.error) console.log(`  Error: ${result.error}`);

  // Save incremental
  const summary = {
    timestamp: new Date().toISOString(),
    totalTests: results.length,
    avgScore: (totalScore / results.length).toFixed(1),
    results,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2));
}

// ─── Final summary ────────────────────────────────────────────────────────
const avgScore = results.length > 0 ? totalScore / results.length : 0;
const perfectScores = results.filter(r => r.score >= 100).length;

console.log(`\n${'='.repeat(60)}`);
console.log('FACTSCORE RESULTS');
console.log(`${'='.repeat(60)}`);
console.log(`Total: ${results.length} | Avg Score: ${avgScore.toFixed(1)}/100 | Perfect (100): ${perfectScores}/${results.length}`);

for (const r of results) {
  const mark = r.score >= 100 ? 'PERFECT' : r.score >= 80 ? 'GOOD' : r.score >= 50 ? 'PARTIAL' : 'FAIL';
  console.log(`  [${mark}] ${r.testId}: ${r.score}/100`);
}

// Details for non-perfect scores
const imperfect = results.filter(r => r.score < 100);
if (imperfect.length > 0) {
  console.log(`\nNon-perfect tests:`);
  for (const r of imperfect) {
    console.log(`  ${r.testId} (${r.score}/100):`);
    for (const d of r.scoreDetails) {
      console.log(`    ${d}`);
    }
  }
}

// Save final
const finalFile = `factscore-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(path.join(RESULTS_DIR, finalFile), JSON.stringify({
  timestamp: new Date().toISOString(),
  avgScore: avgScore.toFixed(1),
  perfectScores,
  totalTests: results.length,
  results,
}, null, 2));
console.log(`\nFinal results saved: ${finalFile}`);
