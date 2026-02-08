/**
 * Integration test for BrowshPage/BrowshBrowserContext/BrowshBrowser.
 *
 * Tests the REAL Playwright server-side classes against a running browsh instance.
 * Requires: browsh running with --remote-control --remote-control-port=3335
 *
 * This tests the full chain:
 *   WebSocketTransport → BrowshConnection → BrowshBrowser → BrowshBrowserContext → Page(BrowshPage)
 */

const { WebSocketTransport } = require('../../packages/playwright-core/lib/server/transport');
const { BrowshConnection } = require('../../packages/playwright-core/lib/server/browsh/browshConnection');
const { BrowshBrowser } = require('../../packages/playwright-core/lib/server/browsh/browshBrowser');

const BROWSH_WS = 'ws://127.0.0.1:3335';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \u2705 ${message}`);
    passed++;
  } else {
    console.log(`  \u274c ${message}`);
    failed++;
  }
}

async function run() {
  console.log('=== Browsh Playwright Integration Test ===\n');

  // --- 1. Test BrowshConnection ---
  console.log('--- BrowshConnection ---');
  let transport;
  try {
    transport = await WebSocketTransport.connect(undefined, BROWSH_WS);
    assert(true, 'WebSocketTransport.connect() succeeded');
  } catch (e) {
    console.log(`  \u274c WebSocketTransport.connect() failed: ${e.message}`);
    console.log('  Is browsh running with --remote-control?');
    process.exit(1);
  }

  const noopLogger = () => {};
  const logsCollector = { recentLogs: () => [], onMessage: () => {} };
  const connection = new BrowshConnection(transport, noopLogger, logsCollector);
  assert(connection._closed === false, 'BrowshConnection created and open');

  // Test version command
  try {
    const versionResult = await connection.send('version');
    assert(versionResult !== undefined, `version command returned: ${JSON.stringify(versionResult)}`);
  } catch (e) {
    assert(false, `version command failed: ${e.message}`);
  }

  // Test navigate
  try {
    const navResult = await connection.send('navigate', { url: 'https://example.com' });
    assert(true, 'navigate command succeeded');
  } catch (e) {
    assert(false, `navigate command failed: ${e.message}`);
  }

  // Wait for page load
  await new Promise(r => setTimeout(r, 3000));

  // Test get_state
  try {
    const state = await connection.send('get_state');
    assert(state && state.title === 'Example Domain', `get_state: title="${state?.title}"`);
    assert(state && state.url.includes('example.com'), `get_state: url="${state?.url}"`);
  } catch (e) {
    assert(false, `get_state failed: ${e.message}`);
  }

  // Test evaluate
  try {
    const title = await connection.send('evaluate', { expression: 'document.title' });
    assert(title === 'Example Domain', `evaluate: document.title="${title}"`);
  } catch (e) {
    assert(false, `evaluate failed: ${e.message}`);
  }

  // Test screenshot
  try {
    const screenshotData = await connection.send('screenshot');
    assert(screenshotData && typeof screenshotData === 'string' && screenshotData.length > 100,
      `screenshot: ${screenshotData?.length || 0} chars base64`);
  } catch (e) {
    assert(false, `screenshot failed: ${e.message}`);
  }

  // Test ARIA snapshot
  try {
    const snapshot = await connection.send('get_aria_snapshot');
    // Browsh returns {url, title, elements} or just the data directly
    const elements = snapshot?.elements || snapshot;
    const hasData = Array.isArray(elements) ? elements.length > 0 : !!snapshot;
    assert(hasData, `get_aria_snapshot: ${Array.isArray(elements) ? elements.length + ' elements' : typeof snapshot}`);
  } catch (e) {
    assert(false, `get_aria_snapshot failed: ${e.message}`);
  }

  connection.close();
  // Give transport time to close
  await new Promise(r => setTimeout(r, 500));
  assert(connection._closed === true, 'BrowshConnection closed');

  // --- 2. Test BrowshBrowser + BrowshBrowserContext ---
  console.log('\n--- BrowshBrowser + BrowshBrowserContext ---');

  let transport2;
  try {
    transport2 = await WebSocketTransport.connect(undefined, BROWSH_WS);
  } catch (e) {
    console.log(`  \u274c Second WebSocketTransport.connect() failed: ${e.message}`);
    printSummary();
    process.exit(failed > 0 ? 1 : 0);
  }

  const connection2 = new BrowshConnection(transport2, noopLogger, logsCollector);

  // Create a real Playwright instance — this sets up attribution.playwright properly
  const { createPlaywright } = require('../../packages/playwright-core/lib/server');
  const playwrightInstance = createPlaywright({ sdkLanguage: 'javascript', isInternalPlaywright: true });
  const rootSDK = playwrightInstance;

  const os = require('os');
  const path = require('path');
  const tmpDir = path.join(os.tmpdir(), 'browsh-test');
  const browserOptions = {
    name: 'browsh',
    isChromium: false,
    protocolLogger: noopLogger,
    browserLogsCollector: logsCollector,
    artifactsDir: path.join(tmpDir, 'artifacts'),
    downloadsPath: path.join(tmpDir, 'downloads'),
    tracesDir: path.join(tmpDir, 'traces'),
    persistent: undefined,
    headful: false,
    wsEndpoint: BROWSH_WS,
    originalLaunchOptions: {},
    sdkLanguage: 'javascript',
  };

  try {
    const browser = await BrowshBrowser.connect(rootSDK, connection2, browserOptions);
    assert(browser.isConnected(), 'BrowshBrowser.connect() succeeded, isConnected=true');
    assert(browser.version().length > 0, `browser.version()="${browser.version()}"`);
    assert(browser.userAgent() === 'Browsh', `browser.userAgent()="${browser.userAgent()}"`);

    // Create context
    const context = await browser.doCreateNewContext({});
    assert(context !== undefined, 'doCreateNewContext() returned a BrowshBrowserContext');
    assert(browser.contexts().length === 1, `browser.contexts().length=${browser.contexts().length}`);

    // Create page
    const page = await context.doCreateNewPage();
    assert(page !== undefined, 'doCreateNewPage() returned a Page');
    assert(context.possiblyUninitializedPages().length === 1,
      `context.possiblyUninitializedPages().length=${context.possiblyUninitializedPages().length}`);

    // Navigate via Page.delegate (BrowshPage)
    const delegate = page.delegate;
    const mainFrame = page.mainFrame();
    assert(mainFrame !== undefined, 'page.mainFrame() exists');

    try {
      const gotoResult = await delegate.navigateFrame(mainFrame, 'https://example.com', undefined);
      assert(gotoResult && gotoResult.newDocumentId, `navigateFrame returned documentId=${gotoResult?.newDocumentId?.substring(0, 8)}...`);
    } catch (e) {
      assert(false, `navigateFrame failed: ${e.message}`);
    }

    // Wait for browsh to load the page
    await new Promise(r => setTimeout(r, 3000));

    // Screenshot via delegate
    try {
      const screenshotBuf = await delegate.takeScreenshot(null, 'png', undefined, undefined, undefined, true, 'device');
      assert(Buffer.isBuffer(screenshotBuf) && screenshotBuf.length > 0,
        `takeScreenshot returned Buffer of ${screenshotBuf.length} bytes`);
    } catch (e) {
      assert(false, `takeScreenshot failed: ${e.message}`);
    }

    // Keyboard via delegate
    try {
      await delegate.rawKeyboard.sendText(null, 'hello');
      assert(true, 'rawKeyboard.sendText("hello") succeeded');
    } catch (e) {
      assert(false, `rawKeyboard.sendText failed: ${e.message}`);
    }

    // Close context
    try {
      await context.doClose(undefined);
      assert(true, 'context.doClose() succeeded');
    } catch (e) {
      assert(false, `context.doClose failed: ${e.message}`);
    }

    connection2.close();
    assert(true, 'Cleanup complete');

  } catch (e) {
    assert(false, `BrowshBrowser flow failed: ${e.message}\n    ${e.stack}`);
    connection2.close();
  }

  printSummary();
  process.exit(failed > 0 ? 1 : 0);
}

function printSummary() {
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests ===`);
}

run().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
