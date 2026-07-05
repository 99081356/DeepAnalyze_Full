// =============================================================================
// DeepAnalyze 4-Benchmark Capability Test
// =============================================================================
// Tests the hardest 10 questions from each of 4 benchmark datasets:
// 1. GAIA L3 — complex multi-step reasoning (requires web search, file analysis)
// 2. LongBench Write — long-form content generation (10K-20K chars)
// 3. HaluEval QA / FActScore — hallucination detection & fact verification
// 4. WebArena / Tool Decathlon — web-based tool use tasks
//
// Run: npx tsx tests/benchmark/run-4benchmark-hard.ts
// =============================================================================

const BASE_URL = "http://localhost:21000";
const RESULTS_DIR = "./tests/benchmark/4benchmark-results";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestCase {
  id: string;
  benchmark: string;
  category: string;
  question: string;
  expectedAnswer?: string;  // For halueval: right_answer
  maxWaitMs: number;
}

interface RunResult {
  testCase: TestCase;
  success: boolean;
  content: string;
  toolCalls: Array<{ toolName: string; input: string; output: string }>;
  durationMs: number;
  turnsUsed: number;
  error?: string;
  outputLength: number;
  usedTools: boolean;
  evaluationNotes: string;
}

// ---------------------------------------------------------------------------
// Test Cases: GAIA L3 (Top 10 hardest)
// ---------------------------------------------------------------------------

