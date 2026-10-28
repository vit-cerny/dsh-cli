import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../src/cli/args.js';
import { parseLlmRoutes, parseMcpServers, runInfoCommand } from '../src/cli/info.js';

function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}

test('--json is accepted after an info subcommand', () => {
  const parsed = parseArgs(['--profile', 'desktop', 'models', '--json']);
  assert.equal(parsed.command.name, 'models');
  assert.equal(parsed.options.profile, 'desktop');
  assert.equal(parsed.options.json, true);
});

test('model inventory ignores nested input modality lists', () => {
  const routes = parseLlmRoutes(`
- id: llm-pi-ai
  config:
    providers:
      example:
        apiKeyEnv: EXAMPLE_KEY
        models:
          - id: model-a
            input:
              - text
              - image
          - id: model-b
            input:
              - text
`);

  assert.deepEqual(routes[0].models.map(({ id }) => id), ['model-a', 'model-b']);
});

test('literal credential values never escape inventory parsing', () => {
  const secret = 'never-print-this-secret';
  const routes = parseLlmRoutes(`
- id: llm-pi-ai
  config:
    providers:
      example:
        apiKey: ${secret}
        models:
          - id: model-a
`);

  assert.equal(routes[0].apiKeyEnv, '<literal apiKey in patch>');
  assert.doesNotMatch(JSON.stringify(routes), new RegExp(secret));
});

test('MCP inventory extracts server names from a profile patch', () => {
  assert.deepEqual(
    parseMcpServers(`
- id: mcp-config
  config:
    servers:
      github:
        command: npx
      filesystem:
        command: node
`),
    ['github', 'filesystem'],
  );
});

test('mcp inventory with no configured servers prints an empty-list message', () => {
  const stdout = capture();
  const code = runInfoCommand(
    { dshHome: 'C:\\missing-dsh-home', profile: 'desktop', provider: 'example', model: 'example' },
    'mcp',
    { stdout },
  );

  assert.equal(code, 0);
  assert.match(stdout.text, /no MCP servers configured/);
  assert.doesNotMatch(stdout.text, /not iterable|undefined/);
});
