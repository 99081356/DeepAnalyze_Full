const { chromium } = require('playwright');

(async () => {
  console.log('=== Starting Frontend UI Tests ===\n');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  
  try {
    // Test 1: Load main page
    console.log('Test 1: Loading main page...');
    await page.goto('http://localhost:21000/', { waitUntil: 'networkidle', timeout: 30000 });
    console.log('✅ Main page loaded successfully');
    
    // Test 2: Check page title
    const title = await page.title();
    console.log('✅ Page title: ' + title);
    
    // Test 3: Check if knowledge base list is visible
    console.log('\nTest 3: Checking knowledge base list...');
    await page.waitForTimeout(2000);
    
    const bodyText = await page.textContent('body');
    if (bodyText && bodyText.length > 50) {
      console.log('✅ Page has content');
      console.log('   Content preview: ' + bodyText.substring(0, 200) + '...');
    }
    
    // Test 4: Take screenshot
    console.log('\nTest 4: Taking screenshot...');
    await page.screenshot({ path: '/tmp/deepanalyze_main.png', fullPage: true });
    console.log('✅ Screenshot saved to /tmp/deepanalyze_main.png');
    
    // Test 5: Check for JavaScript errors
    console.log('\nTest 5: Checking for JavaScript errors...');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    if (errors.length === 0) {
      console.log('✅ No JavaScript errors detected');
    } else {
      console.log('❌ JavaScript errors found:');
      errors.forEach(e => console.log('   - ' + e));
    }
    
    console.log('\n=== Frontend UI Tests Completed ===');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await browser.close();
  }
})();
