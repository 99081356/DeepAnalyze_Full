// Fixed retest for the 2 previously failing test cases
import http from 'node:http';
import fs from 'node:fs';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }));
    }).on('error', reject);
  });
}

async function main() {
  let passed = 0, failed = 0;

  // ===== FIXED TEST 11: Check ALL JS bundles =====
  console.log('===== FIXED TEST 11: Bundle Verification (all chunks) =====');
  const dir = '/mnt/d/code/deepanalyze/deepanalyze/frontend/dist/assets';
  const jsFiles = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

  let foundDaEvidence = false;
  let foundEvidenceLink = false;
  let foundDataEvidence = false;
  let targetFiles = [];

  for (const f of jsFiles) {
    const content = fs.readFileSync(dir + '/' + f, 'utf-8');
    const hasDa = content.includes('da-evidence');
    const hasLink = content.includes('evidence-link');
    const hasData = content.includes('data-evidence');
    if (hasDa || hasLink || hasData) {
      console.log(`  Found in ${f}: da-evidence=${hasDa}, evidence-link=${hasLink}, data-evidence=${hasData}`);
      if (hasDa) foundDaEvidence = true;
      if (hasLink) foundEvidenceLink = true;
      if (hasData) foundDataEvidence = true;
      targetFiles.push(f);
    }
  }

  if (foundDaEvidence && foundEvidenceLink && foundDataEvidence) {
    console.log(`  ✅ PASS: All evidence code found in bundle(s): ${targetFiles.join(', ')}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: Missing - da-evidence=${foundDaEvidence}, evidence-link=${foundEvidenceLink}, data-evidence=${foundDataEvidence}`);
    failed++;
  }

  // ===== FIXED TEST 10: Document preview with actual content =====
  console.log('\n===== FIXED TEST 10: Document Preview Panel =====');

  // Test turn anchor with real sectionContent
  console.log('--- Turn anchor (faae8dfc) ---');
  const turnResp = await fetchJSON('http://localhost:21000/api/preview/evidence/faae8dfc-4fb8-4581-a46a-72353df870d1%3Aturn%3A0');
  const td = turnResp.body;

  const turnChecks = {
    'previewType=document': td.previewType === 'document',
    'has sectionContent': Boolean(td.sectionContent) && td.sectionContent.length > 0,
    'has sectionTitle': Boolean(td.sectionTitle),
    'has highlightText': Boolean(td.highlightText),
    'has display info': Boolean(td.display && td.display.originalName),
  };

  for (const [name, ok] of Object.entries(turnChecks)) {
    console.log(`  ${name}: ${ok}`);
  }
  console.log(`  sectionTitle="${td.sectionTitle}"`);
  console.log(`  sectionContent length=${td.sectionContent?.length || 0}`);
  console.log(`  highlightText="${(td.highlightText || '').substring(0, 60)}"`);
  console.log(`  display=${JSON.stringify(td.display)}`);

  const turnAllOk = Object.values(turnChecks).every(Boolean);
  if (turnAllOk) {
    console.log('  ✅ PASS: Document preview works correctly for turn anchor');
    passed++;
  } else {
    console.log('  ❌ FAIL: Document preview incomplete for turn anchor');
    failed++;
  }

  // Test scene anchor with content
  console.log('\n--- Scene anchor (5e106f81) ---');
  const sceneResp = await fetchJSON('http://localhost:21000/api/preview/evidence/5e106f81-8898-49f0-89a2-3140eb335d08%3Ascene%3A0');
  const sd = sceneResp.body;

  const sceneOk = sd.previewType === 'document' && Boolean(sd.sectionContent);
  console.log(`  previewType=${sd.previewType}, hasContent=${Boolean(sd.sectionContent)}`);
  console.log(`  sectionContent="${(sd.sectionContent || '(none)').substring(0, 120)}"`);
  console.log(`  display=${JSON.stringify(sd.display)}`);
  if (sceneOk) {
    console.log('  ✅ PASS: Document preview works for scene anchor');
    passed++;
  } else {
    console.log('  ❌ FAIL: Scene anchor preview incomplete');
    failed++;
  }

  // Test unknown anchor without content (graceful fallback)
  console.log('\n--- Unknown anchor (fbacf138, no sectionContent) ---');
  const unkResp = await fetchJSON('http://localhost:21000/api/preview/evidence/fbacf138-c2d1-4610-9185-8c9e6fad28bf%3Aunknown%3A0');
  const ud = unkResp.body;

  const unkOk = ud.previewType === 'document' && Boolean(ud.display);
  console.log(`  previewType=${ud.previewType}, hasContent=${Boolean(ud.sectionContent)}`);
  console.log(`  display=${JSON.stringify(ud.display)}`);
  if (unkOk) {
    console.log('  ✅ PASS: Unknown anchor returns document type with display info (graceful)');
    passed++;
  } else {
    console.log('  ❌ FAIL: Unknown anchor handling incorrect');
    failed++;
  }

  // Test image anchor (still works correctly)
  console.log('\n--- Image anchor (3429dca3, POS机.jpg) ---');
  const imgResp = await fetchJSON('http://localhost:21000/api/preview/evidence/3429dca3-5e91-4130-931f-a3840214ab47%3Aimage%3A0');
  const id = imgResp.body;

  const imgOk = id.previewType === 'image' && Boolean(id.imageUrl) && Boolean(id.display?.originalName);
  console.log(`  previewType=${id.previewType}, imageUrl=${id.imageUrl}`);
  console.log(`  display=${JSON.stringify(id.display)}`);
  if (imgOk) {
    console.log('  ✅ PASS: Image preview works correctly');
    passed++;
  } else {
    console.log('  ❌ FAIL: Image preview incorrect');
    failed++;
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