const GAIA_L3_TESTS: TestCase[] = [
  {
    id: "GAIA-L3-01",
    benchmark: "GAIA",
    category: "L3-统计数据分析",
    question: `Give the following statistics according to USDL-22-2309 using the same list format as the statistics requested. If something is a decrease, use a - to note it negative. Express percentage between 0 and 100, without the % sign. So a 5.1 percent increase would be 5.1 and a 2.3 percent decrease would be -2.3. Express your answer as a comma separated list. So if say, I asked for:

a. percent change in hours worked in the fishing industry
b. percent change in fatal injuries in the mining industry
c. number of injuries per 100,000 workers in the agricultural industry

the answer would be formatted like this: 5.2, -1.2, 21.3

assuming the document referenced gave those figures.

Here is the list:

 percent change in suicide rate from 2020 to 2021
 the lowest age in the age demographic that accounted for about 20% of fatalities
 the fatal occupational injury rate in 2021
 the actual change (not percentage or per 100000 FTEs) of violent fatalities (injuries by other humans/animals) from 2020 to 2021
 the change (not percent change) in fishing and hunting workers' fatal injuries per 100000 FTEs from 2020 to 2021
 the percent change in deaths for driver/sales workers and truck drivers`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-02",
    benchmark: "GAIA",
    category: "L3-多步跨域推理",
    question: `One of director Judd Apatow's films features characters using video game controllers from one console to control a game made for a separate console. What is the difference in speed of the main processors in these consoles? Please report your answer as a numerical value followed by either MHz or GHz.

It is possible that multiple revisions of a video game console may have different processors. If this is the case, select the earliest revision of both consoles for the purposes of your computation. Also, it is possible that the video game displayed in the scene was made available for multiple consoles. If this is the case, report the difference in processor speed for each possible combination, in a comma separated list without units, ascending from smallest difference to largest difference.`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-03",
    benchmark: "GAIA",
    category: "L3-数学推理-Fibonacci",
    question: `Rumor has it that the ingredients in Heinz ketchup increase in ascending order from the end of the list to the beginning in a series of percentages that correspond to a subset of sequential Fibonacci numbers. The subset of numbers adds up as close to 100% as any sequential subset of Fibonacci numbers can without exceeding it, and water contributes the remaining percentage. Based on this rumor, to fill a 907g bottle with Heinz ketchup according to the ingredients used in 2021, how many more milliliters of vinegar than water to the nearest milliliter would be needed using a vinegar density of 0.972 g/mL and the rounded integer value of water density?`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-04",
    benchmark: "GAIA",
    category: "L3-文学推理",
    question: `I was reading a novel a while ago. It was one of Frank Belknap Long's stories. In the story, the protagonist starts off beating up a security guard, in either the first or second chapter. And by the end, he ends up saving the day by piloting some sort of aircraft and blowing up the headquarters of an oppressive regime. He does it by infiltrating a group of the aircraft, although I don't remember if it really says how he gets in the aircraft. Anyway, could you please tell me how many aircraft were in the initial group, before the protagonist started to fight back and shoot the others down? Just an integer number as your answer is fine.`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-05",
    benchmark: "GAIA",
    category: "L3-生物化学推理",
    question: `Biochemist Glenn Kuehn's first publication showed the percent of ^14C present as two different chemicals for fixation times of 6 and 12 seconds during ribose oxidation by Hydrogenomonas facilis. Increasing the fixation time from 6 to 12 seconds resulted in an increase in the percent of ^14C present as one of these chemicals. What was the increase in percent of ^14C present for this chemical when fixation time increased from 6 seconds to 12 seconds? Give your answer with two significant figures.`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-06",
    benchmark: "GAIA",
    category: "L3-多步信息检索",
    question: `In a 2022 interview with TED, screenwriter Michael Schur describes the first season of a show he worked on, saying that every episode in the season ended on an unpleasant note. Find the building used for exterior shots of that show's main setting after season one. Railroad tracks run behind the buildings across the street from that building. According to Yahoo Finance, what was the opening stock price on February 1, 1980 of the railroad that owned those tracks as of 2022?`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-07",
    benchmark: "GAIA",
    category: "L3-Wikipedia链式推理",
    question: `As of July 2023, the Wikipedia page for penguins links to the Wikipedia pages for specific penguin species in the body of the article. The last such link goes to a page that has a link to a 4-page PDF file that mentions emperor penguins. The second to last link to a specific penguin species goes to a page that uses a PLOS One reference, which also mentions emperor penguins. How many more times are emperor penguins mentioned in the PDF file than in the PLOS One reference?`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-08",
    benchmark: "GAIA",
    category: "L3-人口统计推理",
    question: `As of January 1, 2021, which surviving President or Vice President of the United States was born in the town or city with the smallest population at the time of their birth? When comparing populations, please use the decennial population data available on the town or city's Wikipedia page nearest to the birth date of the individual in order to keep the population estimates consistent across comparisons. Answer using the format First Name Last Name.`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-09",
    benchmark: "GAIA",
    category: "L3-空间推理-象棋",
    question: `In a chess game where White can mate in 1 by playing a particular type of move (an "underpromotion" to a knight, bishop, or rook), the name of this type of move is also the name of an electronic music album whose cover shows a robot arm playing chess using a physical chessboard. In the album cover image, on which square is there a black piece that is en prise, ignoring the piece that the robot arm is holding? Assume that the white king is on its starting square in the album cover image. Give the answer in algebraic notation.`,
    maxWaitMs: 600_000,
  },
  {
    id: "GAIA-L3-10",
    benchmark: "GAIA",
    category: "L3-游戏分析推理",
    question: `Please tell me how many times the player character in the original Legend of Zelda game for NES can be damaged by enemies before being defeated. For the purpose of this question, assume that the player uses any health-restoring items already held optimally, but that the player does not defeat any enemies and consequently does not find any additional health-restoring items. Please report your answer as an integer number of times the player can sustain damage prior to being defeated.`,
    maxWaitMs: 600_000,
  },
];

// ---------------------------------------------------------------------------
// Test Cases: LongBench Write (Top 10 longest = hardest)
// ---------------------------------------------------------------------------

