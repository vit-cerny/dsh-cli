import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeOpencodeModel, normalizeDisplayName, opencodeConfigPaths, routeKey, refNameFor, protocolFor } from '../lib/sources.js';
import { isChatModel, buildPlan, mergeRoutes } from '../lib/manager.js';
import { redactPlan } from '../lib/index.js';
import { writeState, readState, defaultStatePath } from '../lib/store.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('dsh-model-manager smoke', () => {
  it('normalizes an opencode model row', () => {
    const row = normalizeOpencodeModel('gpt-5', { name: 'GPT-5', limit: { context: 128000, output: 8192 }, capabilities: { input: ['text', 'image'], reasoning: { supported: true, effort: ['low', 'high'] } } })
    assert.equal(row.id, 'gpt-5')
    assert.equal(row.name, 'GPT-5')
    assert.equal(row.contextWindow, 128000)
    assert.equal(row.maxTokens, 8192)
    assert.deepEqual(row.input, ['text', 'image'])
    assert.ok(row.reasoningEfforts)
  })

  it('routeKey is lowercase hyphenated', () => {
    assert.equal(routeKey('OpenAI Codex'), 'openai-codex')
  })

  it('replaces corrupted or unbounded display names', () => {
    assert.equal(normalizeDisplayName('Ãƒ broken', '7api'), '7api')
    assert.equal(normalizeDisplayName('x'.repeat(121), '7api'), '7api')
    assert.equal(normalizeDisplayName('7API', 'fallback'), '7API')
  })

  it('refNameFor produces env-style name', () => {
    assert.equal(refNameFor('my-gateway'), 'MY_GATEWAY_API_KEY')
  })

  it('protocolFor maps packages', () => {
    assert.equal(protocolFor('@ai-sdk/anthropic'), 'anthropic-messages')
    assert.equal(protocolFor('openai-compatible'), 'openai-completions')
  })

  it('isChatModel filters non-chat', () => {
    assert.equal(isChatModel('text-embedding-3', { name: 'Embedding' }), false)
    assert.equal(isChatModel('gpt-5', { name: 'GPT-5' }), true)
  })

  it('buildPlan handles empty input', () => {
    const plan = buildPlan([], { existingProviders: {} })
    assert.deepEqual(plan.routes, {})
    assert.equal(plan.summary.routes, 0)
  })

  it('re-import repairs a corrupt existing provider label', () => {
    const plan = buildPlan([{
      kind: 'provider', sourceId: 'opencode', foreignId: '7api', displayName: '7api',
      protocol: 'openai-responses', baseURL: 'https://gateway.example/v1', models: [{ id: 'gpt-6', name: 'GPT-6' }],
    }], {
      existingProviders: {
        '7api': { displayName: 'Ãƒ'.repeat(200), api: 'openai-responses', baseURL: 'https://gateway.example/v1', models: [] },
      },
    })
    assert.equal(plan.routes['7api'].displayName, '7api')
  })

  it('redacts API keys, environment values and OAuth grants from import plans', () => {
    const result = buildPlan([
      {
        kind: 'provider', sourceId: 'opencode', foreignId: 'example',
        apiKey: 'api-key-test-value', models: [{ id: 'chat-model' }],
      },
      {
        kind: 'oauth', sourceId: 'codex', foreignId: 'openai-codex',
        grant: { access: 'oauth-access-test-value', refresh: 'oauth-refresh-test-value' },
      },
      {
        kind: 'env', sourceId: 'env', foreignId: '.env',
        entries: { EXAMPLE_API_KEY: 'environment-test-value' },
      },
    ]);
    const safe = redactPlan(result);
    const serialized = JSON.stringify(safe);
    assert.equal(safe.summary.credentials, 3);
    assert.deepEqual(safe.envRefs.map(({ ref }) => ref), ['EXAMPLE_API_KEY']);
    assert.equal(safe.routes.example.models[0].id, 'chat-model');
    assert.equal('apiKey' in safe.routes.example, false);
    for (const secret of ['api-key-test-value', 'oauth-access-test-value', 'oauth-refresh-test-value', 'environment-test-value']) {
      assert.equal(serialized.includes(secret), false);
      assert.equal(JSON.stringify(result).includes(secret), true);
    }
  })

  it('mergeRoutes merges providers', () => {
    const merged = mergeRoutes({}, { foo: { models: [{ id: 'm1' }] } })
    assert.ok(merged.providers.foo)
  })

  it('store round-trips state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-'))
    const path = join(dir, 'state.json')
    writeState({ disabledRoutes: {}, disabledModels: {}, envPaths: [] }, path)
    const read = readState(path)
    assert.deepEqual(read.disabledRoutes, {})
    rmSync(dir, { recursive: true, force: true })
  })

  it('maps both opencode package keys to a protocol', () => {
    // V1 opencode configs declare `npm`, V2 declares `package`; reading only one
    // silently downgraded every provider to chat-completions.
    assert.equal(protocolFor('@ai-sdk/anthropic'), 'anthropic-messages')
    assert.equal(protocolFor('@ai-sdk/openai'), 'openai-completions')
    assert.equal(protocolFor(undefined), 'openai-completions')
  })

  it('reads every opencode config file, not just the first', () => {
    // opencode.json and opencode.jsonc can each hold different providers.
    const dir = mkdtempSync(join(tmpdir(), 'mm-config-'))
    const json = join(dir, 'opencode.json')
    const jsonc = join(dir, 'opencode.jsonc')
    writeFileSync(json, JSON.stringify({ provider: { fromJson: { npm: '@ai-sdk/openai', models: { a: {} } } } }))
    writeFileSync(jsonc, JSON.stringify({ provider: { fromJsonc: { npm: '@ai-sdk/anthropic', models: { b: {} } } } }))
    const paths = opencodeConfigPaths([dir])
    assert.deepEqual(paths.sort(), [json, jsonc].sort())
    rmSync(dir, { recursive: true, force: true })
  })
})
