/* YOMIASA v0.1
 * 好きなnoteクリエイターの記事を、年月でたどる小さな道具。
 * Vanilla JS / ビルド不要 / 状態は localStorage に保存。
 *
 * 画面構成（SPA・ハッシュルーティング）:
 *   #list  … クリエイター一覧画面（進捗付き縦リスト）
 *   #read  … 記事一覧画面（選択中の1人を漁る）
 */
(function () {
  'use strict';

  var DEBUG_MODE = location.search.indexOf('debug=1') !== -1;

  // note.com API は CORS を許可していないため、CORS 対応の中継プロキシ経由で取得する。
  // ?id= でクリエイタープロフィール、?path= で任意の note API パスを中継できる。
  var PROXY_URL = 'https://falling-mouse-736b.hasyamo.workers.dev/';
  var STORAGE_KEY = 'yomiasa:v0';
  // 取得ページ上限。通常は isLastPage / 空ページで終端するので実質無制限。
  // この値は API が isLastPage を返さない等の不具合時に無限ループを防ぐ保険。
  // 1ページ6件なので 9999 = 約6万件まで対応。
  var PAGE_LIMIT = 9999;

  // アプリのバージョン。updates.json のキーと一致させること。
  var APP_VERSION = '0.1.6';
  var VERSION_KEY = 'yomiasa:lastSeenVersion';

  // 読了状態の出所。manual=手動トグル / bulk_initial=初期既読セットアップでの一括既読。
  // 状態は常に上書き可能なので優先順位は持たない（最後の操作が勝つ）。
  var SOURCE = { MANUAL: 'manual', BULK_INITIAL: 'bulk_initial' };

  // ---------------------------------------------------------------------------
  // localStorage 読み書き（関数化）
  // ---------------------------------------------------------------------------

  function defaultState() {
    return {
      creators: [],
      selectedCreatorId: '',
      articlesByCreator: {},
      readArticles: {},
      uiState: {
        keyword: '',
        year: 'all',
        month: 'all',
        showUnreadOnly: false,
        sortOrder: 'asc',
      },
      // year / month / showUnreadOnly / sortOrder はクリエイターごとに記憶する。
      // keyword は一時的な絞り込みなのでグローバル(uiState)のまま覚えない。
      uiByCreator: {},
      // キタコレモード。
      //   mode[id]        : キタコレモードON（ダブルタップで立つ。E級スタート）
      //   counts[id]      : 記事ごとのワイ数カウント（収集結果。article.id 単位）
      //   collected[id]   : ワイ語チップを回収済み（ポイント加算済み。二重取り防止）
      //   totalWai        : 回収した累計ワイ数（＝覚醒後ランクの燃料）
      //   keys[id]        : 鍵の数（覚醒前。クイズ正解で +1）
      //   defeatedBosses[id] : 撃破済みボス key の配列（覚醒前ランク・覚醒の導出元）
      //   player          : プレイヤー自身の note 情報 {id, displayName, iconUrl}（発動時に入力）
      //   quizTaps        : クイズ選択肢を押した累計回数（ランクカードの指標）
      kitacore: { mode: {}, counts: {}, collected: {}, totalWai: 0, keys: {}, defeatedBosses: {}, quizCleared: {}, player: null, quizTaps: 0, pendingPostBoss: {} },
    };
  }

  // state.kitacore とその各キーの遅延初期化。読み書き前に必ず通す。
  function ensureKitacore() {
    if (!state.kitacore || typeof state.kitacore !== 'object') state.kitacore = {};
    var k = state.kitacore;
    if (!k.mode || typeof k.mode !== 'object') k.mode = {};
    if (!k.counts || typeof k.counts !== 'object') k.counts = {};
    if (!k.collected || typeof k.collected !== 'object') k.collected = {};
    if (typeof k.totalWai !== 'number') k.totalWai = 0;
    if (!k.keys || typeof k.keys !== 'object') k.keys = {};
    if (!k.defeatedBosses || typeof k.defeatedBosses !== 'object') k.defeatedBosses = {};
    if (!k.quizCleared || typeof k.quizCleared !== 'object') k.quizCleared = {};
    if (k.player !== null && typeof k.player !== 'object') k.player = null;
    if (typeof k.quizTaps !== 'number') k.quizTaps = 0;
    if (!k.pendingPostBoss || typeof k.pendingPostBoss !== 'object') k.pendingPostBoss = {};
    return k;
  }

  // キタコレモードが発動できる唯一の note ID（KITAさん＝推される側。汎用化しない）。
  var KITACORE_ID = 'ktcrs1107';

  // プレイヤー名（＝ユーザー自身の note ID。発動時に入力・保存したものを使う）。
  // 未登録時のフォールバックは 'プレイヤー'（通常は登録後しか表示されない）。
  function playerName() {
    var p = state.kitacore && state.kitacore.player;
    return p && p.id ? p.id : 'プレイヤー';
  }

  // 覚醒後ランク（確定閾値・実データ検算済み）。覚醒＝S級スタートで、
  // 回収した累計ワイ(totalWai)が min 以上の最上位ランクを採用する。
  // key は CSS の rank-<key> と対応（バッジ色）。
  var KITACORE_GOAL = 2000; // 君主到達ライン＝進捗バーの最大
  var KITACORE_RANKS = [
    { rank: 'S級覚醒', key: 's',         min: 0,    bossKey: null },
    { rank: '国家級',  key: 'national',   min: 600,  bossKey: 'requiem' },
    { rank: '君主前',  key: 'lord-prev',  min: 1200, bossKey: 'cael' },
    { rank: '君主',    key: 'monarch',    min: 2000, bossKey: 'ashen' },
  ];

  // 覚醒後ボス（ワイ閾値到達で出現。鍵不要）。
  var KITACORE_POST_BOSSES = [
    { key: 'requiem', name: 'REQUIEM OF SHADOWS', title: '鎮魂の司祭',       rankAfter: '国家級', img: 'assets/boss/REQUIEM_OF_SHADOWS.webp' },
    { key: 'cael',    name: 'CAEL NOX',            title: '記憶する堕天使', rankAfter: '君主前', img: 'assets/boss/CAEL_NOX.webp' },
    { key: 'ashen',   name: 'ASHEN REAPER',        title: '灰の審判者',     rankAfter: '君主',   img: 'assets/boss/ASHEN_REAPER.webp' },
  ];

  // 覚醒後ランク = 撃破済みの覚醒後ボスから導出。
  // ワイ数が閾値を超えてもボスを倒すまでランクは上がらない。
  function kitacoreRankOf(creatorId) {
    var defeated = defeatedBossesOf(creatorId);
    var cur = KITACORE_RANKS[0]; // S級覚醒がデフォルト
    KITACORE_POST_BOSSES.forEach(function (boss) {
      if (defeated.indexOf(boss.key) !== -1) {
        var rank = KITACORE_RANKS.find(function (r) { return r.rank === boss.rankAfter; });
        if (rank && KITACORE_RANKS.indexOf(rank) > KITACORE_RANKS.indexOf(cur)) cur = rank;
      }
    });
    return cur;
  }

  // ワイ数がどのランク閾値に達しているか（ボス出現トリガー判定用）。
  function kitacoreWaiRankOf(totalWai) {
    var cur = KITACORE_RANKS[0];
    for (var i = 0; i < KITACORE_RANKS.length; i++) {
      if (totalWai >= KITACORE_RANKS[i].min) cur = KITACORE_RANKS[i];
    }
    return cur;
  }

  // 覚醒前ボス（撃破で昇格）。order 順に挑戦。最後の wing 撃破で S級覚醒。
  //   cost = 挑戦に要る終焉の鍵。rankBefore = そのボスに挑む時点のランク。
  //   rankAfter = 撃破後に昇格するランク（wing は S級覚醒）。img = 同梱画像。
  var KITACORE_PRE_BOSSES = [
    { key: 'reaper', name: 'REAPER', title: '終焉の執行者', cost: 3, rankBefore: 'E級', rankBeforeKey: 'e', rankAfter: 'C級', img: 'assets/boss/REAPER.webp' },
    { key: 'armored', name: 'ARMORED WARRIOR', title: '戦場の死', cost: 3, rankBefore: 'C級', rankBeforeKey: 'c', rankAfter: 'A級', img: 'assets/boss/ARMORED_WARRIOR.webp' },
    { key: 'wing', name: 'WING OF DEATH', title: '収穫の獣', cost: 3, rankBefore: 'A級', rankBeforeKey: 'a', rankAfter: 'S級覚醒', img: 'assets/boss/WING_OF_DEATH.webp' },
  ];

  // このクリエイターがキタコレ発動対象か（ktcrs1107 限定）。
  function isKitacoreTarget(creatorId) {
    return creatorId === KITACORE_ID;
  }

  // キタコレモードON か（ダブルタップで立つ。表示全般の前提条件）。
  function isModeOn(creatorId) {
    return !!(state.kitacore && state.kitacore.mode && state.kitacore.mode[creatorId]);
  }

  // 撃破済みボス key の配列。
  function defeatedBossesOf(creatorId) {
    var d = state.kitacore && state.kitacore.defeatedBosses ? state.kitacore.defeatedBosses[creatorId] : null;
    return Array.isArray(d) ? d : [];
  }

  // S級覚醒済みか＝覚醒前の最終ボス(wing)を撃破済み。
  function isPostAwakening(creatorId) {
    return defeatedBossesOf(creatorId).indexOf('wing') !== -1;
  }

  // 鍵の数。
  function keysOf(creatorId) {
    var n = state.kitacore && state.kitacore.keys ? state.kitacore.keys[creatorId] : 0;
    return typeof n === 'number' ? n : 0;
  }

  // 次に挑むべき覚醒前ボス（未撃破の先頭）。全撃破なら null。
  function nextPreBoss(creatorId) {
    var done = defeatedBossesOf(creatorId);
    for (var i = 0; i < KITACORE_PRE_BOSSES.length; i++) {
      if (done.indexOf(KITACORE_PRE_BOSSES[i].key) === -1) return KITACORE_PRE_BOSSES[i];
    }
    return null;
  }

  // ボスに挑戦する。鍵が足りれば消費して撃破＝昇格を確定し、戦闘演出を開始。
  // 戻り値: 挑戦できたら true。鍵不足なら false。
  function challengeBoss(creatorId, boss) {
    ensureKitacore();
    if (keysOf(creatorId) < boss.cost) return false;
    // 挑戦ボタンで確定：鍵を消費し撃破を記録（演出は結果の見せ方）。
    state.kitacore.keys[creatorId] = keysOf(creatorId) - boss.cost;
    if (!Array.isArray(state.kitacore.defeatedBosses[creatorId])) {
      state.kitacore.defeatedBosses[creatorId] = [];
    }
    state.kitacore.defeatedBosses[creatorId].push(boss.key);
    saveState();
    startBossBattle(boss, creatorId);
    return true;
  }

  // 登場煽り（撃破の前段）。
  function kitacoreBossEnterLines(boss) {
    return [
      '［ システム ］',
      '〈' + boss.name + '〉— ' + boss.title + ' —が立ちはだかる。',
    ];
  }

  // 通常ボス撃破メッセージ。
  function kitacoreBossDownLines(boss) {
    return [
      '［ システム ］',
      '〈' + boss.name + '〉を撃破しました。',
      'プレイヤー〈' + playerName() + '〉は ' + boss.rankAfter + ' に昇格しました。',
    ];
  }

  // A級ボス(wing)撃破＝S級覚醒の山場メッセージ。
  // ※「収集開始」は覚醒前から動いているので出さない（称号獲得で締める）。
  function kitacoreAwakenLines() {
    return [
      '［ システム ］',
      '最後の門番〈WING OF DEATH〉が沈黙しました。',
      'プレイヤー〈' + playerName() + '〉が覚醒します。',
      '称号『S級覚醒』を獲得しました。',
    ];
  }

  // 戦闘演出（登場→崩れ）。画面タップで撃破。崩れ切ったらバトル画面を閉じ、
  // 撃破/昇格は通常のシステムメッセージ（青ウィンドウ＋タイプライター）で出す。
  //   stage 'enter'   = 登場煽り（画像＋立ちはだかる）。タップで崩れへ。
  //   stage 'shatter' = ボス画像が砕けて消えるアニメ（1.5s。タップ無効）。完了で閉じて
  //                     状態反映＋システムメッセージへ。
  var activeBattle = null; // { boss, creatorId, stage }
  var KITACORE_SHATTER_MS = 1500;
  function startBossBattle(boss, creatorId) {
    activeBattle = { boss: boss, creatorId: creatorId, stage: 'enter' };
    if (els.kitacoreBattleImg) {
      els.kitacoreBattleImg.src = boss.img;
      els.kitacoreBattleImg.classList.remove('is-shatter');
    }
    if (els.kitacoreBattleText) {
      els.kitacoreBattleText.textContent = kitacoreBossEnterLines(boss).join('\n');
    }
    if (els.kitacoreBattle) {
      els.kitacoreBattle.classList.remove('hidden');
      // 砂嵐→ボス登場演出。BOSS_ENTER_STYLE で A/B 切り替え。
      var stage = els.kitacoreBattle.querySelector('.kitacore-battle-stage');
      els.kitacoreBattle.classList.remove('is-glitch');
      if (stage) {
        stage.classList.remove('is-glitch', 'is-enter-flip');
        void stage.offsetWidth;
        stage.classList.add(randomBossEnterStyle());
      }
      void els.kitacoreBattle.offsetWidth;
      els.kitacoreBattle.classList.add('is-glitch');
      playPixelGlitch();
    }
  }

  function onBossBattleTap() {
    if (!activeBattle || activeBattle.stage !== 'enter') return; // 崩れ中は無効
    var boss = activeBattle.boss;
    var creatorId = activeBattle.creatorId;
    activeBattle.stage = 'shatter';
    // テキストを消し、画像を砕くアニメへ。
    if (els.kitacoreBattleText) els.kitacoreBattleText.textContent = '';
    if (els.kitacoreBattleImg) els.kitacoreBattleImg.classList.add('is-shatter');
    setTimeout(function () {
      closeBossBattle();
      // 状態を反映（ヘッダー・記事・カード）。
      renderArticles();
      updateReadStatsHeader();
      renderCreatorCards();
      // 撃破/昇格を通常のシステムメッセージで（モード進入・覚醒と同じUI）。
      showSystemMessage(boss.key === 'wing' ? kitacoreAwakenLines() : kitacoreBossDownLines(boss));
    }, KITACORE_SHATTER_MS);
  }

  function closeBossBattle() {
    activeBattle = null;
    if (els.kitacoreBattle) els.kitacoreBattle.classList.add('hidden');
    if (els.kitacoreBattleImg) els.kitacoreBattleImg.classList.remove('is-shatter');
  }

  // キタコレモードのトグル。ON→E級スタート（修行開始）/ OFF→終了。発動対象のみ反応。
  // ※覚醒(S級)は A級ボス撃破で起きる。ここでは覚醒しない。
  // ON 時、プレイヤー未登録なら ID 入力モーダルを挟む（認証成功で発動）。
  function toggleMode(creatorId) {
    if (!isKitacoreTarget(creatorId)) return;
    ensureKitacore();
    if (isModeOn(creatorId)) {
      // OFF
      delete state.kitacore.mode[creatorId];
      saveState();
      renderCreatorCards();
      showSystemMessage(kitacoreSleepLines());
      return;
    }
    // ON：プレイヤー未登録なら入力モーダル → 認証成功で activateMode。
    if (!state.kitacore.player || !state.kitacore.player.id) {
      openPlayerInput(creatorId);
      return;
    }
    activateMode(creatorId);
  }

  // モードを実際にONにして覚醒メッセージを出す（プレイヤー登録済み前提）。
  function activateMode(creatorId) {
    ensureKitacore();
    state.kitacore.mode[creatorId] = { at: new Date().toISOString() };
    saveState();
    renderCreatorCards();
    showSystemMessage(kitacoreWakeLines());
  }

  // プレイヤーID入力モーダル。認証成功で player を保存し activateMode。
  var pendingModeCreatorId = null;
  function openPlayerInput(creatorId) {
    pendingModeCreatorId = creatorId;
    if (!els.kitacorePlayer) return;
    els.kitacorePlayerInput.value = '';
    els.kitacorePlayerInput.classList.remove('hidden');
    els.kitacorePlayerError.classList.add('hidden');
    els.kitacorePlayerError.textContent = '';
    els.kitacorePlayerAuth.textContent = '認証';
    els.kitacorePlayerAuth.disabled = false;
    pendingPlayerProfile = null;
    resetPlayerPreview();
    els.kitacorePlayer.classList.remove('hidden');
    setTimeout(function () {
      els.kitacorePlayerInput.focus();
    }, 0);
  }

  function closePlayerInput() {
    pendingModeCreatorId = null;
    pendingPlayerProfile = null;
    if (els.kitacorePlayer) els.kitacorePlayer.classList.add('hidden');
  }

  function resetPlayerPreview() {
    if (!els.kitacorePlayerPreview) return;
    els.kitacorePlayerPreview.innerHTML = '';
    els.kitacorePlayerPreview.classList.add('hidden');
  }

  function showPlayerPreview(profile) {
    if (!els.kitacorePlayerPreview) return;
    els.kitacorePlayerPreview.innerHTML = '';
    els.kitacorePlayerPreview.classList.remove('hidden');

    var avatar = document.createElement('div');
    avatar.className = 'add-preview-avatar';
    if (profile.iconUrl) {
      var img = document.createElement('img');
      img.src = profile.iconUrl;
      img.alt = '';
      img.addEventListener('error', function () {
        avatar.removeChild(img);
        avatar.textContent = (profile.displayName || profile.id).charAt(0);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (profile.displayName || profile.id).charAt(0);
    }

    var info = document.createElement('div');
    var nameEl = document.createElement('div');
    nameEl.className = 'add-preview-name';
    nameEl.textContent = profile.displayName || profile.id;
    var idEl = document.createElement('div');
    idEl.className = 'add-preview-id';
    idEl.textContent = '@' + profile.id;
    info.appendChild(nameEl);
    info.appendChild(idEl);

    els.kitacorePlayerPreview.appendChild(avatar);
    els.kitacorePlayerPreview.appendChild(info);
  }

  // 認証：2段階。1回目→プロフィール取得＋プレビュー表示。2回目（決定）→モード発動。
  var pendingPlayerProfile = null;
  function authPlayer() {
    // 2回目：プレビュー確認済み → 決定
    if (pendingPlayerProfile) {
      var creatorId = pendingModeCreatorId;
      ensureKitacore();
      state.kitacore.player = {
        id: pendingPlayerProfile.id,
        displayName: pendingPlayerProfile.displayName,
        iconUrl: pendingPlayerProfile.iconUrl,
      };
      saveState();
      pendingPlayerProfile = null;
      closePlayerInput();
      activateMode(creatorId);
      return;
    }
    // 1回目：ID入力 → プロフィール取得
    var id = (els.kitacorePlayerInput.value || '').trim().replace(/^@/, '');
    if (!id) {
      showPlayerError('IDを入力せよ。');
      return;
    }
    var creatorId = pendingModeCreatorId;
    els.kitacorePlayerAuth.disabled = true;
    els.kitacorePlayerError.classList.add('hidden');
    resetPlayerPreview();
    fetchCreatorProfile(id).then(function (profile) {
      if (!profile) {
        showPlayerError('そのプレイヤーは存在しない。');
        els.kitacorePlayerAuth.disabled = false;
        return;
      }
      pendingPlayerProfile = { id: id, displayName: profile.displayName || id, iconUrl: profile.iconUrl || null };
      showPlayerPreview(pendingPlayerProfile);
      // 入力欄を隠してボタンを「決定」に変更
      els.kitacorePlayerInput.classList.add('hidden');
      els.kitacorePlayerAuth.textContent = '決定';
      els.kitacorePlayerAuth.disabled = false;
    });
  }

  function showPlayerError(msg) {
    if (!els.kitacorePlayerError) return;
    els.kitacorePlayerError.textContent = msg;
    els.kitacorePlayerError.classList.remove('hidden');
  }

  // ランクカード表示
  function openRankCard() {
    if (!els.kitacoreRankCard || !els.kitacoreRankCardContent) return;
    var player = state.kitacore && state.kitacore.player;
    if (!player) return;
    var creatorId = KITACORE_ID;
    var rankInfo = isPostAwakening(creatorId) ? kitacoreRankOf(creatorId) : null;
    var rankLabel = rankInfo
      ? 'ワイ語ハンターランク ' + rankInfo.rank
      : (nextPreBoss(creatorId) ? 'ワイ語ハンターランク ' + nextPreBoss(creatorId).rankBefore : '---');
    var totalWai = (state.kitacore && state.kitacore.totalWai) || 0;
    var quizTaps = (state.kitacore && state.kitacore.quizTaps) || 0;
    var quizCleared = state.kitacore && state.kitacore.quizCleared ? Object.keys(state.kitacore.quizCleared).length : 0;
    var keysCount = keysOf(creatorId);

    var el = els.kitacoreRankCardContent;
    el.innerHTML = '';

    // アイコン + 表示名 + ID
    var playerRow = document.createElement('div');
    playerRow.className = 'rank-card-player';
    var avatar = document.createElement('div');
    avatar.className = 'add-preview-avatar rank-card-avatar';
    if (player.iconUrl) {
      var img = document.createElement('img');
      img.src = player.iconUrl;
      img.alt = '';
      img.addEventListener('error', function () {
        avatar.removeChild(img);
        avatar.textContent = (player.displayName || player.id).charAt(0);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (player.displayName || player.id).charAt(0);
    }
    var playerInfo = document.createElement('div');
    var playerName = document.createElement('div');
    playerName.className = 'add-preview-name';
    playerName.textContent = player.displayName || player.id;
    var playerId = document.createElement('div');
    playerId.className = 'add-preview-id';
    playerId.textContent = '@' + player.id;
    playerInfo.appendChild(playerName);
    playerInfo.appendChild(playerId);
    playerRow.appendChild(avatar);
    playerRow.appendChild(playerInfo);
    el.appendChild(playerRow);

    // ランク
    var rankRow = document.createElement('div');
    rankRow.className = 'rank-card-row';
    var rankKey = rankInfo ? rankInfo.key : (nextPreBoss(creatorId) ? nextPreBoss(creatorId).rankBeforeKey : 'e');
    rankRow.innerHTML = '<span class="rank-card-label">ランク</span><span class="kitacore-rank-text rank-' + rankKey + '">' + rankLabel + '</span>';
    el.appendChild(rankRow);

    // ワイ累計
    var waiRow = document.createElement('div');
    waiRow.className = 'rank-card-row';
    waiRow.innerHTML = '<span class="rank-card-label">ワイ語収集数</span><span class="rank-card-value">' + totalWai + '</span>';
    el.appendChild(waiRow);

    // 鍵（覚醒前のみ）
    if (!isPostAwakening(creatorId)) {
      var keyRow = document.createElement('div');
      keyRow.className = 'rank-card-row';
      keyRow.innerHTML = '<span class="rank-card-label">終焉の鍵</span><span class="rank-card-value">' + keysCount + '</span>';
      el.appendChild(keyRow);
    }

    // 試練の記録
    var tapRow = document.createElement('div');
    tapRow.className = 'rank-card-row';
    tapRow.innerHTML = '<span class="rank-card-label">試練の記録</span><span class="rank-card-value">' + quizCleared + '問正解 / ' + quizTaps + 'タップ</span>';
    el.appendChild(tapRow);

    // 討伐ボス一覧（覚醒前3体 → 覚醒後3体）
    var defeated = defeatedBossesOf(creatorId);
    var allBosses = KITACORE_PRE_BOSSES.concat(KITACORE_POST_BOSSES);
    var bossRow = document.createElement('div');
    bossRow.className = 'rank-card-bosses';
    allBosses.forEach(function (boss) {
      var isDefeated = defeated.indexOf(boss.key) !== -1;
      var card = document.createElement('div');
      card.className = 'rank-card-boss' + (isDefeated ? ' is-defeated' : ' is-locked');
      if (isDefeated) {
        var img = document.createElement('img');
        img.src = boss.img;
        img.alt = boss.name;
        img.addEventListener('error', function () {
          card.removeChild(img);
          var fallback = document.createElement('span');
          fallback.className = 'rank-card-boss-fallback';
          fallback.textContent = '?';
          card.appendChild(fallback);
        });
        card.appendChild(img);
      } else {
        var unknown = document.createElement('span');
        unknown.className = 'rank-card-boss-fallback';
        unknown.textContent = '？';
        card.appendChild(unknown);
      }
      bossRow.appendChild(card);
    });
    el.appendChild(bossRow);

    els.kitacoreRankCard.classList.remove('hidden');
  }

  function closeRankCard() {
    if (els.kitacoreRankCard) els.kitacoreRankCard.classList.add('hidden');
  }

  // クイズデータ（覚醒前）。起動時に一度だけ読み、メモリに保持する。
  //   キー = 記事URLのスラッグ(n...)。{ q, choices[], answer }
  var kitacoreQuizzes = null;
  function loadKitacoreQuizzes() {
    fetch('kitacore_quiz.json?v=' + APP_VERSION)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        kitacoreQuizzes = data && data.quizzes ? data.quizzes : {};
      })
      .catch(function () {
        kitacoreQuizzes = {}; // 読めなくてもクイズ無しで動く
      })
      .then(function () {
        // ロード完了で初めて光ボタンの判定ができる。初回描画はロード前に走るので、
        // ここで現在のルートを描き直して✨ボタンを反映する（レース対策）。
        renderRoute();
      });
  }

  // 記事に紐づくクイズ（無ければ null）。スラッグで引く。
  function quizForArticle(article) {
    if (!kitacoreQuizzes) return null;
    var key = articleKeyFromUrl(article && article.url);
    return key && kitacoreQuizzes[key] ? kitacoreQuizzes[key] : null;
  }

  // クイズ正解済みか（記事ごと1回。鍵の二重獲得防止）。collected を流用せず専用に持つ。
  function isQuizCleared(creatorId, articleId) {
    var k = state.kitacore && state.kitacore.quizCleared ? state.kitacore.quizCleared : null;
    return !!(k && k[articleId]);
  }

  // 鍵を1つ獲得（クイズ正解時）。記事ごと1回きり。
  function awardKey(creatorId, articleId) {
    ensureKitacore();
    if (!state.kitacore.quizCleared) state.kitacore.quizCleared = {};
    if (state.kitacore.quizCleared[articleId]) return; // 既に獲得済み
    state.kitacore.quizCleared[articleId] = true;
    state.kitacore.keys[creatorId] = keysOf(creatorId) + 1;
    saveState();
  }

  // 進行中クイズの文脈。
  var activeQuiz = null; // { creatorId, articleId, quiz }

  // 配列をシャッフルした新配列を返す（Fisher–Yates）。元配列は壊さない。
  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  // ボス登場スタイル：毎回ランダムで3パターンから選ぶ。
  // ボス登場スタイル：揺れ / 裏表回転をランダムで切り替え。
  var BOSS_ENTER_STYLES = ['is-glitch', 'is-enter-flip'];
  function randomBossEnterStyle() {
    return BOSS_ENTER_STYLES[Math.floor(Math.random() * BOSS_ENTER_STYLES.length)];
  }

  // Canvas でピクセルモザイクを全画面に描画し、フェードアウトさせる起動演出。
  // ブロックサイズ大きめ（20px）でデジタルノイズらしいカクカクした四角を出す。
  function playPixelGlitch() {
    // prefers-reduced-motion 対応
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var BLOCK = 8;           // ブロックサイズ（px）
    var FRAMES = 8;          // ざわつくフレーム数
    var FRAME_MS = 60;       // 1フレームの時間
    var FADE_MS = 250;       // フェードアウトにかける時間

    // canvas を生成（既存があれば再利用）
    var canvas = document.getElementById('kitacore-glitch-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'kitacore-glitch-canvas';
      document.body.appendChild(canvas);
    }
    canvas.style.opacity = '1';
    canvas.style.transition = 'none';

    var W = window.innerWidth;
    var H = window.innerHeight;
    canvas.width  = W;
    canvas.height = H;

    var ctx = canvas.getContext('2d');
    var cols = Math.ceil(W / BLOCK);
    var rows = Math.ceil(H / BLOCK);

    // グレースケール6値。黒・白は少なめにしてグレー中心のノイズ感に。
    var COLORS = ['#111111', '#333333', '#555555', '#888888', '#bbbbbb', '#dddddd', '#dddddd', '#888888', '#555555', '#333333'];

    function drawFrame() {
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          ctx.fillStyle = COLORS[Math.floor(Math.random() * COLORS.length)];
          ctx.fillRect(c * BLOCK, r * BLOCK, BLOCK, BLOCK);
        }
      }
    }

    // FRAMES 回ざわつかせてからフェードアウト
    var frame = 0;
    drawFrame();
    var interval = setInterval(function () {
      frame++;
      if (frame >= FRAMES) {
        clearInterval(interval);
        // フェードアウト開始
        canvas.style.transition = 'opacity ' + FADE_MS + 'ms ease-out';
        canvas.style.opacity = '0';
        setTimeout(function () {
          canvas.style.transition = 'none';
          ctx.clearRect(0, 0, W, H);
        }, FADE_MS + 50);
        return;
      }
      drawFrame();
    }, FRAME_MS);
  }

  // クイズモーダルを開く（覚醒前・モードON・未覚醒・クイズ有りのときだけ）。
  // 選択肢は毎回シャッフルする（位置記憶でのズルを防ぐ）。
  function openQuiz(creatorId, article, quiz) {
    // {text, correct} にしてシャッフルし、シャッフル後の正解位置を持つ。
    var items = shuffled(
      quiz.choices.map(function (text, i) {
        return { text: text, correct: i === quiz.answer };
      })
    );
    var correctIndex = items.findIndex(function (it) {
      return it.correct;
    });
    activeQuiz = { creatorId: creatorId, articleId: article.id, correctIndex: correctIndex };

    els.kitacoreQuizQ.textContent = quiz.q;
    els.kitacoreQuizResult.classList.add('hidden');
    els.kitacoreQuizResult.textContent = '';
    els.kitacoreQuizChoices.innerHTML = '';
    var cleared = isQuizCleared(creatorId, article.id);
    items.forEach(function (it, idx) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kitacore-quiz-choice';
      btn.textContent = it.text;
      btn.addEventListener('click', function () {
        answerQuiz(idx);
      });
      els.kitacoreQuizChoices.appendChild(btn);
    });
    if (cleared) {
      // 既に正解済みなら鍵は出ないことを明示（再挑戦自体は可）
      els.kitacoreQuizResult.textContent = 'この試練の終焉の鍵は取得済みです。';
      els.kitacoreQuizResult.classList.remove('hidden');
    }
    els.kitacoreQuiz.classList.remove('hidden');
    // Canvas ピクセルモザイク起動演出 + ウィンドウ揺れ
    var win = els.kitacoreQuiz.querySelector('.kitacore-quiz-window');
    els.kitacoreQuiz.classList.remove('is-glitch');
    if (win) win.classList.remove('is-glitch');
    void els.kitacoreQuiz.offsetWidth;
    els.kitacoreQuiz.classList.add('is-glitch');
    if (win) win.classList.add('is-glitch');
  }

  function answerQuiz(idx) {
    if (!activeQuiz) return;
    // 正解済み（選択肢が disabled）なら何もしない
    if (activeQuiz.answered) return;
    var correct = idx === activeQuiz.correctIndex;
    var btns = els.kitacoreQuizChoices.querySelectorAll('.kitacore-quiz-choice');
    btns[idx].classList.add(correct ? 'is-correct' : 'is-wrong');
    if (correct) {
      activeQuiz.answered = true; // 正解フラグ
      btns[activeQuiz.correctIndex].classList.add('is-correct');
      // 全選択肢を無効化
      btns.forEach(function (b) { b.disabled = true; });
    }
    var alreadyHad = isQuizCleared(activeQuiz.creatorId, activeQuiz.articleId);
    if (correct && !alreadyHad) {
      awardKey(activeQuiz.creatorId, activeQuiz.articleId);
      els.kitacoreQuizResult.textContent = '正解。終焉の鍵を 1 獲得しました。';
      updateReadStatsHeader(); // 鍵の数→ヘッダーへ反映
      renderArticles(); // 光ボタンを「入手済」に更新（モーダルは別レイヤーで残る）
    } else if (correct) {
      els.kitacoreQuizResult.textContent = '正解。この試練の終焉の鍵は取得済みです。';
    } else {
      els.kitacoreQuizResult.textContent = '不正解。再挑戦が可能です。';
    }
    els.kitacoreQuizResult.classList.remove('hidden');
  }

  function closeQuiz() {
    activeQuiz = null;
    if (els.kitacoreQuiz) els.kitacoreQuiz.classList.add('hidden');
  }

  // ダブルタップ／ダブルクリックを要素に仕込む。
  //   デスクトップ: dblclick。
  //   モバイル: touchend の間隔(<=350ms)＋移動量(<=24px)で自前判定する。
  //     iOS Safari はダブルタップがズーム/合成 dblclick と競合するため、
  //     touchend 側で判定したら preventDefault して合成イベントを抑止し、
  //     直後の dblclick を無視して二重発火を防ぐ。
  function attachDoubleTap(el, handler) {
    var DT_MS = 350;
    var DT_MOVE = 24;
    var lastTime = 0;
    var lastX = 0;
    var lastY = 0;
    var suppressDblclickUntil = 0;

    el.addEventListener('dblclick', function (e) {
      // touch 由来で合成された dblclick は無視（touchend 側で処理済み）
      if (e.timeStamp <= suppressDblclickUntil) return;
      e.stopPropagation();
      handler();
    });

    el.addEventListener(
      'touchend',
      function (e) {
        if (!e.changedTouches || e.changedTouches.length !== 1) return;
        var t = e.changedTouches[0];
        var dt = e.timeStamp - lastTime;
        var moved =
          Math.abs(t.clientX - lastX) > DT_MOVE || Math.abs(t.clientY - lastY) > DT_MOVE;
        if (dt > 0 && dt <= DT_MS && !moved) {
          // ダブルタップ成立：ズーム/合成クリックを止めて発火
          e.preventDefault();
          e.stopPropagation();
          suppressDblclickUntil = e.timeStamp + 700;
          lastTime = 0; // 連続トリプルタップを誤検出しない
          handler();
          return;
        }
        lastTime = e.timeStamp;
        lastX = t.clientX;
        lastY = t.clientY;
      },
      { passive: false }
    );
  }

  // ON 時のシステムメッセージ（俺レベ「システム」風・無機質）。
  function kitacoreWakeLines() {
    return [
      '［ システム ］',
      'プレイヤー〈' + playerName() + '〉の覚醒を確認しました。',
      '隠しモード『キタコレモード』が解放されました。',
      'ワイ語の収集を開始します。',
    ];
  }

  // OFF 時のシステムメッセージ。
  function kitacoreSleepLines() {
    return [
      '［ システム ］',
      '『キタコレモード』を終了します。',
      'プレイヤー〈' + playerName() + '〉、また会いましょう。',
    ];
  }

  // 進行中のタイプライターの状態。null=非表示。
  //   { lines, full, typed, timer, done } done=true なら次タップで閉じる。
  var systemMsg = null;

  // システムメッセージをタイプライター表示する。
  //   1回目タップ: 全文即時表示（スキップ）/ 2回目タップ: 閉じる。
  function showSystemMessage(lines) {
    if (!els.kitacoreSystem || !els.kitacoreSystemText) return;
    // 進行中があれば片付ける
    if (systemMsg && systemMsg.timer) clearTimeout(systemMsg.timer);
    var full = lines.join('\n');
    systemMsg = { full: full, typed: 0, timer: null, done: false };
    els.kitacoreSystemText.textContent = '';
    els.kitacoreSystem.classList.remove('hidden');
    typeNextChar();
  }

  function typeNextChar() {
    if (!systemMsg) return;
    if (systemMsg.typed >= systemMsg.full.length) {
      systemMsg.done = true;
      return;
    }
    systemMsg.typed += 1;
    els.kitacoreSystemText.textContent = systemMsg.full.slice(0, systemMsg.typed);
    // 改行は少し溜める＝行送りの間。それ以外は等速。
    var ch = systemMsg.full.charAt(systemMsg.typed - 1);
    var delay = ch === '\n' ? 260 : 34;
    systemMsg.timer = setTimeout(typeNextChar, delay);
  }

  // オーバーレイのタップ: 未完了なら全文即表示、完了済みなら閉じる。
  function onSystemMessageTap() {
    if (!systemMsg) return;
    if (!systemMsg.done) {
      if (systemMsg.timer) clearTimeout(systemMsg.timer);
      systemMsg.typed = systemMsg.full.length;
      els.kitacoreSystemText.textContent = systemMsg.full;
      systemMsg.done = true;
      return;
    }
    closeSystemMessage();
  }

  function closeSystemMessage() {
    if (systemMsg && systemMsg.timer) clearTimeout(systemMsg.timer);
    systemMsg = null;
    if (els.kitacoreSystem) els.kitacoreSystem.classList.add('hidden');
  }

  // クリエイター別に覚える UI 項目のデフォルト。
  function defaultCreatorUi() {
    return { year: 'all', month: 'all', showUnreadOnly: false, sortOrder: 'asc' };
  }

  // 指定クリエイターの保存済み UI 設定を返す（無ければ作って返す）。
  function creatorUi(creatorId) {
    if (!state.uiByCreator) state.uiByCreator = {};
    if (!creatorId) return defaultCreatorUi();
    if (!state.uiByCreator[creatorId]) {
      state.uiByCreator[creatorId] = defaultCreatorUi();
    }
    return state.uiByCreator[creatorId];
  }

  // 「いま表示中のクリエイター」の実効 UI 設定。
  // keyword はグローバル、それ以外はクリエイター別。読み取りは常にこれを使う。
  function activeUi() {
    var cu = creatorUi(state.selectedCreatorId);
    return {
      keyword: state.uiState.keyword || '',
      year: cu.year,
      month: cu.month,
      showUnreadOnly: cu.showUnreadOnly,
      sortOrder: cu.sortOrder,
    };
  }

  // 旧フォーマットを現行の {status, source, readAt} へ移行する。
  //   v0.1: readArticles[key] === true
  //   v0.2: readArticles[key] === {read, source}
  // いずれも「読了」とみなせるものだけ残す（未読は記録しない）。
  function migrateReadArticles(read) {
    var out = {};
    if (!read) return out;
    Object.keys(read).forEach(function (k) {
      var v = read[k];
      var isRead;
      var source = SOURCE.MANUAL;
      if (v === true) {
        isRead = true;
      } else if (v && typeof v === 'object') {
        // 現行構造（status）／旧構造（read）の両対応
        if ('status' in v) {
          isRead = v.status === 'read';
          source = v.source === SOURCE.BULK_INITIAL ? SOURCE.BULK_INITIAL : SOURCE.MANUAL;
        } else {
          isRead = !!v.read;
        }
      } else {
        isRead = false;
      }
      if (isRead) {
        out[k] = { status: 'read', source: source, readAt: v && v.readAt ? v.readAt : null };
      }
    });
    return out;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var base = defaultState();
      return {
        creators: Array.isArray(parsed.creators) ? parsed.creators : base.creators,
        selectedCreatorId: parsed.selectedCreatorId || base.selectedCreatorId,
        articlesByCreator: parsed.articlesByCreator || base.articlesByCreator,
        readArticles: migrateReadArticles(parsed.readArticles),
        uiState: Object.assign({}, base.uiState, parsed.uiState || {}),
        uiByCreator:
          parsed.uiByCreator && typeof parsed.uiByCreator === 'object'
            ? parsed.uiByCreator
            : base.uiByCreator,
        kitacore:
          parsed.kitacore && typeof parsed.kitacore === 'object'
            ? parsed.kitacore
            : base.kitacore,
      };
    } catch (e) {
      return defaultState();
    }
  }

  // 保存できなかった場合は true 以外（メッセージ）を返す。
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return 'localStorage に保存できませんでした。\n空き容量を確認してください。';
    }
  }

  // 現在の状態を JSON テキストにする（エクスポート用）。
  function exportData() {
    return JSON.stringify(
      {
        app: 'yomiasa',
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        state: state,
      },
      null,
      2
    );
  }

  // JSON テキストから状態を復元して上書き保存する（インポート用）。
  // 失敗時は例外を投げる。成功時は新しい state を返す。
  function importData(jsonText) {
    var parsed = JSON.parse(jsonText);
    // エクスポート形式（{app,version,state}）と、生の state 直貼りの両対応
    var incoming = parsed && parsed.state ? parsed.state : parsed;
    if (!incoming || typeof incoming !== 'object') {
      throw new Error('形式が正しくありません');
    }
    var base = defaultState();
    var next = {
      creators: Array.isArray(incoming.creators) ? incoming.creators : base.creators,
      selectedCreatorId: incoming.selectedCreatorId || base.selectedCreatorId,
      articlesByCreator:
        incoming.articlesByCreator && typeof incoming.articlesByCreator === 'object'
          ? incoming.articlesByCreator
          : base.articlesByCreator,
      readArticles: migrateReadArticles(incoming.readArticles),
      uiState: Object.assign({}, base.uiState, incoming.uiState || {}),
      uiByCreator:
        incoming.uiByCreator && typeof incoming.uiByCreator === 'object'
          ? incoming.uiByCreator
          : base.uiByCreator,
      kitacore:
        incoming.kitacore && typeof incoming.kitacore === 'object'
          ? incoming.kitacore
          : base.kitacore,
    };
    state = next;
    var saved = saveState();
    if (saved !== true) throw new Error(saved);
    return state;
  }

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------

  var state = loadState();
  var isFetching = false;
  var editingCreatorId = null;

  // 一覧表示時に取得する各クリエイターの最新状態（揮発・保存しない）。
  //   latestStatus[id] = { totalCount, latestPublishedAt }
  // 新着 = 件数が増えた or 最新公開日が seenLatestPublishedAt より新しい。
  var latestStatus = {};

  // 追加モーダルのプレビュー用。取得に成功すると {id, displayName, iconUrl} が入る。
  var pendingProfile = null;
  var addPreviewToken = 0; // 入力連打時の取得結果の競合を防ぐ
  var addDebounceTimer = null;

  // ---------------------------------------------------------------------------
  // クリエイターID 抽出
  // ---------------------------------------------------------------------------

  function extractCreatorId(input) {
    if (!input) return null;
    var value = String(input).trim();
    if (!value) return null;

    var urlMatch = value.match(/note\.com\/([^\/\?#\s]+)/i);
    if (urlMatch) {
      value = urlMatch[1];
    } else if (/^https?:\/\//i.test(value)) {
      return null;
    }

    value = value.replace(/^@/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    if (value === 'api') return null;
    return value;
  }

  // ---------------------------------------------------------------------------
  // API（取得処理と描画処理は分離する）
  // ---------------------------------------------------------------------------

  function fetchCreatorProfile(creatorId) {
    var url = PROXY_URL + '?id=' + encodeURIComponent(creatorId);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object') return null;
        return {
          displayName: data.nickname || creatorId,
          iconUrl: data.profileImageUrl || null,
        };
      })
      .catch(function () {
        return null;
      });
  }

  // 1ページの取得件数。per 未指定だとデフォルト6件になり、ページ番号上限(約100)に
  // 早く到達して ~600件で打ち切られる。per=18（note web の「もっと見る」と同値・
  // per の許容上限は20）にすることで多記事クリエイターも全件取得できる。
  var PER_PAGE = 18;

  function buildContentsUrl(creatorId, page) {
    var notePath =
      '/api/v2/creators/' +
      encodeURIComponent(creatorId) +
      '/contents?kind=note&page=' +
      page +
      '&per=' +
      PER_PAGE +
      '&disabled_pinned=false&with_notes=false';
    return PROXY_URL + '?path=' + encodeURIComponent(notePath);
  }

  function normalizeArticle(item, creatorId) {
    return {
      id: 'n' + item.id,
      title: item.name || '(無題)',
      url: 'https://note.com/' + creatorId + '/n/' + item.key,
      publishedAt: item.publishAt || item.publish_at || '',
      likeCount: typeof item.likeCount === 'number' ? item.likeCount : 0,
      commentCount: typeof item.commentCount === 'number' ? item.commentCount : 0,
      thumbnailUrl: item.eyecatch || '',
    };
  }

  // 記事を取得する。差分取得対応。
  //   opts.sincePublishedAt : 前回取得時の最新公開日（ISO文字列）。各ページを
  //       公開日の降順にソートし、これ以下の公開日に達したら以降は既知として停止
  //       する（＝新着分だけ取れる）。null/未指定なら全件取得（初回）。
  //   opts.knownIds : 既に持っている記事IDの Set。重複の保険として収集後に除外する。
  //   onProgress(count) : 取得済み件数を都度通知（任意）。
  // 戻り値: { articles: 新しい順の取得分, totalCount, latestPublishedAt, reachedKnown }
  //   latestPublishedAt : page1 全記事のうち最も新しい公開日（ピン留めに影響されない）。
  //
  // 注意: note は page1 の先頭にピン留め記事（古い記事のことが多い）を固定する。
  // contents の素の並び順に頼ると先頭で誤って停止するため、必ず公開日でソートしてから
  // 判定する。これによりピン留めの有無・最新記事がピン留めされたケースも自然に扱える。
  function fetchArticles(creatorId, onProgress, opts) {
    opts = opts || {};
    var since = typeof opts.sincePublishedAt === 'string' ? opts.sincePublishedAt : null;
    var knownIds = opts.knownIds || null;

    var collected = [];
    var page = 1;
    var totalCount = null;
    var latestPublishedAt = null;
    var reachedKnown = false;

    function next() {
      return fetch(buildContentsUrl(creatorId, page))
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status);
          return res.json();
        })
        .then(function (json) {
          var data = json && json.data;
          if (!data || typeof data !== 'object' || !Array.isArray(data.contents)) {
            if (page === 1) throw new Error('no contents');
            return finish();
          }

          if (page === 1) {
            totalCount = typeof data.totalCount === 'number' ? data.totalCount : null;
          }

          // ページ内を公開日の降順にソートしてから走査する（ピン留め対策）。
          var arts = data.contents.map(function (item) {
            return normalizeArticle(item, creatorId);
          });
          arts.sort(function (a, b) {
            return a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0;
          });

          // page1 の最大公開日 = そのクリエイターの最新公開日。
          if (page === 1 && arts.length > 0) {
            latestPublishedAt = arts[0].publishedAt;
          }

          for (var i = 0; i < arts.length; i++) {
            var art = arts[i];
            // 差分取得: 前回の最新公開日以下に達したら、以降は降順で全て既知 → 停止
            if (since !== null && art.publishedAt <= since) {
              reachedKnown = true;
              return finish();
            }
            collected.push(art);
          }

          if (typeof onProgress === 'function') onProgress(collected.length);
          if (data.isLastPage || data.contents.length === 0 || page >= PAGE_LIMIT) {
            return finish();
          }
          page += 1;
          return next();
        });
    }

    function finish() {
      // 保険: 既知IDが混じっていれば除外（公開日が等しい・編集で前後した等の端ケース）。
      var articles = knownIds
        ? collected.filter(function (a) {
            return !knownIds.has(a.id);
          })
        : collected;
      return {
        articles: articles,
        totalCount: totalCount,
        latestPublishedAt: latestPublishedAt,
        reachedKnown: reachedKnown,
      };
    }

    return next();
  }

  // page1 を1リクエストだけ取得し、新着判定に使う最新状態を返す。
  //   { totalCount, latestPublishedAt }
  // latestPublishedAt は page1 全記事の最大公開日（ピン留めに影響されない）。
  // 一覧/読書画面の新着バッジ更新に使う。失敗時は null。
  function fetchLatestStatus(creatorId) {
    return fetch(buildContentsUrl(creatorId, 1))
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object' || !Array.isArray(data.contents)) return null;
        var totalCount = typeof data.totalCount === 'number' ? data.totalCount : null;
        var latestPublishedAt = null;
        for (var i = 0; i < data.contents.length; i++) {
          var pub = data.contents[i].publishAt || data.contents[i].publish_at || '';
          if (pub && (latestPublishedAt === null || pub > latestPublishedAt)) {
            latestPublishedAt = pub;
          }
        }
        return { totalCount: totalCount, latestPublishedAt: latestPublishedAt };
      })
      .catch(function () {
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // 読了状態
  //   readArticles[key] が存在し status==='read' なら読了。未読はキーを持たない。
  //   状態は常に上書き可能（最後の操作が勝つ）。
  // ---------------------------------------------------------------------------

  function readKey(creatorId, articleId) {
    return creatorId + ':' + articleId;
  }

  function isRead(creatorId, articleId) {
    var entry = state.readArticles[readKey(creatorId, articleId)];
    return !!(entry && entry.status === 'read');
  }

  // 読了/未読をセットする。read=false ならエントリを削除（未読）。
  function setRead(creatorId, articleId, read, source) {
    var key = readKey(creatorId, articleId);
    if (read) {
      state.readArticles[key] = {
        status: 'read',
        source: source || SOURCE.MANUAL,
        readAt: new Date().toISOString(),
      };
    } else {
      delete state.readArticles[key];
    }
  }

  // ---------------------------------------------------------------------------
  // キタコレ：ワイ語の収集とポイント回収
  //   収集 = 記事タップ時に本文を取り「ワイ」を数えて counts に保存（点はまだ）。
  //   回収 = 記事行のチップをタップして counts[id].wai を totalWai に加算。
  //   本文HTMLは保存せず数だけ残す。記事ごと1回きり（collected で二重取り防止）。
  // ---------------------------------------------------------------------------

  var WAI_RE = /ワイ/g;
  // 収集中の article.id（多重発火防止）。
  var kitacoreInFlight = {};

  // HTML からタグを除去し最低限の実体参照をデコードして素テキストにする。
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
  function countWai(text) {
    return (String(text).match(WAI_RE) || []).length;
  }

  // 記事 URL からスラッグ（note key）を抜く。失敗時 null。
  function articleKeyFromUrl(url) {
    var m = String(url || '').match(/\/n\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  function isCounted(articleId) {
    return !!(state.kitacore && state.kitacore.counts && state.kitacore.counts[articleId]);
  }

  function isCollected(articleId) {
    return !!(state.kitacore && state.kitacore.collected && state.kitacore.collected[articleId]);
  }

  // 記事 1 本の本文を取り、ワイ数を数えて counts に保存する（＝収集）。
  // 計測済み/計測中/key抽出失敗/body不正 はスキップ。await されない想定で呼ぶ。
  function fetchAndCountArticle(article, creatorId) {
    if (!article || !article.id) return;
    if (isCounted(article.id) || kitacoreInFlight[article.id]) return;
    var key = articleKeyFromUrl(article.url);
    if (!key) return; // スラッグ抽出失敗はスキップ
    ensureKitacore();
    kitacoreInFlight[article.id] = true;
    var url = PROXY_URL + '?path=' + encodeURIComponent('/api/v3/notes/' + key);
    fetch(url)
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        var body = json && json.data ? json.data.body : null;
        if (typeof body !== 'string') return; // 形式不正は未計測のまま握りつぶす
        ensureKitacore();
        state.kitacore.counts[article.id] = {
          wai: countWai(stripHtml(body)),
          countedAt: new Date().toISOString(),
        };
        saveState();
        // 表示中なら該当クリエイターの一覧を作り直してチップを出す
        if (currentRoute() === 'read' && state.selectedCreatorId === creatorId) {
          renderArticles();
        }
      })
      .catch(function () {
        /* ネットワーク失敗等は未計測のまま（次タップで再試行） */
      })
      .then(function () {
        delete kitacoreInFlight[article.id];
      });
  }

  // ワイ語チップを回収する（＝ポイント加算）。
  // 収集済み・未回収・ワイ>0 のときだけ totalWai に加算し collected を立てる。
  function collectWai(articleId) {
    ensureKitacore();
    var entry = state.kitacore.counts[articleId];
    if (!entry) return; // 未収集
    if (isCollected(articleId)) return; // 二重取り防止
    if (entry.wai <= 0) return; // ワイ0は回収対象外（チップ非活性）
    var waiRankBefore = kitacoreWaiRankOf(state.kitacore.totalWai);
    state.kitacore.totalWai += entry.wai;
    state.kitacore.collected[articleId] = true;
    saveState();
    // ワイ閾値を超えたら覚醒後ボスを出現させる（ランク表示はボス撃破まで据え置き）
    var waiRankAfter = kitacoreWaiRankOf(state.kitacore.totalWai);
    if (waiRankAfter.key !== waiRankBefore.key && waiRankAfter.bossKey) {
      var boss = KITACORE_POST_BOSSES.find(function (b) { return b.key === waiRankAfter.bossKey; });
      if (boss) showPostBoss(boss);
    }
  }

  // 覚醒後ボスカードを表示する（挑戦待ち状態にセット）。
  function showPostBoss(boss) {
    ensureKitacore();
    if (!state.kitacore.pendingPostBoss) state.kitacore.pendingPostBoss = {};
    var defeated = defeatedBossesOf(KITACORE_ID);
    // 撃破済みなら無視
    if (defeated.indexOf(boss.key) !== -1) return;
    // 既に挑戦待ちボスがいる場合は上書きしない
    if (state.kitacore.pendingPostBoss[KITACORE_ID]) return;
    // このボスより前の覚醒後ボスが全員撃破済みでなければ出現しない
    var idx = KITACORE_POST_BOSSES.findIndex(function (b) { return b.key === boss.key; });
    for (var i = 0; i < idx; i++) {
      if (defeated.indexOf(KITACORE_POST_BOSSES[i].key) === -1) return;
    }
    state.kitacore.pendingPostBoss[KITACORE_ID] = boss.key;
    saveState();
    renderKitacoreHeader();
  }

  // 覚醒後の挑戦待ちボスを取得（pendingPostBoss から）。
  function pendingPostBossOf(creatorId) {
    var k = state.kitacore && state.kitacore.pendingPostBoss ? state.kitacore.pendingPostBoss[creatorId] : null;
    if (!k) return null;
    var defeated = defeatedBossesOf(creatorId);
    if (defeated.indexOf(k) !== -1) return null; // 撃破済みなら消す
    return KITACORE_POST_BOSSES.find(function (b) { return b.key === k; }) || null;
  }

  // ---------------------------------------------------------------------------
  // 日付ユーティリティ
  // ---------------------------------------------------------------------------

  function parseDate(publishedAt) {
    if (!publishedAt) return null;
    var d = new Date(publishedAt);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function yearOf(a) {
    var d = parseDate(a.publishedAt);
    return d ? d.getFullYear() : null;
  }

  function monthOf(a) {
    var d = parseDate(a.publishedAt);
    return d ? d.getMonth() + 1 : null;
  }

  function formatDateDot(a) {
    var d = parseDate(a.publishedAt);
    if (!d) return '';
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '.' + m + '.' + day;
  }

  function formatFetched(iso) {
    var d = parseDate(iso);
    if (!d) return '未取得';
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '.' + m + '.' + day;
  }

  // ---------------------------------------------------------------------------
  // 集計
  // ---------------------------------------------------------------------------

  function articlesOf(creatorId) {
    return state.articlesByCreator[creatorId] || [];
  }

  // 記事配列のうち最も新しい publishedAt を返す（無ければ null）。
  function maxPublishedAt(articles) {
    var max = null;
    (articles || []).forEach(function (a) {
      if (a.publishedAt && (max === null || a.publishedAt > max)) max = a.publishedAt;
    });
    return max;
  }

  function statsOf(creatorId) {
    var arts = articlesOf(creatorId);
    var read = 0;
    arts.forEach(function (a) {
      if (isRead(creatorId, a.id)) read += 1;
    });
    return { total: arts.length, read: read, unread: arts.length - read };
  }

  // 既読率（0-100の整数）。記事0件なら0。
  function readPercent(stats) {
    if (!stats.total) return 0;
    return Math.round((stats.read / stats.total) * 100);
  }

  // 新着件数を返す。最新状態が未取得なら0。
  // 基本は件数差分（最新totalCount − seenTotalCount）。ただし件数据え置きでも
  // 最新公開日が seenLatestPublishedAt より新しければ「新着あり」とみなし最低1件を返す。
  // （古い記事の削除＋新規投稿で件数が変わらないケースを公開日で拾う。）
  function newCountOf(creator) {
    var status = latestStatus[creator.id];
    if (!status || typeof status.totalCount !== 'number') return 0;
    var seenCount =
      typeof creator.seenTotalCount === 'number' ? creator.seenTotalCount : status.totalCount;
    var byCount = Math.max(0, status.totalCount - seenCount);
    if (byCount > 0) return byCount;
    // 件数差が無くても公開日が進んでいれば新着扱い
    var seenPub = creator.seenLatestPublishedAt;
    if (
      typeof seenPub === 'string' &&
      status.latestPublishedAt &&
      status.latestPublishedAt > seenPub
    ) {
      return 1;
    }
    return 0;
  }

  // 進捗バー要素を生成する（水平バー＋パーセント）。
  function progressBarEl(stats) {
    var pct = readPercent(stats);
    var wrap = document.createElement('div');
    wrap.className = 'progress';

    var track = document.createElement('div');
    track.className = 'progress-track';
    var fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = pct + '%';
    track.appendChild(fill);

    var label = document.createElement('span');
    label.className = 'progress-pct';
    label.textContent = pct + '%';

    wrap.setAttribute('role', 'progressbar');
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    wrap.setAttribute('aria-valuenow', String(pct));
    wrap.setAttribute('aria-label', '読了率 ' + pct + 'パーセント');

    wrap.appendChild(track);
    wrap.appendChild(label);
    return wrap;
  }

  function getCreator(id) {
    return (
      state.creators.filter(function (c) {
        return c.id === id;
      })[0] || null
    );
  }

  function getSelectedCreator() {
    return getCreator(state.selectedCreatorId);
  }

  // ---------------------------------------------------------------------------
  // フィルタ / グルーピング
  // ---------------------------------------------------------------------------

  function applyFilters(articles, creatorId) {
    var ui = activeUi();
    var keyword = (ui.keyword || '').trim().toLowerCase();
    return articles.filter(function (a) {
      if (keyword && a.title.toLowerCase().indexOf(keyword) === -1) return false;
      if (ui.year !== 'all' && String(yearOf(a)) !== String(ui.year)) return false;
      if (ui.month !== 'all' && String(monthOf(a)) !== String(ui.month)) return false;
      if (ui.showUnreadOnly && isRead(creatorId, a.id)) return false;
      return true;
    });
  }

  function groupByYearMonth(articles) {
    var desc = activeUi().sortOrder !== 'asc';
    var sorted = articles.slice().sort(function (a, b) {
      var ta = (parseDate(a.publishedAt) || new Date(0)).getTime();
      var tb = (parseDate(b.publishedAt) || new Date(0)).getTime();
      return desc ? tb - ta : ta - tb;
    });

    var years = [];
    var yearMap = {};
    sorted.forEach(function (a) {
      var y = yearOf(a);
      var m = monthOf(a);
      var yKey = y === null ? '不明' : y;
      var mKey = m === null ? '不明' : m;
      if (!yearMap[yKey]) {
        yearMap[yKey] = { year: yKey, months: [], monthMap: {} };
        years.push(yearMap[yKey]);
      }
      var yg = yearMap[yKey];
      if (!yg.monthMap[mKey]) {
        yg.monthMap[mKey] = { month: mKey, articles: [] };
        yg.months.push(yg.monthMap[mKey]);
      }
      yg.monthMap[mKey].articles.push(a);
    });
    return years;
  }

  // ---------------------------------------------------------------------------
  // DOM 参照
  // ---------------------------------------------------------------------------

  var els = {
    viewList: document.getElementById('view-list'),
    viewRead: document.getElementById('view-read'),
    emptyState: document.getElementById('empty-state'),
    emptyAddBtn: document.getElementById('empty-add-btn'),
    listBody: document.getElementById('list-body'),
    addBtn: document.getElementById('add-btn'),
    creatorList: document.getElementById('creator-list'),
    fab: document.getElementById('fab'),

    backBtn: document.getElementById('back-btn'),
    readName: document.getElementById('read-name'),
    readId: document.getElementById('read-id'),
    readStats: document.getElementById('read-stats'),
    readProgress: document.getElementById('read-progress'),
    kitacoreRankArea: document.getElementById('kitacore-rank-area'),
    kitacoreStats: document.getElementById('kitacore-stats'),
    kitacoreProgress: document.getElementById('kitacore-progress'),
    kitacoreRankCard: document.getElementById('kitacore-rank-card'),
    kitacoreRankCardContent: document.getElementById('kitacore-rank-card-content'),
    kitacoreRankCardClose: document.getElementById('kitacore-rank-card-close'),
    debugBtns: document.getElementById('debug-btns'),
    debugAddKeys: document.getElementById('debug-add-keys'),
    debugAddWai: document.getElementById('debug-add-wai'),
    debugClear: document.getElementById('debug-clear'),
    kitacoreBoss: document.getElementById('kitacore-boss'),
    fetchBtn: document.getElementById('fetch-btn'),
    fetchDot: document.getElementById('fetch-dot'),
    keyword: document.getElementById('keyword'),
    yearFilter: document.getElementById('year-filter'),
    monthFilter: document.getElementById('month-filter'),
    unreadOnly: document.getElementById('unread-only'),
    sortToggle: document.getElementById('sort-toggle'),
    statusMsg: document.getElementById('status-msg'),
    articles: document.getElementById('articles'),

    addModal: document.getElementById('add-modal'),
    addInput: document.getElementById('add-input'),
    addPreview: document.getElementById('add-preview'),
    addNameWrap: document.getElementById('add-name-wrap'),
    addName: document.getElementById('add-name'),
    addError: document.getElementById('add-error'),
    addCancel: document.getElementById('add-cancel'),
    addConfirm: document.getElementById('add-confirm'),

    editModal: document.getElementById('edit-modal'),
    editName: document.getElementById('edit-name'),
    editError: document.getElementById('edit-error'),
    editCancel: document.getElementById('edit-cancel'),
    editSave: document.getElementById('edit-save'),

    setupModal: document.getElementById('setup-modal'),
    setupStepAsk: document.getElementById('setup-step-ask'),
    setupStepBulk: document.getElementById('setup-step-bulk'),
    setupLead: document.getElementById('setup-lead'),
    setupAllUnread: document.getElementById('setup-all-unread'),
    setupBulk: document.getElementById('setup-bulk'),
    setupLater: document.getElementById('setup-later'),
    setupMonthList: document.getElementById('setup-month-list'),
    setupBulkBack: document.getElementById('setup-bulk-back'),
    setupBulkApply: document.getElementById('setup-bulk-apply'),

    readbackModal: document.getElementById('readback-modal'),
    readbackArticle: document.getElementById('readback-article'),
    readbackYes: document.getElementById('readback-yes'),
    readbackNo: document.getElementById('readback-no'),

    headerVersion: document.getElementById('header-version'),
    updateModal: document.getElementById('update-modal'),
    updateVersion: document.getElementById('update-version'),
    updateBody: document.getElementById('update-body'),
    updateClose: document.getElementById('update-close'),

    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    settingsExport: document.getElementById('settings-export'),
    settingsImport: document.getElementById('settings-import'),
    settingsClose: document.getElementById('settings-close'),

    exportModal: document.getElementById('export-modal'),
    exportText: document.getElementById('export-text'),
    exportCopy: document.getElementById('export-copy'),
    exportClose: document.getElementById('export-close'),

    importModal: document.getElementById('import-modal'),
    importText: document.getElementById('import-text'),
    importError: document.getElementById('import-error'),
    importPaste: document.getElementById('import-paste'),
    importConfirm: document.getElementById('import-confirm'),
    importCancel: document.getElementById('import-cancel'),

    kitacoreSystem: document.getElementById('kitacore-system'),
    kitacoreSystemText: document.getElementById('kitacore-system-text'),
    kitacoreQuiz: document.getElementById('kitacore-quiz'),
    kitacoreQuizQ: document.getElementById('kitacore-quiz-q'),
    kitacoreQuizChoices: document.getElementById('kitacore-quiz-choices'),
    kitacoreQuizResult: document.getElementById('kitacore-quiz-result'),
    kitacoreQuizClose: document.getElementById('kitacore-quiz-close'),
    kitacorePlayer: document.getElementById('kitacore-player'),
    kitacorePlayerInput: document.getElementById('kitacore-player-input'),
    kitacorePlayerPreview: document.getElementById('kitacore-player-preview'),
    kitacorePlayerError: document.getElementById('kitacore-player-error'),
    kitacorePlayerAuth: document.getElementById('kitacore-player-auth'),
    kitacorePlayerCancel: document.getElementById('kitacore-player-cancel'),
    kitacoreBattle: document.getElementById('kitacore-battle'),
    kitacoreBattleImg: document.getElementById('kitacore-battle-img'),
    kitacoreBattleText: document.getElementById('kitacore-battle-text'),
  };

  // 初期既読セットアップの対象クリエイターID
  var setupCreatorId = null;

  // ---------------------------------------------------------------------------
  // ルーティング
  // ---------------------------------------------------------------------------

  function currentRoute() {
    return location.hash === '#read' ? 'read' : 'list';
  }

  function goTo(route) {
    if (currentRoute() === route) {
      renderRoute();
    } else {
      location.hash = route === 'read' ? '#read' : '#list';
      // hashchange イベントで renderRoute が走る
    }
  }

  function renderRoute() {
    var route = currentRoute();
    // 選択中クリエイターが無ければ read には入れない
    if (route === 'read' && !getSelectedCreator()) {
      location.hash = '#list';
      return;
    }
    var onRead = route === 'read';
    els.viewList.classList.toggle('hidden', onRead);
    els.viewRead.classList.toggle('hidden', !onRead);
    els.fab.classList.toggle('hidden', onRead || state.creators.length === 0);
    if (onRead) {
      renderReadView();
    } else {
      renderListView();
    }
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // 描画: クリエイター一覧画面
  // ---------------------------------------------------------------------------

  function renderListView() {
    var has = state.creators.length > 0;
    els.emptyState.classList.toggle('hidden', has);
    els.listBody.classList.toggle('hidden', !has);
    if (!has) return;
    renderCreatorCards();
    // 各クリエイターの最新状態を取得して新着バッジを更新する
    refreshLatestCounts();
  }

  // 一覧の全クリエイターの最新状態(件数+最新公開日)をAPIで取得し、新着バッジを更新する。
  // page1の1リクエスト/人。取得済みのものから順次カードに反映する。
  var refreshCountsToken = 0;
  function refreshLatestCounts() {
    var token = ++refreshCountsToken;
    state.creators.forEach(function (c) {
      // 記事未取得（seenTotalCount無し）のクリエイターは新着判定対象外
      if (typeof c.seenTotalCount !== 'number') return;
      fetchLatestStatus(c.id).then(function (status) {
        if (token !== refreshCountsToken) return; // 一覧を離れた等で古い結果は破棄
        if (!status) return;
        var prev = latestStatus[c.id];
        if (
          prev &&
          prev.totalCount === status.totalCount &&
          prev.latestPublishedAt === status.latestPublishedAt
        ) {
          return; // 変化なし
        }
        latestStatus[c.id] = status;
        // 該当カードだけ作り直して差し替え（全再描画は避ける）
        if (currentRoute() === 'list') renderCreatorCards();
      });
    });
  }

  function renderCreatorCards() {
    els.creatorList.innerHTML = '';
    state.creators.forEach(function (c) {
      els.creatorList.appendChild(creatorCardEl(c));
    });
  }

  function creatorCardEl(c) {
    var stats = statsOf(c.id);

    var card = document.createElement('div');
    card.className =
      'creator-card' + (c.id === state.selectedCreatorId ? ' is-selected' : '');

    // top: avatar + name/id + menu
    var top = document.createElement('div');
    top.className = 'creator-card-top';

    var avatar = document.createElement('div');
    avatar.className = 'creator-card-avatar';
    // 発動対象が覚醒済みなら金縁。隠しコマンド（ダブルタップ）で切り替える。
    if (isKitacoreTarget(c.id) && isModeOn(c.id)) {
      avatar.classList.add('is-awakened');
    }
    if (isKitacoreTarget(c.id)) {
      attachDoubleTap(avatar, function () {
        toggleMode(c.id);
      });
    }
    if (c.iconUrl) {
      var img = document.createElement('img');
      img.src = c.iconUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        avatar.removeChild(img);
        avatar.textContent = (c.displayName || c.id).charAt(0);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (c.displayName || c.id).charAt(0);
    }
    top.appendChild(avatar);

    var head = document.createElement('div');
    head.className = 'creator-card-head';
    var name = document.createElement('div');
    name.className = 'creator-card-name';
    name.textContent = c.displayName || c.id;
    var idEl = document.createElement('div');
    idEl.className = 'creator-card-id';
    idEl.textContent = '@' + c.id;
    head.appendChild(name);
    head.appendChild(idEl);
    top.appendChild(head);

    var menu = document.createElement('div');
    menu.className = 'creator-card-menu';
    var editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.type = 'button';
    editBtn.textContent = '編集';
    editBtn.setAttribute('aria-label', '表示名を編集');
    editBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openEditModal(c.id);
    });
    var delBtn = document.createElement('button');
    delBtn.className = 'icon-btn is-danger';
    delBtn.type = 'button';
    delBtn.textContent = '削除';
    delBtn.setAttribute('aria-label', '削除');
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteCreator(c.id);
    });
    menu.appendChild(editBtn);
    menu.appendChild(delBtn);
    top.appendChild(menu);

    card.appendChild(top);

    // stats（左にテキスト、右端に新着バッジ）
    var statsEl = document.createElement('div');
    statsEl.className = 'creator-card-stats';
    var statsText = document.createElement('span');
    statsText.className = 'creator-card-stats-text';
    statsText.textContent =
      '記事 ' + stats.total + '件 / 読了 ' + stats.read + '件 / 未読 ' + stats.unread + '件';
    statsEl.appendChild(statsText);
    // 新着バッジ = 最新totalCount − 取得時totalCount
    var nc = newCountOf(c);
    if (nc > 0) {
      var badge = document.createElement('span');
      badge.className = 'badge-new';
      badge.textContent = '新着 ' + nc;
      statsEl.appendChild(badge);
    }
    card.appendChild(statsEl);

    // 進捗バー（記事取得済みのときだけ）
    if (stats.total > 0) {
      card.appendChild(progressBarEl(stats));
    }

    var fetched = document.createElement('div');
    fetched.className = 'creator-card-fetched';
    fetched.textContent = '最終取得: ' + formatFetched(c.lastFetchedAt);
    card.appendChild(fetched);

    // 初期既読の状態（記事取得済みで未セットアップのときだけ「未設定」を出す）
    if (stats.total > 0 && !c.initialSetupDone) {
      var setupRow = document.createElement('div');
      setupRow.className = 'creator-card-setup';
      setupRow.textContent = '初期既読: 未設定';
      card.appendChild(setupRow);
    }

    // action
    var action = document.createElement('div');
    action.className = 'creator-card-action';

    // 記事取得済み・未セットアップなら「既読を設定する」を併設
    if (stats.total > 0 && !c.initialSetupDone) {
      var setupBtn = document.createElement('button');
      setupBtn.className = 'btn';
      setupBtn.type = 'button';
      setupBtn.textContent = '既読を設定する';
      setupBtn.addEventListener('click', function () {
        // セットアップは選択中クリエイター前提なので合わせておく
        state.selectedCreatorId = c.id;
        saveState();
        openSetupModal(c.id);
      });
      action.appendChild(setupBtn);
    }

    var go = document.createElement('button');
    go.className = 'btn btn-primary';
    go.type = 'button';
    go.textContent = '読みに行く';
    go.addEventListener('click', function () {
      selectCreator(c.id);
    });
    action.appendChild(go);
    card.appendChild(action);

    return card;
  }

  function selectCreator(id) {
    if (state.selectedCreatorId !== id) {
      state.selectedCreatorId = id;
      // 年月・未読のみ・ソート順はクリエイターごとに記憶しているので、
      // 切り替え時はリセットせず前回の表示状態を復元する（renderReadView 経由）。
      saveState();
    }
    // 遷移しただけではバッジを消さない（記事一覧で取得して件数を取り込むまで残す）
    clearStatus();
    goTo('read');
  }

  // ---------------------------------------------------------------------------
  // 描画: 記事一覧画面
  // ---------------------------------------------------------------------------

  function renderReadView() {
    var c = getSelectedCreator();
    if (!c) return;
    var stats = statsOf(c.id);

    els.readName.textContent = c.displayName || c.id;
    els.readId.textContent = '@' + c.id;
    renderReadHeaderStats(stats);

    var ui = activeUi();
    els.keyword.value = ui.keyword;
    els.unreadOnly.checked = !!ui.showUnreadOnly;
    els.sortToggle.textContent = ui.sortOrder === 'asc' ? '古い順' : '新しい順';

    renderFilterOptions();
    renderArticles();

    // 最新状態を取得して新着バッジ/ドットを更新（記事取得済みのときのみ）
    if (typeof c.seenTotalCount === 'number') {
      var cid = c.id;
      fetchLatestStatus(cid).then(function (status) {
        if (!status) return;
        var prev = latestStatus[cid];
        if (
          prev &&
          prev.totalCount === status.totalCount &&
          prev.latestPublishedAt === status.latestPublishedAt
        ) {
          return;
        }
        latestStatus[cid] = status;
        // まだ同じクリエイターの記事一覧を見ているなら再描画
        if (currentRoute() === 'read' && state.selectedCreatorId === cid) {
          renderReadHeaderStats(statsOf(cid));
        }
      });
    }
  }

  function renderFilterOptions() {
    var arts = articlesOf(state.selectedCreatorId);
    var ui = activeUi();

    var years = [];
    var seenY = {};
    arts.forEach(function (a) {
      var y = yearOf(a);
      if (y !== null && !seenY[y]) {
        seenY[y] = true;
        years.push(y);
      }
    });
    years.sort(function (a, b) {
      return b - a;
    });
    fillSelect(
      els.yearFilter,
      [{ value: 'all', label: 'すべて' }].concat(
        years.map(function (y) {
          return { value: String(y), label: y + '年' };
        })
      ),
      ui.year
    );

    var monthsSet = {};
    arts.forEach(function (a) {
      if (ui.year !== 'all' && String(yearOf(a)) !== String(ui.year)) {
        return;
      }
      var m = monthOf(a);
      if (m !== null) monthsSet[m] = true;
    });
    var months = Object.keys(monthsSet)
      .map(Number)
      .sort(function (a, b) {
        return b - a;
      });
    fillSelect(
      els.monthFilter,
      [{ value: 'all', label: 'すべて' }].concat(
        months.map(function (m) {
          return { value: String(m), label: m + '月' };
        })
      ),
      ui.month
    );
  }

  function fillSelect(selectEl, options, selectedValue) {
    selectEl.innerHTML = '';
    var hasSelected = false;
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === String(selectedValue)) {
        o.selected = true;
        hasSelected = true;
      }
      selectEl.appendChild(o);
    });
    if (!hasSelected) selectEl.value = 'all';
  }

  // しおり: 未読のうち最も古い記事の id を返す（投稿日昇順で先頭の未読）。
  // ソート順やフィルタに関係なく「次に読む記事」は同じなので全記事から算出。
  // 全部既読 / 記事なし のときは null。
  function bookmarkArticleId(creatorId) {
    var all = articlesOf(creatorId);
    var oldest = null;
    var oldestTime = Infinity;
    all.forEach(function (a) {
      if (isRead(creatorId, a.id)) return;
      var t = (parseDate(a.publishedAt) || new Date(0)).getTime();
      if (t < oldestTime) {
        oldestTime = t;
        oldest = a.id;
      }
    });
    return oldest;
  }

  // 「続きから」: 栞（未読の最古）の記事へスクロール。フィルタは変えない。
  // sticky ヘッダー（.read-sticky）の高さ分だけ手前で止めて隠れないようにする。
  // ヘッダー高さは名前の行数や safe-area で変わるので毎回実測する。
  function scrollToBookmark() {
    var target = els.articles.querySelector('.article.is-bookmark');
    if (!target) return;
    var sticky = document.querySelector('.read-sticky');
    var offset = (sticky ? sticky.getBoundingClientRect().height : 0) + 12;
    var top = window.scrollY + target.getBoundingClientRect().top - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // 「続きから」を出してよいか: 栞（未読の最古）が現在のフィルタ結果に
  // 含まれていればスクロール先があるので表示できる。
  function resumeAvailable(creatorId) {
    var bookmarkId = bookmarkArticleId(creatorId);
    if (!bookmarkId) return false;
    return applyFilters(articlesOf(creatorId), creatorId).some(function (a) {
      return a.id === bookmarkId;
    });
  }

  // 統計行の右端の「続きから」を現在の状態に合わせて付け外しする。
  // フィルタ変更・既読化のたびに呼ばれ、栞がフィルタ外に出たら消える。
  function updateResumeButton() {
    var existing = els.readStats.querySelector('.resume-btn');
    if (existing) existing.parentNode.removeChild(existing);
    var c = getSelectedCreator();
    if (!c || !resumeAvailable(c.id)) return;
    var resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'resume-btn';
    resume.textContent = '🔖 続きから';
    resume.addEventListener('click', scrollToBookmark);
    els.readStats.appendChild(resume);
  }

  function renderArticles() {
    var c = getSelectedCreator();
    els.articles.innerHTML = '';
    // 栞ボタンは統計行にあり記事描画と独立。現フィルタ状態に合わせて毎回付け外し。
    updateResumeButton();
    if (!c) return;

    var all = articlesOf(c.id);
    if (all.length === 0) {
      els.articles.appendChild(
        emptyArticlesEl('まだ記事を取得していません。\n「記事一覧を取得 / 更新」を押してください。')
      );
      return;
    }

    var filtered = applyFilters(all, c.id);
    if (filtered.length === 0) {
      els.articles.appendChild(emptyArticlesEl('条件に合う記事がありません。'));
      return;
    }

    var bookmarkId = bookmarkArticleId(c.id);

    groupByYearMonth(filtered).forEach(function (yg) {
      var yearSection = document.createElement('div');
      yearSection.className = 'year-group';

      var yh = document.createElement('div');
      yh.className = 'year-heading';
      yh.textContent = yg.year === '不明' ? '日付不明' : yg.year + '年';
      yearSection.appendChild(yh);

      yg.months.forEach(function (mg) {
        var monthSection = document.createElement('div');
        monthSection.className = 'month-group';
        var mh = document.createElement('div');
        mh.className = 'month-heading';
        mh.textContent = mg.month === '不明' ? '月不明' : mg.month + '月';
        monthSection.appendChild(mh);
        mg.articles.forEach(function (a) {
          monthSection.appendChild(articleEl(a, c.id, a.id === bookmarkId));
        });
        yearSection.appendChild(monthSection);
      });

      els.articles.appendChild(yearSection);
    });
  }

  // 通常の記事一覧ではチェックボックスは出さない。
  // 既読は見た目（グレーアウト＋「読了」ラベル）で区別するのみ。
  // 既読状態の設定は「初期既読セットアップ」で行う。
  function articleEl(article, creatorId, isBookmark) {
    var read = isRead(creatorId, article.id);

    var wrap = document.createElement('div');
    wrap.className =
      'article' + (read ? ' is-read' : '') + (isBookmark ? ' is-bookmark' : '');

    // しおり: 次に読む記事（未読の最古）に挟む目印
    if (isBookmark) {
      var mark = document.createElement('span');
      mark.className = 'bookmark-mark';
      mark.setAttribute('aria-label', 'しおり: ここから読む');
      mark.title = 'しおり: ここから読む';
      wrap.appendChild(mark);
    }

    // サムネイル（eyecatch があるときだけ。タップで記事を開ける）
    if (article.thumbnailUrl) {
      var thumbLink = document.createElement('a');
      thumbLink.className = 'article-thumb';
      thumbLink.href = article.url;
      thumbLink.target = '_blank';
      thumbLink.rel = 'noopener';
      thumbLink.tabIndex = -1; // タイトルリンクと重複するのでフォーカス対象から外す
      thumbLink.setAttribute('aria-hidden', 'true');
      var img = document.createElement('img');
      img.src = article.thumbnailUrl;
      img.alt = '';
      img.loading = 'lazy';
      // 画像が読めなければサムネ枠ごと消す
      img.addEventListener('error', function () {
        if (thumbLink.parentNode) thumbLink.parentNode.removeChild(thumbLink);
      });
      thumbLink.appendChild(img);
      wrap.appendChild(thumbLink);
    }

    // サムネのリンクにも「読みに行った」記録を仕込む
    if (article.thumbnailUrl) {
      var thumbA = wrap.querySelector('.article-thumb');
      if (thumbA) {
        thumbA.addEventListener('click', function () {
          rememberPendingArticle(creatorId, article);
        });
      }
    }

    var body = document.createElement('div');
    body.className = 'article-body';

    var link = document.createElement('a');
    link.className = 'article-title';
    link.href = article.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = article.title;
    // 記事を開いたら「読みに行った」記録を残す（戻ってきたら確認モーダル）
    link.addEventListener('click', function () {
      rememberPendingArticle(creatorId, article);
    });
    body.appendChild(link);

    var meta = document.createElement('div');
    meta.className = 'article-meta';
    var date = document.createElement('span');
    date.className = 'article-date';
    date.textContent = formatDateDot(article);
    meta.appendChild(date);

    // 既読トグルチップ（タップで未読⇄既読、手動操作）
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'article-chip' + (read ? ' is-read' : '');
    chip.textContent = read ? '読了 ✓' : '読んだ';
    chip.addEventListener('click', function () {
      var nowRead = !isRead(creatorId, article.id);
      setRead(creatorId, article.id, nowRead, SOURCE.MANUAL);
      saveState();
      renderArticles();
      updateReadStatsHeader();
    });
    meta.appendChild(chip);

    // キタコレ覚醒前：クイズがある記事に「光ボタン」を出す（タップでクイズ）。
    //   未正解＝光る（タップ可）/ 正解済み＝光を消し「入手済」表示（タップ不可）。
    if (isKitacoreTarget(creatorId) && isModeOn(creatorId) && !isPostAwakening(creatorId)) {
      var quiz = quizForArticle(article);
      if (quiz) {
        var quizCleared = isQuizCleared(creatorId, article.id);
        var glow = document.createElement('button');
        glow.type = 'button';
        glow.className = 'kitacore-glow' + (quizCleared ? ' is-cleared' : '');
        glow.textContent = quizCleared ? '鍵 入手済' : '✨ 試練';
        glow.setAttribute('aria-label', quizCleared ? 'クイズ正解済み' : 'クイズに挑戦');
        glow.disabled = quizCleared;
        if (!quizCleared) {
          glow.addEventListener('click', function () {
            ensureKitacore();
            state.kitacore.quizTaps = (state.kitacore.quizTaps || 0) + 1;
            saveState();
            openQuiz(creatorId, article, quiz);
          });
        }
        meta.appendChild(glow);
      }
    }

    // キタコレ：覚醒済みクリエイターで「収集済み」の記事だけワイ語チップを出す。
    //   未収集（タップ前）はチップ無し。ワイ>0未回収=タップ可。
    //   ワイ0 / 回収済み=非活性。
    if (isKitacoreTarget(creatorId) && isModeOn(creatorId) && isCounted(article.id)) {
      var entry = state.kitacore.counts[article.id];
      var collected = isCollected(article.id);
      var claimable = entry.wai > 0 && !collected;
      var wai = document.createElement('button');
      wai.type = 'button';
      wai.className =
        'article-wai' +
        (collected ? ' is-collected' : '') +
        (claimable ? ' is-claimable' : ' is-locked');
      wai.textContent = collected ? 'ワイ ' + entry.wai + ' ✓' : 'ワイ ' + entry.wai;
      wai.disabled = !claimable;
      if (claimable) {
        wai.addEventListener('click', function () {
          collectWai(article.id);
          renderArticles();
          updateReadStatsHeader(); // 累計ワイ→ヘッダーのランクバーへ反映
        });
      }
      meta.appendChild(wai);
    }

    body.appendChild(meta);

    wrap.appendChild(body);
    return wrap;
  }

  // 記事を再描画せずヘッダーの集計だけ更新（チップ操作の軽量反映）
  function updateReadStatsHeader() {
    var c = getSelectedCreator();
    if (!c) return;
    renderReadHeaderStats(statsOf(c.id));
  }

  // ヘッダーの「記事/読了/未読」テキストと進捗バーを更新する。
  function renderReadHeaderStats(stats) {
    els.readStats.innerHTML = '';
    var statsText = document.createElement('span');
    statsText.textContent =
      '記事 ' + stats.total + '件 / 読了 ' + stats.read + '件 / 未読 ' + stats.unread + '件';
    els.readStats.appendChild(statsText);

    // 新着バッジ（クリエイター一覧カードと同じ見た目）＋ 取得ボタン右上のドット
    var c = getSelectedCreator();
    var nc = c ? newCountOf(c) : 0;
    if (nc > 0) {
      var badge = document.createElement('span');
      badge.className = 'badge-new';
      badge.textContent = '新着 ' + nc;
      els.readStats.appendChild(badge);
    }
    els.fetchDot.classList.toggle('hidden', nc <= 0);

    updateResumeButton();

    els.readProgress.innerHTML = '';
    if (stats.total > 0) {
      els.readProgress.appendChild(progressBarEl(stats));
    }

    renderKitacoreHeader();
  }

  // キタコレ：ヘッダーにランク行＋進捗バーを出す。モードON のときだけ表示。
  //   覚醒前（A級ボス未撃破）= 覚醒前ランク（E/C/A）＋鍵の数。
  //   覚醒後（wing 撃破済み）= ワイ語ハンターランク＋ワイ累計バー。
  function renderKitacoreHeader() {
    var c = getSelectedCreator();
    var on = c && isKitacoreTarget(c.id) && isModeOn(c.id);
    if (els.kitacoreRankArea) els.kitacoreRankArea.classList.toggle('hidden', !on);
    if (!on) {
      if (els.kitacoreBoss) els.kitacoreBoss.classList.add('hidden');
      if (els.debugBtns) els.debugBtns.classList.add('hidden');
      return;
    }

    if (isPostAwakening(c.id)) {
      renderKitacorePostHeader(c.id);
      renderKitacorePostBoss(c.id); // 覚醒後ボスカード（出現時のみ表示）
    } else {
      renderKitacorePreHeader(c.id);
      renderKitacoreBoss(c.id);
    }
    // デバッグボタンは ?debug=1 かつ記事取得済みのときのみ表示
    var hasArticles = c && (state.articlesByCreator[c.id] || []).length > 0;
    if (els.debugBtns) els.debugBtns.classList.toggle('hidden', !(DEBUG_MODE && hasArticles));
  }

  // 覚醒前：次のボスカード（画像＋名前＋挑戦ボタン）。鍵が足りれば挑戦可。
  function renderKitacoreBoss(creatorId) {
    if (!els.kitacoreBoss) return;
    var boss = nextPreBoss(creatorId);
    if (!boss) {
      els.kitacoreBoss.classList.add('hidden');
      return;
    }
    var keys = keysOf(creatorId);
    var canChallenge = keys >= boss.cost;
    // 鍵が足りない間はパネルを出さない（一覧を圧迫しない）。
    // 挑戦可能になって初めて表示＝「鍵が貯まった、挑める」導線。
    if (!canChallenge) {
      els.kitacoreBoss.classList.add('hidden');
      return;
    }
    els.kitacoreBoss.innerHTML = '';
    els.kitacoreBoss.classList.remove('hidden');

    var thumb = document.createElement('div');
    thumb.className = 'kitacore-boss-thumb';
    var img = document.createElement('img');
    img.src = boss.img;
    img.alt = boss.name;
    img.loading = 'lazy';
    thumb.appendChild(img);

    var info = document.createElement('div');
    info.className = 'kitacore-boss-info';
    var label = document.createElement('div');
    label.className = 'kitacore-boss-label';
    label.textContent = '次なる試練';
    var name = document.createElement('div');
    name.className = 'kitacore-boss-name';
    name.textContent = boss.name;
    var title = document.createElement('div');
    title.className = 'kitacore-boss-title';
    title.textContent = boss.title;
    info.appendChild(label);
    info.appendChild(name);
    info.appendChild(title);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kitacore-boss-btn';
    btn.textContent = '挑戦（終焉の鍵 × ' + boss.cost + '）';
    btn.disabled = !canChallenge;
    if (canChallenge) {
      btn.addEventListener('click', function () {
        // 鍵消費＆撃破確定→戦闘演出開始。状態の反映は演出を閉じた時に行う。
        challengeBoss(creatorId, boss);
      });
    }
    info.appendChild(btn);

    els.kitacoreBoss.appendChild(thumb);
    els.kitacoreBoss.appendChild(info);
  }

  // 覚醒後：挑戦待ちボスカード（鍵不要。ワイ閾値到達で出現）。
  function renderKitacorePostBoss(creatorId) {
    if (!els.kitacoreBoss) return;
    var boss = pendingPostBossOf(creatorId);
    if (!boss) {
      els.kitacoreBoss.classList.add('hidden');
      return;
    }
    els.kitacoreBoss.innerHTML = '';
    els.kitacoreBoss.classList.remove('hidden');

    var thumb = document.createElement('div');
    thumb.className = 'kitacore-boss-thumb';
    var img = document.createElement('img');
    img.src = boss.img;
    img.alt = boss.name;
    img.loading = 'lazy';
    thumb.appendChild(img);

    var info = document.createElement('div');
    info.className = 'kitacore-boss-info';
    var label = document.createElement('div');
    label.className = 'kitacore-boss-label';
    label.textContent = '次なる試練';
    var name = document.createElement('div');
    name.className = 'kitacore-boss-name';
    name.textContent = boss.name;
    var title = document.createElement('div');
    title.className = 'kitacore-boss-title';
    title.textContent = boss.title;
    info.appendChild(label);
    info.appendChild(name);
    info.appendChild(title);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kitacore-boss-btn';
    btn.textContent = '挑戦';
    btn.addEventListener('click', function () {
      challengePostBoss(creatorId, boss);
    });
    info.appendChild(btn);

    els.kitacoreBoss.appendChild(thumb);
    els.kitacoreBoss.appendChild(info);
  }

  // 覚醒後ボスに挑戦（鍵不要）。撃破確定＆演出開始。
  function challengePostBoss(creatorId, boss) {
    ensureKitacore();
    if (!state.kitacore.defeatedBosses[creatorId]) state.kitacore.defeatedBosses[creatorId] = [];
    state.kitacore.defeatedBosses[creatorId].push(boss.key);
    if (state.kitacore.pendingPostBoss) delete state.kitacore.pendingPostBoss[creatorId];
    saveState();
    // 撃破後、既にワイ閾値を超えている次のボスがあれば出現させる
    var totalWai = state.kitacore.totalWai || 0;
    var defeated = state.kitacore.defeatedBosses[creatorId];
    KITACORE_POST_BOSSES.forEach(function (nextBoss) {
      if (defeated.indexOf(nextBoss.key) !== -1) return; // 既に撃破済み
      var rank = KITACORE_RANKS.find(function (r) { return r.bossKey === nextBoss.key; });
      if (rank && totalWai >= rank.min) showPostBoss(nextBoss);
    });
    startBossBattle(boss, creatorId);
  }

  // バッジ＋進捗バーを共通レイアウトで描く。
  //   badgeText/badgeKey = ランクバッジ。barCur/barMax/barText = 進捗バー。
  function paintKitacoreHeader(badgeText, badgeKey, barCur, barMax, barText) {
    els.kitacoreStats.innerHTML = '';
    var rank = document.createElement('span');
    rank.className = 'kitacore-rank-text rank-' + badgeKey;
    rank.textContent = badgeText;
    els.kitacoreStats.appendChild(rank);

    els.kitacoreProgress.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'progress';
    var track = document.createElement('div');
    track.className = 'progress-track';
    var fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = Math.min(100, barMax > 0 ? (barCur / barMax) * 100 : 0) + '%';
    track.appendChild(fill);
    var barLabel = document.createElement('span');
    barLabel.className = 'progress-pct kitacore-wai-count';
    barLabel.textContent = barText;
    wrap.appendChild(track);
    wrap.appendChild(barLabel);
    els.kitacoreProgress.appendChild(wrap);
  }

  // 覚醒後ヘッダー：ワイ累計→ランク、バーは N／2000。
  function renderKitacorePostHeader(creatorId) {
    var totalWai = state.kitacore && state.kitacore.totalWai ? state.kitacore.totalWai : 0;
    var rankInfo = kitacoreRankOf(creatorId);
    paintKitacoreHeader(
      'ワイ語ハンターランク ' + rankInfo.rank,
      rankInfo.key,
      totalWai,
      KITACORE_GOAL,
      totalWai + '／' + KITACORE_GOAL
    );
  }

  // 覚醒前ヘッダー：覚醒前ランク（次ボスの rankBefore）。
  // 進捗バーは覚醒後と同じワイ累計（N／2000）。覚醒前でも最新記事を読めばワイは貯まる。
  // 鍵の数はバーには出さず、ボスUI側で見せる。
  function renderKitacorePreHeader(creatorId) {
    var boss = nextPreBoss(creatorId); // モードON＆未覚醒なら必ず非null
    var totalWai = state.kitacore && state.kitacore.totalWai ? state.kitacore.totalWai : 0;
    paintKitacoreHeader(
      'ワイ語ハンターランク ' + boss.rankBefore,
      boss.rankBeforeKey,
      totalWai,
      KITACORE_GOAL,
      totalWai + '／' + KITACORE_GOAL
    );
    // ランクバッジの右横に鍵数（覚醒前のみ）。
    var keyEl = document.createElement('span');
    keyEl.className = 'kitacore-keys';
    keyEl.textContent = '終焉の鍵 × ' + keysOf(creatorId);
    els.kitacoreStats.appendChild(keyEl);
  }

  function emptyArticlesEl(text) {
    var p = document.createElement('p');
    p.className = 'empty-articles';
    p.textContent = text;
    return p;
  }

  // ---------------------------------------------------------------------------
  // ステータス表示
  // ---------------------------------------------------------------------------

  // type: 'loading' | 'error' | 'info'
  function setStatus(text, type) {
    els.statusMsg.innerHTML = '';
    els.statusMsg.classList.toggle('is-error', type === 'error');
    els.statusMsg.classList.toggle('is-loading', type === 'loading');
    if (type === 'loading') {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      els.statusMsg.appendChild(spinner);
    }
    els.statusMsg.appendChild(document.createTextNode(text));
    els.statusMsg.classList.remove('hidden');
  }

  function clearStatus() {
    els.statusMsg.classList.add('hidden');
    els.statusMsg.classList.remove('is-loading', 'is-error');
    els.statusMsg.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // 追加モーダル
  // ---------------------------------------------------------------------------

  function openAddModal() {
    els.addInput.value = '';
    els.addName.value = '';
    resetAddPreview();
    hideError(els.addError);
    els.addModal.classList.remove('hidden');
    els.addInput.focus();
  }

  function closeAddModal() {
    els.addModal.classList.add('hidden');
    if (addDebounceTimer) {
      clearTimeout(addDebounceTimer);
      addDebounceTimer = null;
    }
  }

  // プレビュー欄と追加ボタンを初期状態（取得前）に戻す。
  function resetAddPreview() {
    pendingProfile = null;
    addPreviewToken += 1; // 進行中の取得結果を無効化
    els.addPreview.classList.add('hidden');
    els.addPreview.innerHTML = '';
    els.addNameWrap.classList.add('hidden');
    els.addConfirm.disabled = true;
  }

  function showAddLoading() {
    pendingProfile = null;
    els.addConfirm.disabled = true;
    els.addNameWrap.classList.add('hidden');
    els.addPreview.classList.remove('hidden');
    els.addPreview.innerHTML = '<span class="add-preview-loading">読み込み中…</span>';
  }

  function showAddProfilePreview(profile) {
    els.addPreview.classList.remove('hidden');
    els.addPreview.innerHTML = '';

    var avatar = document.createElement('div');
    avatar.className = 'add-preview-avatar';
    if (profile.iconUrl) {
      var img = document.createElement('img');
      img.src = profile.iconUrl;
      img.alt = '';
      img.addEventListener('error', function () {
        avatar.removeChild(img);
        avatar.textContent = (profile.displayName || profile.id).charAt(0);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (profile.displayName || profile.id).charAt(0);
    }

    var info = document.createElement('div');
    var nameEl = document.createElement('div');
    nameEl.className = 'add-preview-name';
    nameEl.textContent = profile.displayName;
    var idEl = document.createElement('div');
    idEl.className = 'add-preview-id';
    idEl.textContent = '@' + profile.id;
    info.appendChild(nameEl);
    info.appendChild(idEl);

    els.addPreview.appendChild(avatar);
    els.addPreview.appendChild(info);

    // 表示名は取得した nickname を初期値に入れて編集可能にする
    els.addNameWrap.classList.remove('hidden');
    els.addName.value = profile.displayName;
    els.addConfirm.disabled = false;
  }

  // 入力に応じてプロフィールを取得し、プレビューを更新する。
  function handleAddInput() {
    var raw = els.addInput.value.trim();
    hideError(els.addError);

    if (!raw) {
      resetAddPreview();
      return;
    }

    var id = extractCreatorId(raw);
    if (!id) {
      resetAddPreview();
      showError(els.addError, 'noteのURLまたはIDを確認してください。');
      return;
    }

    // 既に登録済みなら取得せずに知らせる
    if (getCreator(id)) {
      resetAddPreview();
      showError(els.addError, 'このクリエイターは既に登録されています。');
      return;
    }

    showAddLoading();
    var token = ++addPreviewToken;

    fetchCreatorProfile(id)
      .then(function (profile) {
        if (token !== addPreviewToken) return; // 古い結果は破棄
        if (!profile) {
          // プロフィールが取れない = 存在しないクリエイター
          els.addPreview.classList.add('hidden');
          els.addPreview.innerHTML = '';
          els.addNameWrap.classList.add('hidden');
          els.addConfirm.disabled = true;
          pendingProfile = null;
          showError(els.addError, 'クリエイターが見つかりませんでした。');
          return;
        }
        pendingProfile = {
          id: id,
          displayName: profile.displayName || id,
          iconUrl: profile.iconUrl || null,
        };
        showAddProfilePreview(pendingProfile);
      })
      .catch(function () {
        if (token !== addPreviewToken) return;
        els.addPreview.classList.add('hidden');
        els.addNameWrap.classList.add('hidden');
        els.addConfirm.disabled = true;
        pendingProfile = null;
        showError(els.addError, 'クリエイターが見つかりませんでした。');
      });
  }

  // 確定。プレビューでプロフィール取得に成功している場合のみ登録できる。
  function confirmAdd() {
    if (!pendingProfile) return; // ボタンは disabled のはずだが念のため
    var id = pendingProfile.id;

    if (getCreator(id)) {
      showError(els.addError, 'このクリエイターは既に登録されています。');
      return;
    }

    var name = els.addName.value.trim() || pendingProfile.displayName || id;

    var creator = {
      id: id,
      displayName: name,
      iconUrl: pendingProfile.iconUrl,
      url: 'https://note.com/' + id,
      addedAt: new Date().toISOString(),
      lastFetchedAt: null,
      initialSetupDone: false,
    };
    state.creators.push(creator);
    state.selectedCreatorId = id;
    if (!state.articlesByCreator[id]) state.articlesByCreator[id] = [];

    var saved = saveState();
    if (saved !== true) {
      state.creators.pop(); // 失敗したら巻き戻す
      showError(els.addError, saved);
      return;
    }

    closeAddModal();
    clearStatus();
    goTo('read');
  }

  // ---------------------------------------------------------------------------
  // 編集モーダル
  // ---------------------------------------------------------------------------

  function openEditModal(id) {
    var c = getCreator(id);
    if (!c) return;
    editingCreatorId = id;
    els.editName.value = c.displayName || c.id;
    hideError(els.editError);
    els.editModal.classList.remove('hidden');
    els.editName.focus();
    els.editName.select();
  }

  function closeEditModal() {
    els.editModal.classList.add('hidden');
    editingCreatorId = null;
  }

  function saveEdit() {
    var c = getCreator(editingCreatorId);
    if (!c) {
      closeEditModal();
      return;
    }
    var name = els.editName.value.trim();
    if (!name) {
      showError(els.editError, '表示名を入力してください。');
      return;
    }
    c.displayName = name;
    saveState();
    closeEditModal();
    renderRoute();
  }

  // ---------------------------------------------------------------------------
  // 初期既読セットアップ
  //   初回取得後（またはカードの「既読を設定する」）に表示する。
  //   クリエイターごとに initialSetupDone を立てて、初回は1回だけ自動表示。
  // ---------------------------------------------------------------------------

  function openSetupModal(creatorId) {
    var c = getCreator(creatorId);
    if (!c) return;
    setupCreatorId = creatorId;
    var stats = statsOf(creatorId);
    els.setupLead.textContent =
      (c.displayName || c.id) + 'さんの記事を ' + stats.total + '件 取得しました。';
    // 常にステップ1から
    els.setupStepBulk.classList.add('hidden');
    els.setupStepAsk.classList.remove('hidden');
    els.setupModal.classList.remove('hidden');
  }

  function closeSetupModal() {
    els.setupModal.classList.add('hidden');
    setupCreatorId = null;
  }

  // セットアップ完了を記録して閉じ、記事一覧へ進む。
  function finishSetup() {
    var c = getCreator(setupCreatorId);
    if (c) {
      c.initialSetupDone = true;
      saveState();
    }
    var id = setupCreatorId;
    closeSetupModal();
    if (id && state.selectedCreatorId === id) {
      renderReadView();
    } else {
      renderRoute();
    }
  }

  // 「すべて未読から始める」: 何も既読化せず完了。
  function setupAllUnread() {
    finishSetup();
  }

  // 「あとで」: 完了フラグは立てない（カードから再度開けるように）。
  function setupLater() {
    var id = setupCreatorId;
    closeSetupModal();
    if (id && state.selectedCreatorId === id) {
      renderReadView();
    } else {
      renderRoute();
    }
  }

  // 「既読をまとめて設定する」: 年月チェックリストを表示。
  function setupShowBulk() {
    buildSetupMonthList();
    els.setupStepAsk.classList.add('hidden');
    els.setupStepBulk.classList.remove('hidden');
  }

  function setupBackToAsk() {
    els.setupStepBulk.classList.add('hidden');
    els.setupStepAsk.classList.remove('hidden');
  }

  // 年→月の件数つきチェックリストを組み立てる（新しい年月順）。
  function buildSetupMonthList() {
    els.setupMonthList.innerHTML = '';
    var arts = articlesOf(setupCreatorId);

    // 年→月→件数 を集計
    var years = [];
    var yearMap = {};
    arts.forEach(function (a) {
      var y = yearOf(a);
      var m = monthOf(a);
      if (y === null || m === null) return;
      if (!yearMap[y]) {
        yearMap[y] = { year: y, months: {}, monthOrder: [] };
        years.push(yearMap[y]);
      }
      if (!yearMap[y].months[m]) {
        yearMap[y].months[m] = 0;
        yearMap[y].monthOrder.push(m);
      }
      yearMap[y].months[m] += 1;
    });

    years.sort(function (a, b) {
      return b.year - a.year;
    });

    years.forEach(function (yg) {
      var block = document.createElement('div');
      block.className = 'setup-year-block';
      var label = document.createElement('div');
      label.className = 'setup-year-label';
      label.textContent = yg.year + '年';
      block.appendChild(label);

      yg.monthOrder
        .sort(function (a, b) {
          return b - a;
        })
        .forEach(function (m) {
          var row = document.createElement('label');
          row.className = 'setup-month-row';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.year = String(yg.year);
          cb.dataset.month = String(m);
          var name = document.createElement('span');
          name.className = 'setup-month-name';
          name.textContent = m + '月';
          var count = document.createElement('span');
          count.className = 'setup-month-count';
          count.textContent = yg.months[m] + '件';
          row.appendChild(cb);
          row.appendChild(name);
          row.appendChild(count);
          block.appendChild(row);
        });

      els.setupMonthList.appendChild(block);
    });
  }

  // 選択された年月の記事を一括既読（source: bulk_initial）にして完了。
  function setupApplyBulk() {
    var checks = els.setupMonthList.querySelectorAll('input[type="checkbox"]:checked');
    var selected = {};
    checks.forEach(function (cb) {
      selected[cb.dataset.year + '-' + cb.dataset.month] = true;
    });

    var arts = articlesOf(setupCreatorId);
    arts.forEach(function (a) {
      var y = yearOf(a);
      var m = monthOf(a);
      if (y === null || m === null) return;
      if (selected[y + '-' + m]) {
        setRead(setupCreatorId, a.id, true, SOURCE.BULK_INITIAL);
      }
    });

    finishSetup();
  }

  // ---------------------------------------------------------------------------
  // 記事を開いて戻ったときの読了確認
  //   記事リンクを押したら pending を sessionStorage に記録（別タブ遷移でも残る）。
  //   タブに戻る（visibilitychange/focus）と確認モーダルを出す。
  // ---------------------------------------------------------------------------

  var PENDING_KEY = 'yomiasa:pendingArticle';

  function rememberPendingArticle(creatorId, article) {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ creatorId: creatorId, articleId: article.id, title: article.title })
      );
    } catch (e) {
      /* sessionStorage 不可なら確認は出ないだけ */
    }
    // キタコレ：覚醒済みクリエイターの記事なら、遷移前に裏でワイ数を収集する。
    // （ポイント加算は後で記事行のチップをタップして回収＝ここでは点を入れない）
    if (isKitacoreTarget(creatorId) && isModeOn(creatorId)) {
      fetchAndCountArticle(article, creatorId);
    }
  }

  function takePendingArticle() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(PENDING_KEY);
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  var pendingReadback = null;

  // 戻ってきたら、未処理の pending があれば確認モーダルを開く。
  function handleReturn() {
    if (!els.readbackModal.classList.contains('hidden')) return; // 既に表示中
    var pending = takePendingArticle();
    if (!pending) return;
    // 記事がまだ存在し、既読でない場合のみ聞く（既読済みなら聞く必要なし）
    if (!getCreator(pending.creatorId)) return;
    if (isRead(pending.creatorId, pending.articleId)) return;
    pendingReadback = pending;
    els.readbackArticle.textContent = pending.title;
    els.readbackModal.classList.remove('hidden');
  }

  function closeReadbackModal() {
    els.readbackModal.classList.add('hidden');
    pendingReadback = null;
  }

  function confirmReadbackYes() {
    if (pendingReadback) {
      setRead(pendingReadback.creatorId, pendingReadback.articleId, true, SOURCE.MANUAL);
      saveState();
    }
    closeReadbackModal();
    // 表示中の画面を更新
    if (currentRoute() === 'read') {
      renderArticles();
      updateReadStatsHeader();
    } else {
      renderListView();
    }
  }

  function confirmReadbackNo() {
    closeReadbackModal();
  }

  function deleteCreator(id) {
    var c = getCreator(id);
    if (!c) return;
    var ok = window.confirm(
      '「' + (c.displayName || c.id) + '」を削除しますか?\n取得した記事と読了状態も消えます。'
    );
    if (!ok) return;

    state.creators = state.creators.filter(function (x) {
      return x.id !== id;
    });
    // この creator のキタコレ計測も掃除（counts/collected は article.id 単位なので
    // 削除前に拾う。回収済みの累計 totalWai もそのぶん差し引く）。
    if (state.kitacore) {
      ensureKitacore();
      (state.articlesByCreator[id] || []).forEach(function (a) {
        if (!a || !a.id) return;
        if (state.kitacore.collected[a.id]) {
          var entry = state.kitacore.counts[a.id];
          if (entry && typeof entry.wai === 'number') {
            state.kitacore.totalWai = Math.max(0, state.kitacore.totalWai - entry.wai);
          }
          delete state.kitacore.collected[a.id];
        }
        delete state.kitacore.counts[a.id];
        delete state.kitacore.quizCleared[a.id];
      });
      delete state.kitacore.mode[id];
      delete state.kitacore.keys[id];
      delete state.kitacore.defeatedBosses[id];
      if (state.kitacore.pendingPostBoss) delete state.kitacore.pendingPostBoss[id];
      // KITAcoreクリエーター本体を削除した場合はプレイヤー情報もリセット
      if (id === KITACORE_ID) {
        state.kitacore.player = null;
        state.kitacore.quizTaps = 0;
      }
    }
    delete state.articlesByCreator[id];
    // この creator の読了状態も掃除
    Object.keys(state.readArticles).forEach(function (k) {
      if (k.indexOf(id + ':') === 0) delete state.readArticles[k];
    });
    if (state.uiByCreator) delete state.uiByCreator[id];
    if (state.selectedCreatorId === id) {
      state.selectedCreatorId = state.creators[0] ? state.creators[0].id : '';
    }
    saveState();
    goTo('list');
  }

  // ---------------------------------------------------------------------------
  // 記事取得アクション
  // ---------------------------------------------------------------------------

  function doFetch() {
    if (isFetching) return;
    var c = getSelectedCreator();
    if (!c) return;

    var existing = articlesOf(c.id);
    var isFirstFetch = !c.lastFetchedAt || existing.length === 0;

    isFetching = true;
    els.fetchBtn.disabled = true;
    els.fetchBtn.classList.add('is-loading');
    setStatus(isFirstFetch ? '記事一覧を取得しています…' : '新着を確認しています…', 'loading');

    function onProgress(count) {
      setStatus(count + '件を取得中…', 'loading');
    }

    // 差分取得: 前回の最新公開日を渡す（公開日でソート後、これ以下に達したら停止）。
    // 既存データに seenLatestPublishedAt が無い場合（旧バージョン保存分）は、
    // 既存記事の最大公開日で代替する。既知IDは重複除外の保険として渡す。初回は全件。
    var opts = isFirstFetch
      ? {}
      : {
          sincePublishedAt:
            typeof c.seenLatestPublishedAt === 'string'
              ? c.seenLatestPublishedAt
              : maxPublishedAt(existing),
          knownIds: new Set(
            existing.map(function (a) {
              return a.id;
            })
          ),
        };

    fetchArticles(c.id, onProgress, opts)
      .then(function (result) {
        var fresh = result.articles || [];

        if (isFirstFetch) {
          if (fresh.length === 0) {
            setStatus('記事が見つかりませんでした。', 'error');
            return;
          }
          state.articlesByCreator[c.id] = fresh;
        } else {
          // 新着分を既存の先頭にマージ（fresh は新しい順）。重複は除外。
          if (fresh.length > 0) {
            var have = new Set(
              existing.map(function (a) {
                return a.id;
              })
            );
            var add = fresh.filter(function (a) {
              return !have.has(a.id);
            });
            state.articlesByCreator[c.id] = add.concat(existing);
          }
        }

        // 取得＝最新状態を取り込んだので seen を最新に合わせる → バッジは消える。
        // 最新公開日は取得後の記事一覧から算出（page1が取れない端ケースの保険）。
        if (typeof result.totalCount === 'number') {
          c.seenTotalCount = result.totalCount;
        }
        var newLatestPub = result.latestPublishedAt || maxPublishedAt(state.articlesByCreator[c.id]);
        if (newLatestPub) c.seenLatestPublishedAt = newLatestPub;
        latestStatus[c.id] = {
          totalCount: typeof result.totalCount === 'number' ? result.totalCount : c.seenTotalCount,
          latestPublishedAt: c.seenLatestPublishedAt || null,
        };
        c.lastFetchedAt = new Date().toISOString();

        var saved = saveState();
        if (saved !== true) {
          setStatus(saved, 'error');
          return;
        }

        // 結果メッセージ
        if (!isFirstFetch) {
          var addedNow = state.articlesByCreator[c.id].length - existing.length;
          if (addedNow > 0) {
            setStatus('新着 ' + addedNow + '件を取得しました。', 'info');
          } else {
            setStatus('新着はありませんでした。', 'info');
          }
        } else {
          clearStatus();
        }

        renderReadView();
        if (isFirstFetch && !c.initialSetupDone) {
          openSetupModal(c.id);
        }
      })
      .catch(function () {
        setStatus(
          '記事一覧を取得できませんでした。\nnote IDを確認して、もう一度試してください。',
          'error'
        );
      })
      .then(function () {
        isFetching = false;
        els.fetchBtn.disabled = false;
        els.fetchBtn.classList.remove('is-loading');
      });
  }

  // ---------------------------------------------------------------------------
  // モーダル汎用
  // ---------------------------------------------------------------------------

  function showError(el, text) {
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function hideError(el) {
    el.textContent = '';
    el.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // イベント配線
  // ---------------------------------------------------------------------------

  function wireEvents() {
    window.addEventListener('hashchange', renderRoute);

    els.emptyAddBtn.addEventListener('click', openAddModal);
    els.addBtn.addEventListener('click', openAddModal);
    els.fab.addEventListener('click', openAddModal);

    els.backBtn.addEventListener('click', function () {
      goTo('list');
    });
    els.fetchBtn.addEventListener('click', doFetch);

    // 追加モーダル
    els.addCancel.addEventListener('click', closeAddModal);
    els.addConfirm.addEventListener('click', confirmAdd);
    els.addModal.addEventListener('click', function (e) {
      if (e.target === els.addModal) closeAddModal();
    });
    // 入力中にプロフィールを取得（連打は 350ms デバウンス）
    els.addInput.addEventListener('input', function () {
      if (addDebounceTimer) clearTimeout(addDebounceTimer);
      addDebounceTimer = setTimeout(handleAddInput, 350);
    });
    // Enter での即時取得・確定
    els.addInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (addDebounceTimer) {
        clearTimeout(addDebounceTimer);
        addDebounceTimer = null;
      }
      if (pendingProfile) {
        confirmAdd();
      } else {
        handleAddInput();
      }
    });
    els.addName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && pendingProfile) confirmAdd();
    });

    // 編集モーダル
    els.editCancel.addEventListener('click', closeEditModal);
    els.editSave.addEventListener('click', saveEdit);
    els.editModal.addEventListener('click', function (e) {
      if (e.target === els.editModal) closeEditModal();
    });
    els.editName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveEdit();
    });

    // 初期既読セットアップ
    els.setupAllUnread.addEventListener('click', setupAllUnread);
    els.setupBulk.addEventListener('click', setupShowBulk);
    els.setupLater.addEventListener('click', setupLater);
    els.setupBulkBack.addEventListener('click', setupBackToAsk);
    els.setupBulkApply.addEventListener('click', setupApplyBulk);
    // セットアップはオーバーレイ外クリックでは閉じない（誤操作で初期化を飛ばさない）

    // 読了確認モーダル（記事から戻ったとき）
    els.readbackYes.addEventListener('click', confirmReadbackYes);
    els.readbackNo.addEventListener('click', confirmReadbackNo);

    // 設定 / エクスポート / インポート
    els.settingsBtn.addEventListener('click', openSettingsModal);
    els.settingsClose.addEventListener('click', closeSettingsModal);
    els.settingsModal.addEventListener('click', function (e) {
      if (e.target === els.settingsModal) closeSettingsModal();
    });
    els.settingsExport.addEventListener('click', openExportModal);
    els.settingsImport.addEventListener('click', openImportModal);

    els.exportCopy.addEventListener('click', copyExport);
    els.exportClose.addEventListener('click', closeExportModal);
    els.exportModal.addEventListener('click', function (e) {
      if (e.target === els.exportModal) closeExportModal();
    });

    els.importPaste.addEventListener('click', pasteFromClipboard);
    els.importConfirm.addEventListener('click', confirmImport);
    els.importCancel.addEventListener('click', closeImportModal);
    els.importModal.addEventListener('click', function (e) {
      if (e.target === els.importModal) closeImportModal();
    });

    // 記事を読んで戻ってきたことの検知
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') handleReturn();
    });
    window.addEventListener('focus', handleReturn);

    // フィルタ
    els.keyword.addEventListener('input', function () {
      state.uiState.keyword = els.keyword.value;
      saveState();
      renderArticles();
    });
    els.yearFilter.addEventListener('change', function () {
      var cu = creatorUi(state.selectedCreatorId);
      cu.year = els.yearFilter.value;
      cu.month = 'all';
      saveState();
      renderFilterOptions();
      renderArticles();
    });
    els.monthFilter.addEventListener('change', function () {
      creatorUi(state.selectedCreatorId).month = els.monthFilter.value;
      saveState();
      renderArticles();
    });
    els.unreadOnly.addEventListener('change', function () {
      creatorUi(state.selectedCreatorId).showUnreadOnly = els.unreadOnly.checked;
      saveState();
      renderArticles();
    });
    els.sortToggle.addEventListener('click', function () {
      var cu = creatorUi(state.selectedCreatorId);
      cu.sortOrder = cu.sortOrder === 'asc' ? 'desc' : 'asc';
      els.sortToggle.textContent = cu.sortOrder === 'asc' ? '古い順' : '新しい順';
      saveState();
      renderArticles();
    });

    // Esc でモーダルを閉じる
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!els.addModal.classList.contains('hidden')) closeAddModal();
        if (!els.editModal.classList.contains('hidden')) closeEditModal();
        if (!els.readbackModal.classList.contains('hidden')) closeReadbackModal();
        if (!els.updateModal.classList.contains('hidden')) closeUpdateModal();
        if (!els.settingsModal.classList.contains('hidden')) closeSettingsModal();
        if (!els.exportModal.classList.contains('hidden')) closeExportModal();
        if (!els.importModal.classList.contains('hidden')) closeImportModal();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // アップデートお知らせ
  //   updates.json から現バージョンの更新内容を取得し、未読なら1回だけ表示する。
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function checkVersionUpdate() {
    if (els.headerVersion) els.headerVersion.textContent = 'v' + APP_VERSION;

    var lastSeen = null;
    try {
      lastSeen = localStorage.getItem(VERSION_KEY);
    } catch (e) {
      /* noop */
    }
    if (lastSeen === APP_VERSION) return;

    // updates.json を取得（キャッシュ回避のため t= を付ける）
    fetch('updates.json?t=' + new Date().getTime())
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        var items = data ? data[APP_VERSION] : null;
        if (!items || items.length === 0) {
          // お知らせが無ければ静かに既読化
          rememberSeenVersion();
          return;
        }
        els.updateVersion.textContent = 'v' + APP_VERSION;
        els.updateBody.innerHTML = items
          .map(function (t) {
            return '<li>' + escapeHtml(t) + '</li>';
          })
          .join('');
        els.updateModal.classList.remove('hidden');
      })
      .catch(function () {
        /* 取得失敗時はモーダルを出さない（既読化もしない＝次回再試行） */
      });
  }

  function rememberSeenVersion() {
    try {
      localStorage.setItem(VERSION_KEY, APP_VERSION);
    } catch (e) {
      /* noop */
    }
  }

  function closeUpdateModal() {
    rememberSeenVersion();
    els.updateModal.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // 設定 / エクスポート / インポート
  // ---------------------------------------------------------------------------

  function openSettingsModal() {
    els.settingsModal.classList.remove('hidden');
  }
  function closeSettingsModal() {
    els.settingsModal.classList.add('hidden');
  }

  function openExportModal() {
    closeSettingsModal();
    els.exportText.value = exportData();
    els.exportCopy.textContent = 'コピー';
    els.exportModal.classList.remove('hidden');
    // 選択しておくと手動コピーもしやすい
    setTimeout(function () {
      els.exportText.focus();
      els.exportText.select();
    }, 50);
  }
  function closeExportModal() {
    els.exportModal.classList.add('hidden');
  }

  function copyExport() {
    var text = els.exportText.value;
    var done = function () {
      els.exportCopy.textContent = 'コピーしました';
      setTimeout(function () {
        els.exportCopy.textContent = 'コピー';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(els.exportText);
        done();
      });
    } else {
      legacyCopy(els.exportText);
      done();
    }
  }

  function legacyCopy(textarea) {
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* noop */
    }
  }

  function openImportModal() {
    closeSettingsModal();
    els.importText.value = '';
    hideError(els.importError);
    els.importModal.classList.remove('hidden');
    setTimeout(function () {
      els.importText.focus();
    }, 50);
  }
  function closeImportModal() {
    els.importModal.classList.add('hidden');
  }

  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showError(els.importError, 'この環境では自動貼り付けに対応していません。\n手動で貼り付けてください。');
      els.importText.focus();
      return;
    }
    navigator.clipboard.readText().then(
      function (text) {
        els.importText.value = text;
        hideError(els.importError);
      },
      function () {
        showError(els.importError, 'クリップボードを読み取れませんでした。\n手動で貼り付けてください。');
        els.importText.focus();
      }
    );
  }

  // 貼り付けで混入しがちな不可視文字を正規化する。
  //   BOM除去 / ゼロ幅スペース除去 / ノーブレークスペース等を通常スペースへ
  function normalizePasted(raw) {
    return raw
      .replace(/^﻿/, '')
      .replace(/[​-‍]/g, '')
      .replace(/[   ]/g, ' ')
      .trim();
  }

  function confirmImport() {
    var raw = els.importText.value;
    if (!raw || !raw.trim()) {
      showError(els.importError, 'テキストを貼り付けてください。');
      return;
    }
    var ok = window.confirm('現在のデータを、貼り付けた内容で上書きします。よろしいですか?');
    if (!ok) return;

    try {
      importData(normalizePasted(raw));
    } catch (e) {
      showError(
        els.importError,
        '読み込みに失敗しました。\nエクスポートしたテキストか確認してください。'
      );
      return;
    }
    closeImportModal();
    // 選択中クリエイターの整合性を取り直して全再描画
    if (state.selectedCreatorId && !getCreator(state.selectedCreatorId)) {
      state.selectedCreatorId = '';
      saveState();
    }
    clearStatus();
    goTo('list');
    renderRoute();
  }

  // ---------------------------------------------------------------------------
  // Service Worker（PWA）
  // ---------------------------------------------------------------------------

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // 相対パスで登録（GitHub Pages の /yomiasa/ サブパスでも動く）
    navigator.serviceWorker.register('sw.js').catch(function () {
      /* 登録失敗は致命的でないので無視 */
    });
  }

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------

  function init() {
    // 選択中クリエイターの整合性
    if (state.selectedCreatorId && !getCreator(state.selectedCreatorId)) {
      state.selectedCreatorId = '';
    }
    wireEvents();
    els.updateClose.addEventListener('click', closeUpdateModal);
    // キタコレ：システムメッセージのタップ（全文表示→閉じる）
    if (els.kitacoreSystem) {
      els.kitacoreSystem.addEventListener('click', onSystemMessageTap);
    }
    if (els.kitacoreQuizClose) {
      els.kitacoreQuizClose.addEventListener('click', closeQuiz);
    }
    if (els.kitacoreBattle) {
      els.kitacoreBattle.addEventListener('click', onBossBattleTap);
    }
    if (els.kitacorePlayerAuth) {
      els.kitacorePlayerAuth.addEventListener('click', authPlayer);
    }
    if (els.kitacorePlayerCancel) {
      els.kitacorePlayerCancel.addEventListener('click', closePlayerInput);
    }
    if (els.kitacoreRankArea) {
      els.kitacoreRankArea.addEventListener('click', function (e) {
        // デバッグボタンのクリックは除外
        if (e.target.closest('#debug-btns')) return;
        openRankCard();
      });
    }
    if (els.kitacoreRankCardClose) {
      els.kitacoreRankCardClose.addEventListener('click', closeRankCard);
    }
    if (els.debugAddKeys) {
      els.debugAddKeys.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || !isKitacoreTarget(c.id)) return;
        ensureKitacore();
        state.kitacore.keys[c.id] = keysOf(c.id) + 3;
        saveState();
        renderKitacoreHeader();
      });
    }
    if (els.debugAddWai) {
      els.debugAddWai.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || !isKitacoreTarget(c.id)) return;
        ensureKitacore();
        var waiRankBefore = kitacoreWaiRankOf(state.kitacore.totalWai);
        state.kitacore.totalWai += 100;
        saveState();
        var waiRankAfter = kitacoreWaiRankOf(state.kitacore.totalWai);
        if (waiRankAfter.key !== waiRankBefore.key && waiRankAfter.bossKey) {
          var boss = KITACORE_POST_BOSSES.find(function (b) { return b.key === waiRankAfter.bossKey; });
          if (boss) showPostBoss(boss);
        }
        renderKitacoreHeader();
      });
    }
    if (els.debugClear) {
      els.debugClear.addEventListener('click', function () {
        if (!window.confirm('キタコレの進行データ（鍵・クイズ・ボス撃破・ワイ）をすべてクリアします。よろしいですか？')) return;
        var c = getSelectedCreator();
        if (!c) return;
        ensureKitacore();
        state.kitacore.keys = {};
        state.kitacore.quizCleared = {};
        state.kitacore.defeatedBosses = {};
        state.kitacore.totalWai = 0;
        state.kitacore.counts = {};
        state.kitacore.collected = {};
        state.kitacore.quizTaps = 0;
        state.kitacore.pendingPostBoss = {};
        saveState();
        renderRoute();
        updateReadStatsHeader();
      });
    }
    if (els.kitacorePlayerInput) {
      els.kitacorePlayerInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') authPlayer();
      });
    }
    // 直接 #read で来ても選択が無ければ list に落とす（renderRoute 内で処理）
    renderRoute();
    checkVersionUpdate();
    registerServiceWorker();
    loadKitacoreQuizzes();
  }

  init();
})();
