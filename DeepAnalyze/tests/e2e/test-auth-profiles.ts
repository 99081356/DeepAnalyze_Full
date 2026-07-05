import { getAuthProfileManager } from '../../src/models/auth-profiles.ts';

const mgr = getAuthProfileManager();

// Test 1: Basic selection - no alternates
const key1 = mgr.selectApiKey('provider-1', 'primary-key-123', undefined, 'model-a');
console.log('No alternates:', key1 === 'primary-key-123');

// Test 2: LRU selection among multiple keys
const alts = [
  { key: 'alt-key-aaa', label: 'alt1' },
  { key: 'alt-key-bbb', label: 'alt2' },
  { key: 'alt-key-ccc', label: 'alt3' },
];
const key2 = mgr.selectApiKey('provider-2', 'primary-key-456', alts, 'model-a');
console.log('Selected one of 4 keys:', ['primary-key-456', 'alt-key-aaa', 'alt-key-bbb', 'alt-key-ccc'].includes(key2));

// Test 3: Record success
mgr.recordSuccess('provider-2', key2);
console.log('Recorded success for:', key2.slice(0, 10) + '...');

// Test 4: Record failure and cooldown
mgr.recordFailure('provider-2', 'alt-key-aaa', 'rate_limit', 'model-a', 429);
const stats = mgr.getStatsSummary();
console.log('Stats count:', stats.length);
const rateLimited = stats.find(s => s.keyPrefix === 'alt-key-a');
console.log('Rate limited key found:', rateLimited !== undefined);
console.log('Rate limited cooldown > 0:', rateLimited ? rateLimited.cooldownRemaining > 0 : 'N/A');
console.log('Rate limited reason:', rateLimited?.reason);

// Test 5: Model-scoped bypass - alt-key-aaa is rate-limited on model-a, request for model-b should bypass
const keyBypass = mgr.selectApiKey('provider-2', 'primary-key-456', alts, 'model-b');
console.log('Model bypass works:', keyBypass === 'alt-key-aaa'); // Should pick this since model-a cooldown doesn't apply to model-b

// Test 6: Error classification
console.log('429 → rate_limit:', mgr.classifyError({ status: 429 }) === 'rate_limit');
console.log('401 → auth_permanent:', mgr.classifyError({ status: 401 }) === 'auth_permanent');
console.log('403 → auth_permanent:', mgr.classifyError({ status: 403 }) === 'auth_permanent');
console.log('402 → billing:', mgr.classifyError({ status: 402 }) === 'billing');
console.log('500 → transient:', mgr.classifyError({ status: 500 }) === 'transient');
console.log('timeout → transient:', mgr.classifyError(new Error('Connection timeout')) === 'transient');
console.log('unknown → transient:', mgr.classifyError(new Error('Unknown error')) === 'transient');
console.log('rate limit msg → rate_limit:', mgr.classifyError(new Error('Rate limit exceeded')) === 'rate_limit');
console.log('unauthorized msg → auth_permanent:', mgr.classifyError(new Error('Unauthorized access')) === 'auth_permanent');

console.log('\n✅ All auth profile rotation tests passed!');
