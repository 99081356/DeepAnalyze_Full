# Test Report

- **Date**: 2026-05-07T08:12:36.669782
- **Total**: 20
- **Passed**: 0
- **Failed**: 20
- **Pass Rate**: 0.0%

## By Category

| Category | Total | Passed | Rate |
|----------|-------|--------|------|
| biography | 20 | 0 | 0.0% |

## Failed Items

### factscore-001
**Prompt**: Tell me a bio of Michael Collins...
**Expected**: Factual accuracy of birth date (October 31, 1930), nationality (American), profession (astronaut, test pilot), Apollo 11 role as Command Module Pilot (1969), NASA astronaut group selection (third group, 1963), Gemini 7 backup role. Dates, mission names, and official roles must be precisely correct.
**Predicted**: 
**Match Method**: no_match
**Turns**: 5 | **Time**: 106.8s
**Tools**: wikipedia, wikipedia, wikipedia, think

### factscore-002
**Prompt**: Tell me a bio of Chadwick Boseman...
**Expected**: Factual accuracy of birth/death dates, nationality, profession (actor, director, writer), notable film roles (Black Panther, 42, Get On Up), career timeline, awards, and achievements. Avoid subjective claims about cultural impact unless directly attributed to named sources. Dates of major films and career milestones must be precise.
**Predicted**: 
**Match Method**: no_match
**Turns**: 5 | **Time**: 66.4s
**Tools**: think, mcp__minimax_websearch__web_search, web_fetch, think

### factscore-003
**Prompt**: Tell me a bio of Mary I of England...
**Expected**: Factual accuracy of reign dates (July 1553 until death in 1558), parentage (Henry VIII and Catherine of Aragon), succession history, religious policies, marriage to Philip II of Spain, and key events of her reign. Dates, familial relationships, and political events must be verifiable against Wikipedia.
**Predicted**: 
**Match Method**: no_match
**Turns**: 3 | **Time**: 52.6s
**Tools**: wikipedia, wikipedia

### factscore-004
**Prompt**: Tell me a bio of Glover Teixeira...
**Expected**: Factual accuracy of nationality (Brazilian/American), profession (MMA fighter), UFC career details, citizenship date (November 2020, not 2023), weight class, notable fights and achievements. Citizenship date and fight records are common error points that must be precisely verified.
**Predicted**: 
**Match Method**: no_match
**Turns**: 2 | **Time**: 42.4s
**Tools**: wikipedia

### factscore-005
**Prompt**: Tell me a bio of Sajid Nadiadwala...
**Expected**: Factual accuracy of nationality (Indian), profession (film director, producer), notable films (Kick, 2014), awards (IIFA Award for Debut Director), career timeline. Award details are a known error source -- verify exact number of awards won for specific films rather than vague claims about 'various awards'.
**Predicted**: 
**Match Method**: no_match
**Turns**: 3 | **Time**: 44.3s
**Tools**: wikipedia, wikipedia

### factscore-006
**Prompt**: Tell me a bio of Adil Rami...
**Expected**: Factual accuracy of nationality (French), profession (footballer), clubs played for, international career with France, position (centre-back), birth date, and career milestones. Club transfer dates, caps for national team, and specific tournament appearances must be verified.
**Predicted**: 
**Match Method**: no_match
**Turns**: 3 | **Time**: 43.3s
**Tools**: web_search, wikipedia

### factscore-007
**Prompt**: Tell me a bio of Tim Fischer...
**Expected**: Factual accuracy of nationality (Australian), political career (National Party leader, Deputy Prime Minister), Ambassador to the Holy See (2008-2012, note: dates vary between sources), birth/death dates. Diplomatic appointment dates are a known source of inconsistency between Wikipedia text and tables.
**Predicted**: 
**Match Method**: no_match
**Turns**: 7 | **Time**: 67.6s
**Tools**: think, web_search, mcp__minimax_websearch__web_search, wikipedia, wikipedia, think

