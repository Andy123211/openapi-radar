const assert = require('node:assert/strict');
const test = require('node:test');
const { parseChangeReport, renderChangeReport, specExtension } = require('../.test-build/src/report.js');

test('accepts the CLI no-change response and reports zero changes', () => {
  assert.deepEqual(
    parseChangeReport('{"message":"No changes found between specifications"}'),
    { changes: [], totalChanges: 0, breakingCount: 0 }
  );
});

test('validates report details against per-section summary counts', () => {
  const text = JSON.stringify({
    reportSummary: {
      info: { totalChanges: 1, breakingChanges: 0 },
      paths: { totalChanges: 1, breakingChanges: 1 }
    },
    changes: [
      { breaking: false, change: 1, property: 'title', type: 'Info', original: 'Old', new: 'New' },
      { breaking: true, change: 2, path: '/paths/~1v1/get', property: 'responses', type: 'Operation' }
    ]
  });

  const report = parseChangeReport(text);
  assert.equal(report.totalChanges, 2);
  assert.equal(report.breakingCount, 1);
});

test('fails closed on malformed JSON, missing fields, and inconsistent counts', () => {
  const malformed = [
    '{not json',
    'null',
    '[]',
    '{"reportSummary":{},"changes":{}}',
    '{"reportSummary":{},"changes":[]}',
    '{"changes":[]}',
    '{"reportSummary":{"paths":{"totalChanges":-1,"breakingChanges":0}},"changes":[]}',
    '{"reportSummary":{"paths":{"totalChanges":0,"breakingChanges":1}},"changes":[]}',
    '{"reportSummary":{"paths":{"totalChanges":1,"breakingChanges":0}},"changes":[]}',
    '{"reportSummary":{"paths":{"totalChanges":1,"breakingChanges":0}},"changes":[{}]}',
    '{"reportSummary":{"paths":{"totalChanges":1,"breakingChanges":0}},"changes":[{"breaking":false,"property":4}]}',
    '{"reportSummary":{"paths":{"totalChanges":1,"breakingChanges":0}},"changes":[{"breaking":false,"property":null}]}'
  ];
  for (const text of malformed) assert.throws(() => parseChangeReport(text));
});

test('keeps untrusted Markdown metadata inside escaped inline code spans', () => {
  const maliciousText = '@everyone `\n\n## injected heading';
  const parsed = parseChangeReport(JSON.stringify({
    reportSummary: { paths: { totalChanges: 1, breakingChanges: 1 } },
    changes: [{ breaking: true, changeText: maliciousText, path: maliciousText, property: maliciousText, type: maliciousText }]
  }));
  const markdown = renderChangeReport(parsed, maliciousText, 'abcdef123456', '123456abcdef').markdown;
  assert.match(markdown, /`` @everyone ` ## injected heading ``/);
  assert.doesNotMatch(markdown, /\n\n## injected heading/);
});

test('derives base and head spec suffixes independently and defaults extensionless paths', () => {
  assert.equal(specExtension('api/openapi.json'), '.json');
  assert.equal(specExtension('api/openapi.yaml'), '.yaml');
  assert.equal(specExtension('api/openapi'), '.yaml');
  assert.equal(specExtension('.openapi'), '.yaml');
});
