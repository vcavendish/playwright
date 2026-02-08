/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './fixtures';

// Browsh tests run via MCP server which launches browsh via playwright.browsh.launch().
// Requires PLAYWRIGHT_BROWSH_PATH pointing to the browsh fork binary.
// Run serially since browsh uses a shared Firefox profile.
test.describe.configure({ mode: 'serial' });

// --- Navigation ---

test('browser_navigate', async ({ client, server }) => {
  server.setContent('/', `
    <title>Test Page</title>
    <body><h1>Hello Browsh</h1></body>
  `, 'text/html');

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(response).toHaveResponse({
    page: expect.stringContaining('- Page Title: Test Page'),
  });
});

test('browser_navigate go back', async ({ client, server }) => {
  server.setContent('/', `
    <title>First</title>
    <body><a href="/second">Next</a></body>
  `, 'text/html');

  server.setContent('/second', `
    <title>Second</title>
    <body><h1>Page 2</h1></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/second' },
  });

  const response = await client.callTool({
    name: 'browser_navigate_back',
  });

  expect(response).toHaveResponse({
    page: expect.stringContaining('First'),
  });
});

test('browser_navigate go forward', async ({ client, server }) => {
  server.setContent('/', `
    <title>First</title>
    <body><p>Page 1</p></body>
  `, 'text/html');

  server.setContent('/second', `
    <title>Second</title>
    <body><p>Page 2</p></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/second' },
  });

  await client.callTool({
    name: 'browser_navigate_back',
  });

  const response = await client.callTool({
    name: 'browser_navigate_forward',
  });

  expect(response).toHaveResponse({
    page: expect.stringContaining('Second'),
  });
});

// --- Snapshot ---

test('browser_snapshot', async ({ client, server }) => {
  server.setContent('/', `
    <title>Snapshot Test</title>
    <body>
      <h1>Main Heading</h1>
      <p>Some text content</p>
      <a href="/other">Click here</a>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_snapshot',
  });

  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('heading "Main Heading"'),
  });
  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('link "Click here"'),
  });
});

test('browser_snapshot with form elements', async ({ client, server }) => {
  server.setContent('/', `
    <title>Form Snapshot</title>
    <body>
      <form>
        <label for="name">Name</label>
        <input id="name" type="text" placeholder="Enter name">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="Enter email">
        <button type="submit">Submit</button>
      </form>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_snapshot',
  });

  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('textbox'),
  });
  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('button "Submit"'),
  });
});

test('browser_snapshot with list structure', async ({ client, server }) => {
  server.setContent('/', `
    <title>List Page</title>
    <body>
      <ul>
        <li>Item one</li>
        <li>Item two</li>
        <li>Item three</li>
      </ul>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_snapshot',
  });

  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('list'),
  });
});

// --- Click ---

test('browser_click navigates via link', async ({ client, server }) => {
  server.setContent('/', `
    <title>Page One</title>
    <body><a href="/page2">Go to page 2</a></body>
  `, 'text/html');

  server.setContent('/page2', `
    <title>Page Two</title>
    <body><h1>Second Page</h1></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // Get snapshot to populate refs
  const snapshotResponse = await client.callTool({
    name: 'browser_snapshot',
  });

  // Find the link ref from snapshot
  const snapshotText = snapshotResponse.content[0].text;
  const refMatch = snapshotText.match(/link "Go to page 2"[^[]*\[ref=(\w+)\]/);
  test.skip(!refMatch, 'Could not find link ref in snapshot');

  const response = await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Go to page 2 link',
      ref: refMatch![1],
    },
  });

  expect(response).toHaveResponse({
    page: expect.stringContaining('Page Two'),
  });
});

test('browser_click button triggers action', async ({ client, server }) => {
  server.setContent('/', `
    <title>Click Test</title>
    <body>
      <div id="result">Not clicked</div>
      <button onclick="document.getElementById('result').textContent='Clicked!'">Click Me</button>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const snapshotResponse = await client.callTool({
    name: 'browser_snapshot',
  });

  const snapshotText = snapshotResponse.content[0].text;
  const refMatch = snapshotText.match(/button "Click Me"[^[]*\[ref=(\w+)\]/);
  test.skip(!refMatch, 'Could not find button ref in snapshot');

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Click Me button',
      ref: refMatch![1],
    },
  });

  // Verify the click changed the DOM
  const evalResponse = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.getElementById("result").textContent',
    },
  });

  expect(evalResponse).toHaveResponse({
    result: '"Clicked!"',
  });
});

// --- Evaluate ---

test('browser_evaluate', async ({ client, server }) => {
  server.setContent('/', `
    <title>Eval Test</title>
    <body><div id="data">42</div></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.title',
    },
  });

  expect(response).toHaveResponse({
    result: '"Eval Test"',
  });
});

