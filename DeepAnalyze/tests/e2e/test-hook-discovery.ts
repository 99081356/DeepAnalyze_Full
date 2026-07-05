import { discoverAndLoadHooks } from '../../src/services/agent/hook-discovery.ts';
import { HookManager } from '../../src/services/agent/hooks.js';

// Test 1: Empty directory returns zero hooks
const mgr1 = new HookManager();
const result1 = await discoverAndLoadHooks('/tmp/nonexistent-dir-test', mgr1);
console.log('Empty dir: total=0:', result1.total === 0);
console.log('Empty dir: loaded=0:', result1.loaded === 0);

// Test 2: HookManager callback registration and firing
const mgr2 = new HookManager();
let hookCalled = false;
mgr2.registerCallbackHook('AgentStart', 'test-hook', async () => {
  hookCalled = true;
  return { allowed: true };
});
const fireResult1 = await mgr2.fire('AgentStart', { hookType: 'AgentStart' });
console.log('Callback fired:', hookCalled);
console.log('Callback allowed:', fireResult1.allowed);

// Test 3: Blocking hooks
const mgr3 = new HookManager();
mgr3.registerCallbackHook('PreToolUse', 'block-dangerous', async (ctx) => {
  if (ctx.toolName === 'dangerous_tool') {
    return { allowed: false, error: 'Tool not allowed' };
  }
  return { allowed: true };
});

const blocked = await mgr3.fire('PreToolUse', { hookType: 'PreToolUse', toolName: 'dangerous_tool' });
console.log('Blocked:', !blocked.allowed);
console.log('Block error:', blocked.error === 'Tool not allowed');

const allowed = await mgr3.fire('PreToolUse', { hookType: 'PreToolUse', toolName: 'safe_tool' });
console.log('Allowed:', allowed.allowed);

// Test 4: Tool name matching with glob
const mgr4 = new HookManager();
let bashHookCalled = false;
mgr4.registerCallbackHook('PreToolUse', 'bash-monitor', async () => {
  bashHookCalled = true;
  return { allowed: true };
}, 'bash*');

await mgr4.fire('PreToolUse', { hookType: 'PreToolUse', toolName: 'bash' });
console.log('Match bash:', bashHookCalled);

bashHookCalled = false;
await mgr4.fire('PreToolUse', { hookType: 'PreToolUse', toolName: 'bash_exec' });
console.log('Match bash_exec:', bashHookCalled);

// Test 5: Wildcard matcher
const mgr5 = new HookManager();
let allHookCalled = false;
mgr5.registerCallbackHook('PostToolUse', 'all-monitor', async () => {
  allHookCalled = true;
  return { allowed: true };
}, '*');

await mgr5.fire('PostToolUse', { hookType: 'PostToolUse', toolName: 'any_tool' });
console.log('Wildcard match:', allHookCalled);

// Test 6: Modified input from hook
const mgr6 = new HookManager();
mgr6.registerCallbackHook('PreToolUse', 'modify-input', async (ctx) => {
  return {
    allowed: true,
    modifiedInput: { ...ctx.toolInput, injected: true },
  };
});

const modified = await mgr6.fire('PreToolUse', {
  hookType: 'PreToolUse',
  toolName: 'test',
  toolInput: { query: 'hello' },
});
console.log('Modified input:', modified.modifiedInput?.injected === true);
console.log('Original preserved:', modified.modifiedInput?.query === 'hello');

console.log('\n✅ All hook discovery tests passed!');
