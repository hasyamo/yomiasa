/*
 * インポート（貼り付けたデータで上書き）の受け付け判定のテスト。
 * 実行: npm test   （= node --test）
 *
 * ここで守るのは「形の違うものを貼っても、今のデータが空で上書きされない」こと。
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

const STATE = { creators: [{ id: 'c1', displayName: 'はしゃも' }], readArticles: {}, favorites: {} };

test('エクスポート形式（app と state つき）は、その state を返す', () => {
  const parsed = { app: 'yomiasa', version: '0.1.15', exportedAt: '2026-10-27T00:00:00Z', state: STATE };
  assert.strictEqual(L.importableState(parsed), STATE);
});

test('state の直貼り（creators が配列）も受け付ける', () => {
  assert.strictEqual(L.importableState(STATE), STATE);
});

test('creators が空の配列でも、形が正しければ受け付ける', () => {
  const empty = { creators: [] };
  assert.strictEqual(L.importableState({ app: 'yomiasa', state: empty }), empty);
});

test('{} と [] は受け付けない', () => {
  assert.strictEqual(L.importableState({}), null);
  assert.strictEqual(L.importableState([]), null);
});

test('state が {}・[]・null のエクスポート形式は受け付けない', () => {
  assert.strictEqual(L.importableState({ app: 'yomiasa', state: {} }), null);
  assert.strictEqual(L.importableState({ app: 'yomiasa', state: [] }), null);
  assert.strictEqual(L.importableState({ app: 'yomiasa', state: null }), null);
});

test('別のアプリのデータは受け付けない', () => {
  assert.strictEqual(L.importableState({ app: 'ohayomi', state: STATE }), null);
});

test('creators が無い・配列でないものは受け付けない', () => {
  assert.strictEqual(L.importableState({ readArticles: {} }), null);
  assert.strictEqual(L.importableState({ creators: {} }), null);
});

test('数値・文字列・null は受け付けない', () => {
  assert.strictEqual(L.importableState(1), null);
  assert.strictEqual(L.importableState('{}'), null);
  assert.strictEqual(L.importableState(null), null);
});
