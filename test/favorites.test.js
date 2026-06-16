/*
 * お気に入り（⭐）の純ロジックのテスト。
 * 実行: npm test   （= node --test）
 *
 * ここで守るのは「データが壊れない・機能が壊れない」核の部分。
 * UI/見た目は TESTING.md のチェックリスト（手動＋AI検証）でカバーする。
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

// テスト用のダミー記事
const A1 = { id: 'a1', title: '意味は編集で生まれる', url: 'u1', publishedAt: '2026-01-20T07:00:00+09:00' };
const A2 = { id: 'a2', title: '死の谷を可視化した', url: 'u2', publishedAt: '2026-02-10T07:00:00+09:00' };

test('entryKey は creatorId:articleId の形', () => {
  assert.strictEqual(L.entryKey('kita', 'a1'), 'kita:a1');
});

test('makeFavoriteEntry は記事のスナップショットを作る', () => {
  const e = L.makeFavoriteEntry('kita', A1, '2026-06-16T00:00:00.000Z');
  assert.strictEqual(e.creatorId, 'kita');
  assert.strictEqual(e.articleId, 'a1');
  assert.strictEqual(e.title, '意味は編集で生まれる');
  assert.strictEqual(e.url, 'u1');
  assert.strictEqual(e.publishedAt, '2026-01-20T07:00:00+09:00');
  assert.strictEqual(e.favoritedAt, '2026-06-16T00:00:00.000Z');
});

test('makeFavoriteEntry は欠損フィールドを空文字で埋める', () => {
  const e = L.makeFavoriteEntry('kita', { id: 'x' }, '2026-06-16T00:00:00.000Z');
  assert.strictEqual(e.title, '');
  assert.strictEqual(e.url, '');
  assert.strictEqual(e.thumbnailUrl, '');
  assert.strictEqual(e.publishedAt, '');
});

test('isFavorite はキーの有無で判定', () => {
  const favs = { 'kita:a1': L.makeFavoriteEntry('kita', A1, 'z') };
  assert.strictEqual(L.isFavorite(favs, 'kita', 'a1'), true);
  assert.strictEqual(L.isFavorite(favs, 'kita', 'a2'), false);
  assert.strictEqual(L.isFavorite(favs, 'yume', 'a1'), false); // 別クリエイターは別物
});

test('isFavorite は favorites が空/未定義でも落ちない', () => {
  assert.strictEqual(L.isFavorite({}, 'kita', 'a1'), false);
  assert.strictEqual(L.isFavorite(null, 'kita', 'a1'), false);
  assert.strictEqual(L.isFavorite(undefined, 'kita', 'a1'), false);
});

test('favoritesSorted は追加日の新しい順（降順）', () => {
  const favs = {
    'k:a1': L.makeFavoriteEntry('k', A1, '2026-06-16T00:00:00.000Z'), // 古い
    'k:a2': L.makeFavoriteEntry('k', A2, '2026-06-16T05:00:00.000Z'), // 新しい
  };
  const sorted = L.favoritesSorted(favs);
  assert.strictEqual(sorted.length, 2);
  assert.strictEqual(sorted[0].articleId, 'a2'); // 新しいものが先頭
  assert.strictEqual(sorted[1].articleId, 'a1');
});

test('favoritesSorted は入力を破壊しない', () => {
  const favs = { 'k:a1': L.makeFavoriteEntry('k', A1, 'z') };
  const before = JSON.stringify(favs);
  L.favoritesSorted(favs);
  assert.strictEqual(JSON.stringify(favs), before);
});

test('favoritesSorted は空/不正入力で空配列', () => {
  assert.deepStrictEqual(L.favoritesSorted({}), []);
  assert.deepStrictEqual(L.favoritesSorted(null), []);
  assert.deepStrictEqual(L.favoritesSorted('x'), []);
});

test('favoriteCount は件数', () => {
  assert.strictEqual(L.favoriteCount({ 'k:a1': {}, 'k:a2': {} }), 2);
  assert.strictEqual(L.favoriteCount({}), 0);
  assert.strictEqual(L.favoriteCount(null), 0);
});

// ---- フィルタ（未読のみ / お気に入りのみ / AND） ----

test('matchesFilters: フィルタなしは常に true', () => {
  const ui = { keyword: '', year: 'all', month: 'all', showUnreadOnly: false, showFavoritesOnly: false };
  assert.strictEqual(L.matchesFilters(A1, ui, { read: false, favorite: false }), true);
});

test('matchesFilters: お気に入りのみ ON は favorite=true だけ通す', () => {
  const ui = { keyword: '', year: 'all', month: 'all', showUnreadOnly: false, showFavoritesOnly: true };
  assert.strictEqual(L.matchesFilters(A1, ui, { favorite: true }), true);
  assert.strictEqual(L.matchesFilters(A1, ui, { favorite: false }), false);
});

test('matchesFilters: 未読のみ ON は read=false だけ通す', () => {
  const ui = { keyword: '', year: 'all', month: 'all', showUnreadOnly: true, showFavoritesOnly: false };
  assert.strictEqual(L.matchesFilters(A1, ui, { read: false }), true);
  assert.strictEqual(L.matchesFilters(A1, ui, { read: true }), false);
});

test('matchesFilters: 未読のみ＋お気に入りのみ は AND（未読かつお気に入り）', () => {
  const ui = { keyword: '', year: 'all', month: 'all', showUnreadOnly: true, showFavoritesOnly: true };
  assert.strictEqual(L.matchesFilters(A1, ui, { read: false, favorite: true }), true); // 両方満たす
  assert.strictEqual(L.matchesFilters(A1, ui, { read: true, favorite: true }), false); // 既読で落ちる
  assert.strictEqual(L.matchesFilters(A1, ui, { read: false, favorite: false }), false); // 非お気に入りで落ちる
});

test('matchesFilters: 年・月・キーワードも効く（お気に入りと併用）', () => {
  const base = { keyword: '', year: 'all', month: 'all', showUnreadOnly: false, showFavoritesOnly: false };
  // A1 = 2026-01
  assert.strictEqual(L.matchesFilters(A1, { ...base, year: '2026' }, {}), true);
  assert.strictEqual(L.matchesFilters(A1, { ...base, year: '2025' }, {}), false);
  assert.strictEqual(L.matchesFilters(A1, { ...base, month: '1' }, {}), true);
  assert.strictEqual(L.matchesFilters(A1, { ...base, month: '2' }, {}), false);
  assert.strictEqual(L.matchesFilters(A1, { ...base, keyword: '編集' }, {}), true);
  assert.strictEqual(L.matchesFilters(A1, { ...base, keyword: 'ないよ' }, {}), false);
});

// ---- ロード/インポートの防御（データ事故を防ぐ） ----

test('sanitizeFavorites: 妥当なオブジェクトはそのまま', () => {
  const obj = { 'k:a1': {} };
  assert.strictEqual(L.sanitizeFavorites(obj), obj);
});

test('sanitizeFavorites: 不正値は空オブジェクトにフォールバック', () => {
  assert.deepStrictEqual(L.sanitizeFavorites(undefined), {}); // favorites が無い古いデータ
  assert.deepStrictEqual(L.sanitizeFavorites(null), {});
  assert.deepStrictEqual(L.sanitizeFavorites('壊れた'), {});
  assert.deepStrictEqual(L.sanitizeFavorites(123), {});
  assert.deepStrictEqual(L.sanitizeFavorites([1, 2]), {}); // 配列は不正
});

// ---- 日付ユーティリティ ----

test('parseDate / yearOf / monthOf', () => {
  assert.strictEqual(L.yearOf(A1), 2026);
  assert.strictEqual(L.monthOf(A1), 1);
  assert.strictEqual(L.parseDate(''), null);
  assert.strictEqual(L.parseDate('not-a-date'), null);
  assert.strictEqual(L.yearOf({ publishedAt: '' }), null);
});
