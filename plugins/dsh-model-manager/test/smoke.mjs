import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeOpencodeModel, normalizeDisplayName, routeKey, refNameFor, protocolFor } from '../lib/sources.js';
import { isChatModel, buildPlan, mergeRoutes } from '../lib/manager.js';
import { writeState, readState, defaultStatePath } from '../lib/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
})