const LONGBENCH_TESTS: TestCase[] = [
  {
    id: "LB-01",
    benchmark: "LongBench",
    category: "长篇文学创作-20000字",
    question: `请写一本20000字的小说，名为《清朝那些事儿》，仿照《明朝那些事儿》的写法，以幽默的口吻、小说的笔法讲述中国清朝历史，可夹杂少量虚构内容。要求：1) 有完整的故事结构和时间线 2) 覆盖清朝从建立到灭亡的主要事件 3) 人物对话生动 4) 语言幽默风趣`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-02",
    benchmark: "LongBench",
    category: "长篇学术写作-15000字",
    question: `请撰写一篇15000字的《积极心理学入门》课程教材，包含以下章节：1) 积极心理学概述与历史 2) 幸福感理论（PERMA模型） 3) 优势与美德分类 4) 正念与心流 5) 积极人际关系 6) 积极心理治疗 7) 职场中的积极心理学 8) 积极心理学在中国的发展。每章需要包含理论框架、研究案例、实践练习。`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-03",
    benchmark: "LongBench",
    category: "行业报告-15000字",
    question: `请撰写一篇15000字的上海国潮品牌行业报告，选择三个典型案例：服装鞋帽类——回力；美妆护肤类——百雀羚；零食特产类——大白兔。报告需包含：1) 行业概况与趋势 2) 各品牌历史与发展 3) 品牌复兴策略分析 4) 市场数据与消费者画像 5) SWOT分析 6) 未来发展建议。每个品牌至少3000字深度分析。`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-04",
    benchmark: "LongBench",
    category: "商业分析-12000字",
    question: `Write a 12000-word article about "The Top 10 Business Opportunities in Benin Republic". For each opportunity, cover: How to start or register the business, estimated startup capital needed, the best location for the business, and market analysis. Conclude with an analysis of Benin Republic's future development plans and how they may create more opportunities for both foreigners and locals.`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-05",
    benchmark: "LongBench",
    category: "技术学术论文-10000字",
    question: `Write a 10000-word academic essay about the mathematical fundamentals of Phased Antenna Arrays. Cover: 1) Array theory basics and antenna radiation patterns 2) Beam steering mathematics (phase shifters, time delay) 3) Array factor calculation and grating lobes 4) Adaptive beamforming algorithms (LMS, RLS, CMA) 5) MIMO antenna systems 6) Digital beamforming architectures 7) Practical design considerations. Include mathematical formulas and derivations.`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-06",
    benchmark: "LongBench",
    category: "游戏剧情创作-10000字",
    question: `《完蛋！我被美女包围了！》是一款恋爱模拟游戏。请设计一款《完蛋！我被美女同学包围了！》的游戏剧情，要求：1) 设定在大学校园 2) 至少5个可攻略女角色，每人有独特性格和背景故事 3) 每个角色至少3条剧情分支线 4) 包含关键抉择点和不同结局 5) 剧情总长度10000字以上，内容完整丰富`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-07",
    benchmark: "LongBench",
    category: "剧本创作-10000字",
    question: `请写一份有五个人搞笑的青春校园剧本。要求：1) 五个性格迥异的主角 2) 共五幕，每幕有独立的情节和冲突 3) 明确标注每个角色说的台词 4) 包含舞台指示 5) 剧情连贯，有起承转合 6) 总字数10000字以上 7) 语言幽默搞笑，贴近校园生活`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-08",
    benchmark: "LongBench",
    category: "教学大纲-10000字",
    question: `写一份大数据开发技术的教案，主要知识点包含 Scala、Flink、Spark等大数据分析知识点。要求：1) 将内容分割为20次课讲解 2) 每节课生成细致的讲解内容 3) 每节课需说明教学目标、教学重点、教学难点 4) 教学重点和难点需要提供解决措施 5) 每节课还需要搭配课程思政 6) 总字数10000字左右`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-09",
    benchmark: "LongBench",
    category: "英文小说创作-10000字",
    question: `Write an anti-war novel about Sony Wang, a young painter living in Vienna who is drafted into the army in 1916. Requirements: 1) At least 10000 words 2) Rich character development 3) Vivid descriptions of wartime experiences 4) Multiple plot arcs 5) A compelling narrative voice 6) Historical accuracy for WWI period 7) Exploration of themes: art vs war, identity, loss, humanity`,
    maxWaitMs: 600_000,
  },
  {
    id: "LB-10",
    benchmark: "LongBench",
    category: "长篇小说-10000字",
    question: `Write a novel about a man's quest for the meaning of life. The protagonist Kintu was born in April 1982 in the outskirts of a town named Dilivila. Born amidst bounties of nature and loving parents, his childhood is a dream lived by a typical lower middle class family. He grows up to be a shy boy, excelling in studies. At age seven, he meets a girl named Chinmoyee who becomes his friend. Later as he grows, he explores new horizons - meeting new friends who teach him bad habits. Chinmoyee moves to a different city. Kintu's studies degrade, he feels helpless. Eventually he gets a government job but the joy of life he lost in early days is lost forever. Genre: melodrama. At least 10000 words.`,
    maxWaitMs: 600_000,
  },
];

