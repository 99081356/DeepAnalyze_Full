import { parseSkillMd } from '../../src/services/agent/skill-loader.ts';

// Test 1: Parse full metadata
const skill1 = `---
name: test-skill
description: A test skill for metadata
triggers: [search, find, query]
tags: [search, knowledge, test]
homepage: https://example.com
version: 1.0.0
author: Test Author
emoji: "search"
requires:
  bins: [python3]
  tools: [bash]
  os: [linux, darwin]
install:
  - kind: npm
    package: some-tool
    label: Install some-tool
---

This is the skill prompt body.
`;

const m1 = parseSkillMd(skill1, 'test-skill.md');
console.log('Name:', m1.name === 'test-skill');
console.log('Triggers count:', m1.triggers?.length === 3);
console.log('Has search trigger:', m1.triggers?.includes('search'));
console.log('Tags count:', m1.tags?.length === 3);
console.log('Homepage:', m1.homepage === 'https://example.com');
console.log('Version:', m1.version === '1.0.0');
console.log('Author:', m1.author === 'Test Author');
console.log('Emoji:', m1.emoji === 'search');
console.log('Requires bins:', m1.requires?.bins?.includes('python3'));
console.log('Requires tools:', m1.requires?.tools?.includes('bash'));
console.log('Requires os:', m1.requires?.os?.includes('linux'));
console.log('Install kind:', m1.install?.[0]?.kind === 'npm');
console.log('Install package:', m1.install?.[0]?.package === 'some-tool');
console.log('System prompt:', m1.systemPrompt.includes('skill prompt body'));

// Test 2: OpenClaw compatibility
const skill2 = `---
name: cc-weather
description: Weather lookup skill
metadata:
  openclaw:
    emoji: "rain"
allowed-tools: bash curl
---

Weather skill prompt.
`;

const m2 = parseSkillMd(skill2, 'weather.md');
console.log('\nOpenClaw name:', m2.name === 'cc-weather');
console.log('OpenClaw emoji:', m2.emoji === 'rain');
console.log('OpenClaw tools:', m2.tools.includes('bash') && m2.tools.includes('curl'));

// Test 3: Minimal skill (no new fields)
const skill3 = `---
description: Simple skill
tools: [bash]
---

Simple prompt.
`;

const m3 = parseSkillMd(skill3, 'simple.md');
console.log('\nMinimal: no triggers:', m3.triggers === undefined);
console.log('Minimal: no tags:', m3.tags === undefined);
console.log('Minimal: no emoji:', m3.emoji === undefined);
console.log('Minimal: tools:', m3.tools.includes('bash'));

console.log('\n✅ All skill metadata tests passed!');