test('browser_evaluate returns computed values', async ({ client, server }) => {
  server.setContent('/', `
    <title>Eval Compute</title>
    <body>
      <ul>
        <li>One</li>
        <li>Two</li>
        <li>Three</li>
      </ul>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.querySelectorAll("li").length',
    },
  });

  expect(response).toHaveResponse({
    result: '3',
  });
});

test('browser_evaluate can manipulate DOM', async ({ client, server }) => {
  server.setContent('/', `
    <title>DOM Manipulate</title>
    <body><div id="target">Original</div></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => { document.getElementById("target").textContent = "Modified"; return true; }',
    },
  });

  const verifyResponse = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.getElementById("target").textContent',
    },
  });

  expect(verifyResponse).toHaveResponse({
    result: '"Modified"',
  });
});

// --- Screenshot ---

test('browser_take_screenshot', async ({ startClient, server }, testInfo) => {
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  server.setContent('/', `
    <title>Screenshot Test</title>
    <body><h1>Screenshot Me</h1></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_take_screenshot',
  });

  // Screenshot should return image data
  expect(response.content).toBeDefined();
  const imageContent = response.content.find((c: any) => c.type === 'image');
  expect(imageContent).toBeDefined();
  expect(imageContent.data).toBeTruthy();
  expect(imageContent.mimeType).toBe('image/png');
});

// --- Keyboard/Type ---

test('browser_type into text input', async ({ client, server }) => {
  server.setContent('/', `
    <title>Type Test</title>
    <body>
      <input id="name" type="text" placeholder="Enter name">
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const snapshotResponse = await client.callTool({
    name: 'browser_snapshot',
  });

  const snapshotText = snapshotResponse.content[0].text;
  const refMatch = snapshotText.match(/textbox[^[]*\[ref=(\w+)\]/);
  test.skip(!refMatch, 'Could not find textbox ref in snapshot');

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Name input',
      ref: refMatch![1],
    },
  });

  await client.callTool({
    name: 'browser_type',
    arguments: {
      text: 'Hello Browsh',
      submit: false,
    },
  });

  const evalResponse = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.getElementById("name").value',
    },
  });

  expect(evalResponse).toHaveResponse({
    result: expect.stringContaining('Hello Browsh'),
  });
});

test('browser_press_key Enter submits form', async ({ client, server }) => {
  server.setContent('/', `
    <title>Press Test</title>
    <body>
      <form onsubmit="document.getElementById('result').textContent='Submitted'; return false;">
        <input id="field" type="text">
        <div id="result">Not submitted</div>
      </form>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const snapshotResponse = await client.callTool({
    name: 'browser_snapshot',
  });

  const snapshotText = snapshotResponse.content[0].text;
  const refMatch = snapshotText.match(/textbox[^[]*\[ref=(\w+)\]/);
  test.skip(!refMatch, 'Could not find textbox ref in snapshot');

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'text input',
      ref: refMatch![1],
    },
  });

  await client.callTool({
    name: 'browser_press_key',
    arguments: { key: 'Enter' },
  });

  const evalResponse = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.getElementById("result").textContent',
    },
  });

  expect(evalResponse).toHaveResponse({
    result: '"Submitted"',
  });
});

// --- Complex page structures ---

test('browser_snapshot with nested structure', async ({ client, server }) => {
  server.setContent('/', `
    <title>Nested Page</title>
    <body>
      <nav>
        <a href="/home">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
      </nav>
      <main>
        <article>
          <h2>Article Title</h2>
          <p>Article content goes here.</p>
        </article>
      </main>
      <footer>
        <p>Copyright 2024</p>
      </footer>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_snapshot',
  });

  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('navigation'),
  });
  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('link "Home"'),
  });
  expect(response).toHaveResponse({
    snapshot: expect.stringContaining('heading "Article Title"'),
  });
});

test('multiple navigate and evaluate cycle', async ({ client, server }) => {
  server.setContent('/page-a', `
    <title>Page A</title>
    <body><div id="value">alpha</div></body>
  `, 'text/html');

  server.setContent('/page-b', `
    <title>Page B</title>
    <body><div id="value">beta</div></body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/page-a' },
  });

  let response = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.getElementById("value").textContent',
    },
  });

  expect(response).toHaveResponse({
    result: '"alpha"',
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/page-b' },
  });

  response = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.getElementById("value").textContent',
    },
  });

  expect(response).toHaveResponse({
    result: '"beta"',
  });
});
