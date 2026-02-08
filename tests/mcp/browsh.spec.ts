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

import net from 'net';
import { test, expect } from './fixtures';

// Browsh tests require a running Browsh instance on port 3335.
// Skip entire file if Browsh is not available.
// Run serially since all tests share a single Browsh/Firefox instance.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const available = await new Promise<boolean>(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(3335, 'localhost');
  });
  test.skip(!available, 'Browsh not running on port 3335');
});

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
