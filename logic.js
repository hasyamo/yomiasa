/*
 * logic.js ― YOMIASA の純粋ロジック（state/DOM に依存しない部分）
 *
 * 目的：入力→出力が決まる関数をここに集め、テスト（node --test）で機械的に守る。
 *   - ブラウザ：<script src="logic.js"> で window.YomiasaLogic として読める（app.js より前に読み込む）
 *   - Node    ：require('./logic.js') で同じものが取れる（テストから使う）
 *
 * ここに置く条件：
 *   - グローバル state や document を直接触らない（必要な値は引数で受け取る）
 *   - 同じ入力なら必ず同じ出力（副作用なし）
 * DOM や fetch、state の書き換えを伴うものは app.js 側に残す。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api; // Node（テスト）
  } else {
    root.YomiasaLogic = api; // ブラウザ（app.js から参照）
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 既読・お気に入り共通のエントリキー。app.js の readKey と同じ規則。
  function entryKey(creatorId, articleId) {
    return creatorId + ':' + articleId;
  }

  // ---- 日付ユーティリティ（記事の publishedAt を扱う） ----

  function parseDate(publishedAt) {
    if (!publishedAt) return null;
    var d = new Date(publishedAt);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function yearOf(article) {
    var d = parseDate(article && article.publishedAt);
    return d ? d.getFullYear() : null;
  }

  function monthOf(article) {
    var d = parseDate(article && article.publishedAt);
    return d ? d.getMonth() + 1 : null;
  }

  // ---- お気に入り ----

  // 記事スナップショットを1件作る（favorites マップの値）。
  // article は { id, title, url, thumbnailUrl, publishedAt }。nowIso は呼び出し側が渡す。
  function makeFavoriteEntry(creatorId, article, nowIso) {
    return {
      creatorId: creatorId,
      articleId: article.id,
      title: article.title || '',
      url: article.url || '',
      thumbnailUrl: article.thumbnailUrl || '',
      publishedAt: article.publishedAt || '',
      favoritedAt: nowIso,
    };
  }

  function isFavorite(favorites, creatorId, articleId) {
    return !!(favorites && favorites[entryKey(creatorId, articleId)]);
  }

  // お気に入りを「追加した新しい順」で配列にする（横断ビューの初期並び）。
  // 入力 favorites は破壊しない。
  function favoritesSorted(favorites) {
    if (!favorites || typeof favorites !== 'object') return [];
    return Object.keys(favorites)
      .map(function (k) {
        return favorites[k];
      })
      .sort(function (a, b) {
        var ta = a && a.favoritedAt ? new Date(a.favoritedAt).getTime() : 0;
        var tb = b && b.favoritedAt ? new Date(b.favoritedAt).getTime() : 0;
        return tb - ta;
      });
  }

  function favoriteCount(favorites) {
    return favorites && typeof favorites === 'object' ? Object.keys(favorites).length : 0;
  }

  // ---- 記事フィルタ（純粋判定。state ではなく値を受け取る） ----
  //   ui   : { keyword, year, month, showUnreadOnly, showFavoritesOnly }
  //   flags: { read: boolean, favorite: boolean }（その記事が既読/お気に入りか）
  // 表示するなら true。app.js の applyFilters と同じ条件をここで判定する。
  function matchesFilters(article, ui, flags) {
    ui = ui || {};
    flags = flags || {};
    var keyword = (ui.keyword || '').trim().toLowerCase();
    if (keyword && (article.title || '').toLowerCase().indexOf(keyword) === -1) return false;
    if (ui.year !== 'all' && ui.year != null && String(yearOf(article)) !== String(ui.year))
      return false;
    if (ui.month !== 'all' && ui.month != null && String(monthOf(article)) !== String(ui.month))
      return false;
    if (ui.showUnreadOnly && flags.read) return false;
    if (ui.showFavoritesOnly && !flags.favorite) return false;
    return true;
  }

  // ---- ロード/インポート時のサニタイズ ----
  // favorites として妥当ならそのまま、そうでなければ空オブジェクトを返す。
  // 壊れた/欠損データで落ちないための防御。
  function sanitizeFavorites(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  return {
    entryKey: entryKey,
    parseDate: parseDate,
    yearOf: yearOf,
    monthOf: monthOf,
    makeFavoriteEntry: makeFavoriteEntry,
    isFavorite: isFavorite,
    favoritesSorted: favoritesSorted,
    favoriteCount: favoriteCount,
    matchesFilters: matchesFilters,
    sanitizeFavorites: sanitizeFavorites,
  };
});