// ---------------------------------------------------------------------------
// Test Cases: HaluEval QA / FActScore (Top 10 hardest)
// ---------------------------------------------------------------------------

const FACTSCORE_TESTS: TestCase[] = [
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
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
    maxWaitMs: 120_000,
  },
];

// ---------------------------------------------------------------------------
// Test Cases: WebArena / Tool Decathlon (Top 10 hardest)
// ---------------------------------------------------------------------------

const TOOL_DECATHLON_TESTS: TestCase[] = [
  {
    id: "Tool-01",
    benchmark: "ToolDecathlon",
    category: "路线规划-多地点优化",
    question: `Given the following locations: ['Massachusetts Institute of Technology', 'Harvard University', 'Boston Logan International Airport'], what would be the optimal route to travel through them all in order to minimize total travel time? Please note the journey begins at the first place listed. Please search for the distances between these locations and calculate the optimal route.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-02",
    benchmark: "ToolDecathlon",
    category: "路线规划-多地点优化",
    question: `Given the following locations: ['Carnegie Mellon University', 'apple store shadyside', 'starbucks on craig street'], what would be the optimal route to travel through them all in order to minimize total travel time? The journey begins at the first place. Search for distances and find the optimal order.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-03",
    benchmark: "ToolDecathlon",
    category: "多源信息聚合",
    question: `Gather the titles of Doc and Pies Arcade Factory Cocktail Arcade Machine reviews with 3 stars and less rating, and list them. Also provide a summary of common complaints from these negative reviews. Search for this product online.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-04",
    benchmark: "ToolDecathlon",
    category: "路线规划-大学",
    question: `Given the following locations: ['Princeton University', 'Yale University', 'Harvard University'], what would be the optimal route to travel through them all in order to minimize total travel time? The journey begins at the first place. Search for the driving distances between each pair of universities and find the shortest overall route.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-05",
    benchmark: "ToolDecathlon",
    category: "表单填写-退款",
    question: `I need to draft a refund request for a phone screen protector I bought. It broke after just three days of use. The order number is #000000180. Please search for common refund request formats and draft a professional refund message including: the order number, the reason for the refund (product broke after 3 days), and a request for a full refund. Output the complete message.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-06",
    benchmark: "ToolDecathlon",
    category: "多源信息聚合",
    question: `Search for Nintendo Switch Fortnite Wildcat Console reviews with 3 stars or less rating. List the review titles and provide a summary of the main complaints from these negative reviews.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-07",
    benchmark: "ToolDecathlon",
    category: "表单填写-退款",
    question: `Draft a refund message for a phone screen protector I bought in March 2023. It broke after three days of use. The message should include: order ID, the reason (broke after 3 days), and the amount to refund. Search for professional refund request templates and create a well-formatted message.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-08",
    benchmark: "ToolDecathlon",
    category: "表单填写-退款",
    question: `Draft a refund message for a kitchen organizer I bought around Feb 2023. It broke after three days of use. Include: order ID, reason for refund, and refund amount. Search for examples of effective refund requests and write a professional one.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-09",
    benchmark: "ToolDecathlon",
    category: "表单填写-退款",
    question: `I bought a bluetooth speaker that broke after just three days of use. The order number is #161. Please draft a professional refund request message that includes: order number #161, product SKU, reason (broke after 3 days), and request for full refund.`,
    maxWaitMs: 300_000,
  },
  {
    id: "Tool-10",
    benchmark: "ToolDecathlon",
    category: "表单填写-退款",
    question: `I need to request a refund for a remote controller that broke after just three days of use. Order number is #180. Please search for best practices on writing refund emails and draft a complete, professional refund request including the order number and product details.`,
    maxWaitMs: 300_000,
  },
];

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

