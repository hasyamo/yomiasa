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

  // ===========================================================================
  // モードエンジン（キタコレ等）の純ロジック。
  //   state/DOM に依存しない。ランク・ボス・クイズの配列/フラグを引数で受ける。
  //   定数（RANKS/BOSSES）は各モードで異なるため logic 内に固定せず app.js から渡す。
  // ===========================================================================

  // ---- A群: 完全純粋（app.js からそのまま移設） ----

  // HTML からタグを除去し最低限の実体参照をデコードして素テキストにする。
  // app.js の stripHtml と完全同一実装。
  function stripHtml(html) {
    return String(html)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // テキスト中の「ワイ」出現数。
  //   正規表現は関数内でリテラル生成する（g フラグ共有インスタンスの lastIndex 事故を防ぐ）。
  //   match 方式でカウント（exec/test に書き換えない）。
  function countWai(text) {
    return (String(text).match(/ワイ/g) || []).length;
  }

  // 記事 URL からスラッグ（note key）を抜く。失敗時 null。
  //   app.js の articleKeyFromUrl と同一正規表現。
  function articleKeyFromUrl(url) {
    var m = String(url || '').match(/\/n\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  // ---- B群: 配列/フラグを引数化して純化（creatorId 依存を除去） ----

  // ワイ数がどのランク閾値に達しているか（ボス出現トリガー判定用）。
  //   ranks = 覚醒後ランク閾値テーブル（min 昇順）。
  function kitacoreWaiRankOf(ranks, totalWai) {
    var cur = ranks[0];
    for (var i = 0; i < ranks.length; i++) {
      if (totalWai >= ranks[i].min) cur = ranks[i];
    }
    return cur;
  }

  // 覚醒後ランク = 撃破済みの覚醒後ボスから導出。
  //   ranks = 覚醒後ランク閾値テーブル、postBosses = 覚醒後ボス定義、defeated = 撃破済み key 配列。
  //   ワイ数が閾値を超えてもボスを倒すまでランクは上がらない（撃破ベース）。
  function kitacoreRankOf(ranks, postBosses, defeated) {
    defeated = Array.isArray(defeated) ? defeated : [];
    var cur = ranks[0]; // S級覚醒がデフォルト
    postBosses.forEach(function (boss) {
      if (defeated.indexOf(boss.key) !== -1) {
        var rank = ranks.find(function (r) { return r.rank === boss.rankAfter; });
        if (rank && ranks.indexOf(rank) > ranks.indexOf(cur)) cur = rank;
      }
    });
    return cur;
  }

  // 覚醒済みか＝覚醒前の最終ボス(awakenBossKey)を撃破済み。
  //   awakenBossKey==null なら覚醒概念なしモード → 常に false。
  //   ※ creatorId 文字列を誤って渡すと String.indexOf 誤判定になるため defeated は配列で受ける。
  function isPostAwakening(defeated, awakenBossKey) {
    if (awakenBossKey == null) return false;
    defeated = Array.isArray(defeated) ? defeated : [];
    return defeated.indexOf(awakenBossKey) !== -1;
  }

  // 次に挑むべき覚醒前ボス（未撃破の先頭）。全撃破なら null。
  //   preBosses = 覚醒前ボス定義（order 順）、defeated = 撃破済み key 配列。
  //   戻り値は rankBefore/rankBeforeKey を含むボスオブジェクト。
  function nextPreBoss(preBosses, defeated) {
    defeated = Array.isArray(defeated) ? defeated : [];
    for (var i = 0; i < preBosses.length; i++) {
      if (defeated.indexOf(preBosses[i].key) === -1) return preBosses[i];
    }
    return null;
  }

  // ---- C群: クイズ（正規化＝ジュリ確定形） ----

  // クイズ1問を正規形へ変換する。
  //   正規形: { q, choices: [ { text, result:'success'|'wrong'|'wrong_funny', reaction }, ... ] }
  //   - answer:index 形式:  choices[i] => { text: choices[i], result: i===answer?'success':'wrong', reaction:'' }
  //   - 新形式（result/reaction 直書き）: そのまま採用（両対応）
  //   ★並び順は変えない（シャッフルは app.js openQuiz の責務。正規化＝並び固定と誤解しない）。
  //   answer 範囲外は全 wrong（例外を出さない）。
  function normalizeQuiz(raw) {
    if (!raw || typeof raw !== 'object') return { q: '', choices: [] };
    var q = raw.q != null ? raw.q : '';
    var rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
    var hasAnswer = typeof raw.answer === 'number';
    var choices = rawChoices.map(function (c, i) {
      if (c && typeof c === 'object') {
        // 新形式（result/reaction 直書き）をそのまま採用。
        return {
          text: c.text != null ? c.text : '',
          result: c.result != null ? c.result : 'wrong',
          reaction: c.reaction != null ? c.reaction : '',
        };
      }
      // answer:index 形式。範囲外 answer のときは全 wrong になる。
      return {
        text: c,
        result: hasAnswer && i === raw.answer ? 'success' : 'wrong',
        reaction: '',
      };
    });
    return { q: q, choices: choices };
  }

  // クイズマップ内の各値を normalize する。null/undefined は {}。
  function normalizeQuizMap(rawMap) {
    if (!rawMap || typeof rawMap !== 'object') return {};
    var out = {};
    Object.keys(rawMap).forEach(function (k) {
      out[k] = normalizeQuiz(rawMap[k]);
    });
    return out;
  }

  // 記事に紐づくクイズ（無ければ null）。スラッグで引く。
  //   quizzes = クイズマップ（正規化済み/生どちらでも引ける）、article = { url }。
  function quizForArticle(quizzes, article) {
    if (!quizzes || typeof quizzes !== 'object') return null;
    var key = articleKeyFromUrl(article && article.url);
    return key && quizzes[key] ? quizzes[key] : null;
  }

  // 正誤判定（シャッフル後 index に対して）。
  //   normalizedQuiz.choices[choiceIndex].result を返す。範囲外は 'wrong'（防御）。
  function quizChoiceOutcome(normalizedQuiz, choiceIndex) {
    var choices = normalizedQuiz && Array.isArray(normalizedQuiz.choices) ? normalizedQuiz.choices : [];
    var c = choices[choiceIndex];
    return c && c.result ? c.result : 'wrong';
  }

  // ---- D群: マイグレーション純粋部分 ----

  // 旧フラット state.kitacore を新パス state.modes へ移送する（純粋・非破壊）。
  //   - parsed.modes があればそれをベースに。
  //   - 旧 parsed.kitacore は modes.kitacore が未定義のときだけ移送（新が勝つ＝冪等）。
  //   - {} 入力は {}。進行データ（keys/defeatedBosses/player 等）はそのまま保持。
  //   戻り値は modes マップ。呼び出し側で next.modes に載せる。
  function migrateModes(parsed) {
    parsed = parsed || {};
    var modes = (parsed.modes && typeof parsed.modes === 'object') ? parsed.modes : {};
    if (parsed.kitacore && typeof parsed.kitacore === 'object' && !modes.kitacore) {
      modes = Object.assign({}, modes, { kitacore: parsed.kitacore });
    }
    return modes;
  }

  // targetCreatorId からモード定義を逆引きする。無ければ null。
  function modeForCreator(modeDefs, creatorId) {
    if (!modeDefs || typeof modeDefs !== 'object') return null;
    var keys = Object.keys(modeDefs);
    for (var i = 0; i < keys.length; i++) {
      var def = modeDefs[keys[i]];
      if (def && def.targetCreatorId === creatorId) return def;
    }
    return null;
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
    // ---- モードエンジン純ロジック ----
    stripHtml: stripHtml,
    countWai: countWai,
    articleKeyFromUrl: articleKeyFromUrl,
    kitacoreWaiRankOf: kitacoreWaiRankOf,
    kitacoreRankOf: kitacoreRankOf,
    isPostAwakening: isPostAwakening,
    nextPreBoss: nextPreBoss,
    normalizeQuiz: normalizeQuiz,
    normalizeQuizMap: normalizeQuizMap,
    quizForArticle: quizForArticle,
    quizChoiceOutcome: quizChoiceOutcome,
    migrateModes: migrateModes,
    modeForCreator: modeForCreator,
  };
});
