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

  // weekday（'mon'..'sun'）→ 日本語1文字（'月'..'日'）。該当なしは ''。
  var WEEKDAY_JA = { sun: '日', mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土' };
  function weekdayLabelJa(weekday) {
    return WEEKDAY_JA[weekday] || '';
  }

  // 記事の公開日を「YYYY.MM.DD (曜)」形式にする。全モード共通の一覧表示用。
  //   曜日は weekdayOf と同じ JST 基準で出す（ニゲキレのチップ表示と必ず一致させるため。
  //   ローカル TZ の getDay() だと JST 以外の環境で1日ずれる）。
  //   日付部分も JST の暦日で組む（published_at が '2025-12-15' のような日付のみでも、
  //   タイムゾーンによって前日/翌日にならない）。パース不能なら ''。
  function formatDateWithWeekday(publishedAt) {
    var d = parseDate(publishedAt);
    if (!d) return '';
    var jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    var y = jst.getUTCFullYear();
    var m = String(jst.getUTCMonth() + 1).padStart(2, '0');
    var day = String(jst.getUTCDate()).padStart(2, '0');
    var wd = weekdayLabelJa(NIGEKIRE_WEEKDAY_KEYS[jst.getUTCDay()]);
    return y + '.' + m + '.' + day + (wd ? ' (' + wd + ')' : '');
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

  // ===========================================================================
  // ニゲキレ v2 純ロジック（一言チップ収集・1本ゲージ・生活カード）
  //   参照: nigekire-quiz-and-points-spec.md §10.5 称号閾値 /
  //         §10.7 ホワイトリスト / nigekire-mode-ui-spec.md §5,§6,§10
  //   旧v1（総ポイント制）は推し1人選択構造で廃止・削除済み。
  // ===========================================================================

  // 最推し（最多収集キャラ）。同数は characters の並び（曜日順）で先を採る。
  //   characters = [{ key, ... }, ...]。全0はキャラが1人でも最多が0＝先頭が残るが、
  //   「全0は null」仕様のため、最多収集数が0なら null を返す。characters 空/不正も null。
  function nigekireTopChar(charCounts, characters) {
    if (!Array.isArray(characters) || characters.length === 0) return null;
    var cc = charCounts && typeof charCounts === 'object' ? charCounts : {};
    var top = characters[0];
    var topCnt = typeof cc[top.key] === 'number' ? cc[top.key] : 0;
    for (var i = 1; i < characters.length; i++) {
      var c = characters[i];
      var n = typeof cc[c.key] === 'number' ? cc[c.key] : 0;
      // 厳密に大きいときだけ更新 → 同数は先（曜日順で早い方）が残る。
      if (n > topCnt) {
        top = c;
        topCnt = n;
      }
    }
    if (topCnt <= 0) return null; // 全0はトップなし
    return top;
  }

  // 本文HTMLから一言キャラを抽出（§10.7 ホワイトリスト照合・純関数）。
  //   <h2>◯◯の一言</h2> 形式の最初の見出しの ◯◯ を取り、nameToKey で照合。
  //   nameToKey = { '月子':'tsukiko', ... }（7人ホワイトリスト）。
  //   完全一致すれば charKey を返す。一致しない（例「KITAさん」）/見出しなし/非文字列は null。
  function detectHitokotoChar(bodyHtml, nameToKey) {
    if (typeof bodyHtml !== 'string') return null;
    var m = bodyHtml.match(/<h2[^>]*>([^<]*?)の一言<\/h2>/);
    if (!m) return null;
    var name = m[1];
    var map = nameToKey && typeof nameToKey === 'object' ? nameToKey : {};
    // ホワイトリストに完全一致するときだけ charKey を返す。
    if (Object.prototype.hasOwnProperty.call(map, name) && map[name]) {
      return map[name];
    }
    return null;
  }

  // 一言チップのタップ回収 v2（収集数 +1・§10・非破壊）。
  //   counts[articleId].char が無い → { ok:false }（未取得）。
  //   collected[articleId] あり → { ok:false }（二重取り防止）。
  //   回収可: charKey = counts[articleId].char、nextCharCounts[charKey] +1、
  //           nextCollected[articleId] = true の次状態を返す（非破壊）。
  function nigekireCollectV2(counts, collected, charCounts, articleId) {
    counts = counts && typeof counts === 'object' ? counts : {};
    collected = collected && typeof collected === 'object' ? collected : {};
    var entry = counts[articleId];
    if (!entry || !entry.char) return { ok: false }; // 未取得（一言キャラ未判定）
    if (collected[articleId]) return { ok: false }; // 二重取り防止
    var charKey = entry.char;
    var cc = charCounts && typeof charCounts === 'object' ? charCounts : {};

    var nextCharCounts = Object.assign({}, cc);
    var cur = typeof nextCharCounts[charKey] === 'number' ? nextCharCounts[charKey] : 0;
    nextCharCounts[charKey] = cur + 1;

    var nextCollected = Object.assign({}, collected);
    nextCollected[articleId] = true;

    return {
      ok: true,
      nextCollected: nextCollected,
      nextCharCounts: nextCharCounts,
      charKey: charKey,
    };
  }

  // 試練通過 v2（逃げ切り・§10・非破壊）。ポイントは無い（収集数と別軸）。
  //   passed[articleId] あり → { ok:false }（二重）。
  //   通過: nextPassed[articleId]=true、nextTotalSuccess +1、
  //         isFirstTry なら nextFirstTrySuccess +1 の次状態を返す（非破壊）。
  function nigekireTrialV2(passed, totalSuccess, firstTrySuccess, articleId, isFirstTry) {
    passed = passed && typeof passed === 'object' ? passed : {};
    if (passed[articleId]) return { ok: false }; // 二重取り防止

    var nextPassed = Object.assign({}, passed);
    nextPassed[articleId] = true;

    var ts = typeof totalSuccess === 'number' ? totalSuccess : 0;
    var fts = typeof firstTrySuccess === 'number' ? firstTrySuccess : 0;

    return {
      ok: true,
      nextPassed: nextPassed,
      nextTotalSuccess: ts + 1,
      nextFirstTrySuccess: isFirstTry ? fts + 1 : fts,
    };
  }

  // 生活カード4段階（キャラ別収集数の成長・UI §10-1）。
  //   閾値: 0=未観測(stage1) / 1〜=観測(stage2) / 5〜=定着(stage3) / 10〜=中核(stage4)。
  //   ※称号閾値 0/5/10/15 とは別軸（カードは 0/1/5/10）。
  function nigekireCardStage(charCount) {
    var c = typeof charCount === 'number' ? charCount : 0;
    if (c >= 10) return { stage: 4, name: '中核' };
    if (c >= 5) return { stage: 3, name: '定着' };
    if (c >= 1) return { stage: 2, name: '観測' };
    return { stage: 1, name: '未観測' };
  }

  // ===========================================================================
  // ニゲキレ 通過ベースランク 純ロジック（rankStage・§10-2）
  //   参照: nigekire-final-check-spec.md §10-2 / answer-final-check-rank-update.md
  //   ランクは「収集数の自動判定」ではなく rankStage（0〜6・全7段）で決まる
  //   （キタコレの撃破ベース準拠）。rankStage は N群の「閾値への初到達」で上がる。
  //   旧5段階版（総収集 70/120/200）は廃止・削除済み。
  // ===========================================================================

  // 通過ベースのランク名解決（§10-2）。
  //   rankStage（0〜4）を ranks[rankStage] にマップして {stage,name,key} を返す。
  //   ranks = [{stage,min,name,key}, ...]（5要素・index0=言い訳見習い…index4=管理人）。
  //   範囲外は 0〜(ranks.length-1) にクランプ。非数は 0 扱い。
  //   ranks 空/不正は {stage:0, name:'', key:''}。副作用なし。
  function nigekireRankByStage(rankStage, ranks) {
    if (!Array.isArray(ranks) || ranks.length === 0) return { stage: 0, name: '', key: '' };
    var s = typeof rankStage === 'number' && isFinite(rankStage) ? Math.floor(rankStage) : 0;
    if (s < 0) s = 0;
    if (s > ranks.length - 1) s = ranks.length - 1;
    var r = ranks[s];
    if (!r || typeof r !== 'object') return { stage: 0, name: '', key: '' };
    return {
      stage: typeof r.stage === 'number' ? r.stage : 0,
      name: typeof r.name === 'string' ? r.name : '',
      key: typeof r.key === 'string' ? r.key : '',
      grade: typeof r.grade === 'string' ? r.grade : '', // 等級記号（E..SS）。表示で名前に前置する
    };
  }

  // ===========================================================================
  // M群: ニゲキレ 推し1人選択構造（answer-oshi-select-CONFIRMED.md 確定）
  //   推しを1人選び、そのキャラの曜日の記事だけに試練が出る。逃げ切り9本・3本ごとに
  //   最終確認（計3回）。3回通過で rankStage 3（生活防衛中）＝キャラ変更解禁。
  //   2人目以降の初期試練では rankStage は動かず、oshiCleared（称号の曜日・カード解放）
  //   にだけ積む。閾値は ranks の min 由来（ハードコードしない）。すべて非破壊。
  // ===========================================================================

  // 逃げ切り記録（選択中の推しのぶんだけ）。
  //   count = min(escapeCounts[oshiChar] || 0, 9)（負数/非数は0）。
  //   cleared = 3本ごとの節目3つ（3/6/9）それぞれの到達可否。
  //   nextMilestone = 未達の最小の節目本数（3/6/9）。全達成なら null。
  function nigekireOshiEscapeRecord(escapeCounts, oshiChar) {
    var need = 9;
    var map = escapeCounts && typeof escapeCounts === 'object' ? escapeCounts : {};
    var raw = oshiChar ? map[oshiChar] : 0;
    var count = typeof raw === 'number' && isFinite(raw) ? Math.floor(raw) : 0;
    if (count < 0) count = 0;
    if (count > need) count = need;
    var cleared = [count >= 3, count >= 6, count >= 9];
    var nextMilestone = null;
    for (var i = 0; i < 3; i++) {
      if (!cleared[i]) { nextMilestone = (i + 1) * 3; break; }
    }
    return { count: count, need: need, cleared: cleared, nextMilestone: nextMilestone };
  }

  // キャラ別の通過回数（0..3）を取り出す内部ヘルパ。非数/負数は0・上限3。
  function nigekireOshiPassCount(oshiPassCounts, oshiChar) {
    var map = oshiPassCounts && typeof oshiPassCounts === 'object' ? oshiPassCounts : {};
    var raw = oshiChar ? map[oshiChar] : 0;
    var n = typeof raw === 'number' && isFinite(raw) ? Math.floor(raw) : 0;
    if (n < 0) n = 0;
    if (n > 3) n = 3;
    return n;
  }

  // 通過セリフのキー（NIGEKIRE_PASS_LINES 用）。'<charKey>_<n>'（n は 1..6 にクランプ）。
  //   charKey が空/不正なら '' を返す。
  function nigekireOshiPassLineKey(charKey, passIndex) {
    if (!charKey || typeof charKey !== 'string') return '';
    var n = typeof passIndex === 'number' && isFinite(passIndex) ? Math.floor(passIndex) : 1;
    if (n < 1) n = 1;
    if (n > 6) n = 6;
    return charKey + '_' + n;
  }

  // 称号に曜日を積む。'生活防衛中〈月水金〉'。
  //   oshiCleared を characters の並び（曜日順）に整列し、各 label の1文字目を連結する。
  //   oshiCleared が空/不正なら rankName のみ（括弧なし）。rankName が不正なら '' 。
  // ランク名に等級記号を前置する（例: 'SS:おはカノ生活管理人'）。
  //   ランク名だけでは何段目か分からないため、キタコレ（E級/C級/A級…）と同じ読み口にする。
  //   rank は NIGEKIRE_LIFE_RANKS の1件（{grade, name}）。grade が無ければ name だけ返す。
  function nigekireRankLabel(rank) {
    var r = rank && typeof rank === 'object' ? rank : {};
    var name = typeof r.name === 'string' ? r.name : '';
    var grade = typeof r.grade === 'string' ? r.grade : '';
    if (!name) return '';
    return grade ? grade + ':' + name : name;
  }

  function nigekireRankTitleWithDays(rankName, oshiCleared, characters) {
    var name = typeof rankName === 'string' ? rankName : '';
    if (!name) return '';
    var list = Array.isArray(characters) ? characters : [];
    var cleared = Array.isArray(oshiCleared) ? oshiCleared : [];
    if (list.length === 0 || cleared.length === 0) return name;
    var days = '';
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (!ch || typeof ch !== 'object') continue;
      if (cleared.indexOf(ch.key) === -1) continue;
      var label = typeof ch.label === 'string' ? ch.label : '';
      if (label) days += label.charAt(0);
    }
    if (!days) return name;
    return name + '〈' + days + '〉';
  }

  // ===========================================================================
  // N群: ニゲキレ キャラ単位ポイント＋閾値初到達ランク
  //   参照: nigekire-percharacter-points.md
  //   ポイントは charCounts[charKey]（キャラ単位）。節目は 1キャラにつき6回
  //   （逃げ切き 3/6/9 → ポイント 5/10/15）。ランクは「閾値への初到達」でだけ上がる。
  //   2人目以降は節目のカットインは出るが reachedThresholds に既にあるのでランクは動かない。
  //   M群の旧・節目関数（総収集ベース）は廃止・削除済み。すべて副作用なし。
  // ===========================================================================

  // 通過回数（0..6）を取り出す内部ヘルパ。M群の nigekireOshiPassCount は上限3なので別に持つ。
  function nigekireOshiPassCount6(oshiPassCounts, oshiChar) {
    var map = oshiPassCounts && typeof oshiPassCounts === 'object' ? oshiPassCounts : {};
    var raw = oshiChar ? map[oshiChar] : 0;
    var n = typeof raw === 'number' && isFinite(raw) ? Math.floor(raw) : 0;
    if (n < 0) n = 0;
    if (n > 6) n = 6;
    return n;
  }

  // 閾値キー。'escape3' / 'point5' 等。kind/need が不正なら ''。
  function nigekireThresholdKey(kind, need) {
    if (kind !== 'escape' && kind !== 'point') return '';
    if (typeof need !== 'number' || !isFinite(need)) return '';
    return kind + String(Math.floor(need));
  }

  // 次の節目が出ているか（キャラ単位ポイント版）。
  //   p = そのキャラの通過回数（0..6）。
  //   p<3      : kind='escape'、need=thresholds.escape[p]（3/6/9）、ready=escapeCounts[char]>=need
  //   3<=p<6   : kind='point' 、need=thresholds.point[p-3]（5/10/15）、ready=charCounts[char]>=need
  //   p>=6     : kind='done'、ready=false（そのキャラは6回とも見た）
  //   passIndex = p+1（1..6）＝通過セリフの n。
  function nigekireOshiMilestone(escapeCounts, charCounts, oshiPassCounts, oshiChar, thresholds) {
    var th = thresholds && typeof thresholds === 'object' ? thresholds : {};
    var escList = Array.isArray(th.escape) ? th.escape : [];
    var ptList = Array.isArray(th.point) ? th.point : [];
    var p = nigekireOshiPassCount6(oshiPassCounts, oshiChar);
    var passIndex = p + 1 > 6 ? 6 : p + 1;
    if (!oshiChar || typeof oshiChar !== 'string') {
      return { ready: false, kind: 'done', need: null, passIndex: passIndex };
    }
    if (p >= 6) return { ready: false, kind: 'done', need: null, passIndex: 6 };

    if (p < 3) {
      var needE = typeof escList[p] === 'number' ? escList[p] : Infinity;
      var em = escapeCounts && typeof escapeCounts === 'object' ? escapeCounts : {};
      var rawE = em[oshiChar];
      var cntE = typeof rawE === 'number' && isFinite(rawE) ? Math.floor(rawE) : 0;
      return { ready: cntE >= needE, kind: 'escape', need: needE, passIndex: passIndex };
    }
    var needP = typeof ptList[p - 3] === 'number' ? ptList[p - 3] : Infinity;
    var cm = charCounts && typeof charCounts === 'object' ? charCounts : {};
    var rawP = cm[oshiChar];
    var cntP = typeof rawP === 'number' && isFinite(rawP) ? Math.floor(rawP) : 0;
    return { ready: cntP >= needP, kind: 'point', need: needP, passIndex: passIndex };
  }

  // 節目の通過処理（キャラ単位ポイント版）。非破壊で次の state を返す。
  //   - そのキャラの通過回数 +1（上限6）。
  //   - 閾値キーが reachedThresholds に無ければ追加して rankUp=true（＝初到達）。
  //     既にあれば追加せず rankUp=false（2人目以降）。
  //   - 通過回数が3に達したら oshiCleared に追加（重複しない）。
  //   - oshiChar/kind/need が不正、または既に6回通過済みなら {ok:false}。
  function nigekirePassOshiMilestone(reachedThresholds, oshiPassCounts, oshiCleared, oshiChar, kind, need) {
    var reachedIn = Array.isArray(reachedThresholds) ? reachedThresholds : [];
    var countsIn = oshiPassCounts && typeof oshiPassCounts === 'object' ? oshiPassCounts : {};
    var clearedIn = Array.isArray(oshiCleared) ? oshiCleared : [];
    var key = nigekireThresholdKey(kind, need);
    if (!oshiChar || typeof oshiChar !== 'string' || !key) {
      return {
        ok: false,
        nextReached: reachedIn.slice(),
        nextPassCounts: Object.assign({}, countsIn),
        nextCleared: clearedIn.slice(),
        rankUp: false,
      };
    }
    var p = nigekireOshiPassCount6(countsIn, oshiChar);
    if (p >= 6) {
      return {
        ok: false,
        nextReached: reachedIn.slice(),
        nextPassCounts: Object.assign({}, countsIn),
        nextCleared: clearedIn.slice(),
        rankUp: false,
      };
    }

    var nextPassCounts = Object.assign({}, countsIn);
    nextPassCounts[oshiChar] = p + 1;

    var nextReached = reachedIn.slice();
    var rankUp = false;
    if (nextReached.indexOf(key) === -1) {
      nextReached.push(key);
      rankUp = true;
    }

    var nextCleared = clearedIn.slice();
    if (p + 1 >= 3 && nextCleared.indexOf(oshiChar) === -1) nextCleared.push(oshiChar);

    return {
      ok: true,
      nextReached: nextReached,
      nextPassCounts: nextPassCounts,
      nextCleared: nextCleared,
      rankUp: rankUp,
    };
  }

  // ゲージ（選択中キャラのポイント / 次のポイント閾値）。
  //   cur  = charCounts[oshiChar]（そのキャラのポイント）
  //   need = 次のポイント閾値。p<3 なら最初の 5、3<=p<6 なら point[p-3]、p>=6 なら最後の 15。
  //   pct  = cur/need*100（0-100クランプ）。over = cur > need。
  //   display = cur + ' / ' + need（オーバーしても分子だけ伸びる＝'20 / 15'）。
  function nigekireOshiGauge(charCounts, oshiChar, oshiPassCounts, thresholds) {
    var th = thresholds && typeof thresholds === 'object' ? thresholds : {};
    var ptList = Array.isArray(th.point) && th.point.length > 0 ? th.point : [];
    // 分母は常に最終閾値（15）。途中の閾値（5/10）を分母にすると 0/5 → 5/10 →
    //   10/15 と目盛りが動いてしまい、そのキャラをどこまで掘ったかが読めなくなる。
    var need = typeof ptList[ptList.length - 1] === 'number' ? ptList[ptList.length - 1] : 0;

    var cm = charCounts && typeof charCounts === 'object' ? charCounts : {};
    var raw = oshiChar ? cm[oshiChar] : 0;
    var cur = typeof raw === 'number' && isFinite(raw) ? Math.floor(raw) : 0;
    if (cur < 0) cur = 0;

    var pct = need > 0 ? (cur / need) * 100 : 0;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    return { cur: cur, need: need, pct: pct, over: cur > need, display: cur + ' / ' + need };
  }

  // ランク段＝到達済み閾値の数（0..maxStage にクランプ）。
  function nigekireRankStageFromReached(reachedThresholds, maxStage) {
    var list = Array.isArray(reachedThresholds) ? reachedThresholds : [];
    var max = typeof maxStage === 'number' && isFinite(maxStage) ? Math.floor(maxStage) : 0;
    if (max < 0) max = 0;
    var n = list.length;
    if (n > max) n = max;
    return n;
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

  // ===========================================================================
  // X群: ニゲキレ交換所（おへんじ帖の季節衣装）
  //   参照: nigekire-exchange-spec.md
  //   ★ポイントは減らない（§2）。累計ポイントの「到達数」で何着選べるかが決まる。
  //     減算を書くとランク（reachedThresholds の初到達ベース）と食い違うため。
  //   解放数はキャラ単位（ポイントが charCounts[charKey] のキャラ単位のため）。
  //   すべて副作用なし・非破壊。
  // ===========================================================================

  // 季節の並び（春夏秋冬で位置固定・§4）。表示順はこの配列がゴールデン。
  var OUTFIT_SEASONS = ['spring', 'summer', 'autumn', 'winter'];

  // 累計ポイント → 解放できる衣装の数（§2の到達表）。
  //   thresholds = [5,10,15,20] のような昇順配列。到達した閾値の数がそのまま着数。
  //   ポイントは減らないので、これは「使える枠の総数」であって残高ではない。
  function nigekireOutfitAllowance(points, thresholds) {
    var p = typeof points === 'number' && isFinite(points) ? Math.floor(points) : 0;
    var list = Array.isArray(thresholds) ? thresholds : [];
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (typeof t === 'number' && isFinite(t) && p >= t) n++;
    }
    return n;
  }

  // 次の閾値（まだ到達していない最小の閾値）。全部到達済みなら null。
  //   「選べる衣装 0着（次は10pt）」の 10 を出すのに使う（§5）。
  function nigekireOutfitNextThreshold(points, thresholds) {
    var p = typeof points === 'number' && isFinite(points) ? Math.floor(points) : 0;
    var list = Array.isArray(thresholds) ? thresholds : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (typeof t === 'number' && isFinite(t) && p < t) return t;
    }
    return null;
  }

  // あるキャラの解放済み季節を配列で返す（unlocks から絞り込む）。
  //   unlocks = [{characterId, season}, ...]（APIの GET /api/outfit/unlocks 形式）。
  //   並びは OUTFIT_SEASONS 順に正規化する（APIの返却順に依存しない）。
  function nigekireUnlockedSeasons(unlocks, charKey) {
    var list = Array.isArray(unlocks) ? unlocks : [];
    var found = {};
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u && u.characterId === charKey && typeof u.season === 'string') found[u.season] = true;
    }
    var out = [];
    for (var j = 0; j < OUTFIT_SEASONS.length; j++) {
      if (found[OUTFIT_SEASONS[j]]) out.push(OUTFIT_SEASONS[j]);
    }
    return out;
  }

  // 交換画面の状態をまとめて算出する（§5）。表示に必要な値を1回で出す。
  //   points      : そのキャラの収集数（charCounts[charKey]）
  //   unlocked    : そのキャラの解放済み季節（nigekireUnlockedSeasons の返り値）
  //   available   : 実装済み季節（画像がある季節。現時点は ['summer']）
  //   thresholds  : [5,10,15,20]
  //   -> { allowance, usedCount, remaining, nextThreshold, seasons:[{season,state,shortfall}] }
  //   state は 'unimplemented' | 'unlocked' | 'exchangeable' | 'short'
  function nigekireOutfitState(points, unlocked, available, thresholds) {
    var p = typeof points === 'number' && isFinite(points) ? Math.floor(points) : 0;
    var un = Array.isArray(unlocked) ? unlocked : [];
    var av = Array.isArray(available) ? available : [];
    var allowance = nigekireOutfitAllowance(p, thresholds);
    // 使った枠は「解放済みの数」。ポイントは減らないので枠だけが埋まる。
    var usedCount = un.length;
    var remaining = allowance - usedCount;
    if (remaining < 0) remaining = 0;
    var next = nigekireOutfitNextThreshold(p, thresholds);

    var seasons = [];
    for (var i = 0; i < OUTFIT_SEASONS.length; i++) {
      var s = OUTFIT_SEASONS[i];
      var isUnlocked = un.indexOf(s) >= 0;
      var isAvailable = av.indexOf(s) >= 0;
      var state;
      var shortfall = null;
      if (isUnlocked) {
        // 取得済みは実装状況より優先（過去に解放したものは必ず出す）。
        state = 'unlocked';
      } else if (!isAvailable) {
        state = 'unimplemented';
      } else if (remaining > 0) {
        state = 'exchangeable';
      } else {
        state = 'short';
        // 「あと◯pt」の不足分（§5）。次の閾値が無い（全部到達済み）なら null。
        shortfall = next == null ? null : next - p;
      }
      seasons.push({ season: s, state: state, shortfall: shortfall });
    }
    return {
      allowance: allowance,
      usedCount: usedCount,
      remaining: remaining,
      nextThreshold: next,
      seasons: seasons,
    };
  }

  // 解放できるか（交換ボタンを押せるか）の判定。UIの二度押しロックとは別に、
  //   状態面で許されるかだけを見る。副作用なし。
  function nigekireCanUnlockOutfit(points, unlocked, available, season, thresholds) {
    var st = nigekireOutfitState(points, unlocked, available, thresholds);
    for (var i = 0; i < st.seasons.length; i++) {
      if (st.seasons[i].season === season) return st.seasons[i].state === 'exchangeable';
    }
    return false;
  }

  // 解放の反映（非破壊）。API 成功後に呼ぶ。既に入っていれば増やさない（二重登録防止）。
  //   unlocks は [{characterId, season, unlockedAt}] のキャッシュ配列。
  function nigekireApplyOutfitUnlock(unlocks, charKey, season, unlockedAt) {
    var list = Array.isArray(unlocks) ? unlocks.slice() : [];
    if (!charKey || typeof charKey !== 'string' || !season || typeof season !== 'string') {
      return list;
    }
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u && u.characterId === charKey && u.season === season) return list; // 既存＝そのまま
    }
    list.push({
      characterId: charKey,
      season: season,
      unlockedAt: typeof unlockedAt === 'string' ? unlockedAt : '',
    });
    return list;
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
    weekdayLabelJa: weekdayLabelJa,
    formatDateWithWeekday: formatDateWithWeekday,
    weekdayCharOf: weekdayCharOf,
    nigekireCharTitle: nigekireCharTitle,
    // ---- ニゲキレモード v2 純ロジック（一言収集・1本ゲージ・生活カード） ----
    nigekireTopChar: nigekireTopChar,
    detectHitokotoChar: detectHitokotoChar,
    nigekireCollectV2: nigekireCollectV2,
    nigekireTrialV2: nigekireTrialV2,
    nigekireCardStage: nigekireCardStage,
    // ---- ニゲキレ 通過ベースランク（rankStage・§10-2） ----
    nigekireRankByStage: nigekireRankByStage,
    nigekireOshiEscapeRecord: nigekireOshiEscapeRecord,
    nigekireOshiPassLineKey: nigekireOshiPassLineKey,
    nigekireRankLabel: nigekireRankLabel,
    nigekireRankTitleWithDays: nigekireRankTitleWithDays,

    // N群: キャラ単位ポイント＋閾値初到達ランク
    nigekireThresholdKey: nigekireThresholdKey,
    nigekireOshiMilestone: nigekireOshiMilestone,
    nigekirePassOshiMilestone: nigekirePassOshiMilestone,
    nigekireOshiGauge: nigekireOshiGauge,
    nigekireRankStageFromReached: nigekireRankStageFromReached,
    // ---- X群: 交換所（おへんじ帖の季節衣装）----
    OUTFIT_SEASONS: OUTFIT_SEASONS,
    nigekireOutfitAllowance: nigekireOutfitAllowance,
    nigekireOutfitNextThreshold: nigekireOutfitNextThreshold,
    nigekireUnlockedSeasons: nigekireUnlockedSeasons,
    nigekireOutfitState: nigekireOutfitState,
    nigekireCanUnlockOutfit: nigekireCanUnlockOutfit,
    nigekireApplyOutfitUnlock: nigekireApplyOutfitUnlock,
    // ---- クリエイター削除時のモード掃除（純関数・非破壊） ----
    cleanupKitacoreOnDelete: cleanupKitacoreOnDelete,
    cleanupNigekireOnDelete: cleanupNigekireOnDelete,
  };
});