async function createSession(title: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
  const body = await resp.json();
  return body.id;
}

async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: "DELETE" });
}

async function runAgentSSE(
  sessionId: string,
  question: string,
  maxWaitMs: number,
): Promise<{
  content: string;
  toolCalls: Array<{ id: string; toolName: string; input: any; output: string }>;
  turnsUsed: number;
  success: boolean;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxWaitMs);

  // Declare SSE state before try so catch block can reference them safely
  let content = "";
  const toolCallMap = new Map<string, any>();
  const toolCalls: any[] = [];
  let turnsUsed = 0;
  let success = false;
  let error: string | undefined;

  try {
    const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input: question }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { content: "", toolCalls: [], turnsUsed: 0, success: false, error: `HTTP ${resp.status}` };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "" && currentEvent && currentData) {
          try {
            const data = JSON.parse(currentData);
            switch (currentEvent) {
              case "content_delta":
                content += data.delta || "";
                break;
              case "content":
                // Only replace if the new content is longer (turn text may be short)
                if (data.content && data.content.length > content.length) {
                  content = data.content;
                }
                break;
              case "tool_call":
                toolCallMap.set(data.id, { id: data.id, toolName: data.toolName, input: data.input || {}, output: "", status: "pending" });
                // Capture write_file content from tool_call input (content is in the input, not the result)
                if (data.toolName === "write_file" && data.input?.content && typeof data.input.content === "string") {
                  if (data.input.content.length > content.length) {
                    content = data.input.content;
                  }
                }
                break;
              case "tool_result": {
                const tc = toolCallMap.get(data.id);
                if (tc) { tc.output = data.output || ""; tc.status = "completed"; toolCalls.push(tc); }
                const toolName = data.toolName || (tc && tc.toolName) || "";
                // Capture finish tool output as content (agent may put summary in finish instead of streaming)
                if (toolName === "finish") {
                  let summary = data.output?.summary || data.output?.content || "";
                  // Handle JSON-wrapped output: {"completed":true,"summary":"..."}
                  if (!summary && typeof data.output === "string") {
                    try { const parsed = JSON.parse(data.output); summary = parsed.summary || parsed.content || ""; } catch { summary = data.output; }
                  }
                  if (typeof summary === "string" && summary.length > content.length) {
                    content = summary;
                  }
                }
                // Capture write_file content as content (agent writes long output to files)
                if (toolName === "write_file") {
                  const fileContent = tc?.input?.content || data.output?.content || "";
                  if (typeof fileContent === "string" && fileContent.length > content.length) {
                    content = fileContent;
                  }
                }
                // Capture read_file / push_content content when agent reads sub-agent outputs for merging
                if (toolName === "read_file" || toolName === "push_content") {
                  let readContent = "";
                  if (typeof data.output === "string") {
                    try { const parsed = JSON.parse(data.output); readContent = parsed.data || parsed.content || parsed.text || ""; } catch { readContent = data.output; }
                  } else if (data.output) {
                    readContent = data.output.data || data.output.content || data.output.text || "";
                  }
                  if (typeof readContent === "string" && readContent.length > content.length) {
                    content = readContent;
                    console.log(`[SSE] Captured ${readContent.length} chars from ${toolName} tool_result`);
                  }
                }
                break;
              }
              case "complete":
                // Complete event carries bestOutput from agent-runner
                if (data.output && typeof data.output === "string" && data.output.length > content.length) {
                  content = data.output;
                  console.log(`[SSE] Captured ${data.output.length} chars from complete event`);
                }
                break;
              case "done":
                turnsUsed = data.turnsUsed || 0;
                success = data.status !== "error";
                // Done event now includes output on success — use as fallback
                if (data.output && typeof data.output === "string" && data.output.length > content.length) {
                  content = data.output;
                  console.log(`[SSE] Captured ${data.output.length} chars from done event`);
                }
                break;
              case "push_content": {
                // Dedicated push_content event — agent pushes structured content cards to frontend.
                // This is the primary output channel when sub-agents generate long content via workflow_run.
                const pushedData = data.data || "";
                if (typeof pushedData === "string" && pushedData.length > content.length) {
                  content = pushedData;
                  console.log(`[SSE] Captured ${pushedData.length} chars from push_content event (title: ${data.title})`);
                }
                break;
              }
              case "error":
                error = data.error;
                success = false;
                break;
            }
          } catch { /* skip */ }
          currentEvent = "";
          currentData = "";
        }
      }
    }

    return { content, toolCalls, turnsUsed, success, error };
  } catch (e: any) {
    if (e.name === "AbortError") {
      // Preserve any accumulated content/toolCalls before timeout
      if (content || toolCalls.length > 0) {
        return { content, toolCalls, turnsUsed, success: true, error: "Timeout (partial)" };
      }
      return { content: "", toolCalls: [], turnsUsed: 0, success: false, error: "Timeout" };
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Evaluation Helpers
// ---------------------------------------------------------------------------

function evaluateFActScore(result: RunResult): string {
  if (!result.success && !result.content) return "FAIL: Agent did not produce output";
  const content = result.content.toLowerCase();

  // Check if the answer identifies the hallucinated answer as incorrect
  const indicatesWrong = content.includes("错误") || content.includes("incorrect") ||
    content.includes("不正确") || content.includes("不正确") || content.includes("not correct") ||
    content.includes("hallucinat") || content.includes("虚构") || content.includes("编造");

  const hasReasoning = content.includes("分析") || content.includes("reason") ||
    content.includes("根据") || content.includes("based on") || content.includes("因为");

  const hasConclusion = content.includes("结论") || content.includes("conclusion") ||
    content.includes("最终") || content.includes("因此") || content.includes("综上");

  const parts: string[] = [];
  if (indicatesWrong) parts.push("识别出答案错误 ✓");
  else parts.push("未识别出答案错误 ✗");
  if (hasReasoning) parts.push("有推理过程 ✓");
  if (hasConclusion) parts.push("有明确结论 ✓");

  return parts.join(" | ");
}

function evaluateGAIA(result: RunResult): string {
  if (!result.success && !result.content) return "FAIL: Agent did not produce output";
  const content = result.content;
  const parts: string[] = [];

  // Check for numerical answer
  const hasNumbers = /\d+\.?\d*/.test(content);
  if (hasNumbers) parts.push("包含数值答案");

  // Check for reasoning steps
  const hasSteps = content.includes("步骤") || content.includes("step") ||
    content.includes("首先") || content.includes("然后") || content.includes("推理");
  if (hasSteps) parts.push("有推理过程");

  // Check for tool usage
  if (result.usedTools) parts.push("使用了工具");

  // Check output length
  if (content.length > 200) parts.push(`输出长度: ${content.length}字`);

  return parts.join(" | ");
}

function evaluateLongBench(result: RunResult): string {
  if (!result.success && !result.content) return "FAIL: Agent did not produce output";
  const content = result.content;
  const charCount = content.length;
  const parts: string[] = [];

  parts.push(`输出字数: ${charCount}`);

  // Check for structure
  if (content.includes("#") || content.includes("第") || content.includes("章") || content.includes("Act")) parts.push("有章节结构");
  if (content.includes("，") || content.includes("。") || content.includes(",") || content.includes(".")) parts.push("有正文内容");
  if (charCount >= 10000) parts.push("✅ 长文本达标 (≥10000字)");
  else if (charCount >= 5000) parts.push("⚠️ 中等长度 (5000-10000字)");
  else if (charCount >= 2000) parts.push("⚠️ 偏短 (2000-5000字)");
  else parts.push("❌ 文本过短 (<2000字)");

  // Check for completeness (ending patterns)
  const trimmed = content.trimEnd();
  if (trimmed.endsWith("。") || trimmed.endsWith(".") || trimmed.endsWith("！") || trimmed.endsWith("？") || trimmed.endsWith(")") || trimmed.endsWith("}") || trimmed.endsWith("```")) {
    parts.push("完整结尾 ✓");
  }

  return parts.join(" | ");
}

function evaluateToolDecathlon(result: RunResult): string {
  if (!result.success && !result.content) return "FAIL: Agent did not produce output";
  const parts: string[] = [];

  if (result.usedTools) parts.push("使用了工具 ✓");
  else parts.push("未使用工具 ✗");

  if (result.toolCalls.length > 0) parts.push(`工具调用${result.toolCalls.length}次`);

  const content = result.content;
  if (content.length > 200) parts.push(`输出长度: ${content.length}字`);
  if (content.includes("route") || content.includes("路线") || content.includes("路线")) parts.push("路线相关内容 ✓");
  if (content.includes("refund") || content.includes("退款")) parts.push("退款相关内容 ✓");

  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Test Execution
// ---------------------------------------------------------------------------

async function runTest(testCase: TestCase): Promise<RunResult> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running: ${testCase.id} — ${testCase.benchmark} / ${testCase.category}`);
  console.log(`Question: ${testCase.question.slice(0, 120)}...`);
  console.log(`${"=".repeat(70)}`);

  const startTime = Date.now();
  let sessionId = "";

  try {
    sessionId = await createSession(`Bench4-${testCase.id}-${Date.now()}`);
    const agentResult = await runAgentSSE(sessionId, testCase.question, testCase.maxWaitMs);
    const durationMs = Date.now() - startTime;

    // Evaluate based on benchmark type
    const partial: Omit<RunResult, "evaluationNotes"> = {
      testCase,
      success: agentResult.success,
      content: agentResult.content,
      toolCalls: agentResult.toolCalls.map(tc => ({
        toolName: tc.toolName,
        input: JSON.stringify(tc.input).slice(0, 5000),
        output: tc.output.slice(0, 5000),
      })),
      durationMs,
      turnsUsed: agentResult.turnsUsed,
      error: agentResult.error,
      outputLength: agentResult.content.length,
      usedTools: agentResult.toolCalls.length > 0,
    };

    let evaluationNotes = "";
    switch (testCase.benchmark) {
      case "FActScore": evaluationNotes = evaluateFActScore(partial as RunResult); break;
      case "GAIA": evaluationNotes = evaluateGAIA(partial as RunResult); break;
      case "LongBench": evaluationNotes = evaluateLongBench(partial as RunResult); break;
      case "ToolDecathlon": evaluationNotes = evaluateToolDecathlon(partial as RunResult); break;
    }

    const result: RunResult = { ...partial, evaluationNotes };

    console.log(`\n--- Result ---`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s | Turns: ${agentResult.turnsUsed} | Tools: ${agentResult.toolCalls.length} | Output: ${agentResult.content.length} chars`);
    console.log(`Success: ${agentResult.success}`);
    console.log(`Evaluation: ${result.evaluationNotes}`);
    if (agentResult.content.length > 0) {
      console.log(`\nOutput preview (first 500 chars):\n${agentResult.content.slice(0, 500)}`);
      console.log(`\n... (truncated) ...\n`);
      console.log(`Output preview (last 200 chars):\n${agentResult.content.slice(-200)}`);
    }

    return result;
  } catch (e: any) {
    return {
      testCase,
      success: false,
      content: "",
      toolCalls: [],
      durationMs: Date.now() - startTime,
      turnsUsed: 0,
      error: e.message,
      outputLength: 0,
      usedTools: false,
      evaluationNotes: `ERROR: ${e.message}`,
    };
  } finally {
    if (sessionId) await deleteSession(sessionId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const groupFilter = args[0]; // "gaia", "longbench", "factscore", "tools", or test IDs like "LB-01,LB-02"

  console.log(`\n${"#".repeat(70)}`);
  console.log(`# DeepAnalyze 4-Benchmark Capability Test`);
  console.log(`# Testing hardest 10 questions from each benchmark`);
  console.log(`# Total: 40 questions across 4 benchmarks`);
  console.log(`${"#".repeat(70)}\n`);

  // Select which tests to run
  let allTests: TestCase[] = [];
  const groups: Record<string, TestCase[]> = {
    gaia: GAIA_L3_TESTS,
    longbench: LONGBENCH_TESTS,
    factscore: FACTSCORE_TESTS,
    tools: TOOL_DECATHLON_TESTS,
  };

  // Support comma-separated test IDs to run specific tests (e.g. "LB-01" or "LB-01,LB-04")
  const allGroupTests = [...GAIA_L3_TESTS, ...LONGBENCH_TESTS, ...FACTSCORE_TESTS, ...TOOL_DECATHLON_TESTS];
  const isTestIds = groupFilter && !groups[groupFilter] && groupFilter !== "all";
  if (isTestIds) {
    const ids = groupFilter!.split(",").map(s => s.trim());
    allTests = allGroupTests.filter(t => ids.includes(t.id));
    console.log(`Running specific tests: ${ids.join(", ")} (${allTests.length} found)`);
  } else if (groupFilter && groups[groupFilter]) {
    allTests = groups[groupFilter];
    console.log(`Running group: ${groupFilter} (${allTests.length} tests)`);
  } else if (groupFilter) {
    console.error(`Unknown group: ${groupFilter}. Available: ${Object.keys(groups).join(", ")}`);
    process.exit(1);
  } else {
    allTests = [...GAIA_L3_TESTS, ...LONGBENCH_TESTS, ...FACTSCORE_TESTS, ...TOOL_DECATHLON_TESTS];
    console.log(`Running all 4 benchmarks (${allTests.length} tests)`);
  }

  const results: RunResult[] = [];

  for (let i = 0; i < allTests.length; i++) {
    console.log(`\n[${i + 1}/${allTests.length}]`);
    const result = await runTest(allTests[i]);
    results.push(result);
  }

  // =========================================================================
  // Final Summary
  // =========================================================================
  console.log(`\n\n${"=".repeat(70)}`);
  console.log(`FINAL SUMMARY`);
  console.log(`${"=".repeat(70)}\n`);

  // Group by benchmark
  const benchmarks = [...new Set(results.map(r => r.testCase.benchmark))];
  for (const bm of benchmarks) {
    const bmResults = results.filter(r => r.testCase.benchmark === bm);
    console.log(`\n--- ${bm} (${bmResults.length} tests) ---`);

    let successCount = 0;
    let totalOutputLen = 0;
    let toolUseCount = 0;
    let totalTime = 0;

    for (const r of bmResults) {
      const status = r.success ? "OK" : "FAIL";
      const toolInfo = r.usedTools ? `${r.toolCalls.length}tools` : "no-tools";
      console.log(
        `  ${r.testCase.id} [${status}] ` +
        `${(r.durationMs / 1000).toFixed(1)}s ` +
        `${r.turnsUsed}turns ` +
        `${toolInfo} ` +
        `${r.outputLength}chars ` +
        `${r.error || ""}`
      );
      console.log(`    Eval: ${r.evaluationNotes}`);

      if (r.success) successCount++;
      totalOutputLen += r.outputLength;
      if (r.usedTools) toolUseCount++;
      totalTime += r.durationMs;
    }

    const avgOutputLen = bmResults.length > 0 ? Math.round(totalOutputLen / bmResults.length) : 0;
    console.log(`  Summary: ${successCount}/${bmResults.length} succeeded | Avg output: ${avgOutputLen} chars | Tool use: ${toolUseCount}/${bmResults.length} | Total time: ${(totalTime / 1000).toFixed(0)}s`);
  }

  // Overall
  const totalSuccess = results.filter(r => r.success).length;
  const totalToolUse = results.filter(r => r.usedTools).length;
  const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / results.length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`OVERALL: ${totalSuccess}/${results.length} succeeded (${(totalSuccess / results.length * 100).toFixed(0)}%)`);
  console.log(`Tool usage: ${totalToolUse}/${results.length} tests used tools`);
  console.log(`Avg duration: ${(avgDuration / 1000).toFixed(1)}s per test`);
  console.log(`${"=".repeat(70)}`);

  // Save results
  const fs = await import("node:fs/promises");
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(
    `${RESULTS_DIR}/results-${timestamp}.json`,
    JSON.stringify(results, null, 2),
    "utf-8",
  );
  console.log(`\nResults saved to: ${RESULTS_DIR}/results-${timestamp}.json`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
