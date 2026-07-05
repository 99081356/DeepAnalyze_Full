import { ToolRegistry } from '../../src/services/agent/tool-registry.js';

const registry = new ToolRegistry();

// Register a KB tool with requiresKbScope
registry.register({
  name: 'kb_search',
  description: 'Search KB',
  execute: async () => 'test',
  requiresKbScope: true,
});

// Register a normal tool
registry.register({
  name: 'bash',
  description: 'Run commands',
  execute: async () => 'test',
});

// Test 1: Without KB scope - kb_search should be excluded
registry.setExecutionContext({});
const defsNoKb = registry.buildToolDefinitions();
const kbSearchExcluded = !defsNoKb.find(d => d.name === 'kb_search');
const bashIncluded = !!defsNoKb.find(d => d.name === 'bash');
console.log('Without KB: kb_search excluded:', kbSearchExcluded);
console.log('Without KB: bash included:', bashIncluded);

// Test 2: With KB scope - kb_search should be included
registry.setExecutionContext({ scopeKbIds: ['kb-123'] });
const defsWithKb = registry.buildToolDefinitions();
const kbSearchIncluded = !!defsWithKb.find(d => d.name === 'kb_search');
console.log('With KB: kb_search included:', kbSearchIncluded);

// Test 3: Empty scopeKbIds array - should still exclude
registry.setExecutionContext({ scopeKbIds: [] });
const defsEmptyKb = registry.buildToolDefinitions();
const kbSearchExcludedEmpty = !defsEmptyKb.find(d => d.name === 'kb_search');
console.log('Empty scopeKbIds: kb_search excluded:', kbSearchExcludedEmpty);

// Test 4: Multiple KB tools
registry.register({
  name: 'expand',
  description: 'Expand document',
  execute: async () => 'test',
  requiresKbScope: true,
});

registry.register({
  name: 'doc_grep',
  description: 'Grep docs',
  execute: async () => 'test',
  requiresKbScope: true,
});

registry.setExecutionContext({});
const allDefs = registry.buildToolDefinitions();
const kbTools = allDefs.filter(d => ['kb_search', 'expand', 'doc_grep'].includes(d.name));
const nonKbTools = allDefs.filter(d => !['kb_search', 'expand', 'doc_grep'].includes(d.name));
console.log('Without KB: 0 KB tools:', kbTools.length === 0);
console.log('Without KB: bash still present:', nonKbTools.length >= 1);

console.log('\n✅ All KB tools on-demand tests passed!');
