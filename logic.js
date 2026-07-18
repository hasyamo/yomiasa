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

  // ---- E群: 状態遷移（次状態の計算のみ。副作用は app.js 側） ----
  //   いずれも入力オブジェクトを破壊せず、新オブジェクトを返す（非破壊）。

  // クイズ正解で鍵を1つ獲得（記事ごと1回きり）。
  //   既に quizCleared[articleId] なら null（no-op）。
  //   未クリアなら { nextQuizCleared, nextKeys } を返す。
  //     nextQuizCleared[articleId] = true / nextKeys[creatorId] = (現在値||0)+1。
  function awardKeyOutcome(quizCleared, keys, creatorId, articleId) {
    quizCleared = quizCleared && typeof quizCleared === 'object' ? quizCleared : {};
    keys = keys && typeof keys === 'object' ? keys : {};
    if (quizCleared[articleId]) return null; // 既に獲得済み → no-op
    var nextQuizCleared = Object.assign({}, quizCleared);
    nextQuizCleared[articleId] = true;
    var cur = typeof keys[creatorId] === 'number' ? keys[creatorId] : 0;
    var nextKeys = Object.assign({}, keys);
    nextKeys[creatorId] = cur + 1;
    return { nextQuizCleared: nextQuizCleared, nextKeys: nextKeys };
  }

  // ボス挑戦。鍵が足りなければ { ok:false }。
  //   足りれば鍵を boss.cost 消費し、defeated[creatorId] に boss.key を追加した
  //   { ok:true, nextKeys, nextDefeated } を返す。
  function challengeBossOutcome(keys, defeated, creatorId, boss) {
    keys = keys && typeof keys === 'object' ? keys : {};
    defeated = defeated && typeof defeated === 'object' ? defeated : {};
    var cur = typeof keys[creatorId] === 'number' ? keys[creatorId] : 0;
    if (cur < boss.cost) return { ok: false }; // 鍵不足
    var nextKeys = Object.assign({}, keys);
    nextKeys[creatorId] = cur - boss.cost;
    var curDefeated = Array.isArray(defeated[creatorId]) ? defeated[creatorId] : [];
    var nextDefeated = Object.assign({}, defeated);
    nextDefeated[creatorId] = curDefeated.concat([boss.key]);
    return { ok: true, nextKeys: nextKeys, nextDefeated: nextDefeated };
  }

  // ワイ回収（＝totalWai 加算）。
  //   counts[articleId] なし / collected[articleId] あり / wai<=0 なら { ok:false }。
  //   回収可なら { ok:true, nextTotalWai, nextCollected, summonBossKey } を返す。
  //     summonBossKey は kitacoreWaiRankOf(ranks, totalWai) と
  //     kitacoreWaiRankOf(ranks, nextTotalWai) の key が変わり かつ after.bossKey が
  //     あれば その bossKey、なければ null。
  function collectWaiOutcome(ranks, postBosses, counts, collected, totalWai, articleId) {
    counts = counts && typeof counts === 'object' ? counts : {};
    collected = collected && typeof collected === 'object' ? collected : {};
    var entry = counts[articleId];
    if (!entry) return { ok: false }; // 未収集
    if (collected[articleId]) return { ok: false }; // 二重取り防止
    if (entry.wai <= 0) return { ok: false }; // ワイ0は回収対象外
    var before = kitacoreWaiRankOf(ranks, totalWai);
    var nextTotalWai = totalWai + entry.wai;
    var nextCollected = Object.assign({}, collected);
    nextCollected[articleId] = true;
    var after = kitacoreWaiRankOf(ranks, nextTotalWai);
    var summonBossKey = after.key !== before.key && after.bossKey ? after.bossKey : null;
    return {
      ok: true,
      nextTotalWai: nextTotalWai,
      nextCollected: nextCollected,
      summonBossKey: summonBossKey,
    };
  }

  // 覚醒後ボスを挑戦待ちにできるか（順序ガードの核）。
  //   defeated に bossKey がある → null（撃破済み）。
  //   currentPending が truthy → null（上書きしない）。
  //   postBosses での bossKey の index より前のボスが1つでも defeated にない → null（順序未達）。
  //   全条件クリアなら bossKey を返す。
  function canSummonPostBoss(postBosses, defeated, currentPending, bossKey) {
    defeated = Array.isArray(defeated) ? defeated : [];
    if (defeated.indexOf(bossKey) !== -1) return null; // 撃破済み
    if (currentPending) return null; // 既に挑戦待ちあり → 上書きしない
    var idx = postBosses.findIndex(function (b) { return b.key === bossKey; });
    for (var i = 0; i < idx; i++) {
      if (defeated.indexOf(postBosses[i].key) === -1) return null; // 順序未達
    }
    return bossKey;
  }

  // ===========================================================================
  // ニゲキレモード純ロジック（フェーズ1）。
  //   state/DOM に依存しない。ポイント表・ランク閾値・称号テーブルは
  //   呼び出し側（app.js の MODE_DEFS）から引数で渡す。文言はコード直書きしない。
  //   参照: nigekire-quiz-and-points-spec.md §6.4/§10.4-10.6
  // ===========================================================================

  // 曜日→キャラの機械対応。1週間の曜日番号（0=日曜..6=土曜, JST基準）→ weekday 文字列。
  var NIGEKIRE_WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // published_at（記事公開日）から JST の曜日文字列（'mon'..'sun'）を求める。純関数。
  //   note の published_at は日付/日時文字列。JST(+09:00) で曜日を判定する。
  //   日付だけ（'2025-12-15'）の場合、UTC 深夜0時に解釈されるため +9h して JST 日付にする。
  //   パース不能なら null。
  function weekdayOf(publishedAt) {
    var d = parseDate(publishedAt);
    if (!d) return null;
    // UTC ミリ秒に +9h して JST の暦日にそろえ、その曜日を UTC メソッドで読む。
    var jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return NIGEKIRE_WEEKDAY_KEYS[jst.getUTCDay()];
  }

  // weekday（'mon'..'sun'）から担当キャラを引く。characters は MODE_DEFS の
  //   曜日順キャラ配列（各要素に .weekday を持つ）。該当なしは null。
  function weekdayCharOf(weekday, characters) {
    if (!Array.isArray(characters)) return null;
    for (var i = 0; i < characters.length; i++) {
      if (characters[i] && characters[i].weekday === weekday) return characters[i];
    }
    return null;
  }

  // 生活ランク（総ポイントの4段階・§10.5）。
  //   ranks = [{ stage, name, min }, ...]（min 昇順）。total 以下で最大 min の段階を返す。
  //   戻り値 { stage, name }。ranks 未指定/空なら { stage:0, name:'' }。
  function nigekireLifeRank(totalPoints, ranks) {
    if (!Array.isArray(ranks) || ranks.length === 0) return { stage: 0, name: '', key: '' };
    var t = typeof totalPoints === 'number' ? totalPoints : 0;
    var cur = ranks[0];
    for (var i = 0; i < ranks.length; i++) {
      if (t >= ranks[i].min) cur = ranks[i];
    }
    return { stage: cur.stage, name: cur.name, key: cur.key };
  }

  // キャラ別称号（キャラ別ポイントの4段階・§10.6）。
  //   charPoints = キャラ別ポイントマップ、charKey = 対象キャラのキー、
  //   titleTable = { thresholds:[0,10,25,45], names:{ [charKey]: [段階1..4名] } }。
  //   戻り値 { stage(1..4), name }。該当キャラ名テーブル無しは name:''。
  function nigekireCharTitle(charPoints, charKey, titleTable) {
    var pts = charPoints && typeof charPoints === 'object' && typeof charPoints[charKey] === 'number'
      ? charPoints[charKey] : 0;
    var thresholds = titleTable && Array.isArray(titleTable.thresholds)
      ? titleTable.thresholds : [0];
    var names = titleTable && titleTable.names && titleTable.names[charKey];
    var stage = 1;
    for (var i = 0; i < thresholds.length; i++) {
      if (pts >= thresholds[i]) stage = i + 1;
    }
    var name = Array.isArray(names) && names[stage - 1] != null ? names[stage - 1] : '';
    return { stage: stage, name: name };
  }

  // 現在トップ（最大ポイントのキャラ）。同点は characters の並び（曜日順）で先を採る。
  //   全0/未蓄積でも characters が非空なら先頭を返す（トップ表示は常に1人）。
  //   characters 空/不正なら null。
  function nigekireTopCharacter(charPoints, characters) {
    if (!Array.isArray(characters) || characters.length === 0) return null;
    var pts = charPoints && typeof charPoints === 'object' ? charPoints : {};
    var top = characters[0];
    var topPts = typeof pts[top.key] === 'number' ? pts[top.key] : 0;
    for (var i = 1; i < characters.length; i++) {
      var c = characters[i];
      var p = typeof pts[c.key] === 'number' ? pts[c.key] : 0;
      // 厳密に大きいときだけ更新 → 同点は先（曜日順で早い方）が残る。
      if (p > topPts) {
        top = c;
        topPts = p;
      }
    }
    return top;
  }

  // 総ポイント（全キャラ合算）。charPoints の数値を足す。
  function nigekireTotalPoints(charPoints) {
    if (!charPoints || typeof charPoints !== 'object') return 0;
    return Object.keys(charPoints).reduce(function (sum, k) {
      var v = charPoints[k];
      return sum + (typeof v === 'number' ? v : 0);
    }, 0);
  }

  // 試練成功時のポイント（火種ランク×通常/一発・§10.2）。
  //   pointTable = { light:[通常,一発], medium:[...], heavy:[...] }。未定義ランクは 0。
  function nigekireTrialPoints(fireRank, isFirstTry, pointTable) {
    var row = pointTable && pointTable[fireRank];
    if (!Array.isArray(row)) return 0;
    return isFirstTry ? (row[1] || 0) : (row[0] || 0);
  }

  // 試練通過の状態遷移（非破壊）。§10.2/§10.5
  //   passed[articleId] があれば二重取り防止で { ok:false }。
  //   通過なら awardedPoints を担当キャラの財布に足し、成功数/一発数を更新した
  //   次状態を返す。lifeRankBefore/After は総ポイントのランク、rankUpdated は段階が上がったか。
  //   引数:
  //     charPoints, totalSuccess, firstTrySuccess, passed : 現在状態
  //     charKey    : 担当キャラのキー（付与先の財布）
  //     articleId  : 記事キー（二重取り防止の単位）
  //     fireRank   : 'light'|'medium'|'heavy'
  //     isFirstTry : 一発成功か
  //     pointTable : ポイント表、lifeRanks : 生活ランク閾値テーブル
  function nigekireSuccessOutcome(
    charPoints, totalSuccess, firstTrySuccess, passed,
    charKey, articleId, fireRank, isFirstTry, pointTable, lifeRanks
  ) {
    passed = passed && typeof passed === 'object' ? passed : {};
    if (passed[articleId]) return { ok: false }; // 二重取り防止
    var pts = charPoints && typeof charPoints === 'object' ? charPoints : {};
    var awarded = nigekireTrialPoints(fireRank, isFirstTry, pointTable);
    var totalBefore = nigekireTotalPoints(pts);
    var lifeBefore = nigekireLifeRank(totalBefore, lifeRanks);

    var nextCharPoints = Object.assign({}, pts);
    var cur = typeof nextCharPoints[charKey] === 'number' ? nextCharPoints[charKey] : 0;
    nextCharPoints[charKey] = cur + awarded;

    var nextPassed = Object.assign({}, passed);
    nextPassed[articleId] = true;

    var ts = typeof totalSuccess === 'number' ? totalSuccess : 0;
    var fts = typeof firstTrySuccess === 'number' ? firstTrySuccess : 0;
    var nextTotalSuccess = ts + 1;
    var nextFirstTrySuccess = isFirstTry ? fts + 1 : fts;

    var lifeAfter = nigekireLifeRank(totalBefore + awarded, lifeRanks);

    return {
      ok: true,
      nextCharPoints: nextCharPoints,
      nextTotalSuccess: nextTotalSuccess,
      nextFirstTrySuccess: nextFirstTrySuccess,
      nextPassed: nextPassed,
      awardedPoints: awarded,
      lifeRankBefore: lifeBefore,
      lifeRankAfter: lifeAfter,
      rankUpdated: lifeAfter.stage > lifeBefore.stage,
    };
  }

  // 回収型のタップ回収（+1pt・§10.4）。ニゲキレ専用（キタコレの collectWaiOutcome とは別）。
  //   collected[articleId] があれば二重取り防止で { ok:false }。
  //   回収なら担当キャラの財布に +1 し、collected を立てた次状態を返す（非破壊）。
  //   lifeRankBefore/After・rankUpdated も返す。
  function nigekireCollectOutcome(charPoints, collected, charKey, articleId, lifeRanks) {
    collected = collected && typeof collected === 'object' ? collected : {};
    if (collected[articleId]) return { ok: false }; // 二重取り防止
    var pts = charPoints && typeof charPoints === 'object' ? charPoints : {};
    var awarded = 1;
    var totalBefore = nigekireTotalPoints(pts);
    var lifeBefore = nigekireLifeRank(totalBefore, lifeRanks);

    var nextCharPoints = Object.assign({}, pts);
    var cur = typeof nextCharPoints[charKey] === 'number' ? nextCharPoints[charKey] : 0;
    nextCharPoints[charKey] = cur + awarded;

    var nextCollected = Object.assign({}, collected);
    nextCollected[articleId] = true;

    var lifeAfter = nigekireLifeRank(totalBefore + awarded, lifeRanks);

    return {
      ok: true,
      nextCharPoints: nextCharPoints,
      nextCollected: nextCollected,
      awardedPoints: awarded,
      lifeRankBefore: lifeBefore,
      lifeRankAfter: lifeAfter,
      rankUpdated: lifeAfter.stage > lifeBefore.stage,
    };
  }

  // ---------------------------------------------------------------------------
  // クリエイター削除時のモード state 掃除（純関数・非破壊）
  //   app.js deleteCreator の副作用ロジックを切り出したもの。挙動を1バイトも変えない。
  // ---------------------------------------------------------------------------

  // キタコレ計測の掃除。creatorId 配下の記事（articleIds）ぶんの計測を落とし、
  //   回収済みの累計 totalWai もそのぶん差し引く（Math.max(0,...) 下限あり）。
  //   isTargetCreator（=creatorId が KITACORE_ID 本体）なら player/quizTaps もリセット。
  //   入力 kitacoreState は書き換えず、掃除後の新オブジェクトを返す。
  function cleanupKitacoreOnDelete(kitacoreState, creatorId, articleIds, isTargetCreator) {
    var s = kitacoreState && typeof kitacoreState === 'object' ? kitacoreState : {};
    var next = Object.assign({}, s);
    // 触る各マップは浅くコピーしてから delete（入力を書き換えない）。
    next.counts = Object.assign({}, s.counts);
    next.collected = Object.assign({}, s.collected);
    next.quizCleared = Object.assign({}, s.quizCleared);
    next.mode = Object.assign({}, s.mode);
    next.keys = Object.assign({}, s.keys);
    next.defeatedBosses = Object.assign({}, s.defeatedBosses);
    var totalWai = typeof s.totalWai === 'number' ? s.totalWai : 0;

    var ids = Array.isArray(articleIds) ? articleIds : [];
    ids.forEach(function (aid) {
      if (!aid) return;
      if (next.collected[aid]) {
        var entry = next.counts[aid];
        if (entry && typeof entry.wai === 'number') {
          totalWai = Math.max(0, totalWai - entry.wai);
        }
        delete next.collected[aid];
      }
      delete next.counts[aid];
      delete next.quizCleared[aid];
    });
    next.totalWai = totalWai;

    delete next.mode[creatorId];
    delete next.keys[creatorId];
    delete next.defeatedBosses[creatorId];
    if (s.pendingPostBoss) {
      next.pendingPostBoss = Object.assign({}, s.pendingPostBoss);
      delete next.pendingPostBoss[creatorId];
    }
    // KITAcoreクリエーター本体を削除した場合はプレイヤー情報もリセット。
    if (isTargetCreator) {
      next.player = null;
      next.quizTaps = 0;
    }
    return next;
  }

  // ニゲキレ state の掃除。isTargetCreator（=creatorId が NIGEKIRE_ID 本体=唯一の対象）なら、
  //   ポイント逆算が煩雑なため進行を丸ごとリセット（亡霊 state を残さない）。
  //   対象でなければ変更なし（＝入力と同値の新オブジェクトを返す）。非破壊。
  function cleanupNigekireOnDelete(nigekireState, isTargetCreator) {
    var s = nigekireState && typeof nigekireState === 'object' ? nigekireState : {};
    var next = Object.assign({}, s);
    if (isTargetCreator) {
      next.mode = {};
      next.charPoints = {};
      next.passed = {};
      next.collected = {};
      next.totalSuccess = 0;
      next.firstTrySuccess = 0;
      next.player = null;
    }
    return next;
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
    // ---- 状態遷移（次状態の計算） ----
    awardKeyOutcome: awardKeyOutcome,
    challengeBossOutcome: challengeBossOutcome,
    collectWaiOutcome: collectWaiOutcome,
    canSummonPostBoss: canSummonPostBoss,
    // ---- ニゲキレモード純ロジック（フェーズ1） ----
    weekdayOf: weekdayOf,
    weekdayCharOf: weekdayCharOf,
    nigekireLifeRank: nigekireLifeRank,
    nigekireCharTitle: nigekireCharTitle,
    nigekireTopCharacter: nigekireTopCharacter,
    nigekireTotalPoints: nigekireTotalPoints,
    nigekireTrialPoints: nigekireTrialPoints,
    nigekireSuccessOutcome: nigekireSuccessOutcome,
    nigekireCollectOutcome: nigekireCollectOutcome,
    // ---- クリエイター削除時のモード掃除（純関数・非破壊） ----
    cleanupKitacoreOnDelete: cleanupKitacoreOnDelete,
    cleanupNigekireOnDelete: cleanupNigekireOnDelete,
  };
});