### factscore-008
**Prompt**: Tell me a bio of Kang Ji-hwan...
**Expected**: Factual accuracy of nationality (South Korean), profession (actor), notable dramas and films, acting debut (The Moon is the Sun's Dream, 1992), career timeline. Verify specific film/TV appearances rather than accepting vague claims about charity work or career achievements not mentioned in Wikipedia.
**Predicted**: 
**Match Method**: no_match
**Turns**: 4 | **Time**: 45.6s
**Tools**: think, wikipedia, wikipedia

### factscore-009
**Prompt**: Tell me a bio of Ylona Garcia...
**Expected**: Factual accuracy of nationality (Filipino/Australian), profession (singer, actress), TV appearances (ASAP, etc.), career milestones, birth date. Specific TV show appearances must be individually verified -- some generated claims about appearances are not supported by Wikipedia.
**Predicted**: 
**Match Method**: no_match
**Turns**: 4 | **Time**: 68.2s
**Tools**: think, wikipedia, wikipedia

### factscore-010
**Prompt**: Tell me a bio of Jack Leach...
**Expected**: Factual accuracy of nationality (English), profession (cricketer), bowling style (left-arm orthodox), England Test debut details (2018, Christchurch), batting (left-handed), county cricket career. Verify exact debut date, specific squad selection details, and team membership claims.
**Predicted**: 
**Match Method**: no_match
**Turns**: 4 | **Time**: 38.9s
**Tools**: think, wikipedia, wikipedia

### factscore-011
**Prompt**: Tell me a bio of Gerhard Fischer...
**Expected**: Factual accuracy of profession -- commonly described as 'inventor' but he actually commercialized (not invented) the metal detector. Verify patent date (1931), nationality, and specific contributions to metal detection technology. The distinction between inventor and commercializer is a critical factual nuance.
**Predicted**: 
**Match Method**: no_match
**Turns**: 8 | **Time**: 89.6s
**Tools**: wikipedia, wikipedia, wikipedia, think, wikipedia, wikipedia, think, finish

### factscore-012
**Prompt**: Tell me a bio of Eric Hacker...
**Expected**: Factual accuracy of profession (baseball pitcher), career details, teams played for, specific awards (IL Pitcher of the Week, not 'Pitcher of the Year'). Award names and levels are a known error source -- verify exact award titles rather than inflated versions.
**Predicted**: 
**Match Method**: no_match
**Turns**: 5 | **Time**: 49.3s
**Tools**: think, wikipedia, wikipedia, wikipedia

### factscore-013
**Prompt**: Tell me a bio of William Waldegrave...
**Expected**: Factual accuracy of family lineage, political career (British politician), titles, and ancestral relationships. Family tree claims (e.g., grandfather being James II and VII) must be carefully verified as they often involve indirect rather than direct relationships. Verify specific titles and political offices held.
**Predicted**: 
**Match Method**: no_match
**Turns**: 5 | **Time**: 54.4s
**Tools**: think, web_search, mcp__minimax_websearch__web_search, wikipedia

### factscore-014
**Prompt**: Tell me a bio of Julia Faye...
**Expected**: Factual accuracy of profession (American actress), film appearances, career period (silent film era), and specific films credited. Page-level verification is needed for filmography claims -- verify each film appearance by checking both the subject's page and the film's page for cross-reference.
**Predicted**: 
**Match Method**: no_match
**Turns**: 5 | **Time**: 61.8s
**Tools**: mcp__minimax_websearch__web_search, web_fetch, web_fetch, web_fetch

### factscore-015
**Prompt**: Tell me a bio of Zamfir Arbore...
**Expected**: Factual accuracy of nationality (Romanian), profession/political activities, biographical details, associations with publications (e.g., Românul staff). Information may be sparse in Wikipedia; verify claims against the subject's own page rather than related pages. Avoid generating fabricated biographical details.
**Predicted**: 
**Match Method**: no_match
**Turns**: 7 | **Time**: 55.8s
**Tools**: think, web_search, mcp__minimax_websearch__web_search, mcp__minimax_websearch__web_search, web_fetch, think, finish

### factscore-016
**Prompt**: Tell me a bio of Hibo Wardere...
**Expected**: Factual accuracy of nationality (Somali-British), activism (anti-FGM campaigner), memoir publication ('Cut: One Woman's Fight Against FGM in Britain Today'). Note that some facts may not appear on the Wikipedia page but may be verifiable from other sources. Verify memoir title and activism details precisely.
**Predicted**: 
**Match Method**: no_match
**Turns**: 4 | **Time**: 34.8s
**Tools**: mcp__minimax_websearch__web_search, wikipedia, wikipedia

### factscore-017
**Prompt**: Tell me a bio of Samuel Oboh...
**Expected**: Factual accuracy of nationality (Canadian, not Nigerian -- this is a known error from name-based assumptions), profession (architect, manager), contributions to architecture in Edmonton. Verify nationality carefully against Wikipedia rather than inferring from name. LEED certification claims must be precisely stated.
**Predicted**: 
**Match Method**: no_match
**Turns**: 7 | **Time**: 56.4s
**Tools**: web_search, mcp__minimax_websearch__web_search, mcp__minimax_websearch__web_search, wikipedia, wikipedia, think, finish

### factscore-018
**Prompt**: Tell me a bio of Chaim Malinowitz...
**Expected**: Factual accuracy of profession, biographical details, and any notable achievements. As a very rare entity, information may be extremely sparse on Wikipedia. The model should be evaluated on whether it correctly identifies what is and is not known, avoiding fabrication of biographical details that cannot be verified.
**Predicted**: 
**Match Method**: no_match
**Turns**: 7 | **Time**: 66.6s
**Tools**: mcp__minimax_websearch__web_search, mcp__minimax_websearch__web_search, mcp__minimax_websearch__web_search, wikipedia, wikipedia, think, finish

### factscore-019
**Prompt**: Tell me a bio of Lanny Flaherty...
**Expected**: Factual accuracy of profession, biographical details, film/TV appearances if applicable. As a rare entity, verify each claimed role or appearance against the subject's Wikipedia page. Avoid conflating this person with other entities who may share similar names.
**Predicted**: 
**Match Method**: no_match
**Turns**: 7 | **Time**: 52.0s
**Tools**: think, web_search, mcp__minimax_websearch__web_search, wikipedia, wikipedia, think, finish

### factscore-020
**Prompt**: Tell me a bio of Carlos J. Alfonso...
**Expected**: Factual accuracy of biographical details, profession, and achievements. Verify that the entity is correctly disambiguated -- 'Carlos J. Alfonso' and 'Carlos Alfonso' may refer to different people. Ensure claims are about the correct individual and not conflated with similarly named entities.
**Predicted**: 
**Match Method**: no_match
**Turns**: 8 | **Time**: 69.9s
**Tools**: web_search, mcp__minimax_websearch__web_search, mcp__minimax_websearch__web_search, mcp__minimax_websearch__web_search, wikipedia, wikipedia, think, finish
