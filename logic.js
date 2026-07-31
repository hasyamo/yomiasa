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

  // note ID の正規化。クライアント側の唯一の規則＝trim（前後空白の除去）のみ。
  //   @除去・大文字小文字の同一視はしない（サーバへ送る形を変えないため）。
  //   非文字列は ''。読み書き・移行のすべてがこの規則を通る。
  function normalizeNoteId(id) {
    return typeof id === 'string' ? id.trim() : '';
  }

  // 全モード共有の user.noteId を導出する（純粋・非破壊）。
  //   戻り値は次の user オブジェクト（loadState/importData で next.user に載せる）。
  //   規則はこれだけ（フラグ無し・毎回この判定でよい＝冪等）：
  //     1. user.noteId が既に入っていればそれを正として使う（プロフィールも user 側を維持）。
  //     2. 空なら旧 modes.*.player から拾う：
  //          正規化後1種類だけ → 自動昇格（displayName/iconUrl も引き継ぐ）。
  //          正規化後 複数種類  → 自動確定しない（空。次に note ID が要る操作で入力を促す）。
  //          旧IDなし          → 空。
  //   ※ user.noteId が入っている限り旧 player より優先されるので、認証で user に入れれば
  //     以後は player を見ない。フラグを持たなくても「先勝ちで別人に化ける」ことはない。
  //   normalize は呼び出し側（app.js）と同一規則を渡す＝クライアント全体で1規則。
  function migrateUserNoteId(parsed, normalize) {
    parsed = parsed || {};
    normalize = normalize || normalizeNoteId;
    var existing = (parsed.user && typeof parsed.user === 'object') ? parsed.user : {};
    var existingId = normalize(existing.noteId);
    // 1. user.noteId が既にある → それを正とする（旧 player は見ない）。
    if (existingId) {
      return {
        noteId: existingId,
        displayName: typeof existing.displayName === 'string' ? existing.displayName : '',
        iconUrl: typeof existing.iconUrl === 'string' ? existing.iconUrl : '',
      };
    }
    // 2. 空 → 旧 modes.*.player から拾う。正規化後IDごとに最初のプロフィールを覚える。
    var modes = (parsed.modes && typeof parsed.modes === 'object') ? parsed.modes : {};
    var byId = {};
    var order = [];
    Object.keys(modes).forEach(function (k) {
      var m = modes[k];
      var p = m && typeof m === 'object' ? m.player : null;
      var norm = p && typeof p === 'object' ? normalize(p.id) : '';
      if (!norm) return;
      if (!byId[norm]) {
        byId[norm] = {
          noteId: norm,
          displayName: typeof p.displayName === 'string' ? p.displayName : '',
          iconUrl: typeof p.iconUrl === 'string' ? p.iconUrl : '',
        };
        order.push(norm);
      }
    });
    if (order.length === 1) {
      return byId[order[0]]; // 1種類だけ → 自動昇格。
    }
    // 複数種類 or 旧IDなし → 空（自動確定しない）。
    return { noteId: '', displayName: '', iconUrl: '' };
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

  // ---- 発掘（dig）純ロジック ----

  // 発掘の被験体（掘られる側）判定。参加者API のレスポンス配列から noteId 一致の
  //   参加者を探し、その roleTags に「掘られる側」を含むかを返す（純粋）。
  //   participants: [{ noteId, roleTags:[...] }, ...]。noteId は正規化（trim）して比較する。
  var DIG_TARGET_ROLE = '掘られる側';
  function isDigTargetInParticipants(participants, noteId) {
    if (!Array.isArray(participants)) return false;
    var want = normalizeNoteId(noteId);
    if (!want) return false;
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      if (!p || normalizeNoteId(p.noteId) !== want) continue;
      return Array.isArray(p.roleTags) && p.roleTags.indexOf(DIG_TARGET_ROLE) !== -1;
    }
    return false;
  }

  // そのクリエイターの記事のうち読了済みの note_key 配列を返す（純粋・非破壊）。
  //   articles: [{ id, url }, ...]、isReadFn(articleId)→boolean を受け取り、
  //   読了記事の url から note_key（articleKeyFromUrl）を抜いて重複なしで返す。
  //   note_key が取れない記事は黙って除外する。
  function readNoteKeys(articles, isReadFn) {
    if (!Array.isArray(articles) || typeof isReadFn !== 'function') return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      if (!a || !isReadFn(a.id)) continue;
      var key = articleKeyFromUrl(a.url);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  // 未送信の note_key（差分同期）＝ allKeys のうち sentKeys に無いもの。順序は allKeys を維持。
  //   allKeys: readNoteKeys の結果など。sentKeys: 送信済み配列（無ければ空扱い）。純粋・非破壊。
  function unsentNoteKeys(allKeys, sentKeys) {
    if (!Array.isArray(allKeys)) return [];
    var sentSet = {};
    if (Array.isArray(sentKeys)) {
      for (var i = 0; i < sentKeys.length; i++) sentSet[sentKeys[i]] = true;
    }
    var out = [];
    for (var j = 0; j < allKeys.length; j++) {
      if (!sentSet[allKeys[j]]) out.push(allKeys[j]);
    }
    return out;
  }

  // レイド開始後に読んだ記事か（発掘報告の対象か）を判定する（純粋・非破壊）。
  //   entry: state.readArticles の1エントリ（{ status, source, readAt }）。
  //   startsAt: レイド開始時刻（ISO文字列）。レイドマスター未取得なら空・null を渡す。
  //   開始前から既読だった記事を発掘成果に混ぜないための判定。readAt 欠損・不正値、
  //   startsAt 未取得はすべて false（＝報告対象にしない）。取れないものは送らない側に倒す。
  function isRaidReportableRead(entry, startsAt) {
    if (!entry || entry.status !== 'read') return false;
    if (!entry.readAt || !startsAt) return false;
    var readAt = Date.parse(entry.readAt);
    var raidStart = Date.parse(startsAt);
    if (!isFinite(readAt) || !isFinite(raidStart)) return false;
    return readAt >= raidStart;
  }

  // 送信済み集合に新しい note_key をマージした配列を返す（重複なし・非破壊）。
  //   prevSent: 既存の送信済み配列。addKeys: 今回成功した note_key。順序は prev→新規追加順。
  function mergeReportedKeys(prevSent, addKeys) {
    var out = [];
    var seen = {};
    function push(k) { if (k && !seen[k]) { seen[k] = true; out.push(k); } }
    if (Array.isArray(prevSent)) prevSent.forEach(push);
    if (Array.isArray(addKeys)) addKeys.forEach(push);
    return out;
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

  // 本文HTMLから一言キャラを「すべて」抽出（§10.7 ホワイトリスト照合・純関数）。
  //   本文中の見出し（h1〜h6）「◯◯の一言…」を全部拾い、7人に該当するものを配列で返す。
  //   ・見出しタグは h1〜h6 のどれでも可（実データは <h3>「凛華の一言:」～<h2>「月子の一言」）
  //   ・「◯◯の一言」の後ろ（コロン・空白・</hN>）は問わない
  //   ・1見出しに複数名は区切りで分割してそれぞれ照合
  //     記号（・、，,／/＆&）と並列助詞（と・や）を区切りに使う（例「月子と陽の一言」）。
  //     ※7人名に「と」「や」を含む名前は無いので助詞を区切りにしても誤爆しない。
  //   ・複数の見出しに別々のキャラ（「日和の一言」「しずくの一言」）があれば全部拾う
  //   返り値: charKey の配列（本文の出現順・重複除去）。該当なし/非文字列は []。
  //   nameToKey = { '月子':'tsukiko', ... }（7人ホワイトリスト）。
  function detectHitokotoChars(bodyHtml, nameToKey) {
    if (typeof bodyHtml !== 'string') return [];
    var map = nameToKey && typeof nameToKey === 'object' ? nameToKey : {};
    var out = [];
    var seen = {};
    // 見出し（hN）内の「◯◯の一言」を全部走査する。◯◯ は次の「の一言」まで。
    var re = /<h[1-6][^>]*>([^<]*?)の一言/g;
    var m;
    while ((m = re.exec(bodyHtml)) !== null) {
      // 「るな・陽」「月子と陽」のような複数名を区切りで分割（記号＋並列助詞と/や）。
      var parts = m[1].split(/[・､、，,／/＆&]|と|や/);
      for (var i = 0; i < parts.length; i++) {
        var name = parts[i].trim();
        if (!name) continue;
        if (Object.prototype.hasOwnProperty.call(map, name) && map[name]) {
          var key = map[name];
          if (!seen[key]) { seen[key] = true; out.push(key); } // 重複除去（出現順は保つ）
        }
      }
    }
    return out;
  }

  // 一言チップのタップ回収 v2（キャラ別・収集数 +1・§10・非破壊）。
  //   1記事に複数キャラの一言チップが出るため、どの charKey を回収するかを受ける。
  //   counts[articleId].chars に charKey が含まれない → { ok:false }（この記事の対象でない）。
  //   collected[articleId][charKey] あり → { ok:false }（そのキャラは回収済み・二重取り防止）。
  //   回収可: nextCharCounts[charKey] +1、nextCollected[articleId][charKey]=true を返す（非破壊）。
  //   collected はキャラ別（{ [articleId]: { [charKey]: true } }）＝チップごとに独立回収。
  function nigekireCollectV2(counts, collected, charCounts, articleId, charKey) {
    counts = counts && typeof counts === 'object' ? counts : {};
    collected = collected && typeof collected === 'object' ? collected : {};
    if (!charKey || typeof charKey !== 'string') return { ok: false };
    var entry = counts[articleId];
    var chars = entry && Array.isArray(entry.chars) ? entry.chars : [];
    if (chars.indexOf(charKey) < 0) return { ok: false }; // この記事の一言キャラでない

    var prevArticle = collected[articleId] && typeof collected[articleId] === 'object'
      ? collected[articleId] : {};
    if (prevArticle[charKey]) return { ok: false }; // そのキャラは回収済み

    var cc = charCounts && typeof charCounts === 'object' ? charCounts : {};
    var nextCharCounts = Object.assign({}, cc);
    var cur = typeof nextCharCounts[charKey] === 'number' ? nextCharCounts[charKey] : 0;
    nextCharCounts[charKey] = cur + 1;

    var nextCollected = Object.assign({}, collected);
    nextCollected[articleId] = Object.assign({}, prevArticle);
    nextCollected[articleId][charKey] = true;

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

  // ねんころ state の掃除。isTargetCreator（=creatorId が NENKORO_ID 本体=唯一の対象）なら、
  //   ポイント逆算（記事→キーワード→pt）が煩雑なため進行を丸ごとリセット（亡霊 state を残さない）。
  //   ニゲキレ版と同方針。対象でなければ変更なし（＝入力と同値の新オブジェクトを返す）。非破壊。
  function cleanupNenkoroOnDelete(nenkoroState, isTargetCreator) {
    var s = nenkoroState && typeof nenkoroState === 'object' ? nenkoroState : {};
    var next = Object.assign({}, s);
    if (isTargetCreator) {
      next.mode = {};
      next.counts = {};
      next.collected = {};
      next.totalResearchPoints = 0;
      next.keywordTotals = { chatgpt: 0, sora: 0 };
      next.seenMilestones = [];
      next.selectedBg = null;
    }
    return next;
  }

  // ===========================================================================
  // ねんころモード（AI研究所モード）純ロジック
  //   設計正本 nenkoro-mode-implementation-design.md §4〜§11。
  //   収集＝キーワード出現数を数える（本文のみ）。1件=研究ポイント1。
  //   ランクは totalResearchPoints から算出（保存しない）。0pt は「研究準備中」。
  //   すべて副作用なし・非破壊。
  // ===========================================================================

  // 本文テキストから各キーワードの出現数を数える。
  //   keywords = [{ key, label, pattern }]（pattern は g フラグ付きの正規表現）。
  //   ※呼び出しごとに新しい正規表現を new RegExp で作り直す（g フラグの lastIndex 残留事故を避ける）。
  //   戻り値: { <key>: number, ..., total: number }。text 非文字列は全 0。
  function nenkoroCountKeywords(text, keywords) {
    var s = typeof text === 'string' ? text : '';
    var list = Array.isArray(keywords) ? keywords : [];
    var out = {};
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var kw = list[i];
      if (!kw || typeof kw.key !== 'string' || !kw.pattern) continue;
      // pattern の source/flags から毎回作り直す（g を必ず立てる。lastIndex 共有を断つ）。
      var flags = (kw.pattern.flags || '').replace('g', '') + 'g';
      var re = new RegExp(kw.pattern.source, flags);
      var n = (s.match(re) || []).length;
      out[kw.key] = n;
      total += n;
    }
    out.total = total;
    return out;
  }

  // 研究ポイントが到達している閾値ランク（＝節目カードを出す判定用・設計 §7）。
  //   ranks = [{ key, minPoints, name }, ...]（minPoints 昇順）。閾値以上の最上位ランクを返す。
  //   ※これは「ポイントが達しているか」の判定であって、表示ランクではない。
  //     キタコレの kitacoreWaiRankOf（ワイ数→ボス出現トリガー）に相当する。
  //     表示ランクは nenkoroRankFromPassed（カットインを見た＝通過した節目から導出）を使う。
  //   initialStatus = { key, name }（研究準備中）。最初の閾値未満なら initialStatus を返す。
  //   戻り値: { key, name, minPoints, isPreparing }。ranks 不正/points<最小閾値 は initialStatus。
  function nenkoroRankOf(ranks, initialStatus, totalPoints) {
    var init = initialStatus && typeof initialStatus === 'object'
      ? initialStatus : { key: 'preparing', name: '' };
    var list = Array.isArray(ranks) ? ranks : [];
    var p = typeof totalPoints === 'number' && isFinite(totalPoints) ? totalPoints : 0;
    var found = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.minPoints !== 'number') continue;
      if (p >= r.minPoints) found = r; // 昇順前提で最後にマッチしたもの＝最上位
    }
    if (!found) {
      return { key: init.key || 'preparing', name: init.name || '', minPoints: 0, isPreparing: true };
    }
    return {
      key: typeof found.key === 'string' ? found.key : '',
      name: typeof found.name === 'string' ? found.name : '',
      minPoints: found.minPoints,
      isPreparing: false,
    };
  }

  // 通過済み節目（カットインを見た＝レベルアップ確定したランクkey）から表示ランクを導出する。
  //   キタコレの kitacoreRankOf（撃破済みボスから導出）と同じ考え方＝
  //   「ポイントが閾値を超えてもカットインを見るまでランクは上がらない」を実現する。
  //   ranks = [{ key, minPoints, name }]（昇順）。passedKeys = 通過済みランクkey配列（seenMilestones）。
  //   passedKeys のうち minPoints が最大のランクを返す。空なら initialStatus（研究準備中）。
  //   戻り値: { key, name, minPoints, isPreparing }。
  function nenkoroRankFromPassed(ranks, initialStatus, passedKeys) {
    var init = initialStatus && typeof initialStatus === 'object'
      ? initialStatus : { key: 'preparing', name: '' };
    var list = Array.isArray(ranks) ? ranks : [];
    var passed = Array.isArray(passedKeys) ? passedKeys : [];
    var found = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.key !== 'string' || typeof r.minPoints !== 'number') continue;
      if (passed.indexOf(r.key) === -1) continue; // まだ通過していない＝ランクに数えない
      if (!found || r.minPoints > found.minPoints) found = r; // 通過済みの中で最上位
    }
    if (!found) {
      return { key: init.key || 'preparing', name: init.name || '', minPoints: 0, isPreparing: true };
    }
    return {
      key: found.key,
      name: typeof found.name === 'string' ? found.name : '',
      minPoints: found.minPoints,
      isPreparing: false,
    };
  }

  // ※1本ゲージは絶対ゲージ（totalResearchPoints／NENKORO_GOAL=700）＝キタコレと同一構造。
  //   区間ゲージ（現ランク→次ランク）は誤りだったため廃止。描画は app.js の
  //   paintKitacoreHeader（totalWai／KITACORE_GOAL と同じ経路）に乗せるので logic 関数は不要。

  // 研究チップ回収（＝研究ポイント加算・設計 §5/§6）。
  //   counts[articleKey] = { chatgpt, sora, total }。total>0 かつ未回収のときだけ加算。
  //   counts なし / collected[articleKey] あり / total<=0 なら { ok:false }。
  //   回収可なら { ok:true, nextTotal, nextCollected, nextKeywordTotals, gained } を返す（非破壊）。
  //   nextKeywordTotals は keywordTotals にキーワード別内訳を足したもの。
  function nenkoroCollectOutcome(counts, collected, totalPoints, keywordTotals, articleKey) {
    counts = counts && typeof counts === 'object' ? counts : {};
    collected = collected && typeof collected === 'object' ? collected : {};
    keywordTotals = keywordTotals && typeof keywordTotals === 'object' ? keywordTotals : {};
    var entry = counts[articleKey];
    if (!entry || typeof entry !== 'object') return { ok: false }; // 未収集
    if (collected[articleKey]) return { ok: false }; // 二重回収防止
    var total = typeof entry.total === 'number' ? entry.total : 0;
    if (total <= 0) return { ok: false }; // 0件は回収対象外
    var nextCollected = Object.assign({}, collected);
    nextCollected[articleKey] = true;
    // キーワード別内訳を加算（total 以外の数値キーを内訳とみなす）。
    var nextKeywordTotals = Object.assign({}, keywordTotals);
    Object.keys(entry).forEach(function (k) {
      if (k === 'total' || k === 'countedAt') return;
      if (typeof entry[k] !== 'number') return;
      var prev = typeof nextKeywordTotals[k] === 'number' ? nextKeywordTotals[k] : 0;
      nextKeywordTotals[k] = prev + entry[k];
    });
    var base = typeof totalPoints === 'number' && isFinite(totalPoints) ? totalPoints : 0;
    return {
      ok: true,
      gained: total,
      nextTotal: base + total,
      nextCollected: nextCollected,
      nextKeywordTotals: nextKeywordTotals,
    };
  }

  // 今日（JST境界）読んだ記事の数（記事一覧ヘッダーの「今日読んだ記事」表示用）。
  //   readArticles = { key: { status:'read', readAt: ISO文字列 } }（app.js の形）。
  //   nowIso = 現在時刻の ISO 文字列（テスト可能にするため引数で受ける）。
  //   readAt を JST(+9h) の暦日に直し、now の JST 暦日と一致する read エントリを数える。
  //   readAt 無し / パース不能 / 未読 は除外。純関数。
  function nenkoroReadTodayCount(readArticles, nowIso) {
    var map = readArticles && typeof readArticles === 'object' ? readArticles : {};
    var now = parseDate(nowIso);
    if (!now) return 0;
    var nowJst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    var y = nowJst.getUTCFullYear();
    var m = nowJst.getUTCMonth();
    var d = nowJst.getUTCDate();
    var count = 0;
    Object.keys(map).forEach(function (k) {
      var e = map[k];
      if (!e || typeof e !== 'object' || e.status !== 'read' || !e.readAt) return;
      var ra = parseDate(e.readAt);
      if (!ra) return;
      var raJst = new Date(ra.getTime() + 9 * 60 * 60 * 1000);
      if (raJst.getUTCFullYear() === y && raJst.getUTCMonth() === m && raJst.getUTCDate() === d) {
        count++;
      }
    });
    return count;
  }

  // 未表示の節目（新到達ランク）を低い順に返す（設計 §9・複数閾値同時通過対応）。
  //   ranks = [{ key, minPoints, name }]（昇順）。seenMilestones = 表示済みランクkey配列。
  //   totalPoints 到達済み かつ seen に無いランクを minPoints 昇順で返す。
  //   戻り値: [rankObj, ...]（空配列可）。ランクは §7 の1対1（画像・文言はランクkeyから引く）。
  function nenkoroPendingMilestones(ranks, seenMilestones, totalPoints) {
    var list = Array.isArray(ranks) ? ranks.slice() : [];
    var seen = Array.isArray(seenMilestones) ? seenMilestones : [];
    var p = typeof totalPoints === 'number' && isFinite(totalPoints) ? totalPoints : 0;
    // minPoints 昇順に整える（定義が昇順でなくても壊れないように）。
    list.sort(function (a, b) {
      var am = a && typeof a.minPoints === 'number' ? a.minPoints : 0;
      var bm = b && typeof b.minPoints === 'number' ? b.minPoints : 0;
      return am - bm;
    });
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.minPoints !== 'number' || typeof r.key !== 'string') continue;
      if (p >= r.minPoints && seen.indexOf(r.key) === -1) out.push(r);
    }
    return out;
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
    normalizeNoteId: normalizeNoteId,
    migrateUserNoteId: migrateUserNoteId,
    modeForCreator: modeForCreator,
    isDigTargetInParticipants: isDigTargetInParticipants,
    readNoteKeys: readNoteKeys,
    unsentNoteKeys: unsentNoteKeys,
    isRaidReportableRead: isRaidReportableRead,
    mergeReportedKeys: mergeReportedKeys,
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
    detectHitokotoChars: detectHitokotoChars,
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
    cleanupNenkoroOnDelete: cleanupNenkoroOnDelete,
    // ---- ねんころモード（AI研究所モード）純ロジック ----
    nenkoroCountKeywords: nenkoroCountKeywords,
    nenkoroRankOf: nenkoroRankOf,
    nenkoroRankFromPassed: nenkoroRankFromPassed,
    nenkoroCollectOutcome: nenkoroCollectOutcome,
    nenkoroPendingMilestones: nenkoroPendingMilestones,
    nenkoroReadTodayCount: nenkoroReadTodayCount,
  };
});
