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

  // 純粋ロジックは logic.js（window.YomiasaLogic）に切り出してテスト可能にしている。
  // index.html で app.js より前に読み込む前提。万一未ロードでも気付けるよう存在を確認する。
  var L = window.YomiasaLogic;
  if (!L) {
    throw new Error('logic.js (YomiasaLogic) が読み込まれていません。index.html の読み込み順を確認してください。');
  }

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
  var APP_VERSION = '0.1.9';
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
      // お気に入り（⭐）。"creatorId:articleId" → スナップショット。
      //   保存機能ではなく「あとで戻る場所」を作る機能。クリエイター横断で見返す。
      //   横断ビューで現在クリエイター未選択でも表示するため、記事の最小情報を複製して持つ。
      favorites: {},
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
      // モード state 名前空間。各モードの進行データは state.modes[modeKey] に載る。
      //   キタコレは state.modes.kitacore（旧 state.kitacore から migrateModes で移行済み）。
      modes: {},
    };
  }

  // モード1個分の空 state（defaultState の旧 kitacore リテラルと同一形）。
  function blankModeState() {
    return { mode: {}, counts: {}, collected: {}, totalWai: 0, keys: {}, defeatedBosses: {}, quizCleared: {}, player: null, quizTaps: 0, pendingPostBoss: {} };
  }

  // state.modes 名前空間の遅延初期化。
  function ensureModes() {
    if (!state.modes || typeof state.modes !== 'object') state.modes = {};
    return state.modes;
  }

  // state.modes[modeKey] とその各キーの遅延初期化。読み書き前に必ず通す。
  //   旧 ensureKitacore と1対1で同一のサブキー型チェック（player は null 許容の特殊ガード）。
  function ensureMode(modeKey) {
    ensureModes();
    var m = state.modes[modeKey];
    if (!m || typeof m !== 'object') m = state.modes[modeKey] = blankModeState();
    if (!m.mode || typeof m.mode !== 'object') m.mode = {};
    if (!m.counts || typeof m.counts !== 'object') m.counts = {};
    if (!m.collected || typeof m.collected !== 'object') m.collected = {};
    if (typeof m.totalWai !== 'number') m.totalWai = 0;
    if (!m.keys || typeof m.keys !== 'object') m.keys = {};
    if (!m.defeatedBosses || typeof m.defeatedBosses !== 'object') m.defeatedBosses = {};
    if (!m.quizCleared || typeof m.quizCleared !== 'object') m.quizCleared = {};
    if (m.player !== null && typeof m.player !== 'object') m.player = null;
    if (typeof m.quizTaps !== 'number') m.quizTaps = 0;
    if (!m.pendingPostBoss || typeof m.pendingPostBoss !== 'object') m.pendingPostBoss = {};
    // ── ニゲキレ固有サブキー（キタコレでは触らない）──
    //   共通型（mode/collected/player）はそのまま流用し、7人財布・通過・成功数だけ足す。
    if (modeKey === 'nigekire') {
      // ── v2：一言チップ収集（実行時取得）──
      if (!m.counts || typeof m.counts !== 'object') m.counts = {};             // { [articleId]: { chars: [charKey,...] } } 本文取得で判定した一言キャラ（複数可）
      if (!m.charCounts || typeof m.charCounts !== 'object') m.charCounts = {};  // { [charKey]: number } キャラ別収集数
      // ── 試練（曜日キャラ・逃げ切り）＋既存共通 ──
      if (!m.passed || typeof m.passed !== 'object') m.passed = {};             // { [articleId]: true } 試練通過
      if (typeof m.totalSuccess !== 'number') m.totalSuccess = 0;               // 総ニゲキレ成功数（逃げ切り数）
      if (typeof m.firstTrySuccess !== 'number') m.firstTrySuccess = 0;         // 一発成功数
      // ── 節目イベント（最終確認・閾値初到達ベース）──
      //   rankStage = 到達済み閾値の数（0〜6）＝現ランク段。reachedThresholds から導出する。
      if (typeof m.rankStage !== 'number' || !isFinite(m.rankStage)) m.rankStage = 0;
      else {
        m.rankStage = Math.floor(m.rankStage);
        if (m.rankStage < 0) m.rankStage = 0;
        if (m.rankStage > 6) m.rankStage = 6;
      }
      // reachedThresholds: 到達済み閾値キーの配列（'escape3'..'point15'）。ランクの源泉。
      //   既存データ（この配列を持たない）は rankStage から順番どおりに復元する。
      if (!Array.isArray(m.reachedThresholds)) {
        m.reachedThresholds = NIGEKIRE_THRESHOLD_ORDER.slice(0, m.rankStage);
      }
      // rankStage は毎回 reachedThresholds.length から導出して代入（既存コードが参照するため）。
      m.rankStage = L.nigekireRankStageFromReached(
        m.reachedThresholds, NIGEKIRE_LIFE_RANKS.length - 1
      );
      // ── 推し1人選択構造 ──
      //   oshiChar: 選択中の推し charKey（null=未選択＝推し選択モーダルを出す）
      //   oshiCleared: 初期試練を3回通過したキャラの charKey 配列（称号の曜日・カード解放）
      //   escapeCounts: { [charKey]: number } キャラ別の逃げ切き数（0..9）。キャラ変更で消えない
      //   oshiPassCounts: { [charKey]: number } キャラ別の節目 通過回数（0..6・初期試練3＋収集3）
      if (m.oshiChar !== null && typeof m.oshiChar !== 'string') m.oshiChar = null;
      if (typeof m.oshiChar === 'undefined') m.oshiChar = null;
      if (!Array.isArray(m.oshiCleared)) m.oshiCleared = [];
      if (!m.escapeCounts || typeof m.escapeCounts !== 'object') m.escapeCounts = {};
      if (!m.oshiPassCounts || typeof m.oshiPassCounts !== 'object') m.oshiPassCounts = {};
      // ── 交換所（おへんじ帖の季節衣装・nigekire-exchange-spec.md §7）──
      //   outfitUnlocks: [{characterId, season, unlockedAt}] のキャッシュ。
      //   正本はD1（サーバー）。毎回通信しないためローカルにも持つ。
      //   ★ポイントは減らないので、ここに残高の類は持たない。
      if (!Array.isArray(m.outfitUnlocks)) m.outfitUnlocks = [];
      // ※ lastCollectedChar / finalCheckDone は推し選択構造では使わない（残置は無害・参照しない）。
      if (m.finalCheckChar !== null && typeof m.finalCheckChar !== 'string') m.finalCheckChar = null; // 今出ている節目のキャラkey（都度セット）
      // 旧 charPoints（v1 ポイント制）は残っていても無害（v2 では使わない）。初期化はしない。
    }
    return m;
  }

  // モード state アクセサ（固定キー限定・汎用化しない）。
  //   state.modes[modeKey] を遅延初期化して返す。
  function modeState(modeKey) {
    return ensureMode(modeKey);
  }
  // キタコレ用の固定アクセサ（active-mode 解決には使わない）。
  function mc() {
    return modeState('kitacore');
  }

  // ── モード横断アクセサ（発動フロー汎用化用）──
  //   creatorId → そのクリエイターに紐づくモード key（無ければ null）。
  //   MODE_DEFS の targetCreatorId 逆引き。mc() は 'kitacore' 固定のまま残す（R3）。
  function activeModeKey(creatorId) {
    var def = L.modeForCreator(MODE_DEFS, creatorId);
    return def ? def.key : null;
  }
  // creatorId に紐づくモードの state（遅延初期化）。無ければ null。
  //   ニゲキレの state 読み書きはこれ経由（キタコレ専用の mc() とは分離）。
  function modeStateFor(creatorId) {
    var key = activeModeKey(creatorId);
    return key ? ensureMode(key) : null;
  }
  // creatorId に紐づくモードが ON か（モード横断版）。
  function isModeOnFor(creatorId) {
    var m = modeStateFor(creatorId);
    return !!(m && m.mode && m.mode[creatorId]);
  }

  // キタコレモードが発動できる唯一の note ID（KITAさん＝推される側。汎用化しない）。
  var KITACORE_ID = 'ktcrs1107';

  // システムメッセージ生成中に参照するモード key（lines 内の playerName() 解決用）。
  //   null のときはキタコレ（mc()）を見る＝従来挙動。発動/終了の直前にセットしてから
  //   def.lines.*() を呼び、直後にクリアする。
  var linesModeKey = null;

  // プレイヤー名（＝ユーザー自身の note ID。発動時に入力・保存したものを使う）。
  // 未登録時のフォールバックは 'プレイヤー'（通常は登録後しか表示されない）。
  //   linesModeKey がセット済みならそのモードの player を見る（モード別 state.player 対応）。
  function playerName() {
    var m = linesModeKey ? ensureMode(linesModeKey) : mc();
    var p = m.player;
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
  //   実体は logic.js（L.kitacoreRankOf）。app 側は state から撃破配列を取り出して渡す薄いラッパ。
  function kitacoreRankOf(creatorId) {
    return L.kitacoreRankOf(KITACORE_RANKS, KITACORE_POST_BOSSES, defeatedBossesOf(creatorId));
  }

  // ワイ数がどのランク閾値に達しているか（ボス出現トリガー判定用）。実体は logic.js。
  function kitacoreWaiRankOf(totalWai) {
    return L.kitacoreWaiRankOf(KITACORE_RANKS, totalWai);
  }

  // 覚醒前ボス（撃破で昇格）。order 順に挑戦。最後の wing 撃破で S級覚醒。
  //   cost = 挑戦に要る終焉の鍵。rankBefore = そのボスに挑む時点のランク。
  //   rankAfter = 撃破後に昇格するランク（wing は S級覚醒）。img = 同梱画像。
  var KITACORE_PRE_BOSSES = [
    { key: 'reaper', name: 'REAPER', title: '終焉の執行者', cost: 3, rankBefore: 'E級', rankBeforeKey: 'e', rankAfter: 'C級', img: 'assets/boss/REAPER.webp' },
    { key: 'armored', name: 'ARMORED WARRIOR', title: '戦場の死', cost: 3, rankBefore: 'C級', rankBeforeKey: 'c', rankAfter: 'A級', img: 'assets/boss/ARMORED_WARRIOR.webp' },
    { key: 'wing', name: 'WING OF DEATH', title: '収穫の獣', cost: 3, rankBefore: 'A級', rankBeforeKey: 'a', rankAfter: 'S級覚醒', img: 'assets/boss/WING_OF_DEATH.webp' },
  ];

  // ===========================================================================
  // ニゲキレモード 静的定義（フェーズ1配線）。
  //   発動対象は hasyamo（おはようカノジョも同アカウント内）。曜日→キャラは機械対応。
  //   ポイント表・ランク閾値・称号テーブルは正史 nigekire-quiz-and-points-spec.md §10。
  // ===========================================================================
  var NIGEKIRE_ID = 'hasyamo';

  // 7人（曜日順・月子→日和固定）。color=キャラ設定のパーソナルカラー hex、img=<name>.webp。
  var NIGEKIRE_CHARACTERS = [
    { key: 'tsukiko', weekday: 'mon', label: '月曜', name: '月子',   color: '#1f3a5f', img: 'tsukiko.webp' }, // ネイビー
    { key: 'you',     weekday: 'tue', label: '火曜', name: '陽',     color: '#f28c28', img: 'you.webp' },     // オレンジ
    { key: 'shizuku', weekday: 'wed', label: '水曜', name: 'しずく', color: '#7ec8e3', img: 'shizuku.webp' }, // ライトブルー
    { key: 'rinka',   weekday: 'thu', label: '木曜', name: '凛華',   color: '#7b1e2b', img: 'rinka.webp' },   // ボルドー／ワインレッド
    { key: 'runa',    weekday: 'fri', label: '金曜', name: 'るな',   color: '#2ecc71', img: 'runa.webp' },    // エメラルドグリーン
    { key: 'mahiru',  weekday: 'sat', label: '土曜', name: 'まひる', color: '#b39ddb', img: 'mahiru.webp' },  // ラベンダー
    { key: 'hiyori',  weekday: 'sun', label: '日曜', name: '日和',   color: '#f7b6c2', img: 'hiyori.webp' },  // ソフトピンク
  ];

  // 一言見出し「◯◯の一言」の名前 → charKey 照合マップ（§10.7 ホワイトリスト・7人限定）。
  //   L.detectHitokotoChars に渡す。NIGEKIRE_CHARACTERS の name から機械生成（二重定義しない）。
  //   「KITAさんの一言」等はこのマップに無い＝ null（収集対象外）になる。
  var NIGEKIRE_NAME_TO_KEY = NIGEKIRE_CHARACTERS.reduce(function (map, ch) {
    map[ch.name] = ch.key;
    return map;
  }, {});

  // 曜日順の key 配列。= ['tsukiko','you','shizuku','rinka','runa','mahiru','hiyori']
  //   （NIGEKIRE_CHARACTERS の key 順）。推し選択UI・称号の曜日並びで使う。
  var NIGEKIRE_CHAR_ORDER = NIGEKIRE_CHARACTERS.map(function (ch) { return ch.key; });

  // 生活ランク定義（7段階・通過ベース）。ランクは全体で1つ（キャラごとに持たない）。
  //   ランクは収集数では決まらない。rankStage（到達済み閾値の数・0〜6）で決まる。
  //   この配列は logic.js の nigekireRankByStage（rankStage→ランク名）に渡す。
  //
  //   ※ min は【もう参照されない】（nigekire-percharacter-points.md で閾値は
  //     NIGEKIRE_THRESHOLDS へ移した）。値は既存データ互換のため残置するが、
  //     判定には一切使わない。
  //   grade = 上位感を伝える記号（E→SS）。ランク名だけだと何段目か分からないため、
  //     キタコレ（E級/C級/A級/S級覚醒…）と同じ読み口で「S:おはカノ生活継続者」と前置する。
  var NIGEKIRE_LIFE_RANKS = [
    { stage: 1, min: 0,   grade: 'E',  name: '言い訳見習い',        key: 'nige1' }, // min 参照されない
    { stage: 2, min: 0,   grade: 'D',  name: '言い訳準備中',        key: 'nige2' }, // min 参照されない
    { stage: 3, min: 0,   grade: 'C',  name: '生活立て直し中',      key: 'nige3' }, // min 参照されない
    { stage: 4, min: 0,   grade: 'B',  name: '生活防衛中',          key: 'nige4' }, // min 参照されない
    { stage: 5, min: 70,  grade: 'A',  name: '火種処理係',          key: 'nige5' }, // min 参照されない
    { stage: 6, min: 120, grade: 'S',  name: 'おはカノ生活継続者',  key: 'nige6' }, // min 参照されない
    { stage: 7, min: 200, grade: 'SS', name: 'おはカノ生活管理人',  key: 'nige7' }, // min 参照されない
  ];

  // 節目の閾値（1キャラにつき6回）。
  //   escape: 初期試練＝そのキャラの逃げ切き本数 3/6/9
  //   point : 収集＝そのキャラのポイント（charCounts[charKey]）5/10/15
  //   ランクは「閾値キーへの初到達」でだけ上がる（2人目以降は節目だけ出てランクは動かない）。
  var NIGEKIRE_THRESHOLDS = { escape: [3, 6, 9], point: [5, 10, 15] };

  // ---- 交換所（おへんじ帖の季節衣装・nigekire-exchange-spec.md）----
  //   ★ポイントは減らない（§2）。到達数で「何着選べるか」が決まる。
  //   解放数はキャラ単位（ポイントが charCounts[charKey] のキャラ単位のため）。
  var NIGEKIRE_OUTFIT_THRESHOLDS = [5, 10, 15, 20];
  // 実装済み＝画像がある季節。将来 chibi-autumn/ 等が増えたらここに足す（§7 カタログはコードに持つ）。
  var NIGEKIRE_OUTFIT_AVAILABLE = ['summer'];
  // 季節の表示名と記号（未実装マスは記号＋「今後のバージョンで解放」・§5）。
  var NIGEKIRE_SEASON_META = {
    spring: { name: '春', dir: 'chibi-spring' },
    summer: { name: '夏', dir: 'chibi-summer' },
    autumn: { name: '秋', dir: 'chibi-autumn' },
    winter: { name: '冬', dir: 'chibi-winter' },
  };
  // サーバー（CF/yomiasa-site・README の本番URL）。
  var NIGEKIRE_OUTFIT_API = 'https://yomiasa-site.hasyamo.workers.dev';

  // 閾値キーの正順（ランク段 1..6 に対応）。既存データの reachedThresholds 復元に使う。
  //   rankStage=3 → ['escape3','escape6','escape9']、rankStage=5 → +['point5','point10']。
  var NIGEKIRE_THRESHOLD_ORDER = NIGEKIRE_THRESHOLDS.escape
    .map(function (n) { return L.nigekireThresholdKey('escape', n); })
    .concat(NIGEKIRE_THRESHOLDS.point.map(function (n) {
      return L.nigekireThresholdKey('point', n);
    }));

  // キャラ別称号（キャラ別収集数判定・4段階・§10.5）。閾値 0/5/10/15。
  //   names[charKey] = [段階1..4名]。logic.js の nigekireCharTitle に渡す（閾値だけ v2 に変更）。
  var NIGEKIRE_CHAR_TITLE_TABLE = {
    thresholds: [0, 5, 10, 15],
    names: {
      tsukiko: ['呼び止められ中', '説明準備中',   '予定確認済み', '月曜逃げ切り'],
      you:     ['勢いで弁明中',   '笑ってごまかし中', '火曜突破中', '火曜逃げ切り'],
      shizuku: ['そっと確認中',   '迷い回収中',   '静かに通過中', '水曜逃げ切り'],
      rinka:   ['見られてる',     '言い訳審査中', '別に許してない', '木曜逃げ切り'],
      runa:    ['追いかけられ中', '全力弁明中',   '勢いで突破中', '金曜逃げ切り'],
      mahiru:  ['寝たふり中',     '見抜かれ中',   'まだ許され中', '土曜逃げ切り'],
      hiyori:  ['やさしく確認中', '生活立て直し中', 'そっと通過中', '日曜逃げ切り'],
    },
  };

  // 試練ポイント表（火種ランク×通常/一発・§10.2）。[通常, 一発]。回収型は別で +1固定。
  var NIGEKIRE_POINT_TABLE = {
    light:  [1, 2],
    medium: [2, 3],
    heavy:  [3, 4],
  };

  // 最終確認カットインのシステム文（正史 §9・7人分そのまま）。charKey → 中央の一文。
  //   演出は「出かけようとしたところで曜日キャラが逃げ道をふさいでいる」。戦闘語彙・絵文字は使わない。
  var NIGEKIRE_CUTIN_LINES = {
    tsukiko: '〈月子〉が玄関で待っている。',
    you:     '〈陽〉が笑顔で先回りしている。',
    shizuku: '〈しずく〉が静かにこちらを見ている。',
    rinka:   '〈凛華〉が何も言わずに立っている。',
    runa:    '〈るな〉が逃げ道をふさいでいる。',
    mahiru:  '〈まひる〉が眠そうに待っている。',
    hiyori:  '〈日和〉がやさしく待っている。',
  };

  // カットイン専用画像（charKey → 画像パス）。当面は各キャラの生活カード画像（ch.img）と同値。
  //   ※専用カットイン画像は後日はしゃもさんから受け取る。差し替えはこの定数の値を変えるだけで済む
  //     （openNigekireFinalCutin は必ずこの定数から src を引く。1箇所修正で全体に反映される）。
  // 最終確認カットイン専用画像（§9・縦長全身の暗転ポーズ）。生活カード（正方形バストアップ）とは別。
  var NIGEKIRE_CUTIN_IMG = NIGEKIRE_CHARACTERS.reduce(function (map, ch) {
    map[ch.key] = 'assets/ohakano/cutin/' + ch.key + '.webp';
    return map;
  }, {});

  // 最終確認画面の通過セリフ 42本（7人×6回・answer-oshi-select-CONFIRMED.md からそのまま）。
  //   キー = <charKey>_<回>。回 1〜3＝初期試練の最終確認①②③、4〜6＝収集の節目（70/120/200）。
  //   引くときは L.nigekireOshiPassLineKey(charKey, passIndex)。
  //   ※鉤括弧「」はセリフに含まれている（表示側で付与しない）。
  var NIGEKIRE_PASS_LINES = {
    tsukiko_1: '「ひとつ通ったわね。けれど、逃げようとした事実は記録しておくわ」',
    tsukiko_2: '「二つ目。言い訳の筋は通ったけれど、態度まで通ったとは言っていないわよ」',
    tsukiko_3: '「三つ通過。生活防衛中ね。……次に逃げたら、最初から聞き直すわ」',
    tsukiko_4: '「火種に気づいたなら、見なかったふりは通らないわ。そこは分かっているわね」',
    tsukiko_5: '「続けている点は認めるわ。ただし、逃げ癖を残したままなら意味がないわよ」',
    tsukiko_6: '「管理できるところまでは来たわね。だからこそ、もう雑な言い逃れは許さないわ」',

    you_1: '「ひとつ通ったね！ でも逃げようとしたの、ぜんぶ見えてたからね？」',
    you_2: '「二つ目も通った！ だからさ、次は逃げる前にちゃんと止まりなってば！」',
    you_3: '「三つ通過！ 生活防衛中ってことにするけど、また逃げたらすぐ捕まえるから！」',
    you_4: '「火種、見えてきたじゃん！ じゃあもう、知らないふりはナシだよ！」',
    you_5: '「続いてるのは分かった！ でも、こそこそ逃げるのは絶対ダメだからね！」',
    you_6: '「ここまで来たなら分かるよね？ 次に逃げたら、全力で止めるから！」',

    shizuku_1: '「ひとつ通ったね。でも、逃げようとしたのは……ちゃんと分かってるよ」',
    shizuku_2: '「二つ目も通ったね。ごまかして通ろうとしたところも、見えてたよ」',
    shizuku_3: '「三つ通ったね。生活には戻してあげる。でも、黙って逃げるのはだめ」',
    shizuku_4: '「火種に気づいたなら、そっと隠さないで。そういうの、あとで痛くなるから」',
    shizuku_5: '「続けているのは分かるよ。でも、逃げようとする癖まで見逃すつもりはないよ」',
    shizuku_6: '「ここまで来たね。だから次に逃げそうになったら、もっと早く止めるから」',

    rinka_1: '「ひとつ通ったくらいで安心しないで。逃げようとしたの、見えてたから」',
    rinka_2: '「二つ目。少しはマシだけど、まだ言い逃れの匂いがするわね」',
    rinka_3: '「三つ通ったなら一応認める。……でも、逃げ癖まで許した覚えはないから」',
    rinka_4: '「火種を放置しなくなったのは進歩ね。別に褒めてないけど」',
    rinka_5: '「続けてるのは分かった。だけど、雑に逃げたらその場で止めるから」',
    rinka_6: '「ここまで来たなら分かってるでしょ。次に逃げたら、もう言い訳は聞かない」',

    runa_1: '「ひとつ通ったねっ！ でも逃げようとしたの、バレバレだからね！」',
    runa_2: '「二つ目いけたじゃん！ でも次は逃げる前に止まること！ 約束っ！」',
    runa_3: '「三つ通過っ！ 生活防衛中！ でも逃げたらすぐ追いかけるからね！」',
    runa_4: '「火種、見つけられるようになってきたねっ！ じゃあ放置は禁止！」',
    runa_5: '「ここまで続いてるのはいい感じ！ でも、こっそり逃げるのはナシっ！」',
    runa_6: '「管理人まで来たねっ！ ここまで来て逃げたら、全力で捕まえるから！」',

    mahiru_1: '「ひとつ通ったね。でも、逃げようとしてたのは見えてたよ」',
    mahiru_2: '「二つ目も通ったね。寝たふりみたいにごまかしても、分かるよ」',
    mahiru_3: '「三つ通ったなら、生活防衛中でいいよ。でも、置いていくのはだめ」',
    mahiru_4: '「火種、見つけたね。あとで困る前に、ちゃんと片づけようね」',
    mahiru_5: '「続いてるね。でも、疲れたふりで逃げるのはなしだよ」',
    mahiru_6: '「ここまで来たなら大丈夫そう。……でも逃げたら、起きて止めるからね」',

    hiyori_1: '「ひとつ通ったね。でも、行こうとしてたのは……ちゃんと見てたよ」',
    hiyori_2: '「二つ目も通ったね。逃げる前に、ちゃんとこちらを見てね」',
    hiyori_3: '「三つ通ったなら、生活に戻っていいよ。でも、黙って逃げるのはだめ」',
    hiyori_4: '「火種に気づいたね。見つけたのなら、隠して通ろうとしないでね」',
    hiyori_5: '「続けてきたことは見てるよ。だから、逃げようとする時も分かるからね」',
    hiyori_6: '「ここまで来たなら大丈夫。でも次に逃げたら、ちゃんと止めるからね」',
  };

  // 推し選択・キャラ変更セリフ 7本（answer-oshi-select-CONFIRMED.md からそのまま）。
  //   初回の推し選択時とキャラ変更時で同じセリフを使い回す。
  var NIGEKIRE_OSHI_SELECT_LINES = {
    tsukiko: '「私を選ぶのね。いいわ、逃げ癖から順に確認していくわよ」',
    you:     '「私だね！ じゃあ、逃げる前にちゃんと止めるからね！」',
    shizuku: '「私でいいんだね。逃げようとしても、ちゃんと気づくからね」',
    rinka:   '「私を選ぶんだ。……逃げたら見逃さないから、そのつもりでいて」',
    runa:    '「私の番だねっ！ 逃げてもすぐ追いつくから、覚悟してね！」',
    mahiru:  '「私でいくんだね。急がなくていいけど、逃げるのはだめだよ」',
    hiyori:  '「私を選んだんだね。大丈夫、逃げようとしたらちゃんと止めるからね」',
  };

  // charKey → NIGEKIRE_CHARACTERS の1件（見つからなければ null）。
  function nigekireCharByKey(charKey) {
    if (!charKey) return null;
    var hit = NIGEKIRE_CHARACTERS.filter(function (c) { return c.key === charKey; });
    return hit.length ? hit[0] : null;
  }

  // ── モード定義（静的データのみ。関数参照は演出 lines のみ許容）──
  //   MODE_DEFS はモードの静的定義だけを持つ（state ではない）。値は全て既存
  //   KITACORE_* 定数・kitacore*Lines 関数を参照し二重定義しない（rankAfter 突き合わせズレ防止）。
  //   lines の関数は宣言（巻き上げ済み）なので、後方に定義されていても参照できる。
  var MODE_DEFS = {
    kitacore: {
      key: 'kitacore',
      targetCreatorId: KITACORE_ID,        // modeForCreator が逆引き
      challengeType: 'choice_judgement',   // 既存クイズ=正誤判定型
      goal: KITACORE_GOAL,                 // 進捗バー最大
      ranks: KITACORE_RANKS,               // 覚醒後ランク閾値テーブル
      postBosses: KITACORE_POST_BOSSES,    // 覚醒後ボス（ワイ閾値で出現）
      preBosses: KITACORE_PRE_BOSSES,      // 覚醒前ボス（鍵消費で挑戦）
      awakenBossKey: 'wing',               // 覚醒を起こすボス key。null なら覚醒概念なし
      quizUrl: 'kitacore_quiz.json',       // fetch 先。null ならクイズ無し
      lines: {
        wake:   kitacoreWakeLines,         // モード発動メッセージ
        sleep:  kitacoreSleepLines,        // モード終了メッセージ
        enter:  kitacoreBossEnterLines,    // ボス登場（boss を受ける）
        down:   kitacoreBossDownLines,     // ボス撃破（boss を受ける）
        awaken: kitacoreAwakenLines,       // 覚醒（awakenBossKey 撃破時）
      },
    },
    // ── ニゲキレモード（フェーズ1配線）──
    //   boss/rank/覚醒 概念は無い。7人同時進行＋キャラ別ポイント蓄積。
    //   characters/lifeRanks/charTitleTable/pointTable は上の定数を参照（二重定義しない）。
    nigekire: {
      key: 'nigekire',
      targetCreatorId: NIGEKIRE_ID,        // 'hasyamo'（modeForCreator が逆引き）
      challengeType: 'excuse_choice',      // 火種確認＋4択言い訳＋キャラ反応
      quizUrl: 'nigekire_quiz.json',       // fetch 先（note_key → レコード）
      characters: NIGEKIRE_CHARACTERS,     // 曜日順固定 7人
      lifeRanks: NIGEKIRE_LIFE_RANKS,      // 生活ランク（総ポイント判定・§10.5）
      charTitleTable: NIGEKIRE_CHAR_TITLE_TABLE, // キャラ別称号（§10.6）
      pointTable: NIGEKIRE_POINT_TABLE,    // 試練ポイント表（§10.2）
      lines: {
        wake:       nigekireWakeLines,       // §16 初回解放
        sleep:      nigekireSleepLines,      // モード終了
        success:    nigekireSuccessLines,    // §17 成功（char を受ける）
        firstTry:   nigekireFirstTryLines,   // §18 一発成功（char を受ける）
        failure:    nigekireFailureLines,    // §19 失敗（char を受ける）
        rankUpdate: nigekireRankUpdateLines, // §20 生活ランク更新（rankName を受ける）
      },
    },
  };

  // このクリエイターが何らかのモード（キタコレ / ニゲキレ …）の発動対象か。
  //   実体は L.modeForCreator（MODE_DEFS の targetCreatorId 逆引き）。
  //   ※「キタコレ限定か」を問いたい箇所では activeModeKey(id) === 'kitacore' を使うこと。
  function isModeCreator(creatorId) {
    return L.modeForCreator(MODE_DEFS, creatorId) != null;
  }

  // キタコレモードON か（ダブルタップで立つ。表示全般の前提条件）。
  function isModeOn(creatorId) {
    return !!(mc().mode && mc().mode[creatorId]);
  }

  // 撃破済みボス key の配列。
  function defeatedBossesOf(creatorId) {
    var d = mc().defeatedBosses ? mc().defeatedBosses[creatorId] : null;
    return Array.isArray(d) ? d : [];
  }

  // S級覚醒済みか＝覚醒前の最終ボス(wing)を撃破済み。
  //   実体は logic.js（L.isPostAwakening）。覚醒ボス key は 'wing' 固定で渡す薄いラッパ。
  function isPostAwakening(creatorId) {
    return L.isPostAwakening(defeatedBossesOf(creatorId), 'wing');
  }

  // 鍵の数。
  function keysOf(creatorId) {
    var n = mc().keys ? mc().keys[creatorId] : 0;
    return typeof n === 'number' ? n : 0;
  }

  // 次に挑むべき覚醒前ボス（未撃破の先頭）。全撃破なら null。実体は logic.js。
  function nextPreBoss(creatorId) {
    return L.nextPreBoss(KITACORE_PRE_BOSSES, defeatedBossesOf(creatorId));
  }

  // ボスに挑戦する。鍵が足りれば消費して撃破＝昇格を確定し、戦闘演出を開始。
  // 戻り値: 挑戦できたら true。鍵不足なら false。
  function challengeBoss(creatorId, boss) {
    ensureMode('kitacore');
    // 判定＋次状態の計算は純関数（logic.js）。副作用はここに残す。
    var out = L.challengeBossOutcome(mc().keys, mc().defeatedBosses, creatorId, boss);
    if (!out.ok) return false; // 鍵不足
    mc().keys = out.nextKeys;
    mc().defeatedBosses = out.nextDefeated;
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
      //   覚醒ボス(awakenBossKey)撃破なら覚醒演出。値は 'wing' 固定なので挙動不変。
      var def = MODE_DEFS.kitacore;
      showSystemMessage(boss.key === def.awakenBossKey ? kitacoreAwakenLines() : kitacoreBossDownLines(boss));
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
  //   creatorId → modeKey を解決し、そのモードの state・def.lines で発動/終了する。
  //   キタコレは modeKey='kitacore' に解決され従来と同一経路を通る（挙動不変）。
  function toggleMode(creatorId) {
    var def = L.modeForCreator(MODE_DEFS, creatorId);
    if (!def) return;
    var modeKey = def.key;
    var m = ensureMode(modeKey);
    if (isModeOnFor(creatorId)) {
      // OFF
      delete m.mode[creatorId];
      saveState();
      renderCreatorCards();
      linesModeKey = modeKey;
      showSystemMessage(def.lines.sleep());
      linesModeKey = null;
      return;
    }
    // ON：プレイヤー未登録なら入力モーダル → 認証成功で activateMode。
    //   プレイヤー認証はモード横断で共有可だが、保存先は当該モードの state.player。
    if (!m.player || !m.player.id) {
      openPlayerInput(creatorId);
      return;
    }
    activateMode(creatorId);
  }

  // モードを実際にONにして発動メッセージを出す（プレイヤー登録済み前提）。
  function activateMode(creatorId) {
    var def = L.modeForCreator(MODE_DEFS, creatorId);
    if (!def) return;
    var m = ensureMode(def.key);
    m.mode[creatorId] = { at: new Date().toISOString() };
    saveState();
    renderCreatorCards();
    linesModeKey = def.key;
    showSystemMessage(def.lines.wake());
    linesModeKey = null;
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
      // 保存先は当該モードの state.player（キタコレなら modeStateFor→kitacore state＝mc() と同一）。
      var m = modeStateFor(creatorId) || ensureMode('kitacore');
      m.player = {
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
    // アクティブモードがニゲキレなら 7人カルーセルの詳細カードを描く（キタコレのボスカードは無改変）。
    var selectedCard = getSelectedCreator();
    if (selectedCard && activeModeKey(selectedCard.id) === 'nigekire' && isModeOnFor(selectedCard.id)) {
      renderNigekireCard();
      return;
    }
    var player = mc().player;
    if (!player) return;
    // 対象クリエイターは選択中クリエイターから modeForCreator で解決。
    //   ランクエリアはキタコレ発動対象でのみ表示されるため、現状は常に KITACORE_ID と一致（挙動不変）。
    var selected = getSelectedCreator();
    var def = selected ? L.modeForCreator(MODE_DEFS, selected.id) : null;
    var creatorId = def ? def.targetCreatorId : KITACORE_ID;
    var rankInfo = isPostAwakening(creatorId) ? kitacoreRankOf(creatorId) : null;
    var rankLabel = rankInfo
      ? 'ワイ語ハンターランク ' + rankInfo.rank
      : (nextPreBoss(creatorId) ? 'ワイ語ハンターランク ' + nextPreBoss(creatorId).rankBefore : '---');
    var totalWai = mc().totalWai || 0;
    var quizTaps = mc().quizTaps || 0;
    var quizCleared = mc().quizCleared ? Object.keys(mc().quizCleared).length : 0;
    var keysCount = keysOf(creatorId);

    var el = els.kitacoreRankCardContent;
    el.innerHTML = '';
    el.classList.remove('nigekire-card'); // ニゲキレ描画の残りクラスを落とす（キタコレ表示は無改変）
    if (el.parentNode && el.parentNode.classList) el.parentNode.classList.remove('is-nigekire');

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

  // ニゲキレ：詳細カード（上部サマリ＋7人の一覧）。#kitacore-rank-card を流用し中身だけ差し替える。
  //   上部: 生活ランク・総ニゲキレ成功数・一発ニゲキレ数。
  //   下部: 7人カルーセル（曜日順固定・左右ボタンで1人ずつ）。各キャラは
  //         画像(assets/ohakano/<img>・無ければプレースホルダ)・曜日｜キャラ名(色強調)・
  //         ポイント・進行(段階/4)・キャラ別称号。
  //   語彙: 生活ランク/確認/通過/到達。禁止語彙(撃破/討伐/覚醒/ボス/好感度/勝利)は使わない。
  function renderNigekireCard() {
    var el = els.kitacoreRankCardContent;
    el.innerHTML = '';
    el.classList.add('nigekire-card');
    // 窓側にも印を付ける（7人一覧を画面内に収めてスクロールさせるため・CSS で使う）。
    if (el.parentNode && el.parentNode.classList) el.parentNode.classList.add('is-nigekire');

    var m = ensureMode('nigekire');
    // v2：ランクは通過ベース（rankStage・§10-2）。収集数は次の節目トリガーで、ランク名は決めない。
    //   キャラ別カードは charCounts で育つ（収集数は各キャラの明細行に出す）。
    var counts = m.charCounts && typeof m.charCounts === 'object' ? m.charCounts : {};
    var life = L.nigekireRankByStage(m.rankStage, NIGEKIRE_LIFE_RANKS);
    var totalSuccess = typeof m.totalSuccess === 'number' ? m.totalSuccess : 0;
    var firstTry = typeof m.firstTrySuccess === 'number' ? m.firstTrySuccess : 0;

    // 上部：プロフィール（アイコン＋表示名＋@ID）。キタコレのランクカードと同じ構成にする。
    var player = mc().player;
    if (player) {
      var playerRow = document.createElement('div');
      playerRow.className = 'rank-card-player';
      var avatar = document.createElement('div');
      avatar.className = 'add-preview-avatar rank-card-avatar';
      if (player.iconUrl) {
        var pimg = document.createElement('img');
        pimg.src = player.iconUrl;
        pimg.alt = '';
        pimg.addEventListener('error', function () {
          if (pimg.parentNode) avatar.removeChild(pimg);
          avatar.textContent = (player.displayName || player.id).charAt(0);
        });
        avatar.appendChild(pimg);
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
    }

    // 上部サマリ（生活ランク・総ニゲキレ成功=逃げ切り数・一発・キャラ名収集数）。§12。
    //   ランクはキタコレと同じくバッジ（.kitacore-rank-text rank-XX）で出す。
    var summary = document.createElement('div');
    summary.className = 'nigekire-card-summary';
    var rankRow = document.createElement('div');
    rankRow.className = 'rank-card-row';
    rankRow.innerHTML =
      '<span class="rank-card-label">ランク</span>' +
      '<span class="kitacore-rank-text rank-' + escapeHtml(life.key || 'nige1') + '">' +
      escapeHtml(L.nigekireRankTitleWithDays(L.nigekireRankLabel(life) || '---', m.oshiCleared, NIGEKIRE_CHARACTERS)) +
      '</span>';
    summary.appendChild(rankRow);
    var succRow = document.createElement('div');
    succRow.className = 'rank-card-row';
    succRow.innerHTML =
      '<span class="rank-card-label">総ニゲキレ成功</span>' +
      '<span class="rank-card-value">' + totalSuccess + '</span>';
    summary.appendChild(succRow);
    var ftRow = document.createElement('div');
    ftRow.className = 'rank-card-row';
    ftRow.innerHTML =
      '<span class="rank-card-label">一発ニゲキレ</span>' +
      '<span class="rank-card-value">' + firstTry + '</span>';
    summary.appendChild(ftRow);
    // キャラ名収集数はサマリに出さない（各キャラの明細行に「N 収集」として出る）。
    el.appendChild(summary);

    // 7人の一覧（縦スクロール）。カルーセルは一覧性が落ちるので廃止した。
    //   各行は「左にキャラ画像・右にステータス」の横並び（nigekireCharCardEl）。
    var list = document.createElement('div');
    list.className = 'nigekire-char-list';
    NIGEKIRE_CHARACTERS.forEach(function (ch) {
      list.appendChild(nigekireCharCardEl(ch, counts));
    });
    el.appendChild(list);

    els.kitacoreRankCard.classList.remove('hidden');
  }

  // ニゲキレ：カルーセル1枚分（1キャラ）の DOM を組む（v2・生活カード4段階）。
  //   counts = charCounts（キャラ別収集数）。段階は L.nigekireCardStage で4段階。
  //     未観測(0):画像グレー・「未観測」／観測(1+):カラー・収集数・称号／
  //     定着(5+):枠キャラ色・称号／中核(10+):バッジ。
  //   画像は assets/ohakano/<img>。読めなければ頭文字プレースホルダ（キタコレの ? fallback 同方式）。
  function nigekireCharCardEl(ch, counts) {
    var cnt = counts && typeof counts[ch.key] === 'number' ? counts[ch.key] : 0;
    var stageInfo = L.nigekireCardStage(cnt); // { stage:1..4, name:'未観測'|'観測'|'定着'|'中核' }
    var title = L.nigekireCharTitle(counts, ch.key, NIGEKIRE_CHAR_TITLE_TABLE);
    // イラスト解放は「3回通過（oshiCleared 入り）」で決まる（収集数ではない）。
    //   未通過は影（グレー）＝コンプは7人ぶん通過すること。
    var nm = ensureMode('nigekire');
    var unobserved = nm.oshiCleared.indexOf(ch.key) < 0;
    var focus = stageInfo.stage >= 3;      // 定着(5+)以上＝枠をキャラ色に（段階は文字にしない）

    var card = document.createElement('div');
    card.className = 'nigekire-char-card is-stage-' + stageInfo.stage +
      (unobserved ? ' is-unobserved' : '');
    // 定着(5+)以上でカード枠をキャラ色に（観測まではデフォルト枠）。
    if (focus && ch.color) card.style.borderColor = ch.color;

    // 画像（無ければ頭文字プレースホルダ）。未観測はグレースケール（CSS .is-unobserved）。
    var thumb = document.createElement('div');
    thumb.className = 'nigekire-char-thumb';
    if (!unobserved && ch.color) thumb.style.background = ch.color + '22'; // 観測以降のみ薄いキャラカラー背景
    var img = document.createElement('img');
    img.src = 'assets/ohakano/' + ch.img;
    img.alt = ch.name;
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.removeChild(img);
      var ph = document.createElement('span');
      ph.className = 'nigekire-char-thumb-fallback';
      ph.textContent = ch.name.charAt(0);
      if (ch.color) ph.style.color = ch.color;
      thumb.appendChild(ph);
    });
    thumb.appendChild(img);
    card.appendChild(thumb);

    // 右側：ステータス（名前・称号・収集数）をまとめる。行は「左に画像・右に情報」。
    var info = document.createElement('div');
    info.className = 'nigekire-char-info';

    // 曜日｜キャラ名（キャラカラー強調・未通過はグレー）。
    //   段階（未観測/観測/定着/中核）は文字で出さない＝カード枠の色と画像の解放で表す。
    var nameEl = document.createElement('div');
    nameEl.className = 'nigekire-char-name';
    nameEl.textContent = ch.label + '｜' + ch.name;
    // 色は CSS 側で --char-color に白を混ぜて出す（月子のネイビー等が暗背景に沈むため）。
    if (!unobserved && ch.color) nameEl.style.setProperty('--char-color', ch.color);
    info.appendChild(nameEl);

    // キャラ別称号（ラベル＋値）。未通過は「未観測」。
    var titleRow = document.createElement('div');
    titleRow.className = 'nigekire-char-row';
    var titleLabel = document.createElement('span');
    titleLabel.className = 'nigekire-char-label';
    titleLabel.textContent = '称号';
    var titleEl = document.createElement('span');
    titleEl.className = 'nigekire-char-title';
    titleEl.textContent = unobserved ? '未観測' : (title.name || '---');
    titleRow.appendChild(titleLabel);
    titleRow.appendChild(titleEl);
    info.appendChild(titleRow);

    // 収集数（ラベル＋値）。
    var statRow = document.createElement('div');
    statRow.className = 'nigekire-char-row';
    var cntLabel = document.createElement('span');
    cntLabel.className = 'nigekire-char-label';
    cntLabel.textContent = '収集';
    var cntEl = document.createElement('span');
    cntEl.className = 'nigekire-char-points';
    cntEl.textContent = cnt;
    statRow.appendChild(cntLabel);
    statRow.appendChild(cntEl);
    info.appendChild(statRow);

    // 衣装行（交換所・§4）。春夏秋冬で位置固定・取得済みだけ季節名・未取得は「-」。
    //   ボタンは常時表示（5pt以上でカラー／未満はグレー）。
    var outfitSeasons = L.nigekireUnlockedSeasons(nm.outfitUnlocks, ch.key);
    // 交換できるのは「姿が解放された（アイコンが活性化した）キャラ」だけ。
    //   ＝初期試練を3回通過して oshiCleared に入っているキャラ（unobserved の裏）。
    //   ポイントが足りていても、未観測のキャラは交換できない。
    var canExchange = !unobserved &&
      L.nigekireOutfitAllowance(cnt, NIGEKIRE_OUTFIT_THRESHOLDS) > 0;

    var outfitRow = document.createElement('div');
    outfitRow.className = 'nigekire-char-row nigekire-outfit-row';
    var outfitLabel = document.createElement('span');
    outfitLabel.className = 'nigekire-char-label';
    outfitLabel.textContent = '衣装';
    var slots = document.createElement('span');
    slots.className = 'nigekire-outfit-slots';
    L.OUTFIT_SEASONS.forEach(function (season) {
      var slot = document.createElement('span');
      var has = outfitSeasons.indexOf(season) >= 0;
      slot.className = 'nigekire-outfit-slot' + (has ? ' is-has' : '');
      slot.textContent = has ? (NIGEKIRE_SEASON_META[season] || {}).name || season : '-';
      slots.appendChild(slot);
    });
    outfitRow.appendChild(outfitLabel);
    outfitRow.appendChild(slots);
    info.appendChild(outfitRow);

    // 交換所を開くボタン（文言は日本語で固定・§4）。
    var exBtn = document.createElement('button');
    exBtn.type = 'button';
    exBtn.className = 'nigekire-outfit-btn' + (canExchange ? '' : ' is-locked');
    exBtn.textContent = 'おへんじ帖の衣装';
    exBtn.addEventListener('click', function () {
      // 押せない理由を出す（無反応にしない）。姿が未解放のほうを先に案内する。
      if (unobserved) {
        showSystemMessage([
          '［ システム ］',
          '',
          '〈' + ch.name + '〉の姿がまだ見えていません。',
          '初期試練を通すと受け取れるようになります。',
        ]);
        return;
      }
      if (!canExchange) {
        var need = L.nigekireOutfitNextThreshold(cnt, NIGEKIRE_OUTFIT_THRESHOLDS);
        showSystemMessage([
          '［ システム ］',
          '',
          'まだ受け取れません。',
          need == null ? '' : 'あと' + (need - cnt) + 'pt で1着選べます。',
        ]);
        return;
      }
      openNigekireOutfit(ch.key);
    });
    info.appendChild(exBtn);

    card.appendChild(info);

    return card;
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
        // 読込時に一度だけ正規形へ変換する（choices=[{text,result,reaction}]）。
        // kitacore_quiz.json 自体は無改変。answer:index 形式は normalizeQuiz が内部変換。
        kitacoreQuizzes = L.normalizeQuizMap(data && data.quizzes ? data.quizzes : {});
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

  // ニゲキレのクイズデータ。起動時に一度だけ読み、メモリに保持する。
  //   キー = 記事URLのスラッグ(note_key)。値 = レコード（weekday/targetType/fireRank/
  //   question/choices[]/correctKey/promptLine/successLine/failureLine）。
  //   ※文言はコードに直書きせず JSON から読む（スキーマは差し替え前提）。フェーズ2で使う。
  var nigekireQuizzes = null;
  function loadNigekireQuizzes() {
    fetch('nigekire_quiz.json?v=' + APP_VERSION)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        // note_key → レコードのマップ。スキーマ変換はせずそのまま保持（フェーズ1は配線のみ）。
        nigekireQuizzes = data && data.quizzes && typeof data.quizzes === 'object' ? data.quizzes : {};
      })
      .catch(function () {
        nigekireQuizzes = {}; // 読めなくてもモード発動は動く
      })
      .then(function () {
        // ロード完了で初めて記事チップの判定ができる。初回描画はロード前に走るため、
        // ここで現在のルートを描き直してニゲキレチップを反映する（キタコレと同じレース対策）。
        renderRoute();
      });
  }

  // 記事に紐づくクイズ（無ければ null）。スラッグで引く。実体は logic.js。
  //   app 側は現在のクイズマップ（kitacoreQuizzes）を渡す薄いラッパ。
  function quizForArticle(article) {
    return L.quizForArticle(kitacoreQuizzes, article);
  }

  // ニゲキレ：記事に紐づくクイズレコード（無ければ null）。
  //   articleKeyFromUrl(article.url) で note_key を引き nigekireQuizzes から取る。
  //   nigekireQuizzes 未ロード（null）や該当なしは null。文言はコード直書きせず
  //   このレコード（question/choices/promptLine/successLine/failureLine 等）から読む。
  function nigekireQuizForArticle(article) {
    if (!nigekireQuizzes || typeof nigekireQuizzes !== 'object') return null;
    var key = L.articleKeyFromUrl(article && article.url);
    return key && nigekireQuizzes[key] ? nigekireQuizzes[key] : null;
  }

  // ニゲキレ：記事の担当キャラを解決する。
  //   優先: クイズレコードの weekday（正史データが持つ確定曜日）。
  //   フォールバック: article.publishedAt から weekdayOf で算出。
  //   該当キャラ無しは null。
  function nigekireCharForArticle(article, rec) {
    var wd = rec && rec.weekday ? rec.weekday : L.weekdayOf(article && article.publishedAt);
    return L.weekdayCharOf(wd, NIGEKIRE_CHARACTERS);
  }

  // クイズ正解済みか（記事ごと1回。鍵の二重獲得防止）。collected を流用せず専用に持つ。
  function isQuizCleared(creatorId, articleId) {
    var k = mc().quizCleared ? mc().quizCleared : null;
    return !!(k && k[articleId]);
  }

  // 鍵を1つ獲得（クイズ正解時）。記事ごと1回きり。
  function awardKey(creatorId, articleId) {
    ensureMode('kitacore');
    if (!mc().quizCleared) mc().quizCleared = {};
    // 判定＋次状態の計算は純関数（logic.js）。no-op なら何もしない。
    var out = L.awardKeyOutcome(mc().quizCleared, mc().keys, creatorId, articleId);
    if (!out) return; // 既に獲得済み
    mc().quizCleared = out.nextQuizCleared;
    mc().keys = out.nextKeys;
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
    // quiz は正規形（choices=[{text,result,reaction}]）。選択肢を毎回シャッフルして
    // シャッフル後の並びを activeQuiz に保持する（正解位置のランダム性を温存）。
    // 判定はシャッフル後 index に対して L.quizChoiceOutcome で行う。
    var items = shuffled(quiz.choices.slice());
    var shuffledQuiz = { q: quiz.q, choices: items };
    activeQuiz = { creatorId: creatorId, articleId: article.id, quiz: shuffledQuiz };
    // 共有モーダルのラベルをキタコレ用に設定（ニゲキレと同じ DOM を使い回すため毎回セット）。
    if (els.kitacoreQuizLabel) {
      els.kitacoreQuizLabel.textContent = '［ システム ］試練：正解で終焉の鍵を1つ得る';
    }

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
    // シャッフル後の並びに対して正誤判定する。'success' のみ正解扱い、
    // 'wrong'/'wrong_funny' は不正解（再挑戦可）。
    var outcome = L.quizChoiceOutcome(activeQuiz.quiz, idx);
    var correct = outcome === 'success';
    var btns = els.kitacoreQuizChoices.querySelectorAll('.kitacore-quiz-choice');
    btns[idx].classList.add(correct ? 'is-correct' : 'is-wrong');
    if (correct) {
      activeQuiz.answered = true; // 正解フラグ
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

  // ── ニゲキレ用システムメッセージ（正史 nigekire-mode-ui-spec.md §16-20 準拠）──
  //   文言はモード発動等のシステムメッセージ（クイズ文言ではない＝正史記載なので直書き可）。
  //   playerName() はモード横断で共有（認証プレイヤー）。
  //   showSystemMessage 側でタップ挙動を持つため「画面をタップ」フッターは付けない（キタコレと揃える）。

  // §16 初回解放（モード発動時）。
  function nigekireWakeLines() {
    return [
      '［ システム ］',
      'プレイヤー〈' + playerName() + '〉の過去記事に、',
      '複数の火種を検出しました。',
      '隠しモード『ニゲキレモード』が解放されました。',
      '曜日担当による確認を開始します。',
    ];
  }

  // モード終了時（キタコレのスリープに対応。§では未指定のため語彙に沿った締め）。
  function nigekireSleepLines() {
    return [
      '［ システム ］',
      '『ニゲキレモード』を終了します。',
      'プレイヤー〈' + playerName() + '〉、また確認しましょう。',
    ];
  }

  // §17 成功時（v2）。char = 担当キャラ { label, name }。
  //   v2：ポイント文言は廃止。試練成功＝その記事が「逃げ切り済み」になる（記事状態の変化）。
  function nigekireSuccessLines(char) {
    return [
      '［ システム ］',
      char.label + '担当〈' + char.name + '〉の確認を通過しました。',
      'この記事から逃げ切りました。',
    ];
  }

  // §17-1 一言チップ回収時（v2・収集モード）。char = 検出キャラ { name }。
  //   「確認を通過」ではなく「気配を見つけた／収集した」の語彙（収集は詰めではない）。
  //   ポイント文言は使わない。char が無い場合の防御込み。
  function nigekireCollectLines(char) {
    var label = char ? char.label + '担当〈' + char.name + '〉' : '担当キャラ';
    var name = char ? char.name : 'キャラ';
    return [
      '［ システム ］',
      label + 'の気配を見つけました。',
      name + 'の収集数が増えました。',
    ];
  }

  // §18 一発成功時。
  function nigekireFirstTryLines(char) {
    return [
      '［ システム ］',
      char.label + '担当〈' + char.name + '〉の確認を、',
      '一度で通過しました。',
      '一発ニゲキレ記録を更新しました。',
    ];
  }

  // §19 失敗時。
  function nigekireFailureLines(char) {
    return [
      '［ システム ］',
      char.label + '担当〈' + char.name + '〉は、',
      'その説明では納得しませんでした。',
      '別の説明を選んでください。',
    ];
  }

  // §20 生活ランク更新時。rankName = 到達した生活ランク名。
  function nigekireRankUpdateLines(rankName) {
    return [
      '［ システム ］',
      '生活ランクが更新されました。',
      'プレイヤー〈' + playerName() + '〉は、',
      '『' + rankName + '』に到達しました。',
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

  // ---------------------------------------------------------------------------
  // システム確認（Yes/No の選択式）。
  //   システムメッセージ（#kitacore-system）と同じ見た目のまま、タップで閉じる代わりに
  //   選択ボタンを出す汎用部品。用途は限定しない（推し選択に限らず使える）。
  //     lines   : 表示する行の配列（showSystemMessage と同じ形）
  //     choices : [{ label, onSelect?, primary?, danger? }, ...]（省略時は「はい」「やめる」）
  //   選択すると閉じてから onSelect を呼ぶ。背景タップでは閉じない（誤操作で流さない）。
  // ---------------------------------------------------------------------------
  function showSystemConfirm(lines, choices) {
    if (!els.systemConfirm || !els.systemConfirmText || !els.systemConfirmActions) return;
    var items = Array.isArray(choices) && choices.length
      ? choices
      : [{ label: 'はい', primary: true }, { label: 'やめる' }];

    els.systemConfirmText.textContent = (lines || []).join('\n');
    els.systemConfirmActions.innerHTML = '';

    items.forEach(function (it) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'system-confirm-btn' +
        (it.primary ? ' is-primary' : '') +
        (it.danger ? ' is-danger' : '');
      btn.textContent = it.label != null ? it.label : 'OK';
      btn.addEventListener('click', function () {
        closeSystemConfirm();
        if (typeof it.onSelect === 'function') it.onSelect();
      });
      els.systemConfirmActions.appendChild(btn);
    });

    els.systemConfirm.classList.remove('hidden');
  }

  function closeSystemConfirm() {
    if (els.systemConfirm) els.systemConfirm.classList.add('hidden');
    if (els.systemConfirmActions) els.systemConfirmActions.innerHTML = '';
  }

  // クリエイター別に覚える UI 項目のデフォルト。
  function defaultCreatorUi() {
    return {
      year: 'all',
      month: 'all',
      showUnreadOnly: false,
      showFavoritesOnly: false,
      sortOrder: 'asc',
    };
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
      showFavoritesOnly: cu.showFavoritesOnly,
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
        favorites: L.sanitizeFavorites(parsed.favorites),
        uiState: Object.assign({}, base.uiState, parsed.uiState || {}),
        uiByCreator:
          parsed.uiByCreator && typeof parsed.uiByCreator === 'object'
            ? parsed.uiByCreator
            : base.uiByCreator,
        // モード state。新 parsed.modes 優先・旧 parsed.kitacore は modes.kitacore
        //   未定義時のみ移送（migrateModes が冪等・非破壊）。この行を落とすと進行データが黙って消える。
        modes: L.migrateModes(parsed),
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
      favorites: L.sanitizeFavorites(incoming.favorites),
      uiState: Object.assign({}, base.uiState, incoming.uiState || {}),
      uiByCreator:
        incoming.uiByCreator && typeof incoming.uiByCreator === 'object'
          ? incoming.uiByCreator
          : base.uiByCreator,
      // モード state。incoming.modes 優先・旧 incoming.kitacore は modes.kitacore
      //   未定義時のみ移送（migrateModes が冪等・非破壊）。この行を落とすと進行データが黙って消える。
      modes: L.migrateModes(incoming),
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
  // お気に入り（⭐）
  //   キーは readKey と同じ "creatorId:articleId"。
  //   値は横断ビュー用のスナップショット（クリエイター未選択でも表示できるよう複製）。
  // ---------------------------------------------------------------------------

  function ensureFavorites() {
    if (!state.favorites || typeof state.favorites !== 'object') state.favorites = {};
    return state.favorites;
  }

  // 以下のお気に入りロジックは logic.js（L）に委譲。app.js 側は state の橋渡しだけ。
  function isFavorite(creatorId, articleId) {
    return L.isFavorite(ensureFavorites(), creatorId, articleId);
  }

  // お気に入りの ON/OFF を切り替える。article は記事オブジェクト（スナップショット元）。
  function toggleFavorite(creatorId, article) {
    var favs = ensureFavorites();
    var key = L.entryKey(creatorId, article.id);
    if (favs[key]) {
      delete favs[key];
    } else {
      favs[key] = L.makeFavoriteEntry(creatorId, article, new Date().toISOString());
    }
  }

  function favoriteCount() {
    return L.favoriteCount(ensureFavorites());
  }

  // お気に入りを「追加した新しい順」で配列に。横断ビューの初期並び。
  function favoritesSorted() {
    return L.favoritesSorted(ensureFavorites());
  }

  // ---------------------------------------------------------------------------
  // キタコレ：ワイ語の収集とポイント回収
  //   収集 = 記事タップ時に本文を取り「ワイ」を数えて counts に保存（点はまだ）。
  //   回収 = 記事行のチップをタップして counts[id].wai を totalWai に加算。
  //   本文HTMLは保存せず数だけ残す。記事ごと1回きり（collected で二重取り防止）。
  // ---------------------------------------------------------------------------

  // 収集中の article.id（多重発火防止）。
  var kitacoreInFlight = {};
  // ニゲキレ一言検出の取得中フラグ（キタコレとは別マップ＝混線させない）。
  var nigekireInFlight = {};

  // HTML からタグを除去し最低限の実体参照をデコードして素テキストにする。
  //   実体は logic.js（L.stripHtml）。呼び出し側は無変更。
  function stripHtml(html) {
    return L.stripHtml(html);
  }

  // テキスト中の「ワイ」出現数。実体は logic.js（L.countWai）。
  function countWai(text) {
    return L.countWai(text);
  }

  // 記事 URL からスラッグ（note key）を抜く。失敗時 null。実体は logic.js。
  function articleKeyFromUrl(url) {
    return L.articleKeyFromUrl(url);
  }

  function isCounted(articleId) {
    return !!(mc().counts && mc().counts[articleId]);
  }

  function isCollected(articleId) {
    return !!(mc().collected && mc().collected[articleId]);
  }

  // 記事 1 本の本文を取り、ワイ数を数えて counts に保存する（＝収集）。
  // 計測済み/計測中/key抽出失敗/body不正 はスキップ。await されない想定で呼ぶ。
  function fetchAndCountArticle(article, creatorId) {
    if (!article || !article.id) return;
    if (isCounted(article.id) || kitacoreInFlight[article.id]) return;
    var key = articleKeyFromUrl(article.url);
    if (!key) return; // スラッグ抽出失敗はスキップ
    ensureMode('kitacore');
    kitacoreInFlight[article.id] = true;
    var url = PROXY_URL + '?path=' + encodeURIComponent('/api/v3/notes/' + key);
    fetch(url)
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        var body = json && json.data ? json.data.body : null;
        if (typeof body !== 'string') return; // 形式不正は未計測のまま握りつぶす
        ensureMode('kitacore');
        mc().counts[article.id] = {
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

  // ニゲキレ v2：記事本文を取り「◯◯の一言」見出しから一言キャラを検出して counts に保存。
  //   キタコレの fetchAndCountArticle と同方式（プロキシで本文取得→実行時判定）だが、
  //   別 state（nigekire.counts）・別 in-flight（nigekireInFlight）で完全に分離する。
  //   検出済み/取得中/key抽出失敗/body不正/一言なし（ホワイトリスト外）はスキップ。
  //   ※detect は生 HTML の <h2> を見るので stripHtml しない（生 body を渡す）。
  function fetchAndDetectNigekireChar(article, creatorId) {
    if (!article || !article.id) return;
    var nm = ensureMode('nigekire');
    if ((nm.counts && nm.counts[article.id]) || nigekireInFlight[article.id]) return;
    var key = articleKeyFromUrl(article.url);
    if (!key) return; // スラッグ抽出失敗はスキップ
    nigekireInFlight[article.id] = true;
    var url = PROXY_URL + '?path=' + encodeURIComponent('/api/v3/notes/' + key);
    fetch(url)
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        var body = json && json.data ? json.data.body : null;
        if (typeof body !== 'string') return; // 形式不正は未検出のまま握りつぶす
        // 本文中の「◯◯の一言」を全部拾い、7人に該当するキャラを配列で得る。
        //   1記事に複数キャラ（「日和の一言」「しずくの一言」）があれば全員ぶんチップを出す。
        var chars = L.detectHitokotoChars(body, NIGEKIRE_NAME_TO_KEY);
        if (!chars.length) return; // 一言見出しなし / 7人ホワイトリスト外（例「KITAさん」）は収集対象外
        var m = ensureMode('nigekire');
        m.counts[article.id] = { chars: chars };
        saveState();
        // ニゲキレ表示中なら該当クリエイターの一覧を作り直して一言チップを出す。
        if (currentRoute() === 'read' && state.selectedCreatorId === creatorId) {
          renderArticles();
        }
      })
      .catch(function () {
        /* ネットワーク失敗等は未検出のまま（次タップで再試行） */
      })
      .then(function () {
        delete nigekireInFlight[article.id];
      });
  }

  // ワイ語チップを回収する（＝ポイント加算）。
  // 収集済み・未回収・ワイ>0 のときだけ totalWai に加算し collected を立てる。
  function collectWai(articleId) {
    ensureMode('kitacore');
    // 判定＋加算後 totalWai＋出現すべきボス key の計算は純関数（logic.js）。
    var out = L.collectWaiOutcome(
      KITACORE_RANKS, KITACORE_POST_BOSSES, mc().counts, mc().collected, mc().totalWai, articleId
    );
    if (!out.ok) return; // 未収集 / 二重取り / ワイ0
    mc().totalWai = out.nextTotalWai;
    mc().collected = out.nextCollected;
    saveState();
    // ワイ閾値を超えたら覚醒後ボスを出現させる（ランク表示はボス撃破まで据え置き）
    if (out.summonBossKey) {
      var boss = KITACORE_POST_BOSSES.find(function (b) { return b.key === out.summonBossKey; });
      if (boss) showPostBoss(boss);
    }
  }

  // 覚醒後ボスカードを表示する（挑戦待ち状態にセット）。
  function showPostBoss(boss) {
    ensureMode('kitacore');
    if (!mc().pendingPostBoss) mc().pendingPostBoss = {};
    // 順序ガードの判定は純関数（logic.js）。null なら出さない。
    var summon = L.canSummonPostBoss(
      KITACORE_POST_BOSSES, defeatedBossesOf(KITACORE_ID), mc().pendingPostBoss[KITACORE_ID], boss.key
    );
    if (summon == null) return;
    mc().pendingPostBoss[KITACORE_ID] = summon;
    saveState();
    renderKitacoreHeader();
  }

  // 覚醒後の挑戦待ちボスを取得（pendingPostBoss から）。
  function pendingPostBossOf(creatorId) {
    var k = mc().pendingPostBoss ? mc().pendingPostBoss[creatorId] : null;
    if (!k) return null;
    var defeated = defeatedBossesOf(creatorId);
    if (defeated.indexOf(k) !== -1) return null; // 撃破済みなら消す
    return KITACORE_POST_BOSSES.find(function (b) { return b.key === k; }) || null;
  }

  // ===========================================================================
  // ニゲキレ コアループ（v2）。試練の逃げ切りと一言チップ収集が入る部分。
  //   DOM は #kitacore-quiz（試練モーダル）/ #kitacore-system（メッセージ）を流用。
  //   キタコレの openQuiz/answerQuiz/awardKey/collectWai は無改変。ニゲキレ専用の
  //   openNigekireTrial/answerNigekire/nigekireCollect を新設する（挙動を混ぜない）。
  //   語彙: 確認/通過/火種/生活ランク/更新/到達。禁止: 撃破/討伐/覚醒/ボス/好感度/勝利。
  // ===========================================================================

  // 進行中のニゲキレ試練の文脈（キタコレの activeQuiz とは別変数＝混線しない）。
  //   { creatorId, articleId, char, rec, choices, fireRank, wrongCount, done }
  //   choices = シャッフル後の4択（各 { text, isCorrect }）。
  //   wrongCount = このモーダルで失敗した回数（0のまま成功＝一発）。
  var activeNigekireTrial = null;

  // 最終確認カットイン／最終確認画面で扱っている曜日キャラ key（タップ遷移の受け渡し用）。
  var activeNigekireFinalChar = null;


  // 試練モーダルを開く（ニゲキレ・モードON・試練型記事のとき）。
  //   促し文（promptLine）を上部に、4択（choices）をシャッフルして並べる。
  //   選択は answerNigekire(idx) へ。キタコレの openQuiz とは別実装（DOM だけ共有）。
  function openNigekireTrial(article) {
    if (!els.kitacoreQuiz) return;
    var rec = nigekireQuizForArticle(article);
    if (!rec) return;
    var char = nigekireCharForArticle(article, rec);
    if (!char) return;
    // 既に通過済みなら開かない（二重取り防止＝チップ側で非活性のはずだが二重防御）。
    var m = ensureMode('nigekire');
    if (m.passed && m.passed[article.id]) return;

    // choices を正規化（{ text, isCorrect }）してシャッフル。正解位置のランダム性を温存。
    var rawChoices = Array.isArray(rec.choices) ? rec.choices : [];
    var norm = rawChoices.map(function (c) {
      return { text: c && c.text != null ? c.text : '', isCorrect: !!(c && c.isCorrect) };
    });
    var items = shuffled(norm.slice());

    activeNigekireTrial = {
      creatorId: NIGEKIRE_ID,
      articleId: article.id,
      char: char,
      rec: rec,
      choices: items,
      fireRank: rec.fireRank,
      wrongCount: 0,
      done: false,
    };

    // 共有モーダルのラベルをニゲキレ用に設定（キタコレの「終焉の鍵」文言を上書き）。
    //   語彙は §15 準拠（確認・通過・曜日担当）。鍵の概念はニゲキレに無いので使わない。
    if (els.kitacoreQuizLabel) {
      els.kitacoreQuizLabel.textContent =
        '［ システム ］' + char.label + '担当〈' + char.name + '〉の確認';
    }

    // 上部: 火種確認セリフ（promptLine）＋設問（question）。文言は rec から読む。
    //   promptLine を上、question を下に2段で見せる（共有 CSS が white-space:pre-line で
    //   ない場合に備え、textContent ではなく行要素を組んで確実に改行する）。
    var prompt = rec.promptLine != null ? rec.promptLine : '';
    var question = rec.question != null ? rec.question : '';
    els.kitacoreQuizQ.innerHTML = '';
    if (prompt) {
      var pEl = document.createElement('span');
      pEl.className = 'nigekire-prompt-line';
      pEl.textContent = prompt;
      pEl.style.display = 'block';
      pEl.style.marginBottom = '8px';
      els.kitacoreQuizQ.appendChild(pEl);
    }
    var qEl = document.createElement('span');
    qEl.className = 'nigekire-question-line';
    qEl.textContent = question;
    qEl.style.display = 'block';
    els.kitacoreQuizQ.appendChild(qEl);
    els.kitacoreQuizResult.classList.add('hidden');
    els.kitacoreQuizResult.textContent = '';
    els.kitacoreQuizChoices.innerHTML = '';
    items.forEach(function (it, idx) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kitacore-quiz-choice';
      btn.textContent = it.text;
      btn.addEventListener('click', function () {
        answerNigekire(idx);
      });
      els.kitacoreQuizChoices.appendChild(btn);
    });
    els.kitacoreQuiz.classList.remove('hidden');
    // 演出はキタコレのクイズと同じグリッチを流用（DOM 共有のため）。
    var win = els.kitacoreQuiz.querySelector('.kitacore-quiz-window');
    els.kitacoreQuiz.classList.remove('is-glitch');
    if (win) win.classList.remove('is-glitch');
    void els.kitacoreQuiz.offsetWidth;
    els.kitacoreQuiz.classList.add('is-glitch');
    if (win) win.classList.add('is-glitch');
  }

  // ニゲキレ試練の選択に答える。
  //   isCorrect → 通過（逃げ切り）: passed 記録・総ニゲキレ成功・一発判定（収集数と別軸・ポイントなし）。
  //   それ以外 → 失敗: failureLine を反応表示し再挑戦可（wrongCount++）。
  //   一発判定 = このモーダルで失敗を挟まず（wrongCount===0）1回目の選択で通過。
  function answerNigekire(idx) {
    var t = activeNigekireTrial;
    if (!t || t.done) return;
    var choice = t.choices[idx];
    var correct = !!(choice && choice.isCorrect);
    var btns = els.kitacoreQuizChoices.querySelectorAll('.kitacore-quiz-choice');
    if (btns[idx]) btns[idx].classList.add(correct ? 'is-correct' : 'is-wrong');

    if (!correct) {
      // 失敗＝再挑戦可。失敗を1回でも挟むと一発ではなくなる。
      t.wrongCount += 1;
      els.kitacoreQuizResult.textContent =
        t.rec && t.rec.failureLine != null && t.rec.failureLine !== ''
          ? t.rec.failureLine
          : 'その説明では納得しませんでした。別の説明を選んでください。';
      els.kitacoreQuizResult.classList.remove('hidden');
      return;
    }

    // 通過（成功）。二度目以降の発火を止める。
    t.done = true;
    btns.forEach(function (b) { b.disabled = true; });
    var isFirstTry = t.wrongCount === 0;

    // 逃げ切り（試練通過）判定は純関数（logic.js・v2）。試練は収集数と別軸＝ポイントなし。
    //   passed 記録・総ニゲキレ成功・一発成功のみ更新する。生活ランクは収集数で動くので
    //   試練成功では変わらない（ランク更新メッセージは出さない）。
    var m = ensureMode('nigekire');
    var out = L.nigekireTrialV2(m.passed, m.totalSuccess, m.firstTrySuccess, t.articleId, isFirstTry);

    // 反応表示（successLine）。二重取り（既通過）でも文言は出す。
    els.kitacoreQuizResult.textContent =
      t.rec && t.rec.successLine != null && t.rec.successLine !== ''
        ? t.rec.successLine
        : t.char.name + 'の確認を通過しました。';
    els.kitacoreQuizResult.classList.remove('hidden');

    if (!out.ok) return; // 二重取り防止（既に通過済み）→ 加算なし

    m.passed = out.nextPassed;
    m.totalSuccess = out.nextTotalSuccess;
    m.firstTrySuccess = out.nextFirstTrySuccess;
    // 逃げ切き記録はキャラ別に積む（試練は推しの曜日にしか出ないので t.char.key = 推し）。
    //   キャラ別に持つので、推しを変えて戻ってきても記録が消えない。
    if (t.char && t.char.key) {
      var prev = typeof m.escapeCounts[t.char.key] === 'number' ? m.escapeCounts[t.char.key] : 0;
      m.escapeCounts[t.char.key] = prev + 1;
    }
    saveState();

    // 記事チップ（逃げ切り済み表示）とヘッダーへ反映（クイズモーダルは別レイヤーで残る）。
    renderArticles();
    updateReadStatsHeader();
    // successLine はクイズ画面内（kitacoreQuizResult）に上で出している。キタコレの
    //   answerQuiz と揃え、別レイヤーのシステムメッセージ（showNigekireSuccessMessage）は
    //   出さない＝二重表示にしない。閉じるまで正解の緑ハイライトが見える。
  }

  // ニゲキレ試練モーダルを閉じる（DOM 共有のため hidden 付与＋文脈クリア）。
  function closeNigekireTrial() {
    activeNigekireTrial = null;
    if (els.kitacoreQuiz) els.kitacoreQuiz.classList.add('hidden');
  }

  // 今 節目が出ているか（1箇所に集約・見出し／カットイン／最終確認／通過／DEBUG で共用）。
  //   -> { ready, kind:'escape'|'point'|'done', need, passIndex }
  //   閾値は選択中キャラ単位（逃げ切き 3/6/9 → ポイント 5/10/15・計6回）。
  function nigekireReadyOut(m) {
    return L.nigekireOshiMilestone(
      m.escapeCounts, m.charCounts, m.oshiPassCounts, m.oshiChar, NIGEKIRE_THRESHOLDS
    );
  }

  // ---------------------------------------------------------------------------
  // 推し選択（7人から1人）。初回（oshiChar が null）とキャラ変更（rankStage>=3）で共用。
  //   選択で oshiChar を確定し、NIGEKIRE_OSHI_SELECT_LINES をシステムメッセージで出す。
  // ---------------------------------------------------------------------------

  // モーダルを開く。isChange=true でキャラ変更（やめるボタンを出す・初回は閉じられない）。
  function openNigekireOshiSelect(isChange) {
    if (!els.nigekireOshi || !els.nigekireOshiGrid) return;
    var m = ensureMode('nigekire');

    if (els.nigekireOshiTitle) {
      els.nigekireOshiTitle.textContent = isChange ? '推しを変える' : '推しを選ぶ';
    }
    if (els.nigekireOshiNote) {
      els.nigekireOshiNote.textContent = isChange
        ? '選び直すと、新しい曜日の記事に試練が出るようになります。'
        : '1人選んでください。選んだ相手の曜日の記事にだけ試練が出ます。';
    }
    if (els.nigekireOshiCancel) {
      els.nigekireOshiCancel.classList.toggle('hidden', !isChange);
    }

    els.nigekireOshiGrid.innerHTML = '';
    NIGEKIRE_CHARACTERS.forEach(function (ch) {
      var isCurrent = m.oshiChar === ch.key;
      var isCleared = m.oshiCleared.indexOf(ch.key) >= 0;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nigekire-oshi-item' +
        (isCurrent ? ' is-current' : '') +
        (isCleared ? ' is-cleared' : '');
      if (ch.color) btn.style.setProperty('--char-color', ch.color);

      // 画像は通常の立ち絵（生活カードと同じ assets/ohakano/<img>・正方形バストアップ）。
      //   カットイン用の縦長全身は演出専用なので、一覧では使わない。
      var thumb = document.createElement('div');
      thumb.className = 'nigekire-oshi-thumb';
      var img = document.createElement('img');
      img.src = 'assets/ohakano/' + ch.img;
      img.alt = ch.name;
      img.loading = 'lazy';
      thumb.appendChild(img);

      var nameEl = document.createElement('span');
      nameEl.className = 'nigekire-oshi-name';
      nameEl.textContent = ch.label + '｜' + ch.name;
      // 色は CSS 側で --char-color に白を混ぜて出す（inline 指定だと暗いキャラ色のまま沈む）。

      btn.appendChild(thumb);
      btn.appendChild(nameEl);

      // 通過済み（3回クリア）は印を出す。絵文字は使わない。
      if (isCleared) {
        var mark = document.createElement('span');
        mark.className = 'nigekire-oshi-mark';
        mark.textContent = '通過済み';
        btn.appendChild(mark);
      }

      btn.setAttribute('data-char', ch.key); // 確認バーの選択強調で引く
      btn.addEventListener('click', function () { pickNigekireOshi(ch.key); });
      els.nigekireOshiGrid.appendChild(btn);
    });

    els.nigekireOshi.classList.remove('hidden');
  }

  function closeNigekireOshiSelect() {
    if (els.nigekireOshi) els.nigekireOshi.classList.add('hidden');
  }

  // 推しカードをタップ → その場で確定せず、システム確認（Yes/No）を挟む。
  //   誤タップ防止＝キャラ変更は3回通過してやっと解禁される重い選択なので、必ず一度聞く。
  function pickNigekireOshi(charKey) {
    var ch = nigekireCharByKey(charKey);
    if (!ch) return;
    var m = ensureMode('nigekire');
    if (m.oshiChar === charKey) { closeNigekireOshiSelect(); return; } // 現在の推しなら何もしない
    var isChange = !!m.oshiChar;
    showSystemConfirm(
      [
        '［ システム ］',
        '',
        isChange
          ? ch.label + '担当〈' + ch.name + '〉に変えますか。'
          : ch.label + '担当〈' + ch.name + '〉を推しにしますか。',
        '',
        '試練は' + ch.label + 'の記事に出るようになります。',
      ],
      [
        { label: 'はい', primary: true, onSelect: function () { confirmNigekireOshi(charKey); } },
        { label: 'やめる' },
      ]
    );
  }

  // 推しを確定する（システム確認で「はい」を選んだとき）。
  function confirmNigekireOshi(charKey) {
    var ch = nigekireCharByKey(charKey);
    if (!ch) return;
    var m = ensureMode('nigekire');

    m.oshiChar = charKey;
    saveState();
    closeNigekireOshiSelect();

    // 記事一覧を再描画（試練チップの出る曜日が変わる）＋ヘッダー更新。
    renderRoute();
    updateReadStatsHeader();

    showSystemMessage([
      '［ システム ］',
      '',
      ch.label + '担当〈' + ch.name + '〉を選びました。',
      '',
      NIGEKIRE_OSHI_SELECT_LINES[charKey] || '',
    ]);
  }

  // ---------------------------------------------------------------------------
  // 交換所（おへんじ帖の季節衣装・nigekire-exchange-spec.md）
  //   ★ポイントは減らない（§2）。到達数で「何着選べるか」が決まる。
  //   ポイントの正本はローカル。交換ボタンを押したときだけ API を叩く（§7）。
  // ---------------------------------------------------------------------------

  // 交換所で今開いているキャラ。二度押しロックは inFlight で持つ（§4 通信の失敗時）。
  var outfitCharKey = null;
  var outfitInFlight = false;

  // ちび絵のパス。季節ごとにディレクトリが分かれる（chibi-summer/tsukiko.png）。
  function nigekireOutfitImgSrc(charKey, season) {
    var meta = NIGEKIRE_SEASON_META[season];
    if (!meta || !meta.dir) return '';
    return 'assets/ohakano/' + meta.dir + '/' + charKey + '.png';
  }

  // 解放済み一覧をサーバーから取り直してローカルへ反映（§7 キャッシュ）。
  //   失敗しても致命ではない（キャッシュで表示を続ける）。
  function refreshNigekireOutfitUnlocks() {
    var m = ensureMode('nigekire');
    var noteId = m.player && m.player.id ? m.player.id : '';
    if (!noteId) return Promise.resolve();
    return fetch(NIGEKIRE_OUTFIT_API + '/api/outfit/unlocks?noteId=' + encodeURIComponent(noteId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.outfits)) return;
        m.outfitUnlocks = data.outfits.map(function (o) {
          return {
            characterId: o.characterId,
            season: o.season,
            unlockedAt: typeof o.unlockedAt === 'string' ? o.unlockedAt : '',
          };
        });
        saveState();
      })
      .catch(function () { /* オフラインはキャッシュで続行（§7） */ });
  }

  // 交換画面を開く（§5・2列×2行）。
  function openNigekireOutfit(charKey) {
    if (!els.nigekireOutfit || !els.nigekireOutfitGrid) return;
    outfitCharKey = charKey;
    renderNigekireOutfit();
    els.nigekireOutfit.classList.remove('hidden');
    // 開いたあとに最新を取り直す（取れたら描き直す）。オフラインでも開ける。
    refreshNigekireOutfitUnlocks().then(function () {
      if (outfitCharKey === charKey) renderNigekireOutfit();
    });
  }

  function closeNigekireOutfit() {
    outfitCharKey = null;
    if (els.nigekireOutfit) els.nigekireOutfit.classList.add('hidden');
    // カード画面の衣装行を更新（交換後の `- 夏 - -` を反映）。
    renderNigekireCard();
  }

  // 交換画面の中身を描く。状態は logic の nigekireOutfitState に集約。
  function renderNigekireOutfit() {
    if (!outfitCharKey || !els.nigekireOutfitGrid) return;
    var m = ensureMode('nigekire');
    var ch = nigekireCharByKey(outfitCharKey);
    if (!ch) return;
    var cnt = typeof m.charCounts[ch.key] === 'number' ? m.charCounts[ch.key] : 0;
    var unlocked = L.nigekireUnlockedSeasons(m.outfitUnlocks, ch.key);
    var st = L.nigekireOutfitState(
      cnt, unlocked, NIGEKIRE_OUTFIT_AVAILABLE, NIGEKIRE_OUTFIT_THRESHOLDS
    );

    if (els.nigekireOutfitTitle) {
      els.nigekireOutfitTitle.textContent = ch.label + '｜' + ch.name;
      if (ch.color) els.nigekireOutfitTitle.style.setProperty('--char-color', ch.color);
    }
    // 「選べる衣装 N着」＝減らないが到達数で決まる仕組みを伝える唯一の場所（§5・省略しない）。
    if (els.nigekireOutfitSummary) {
      var summary = '収集 ' + cnt + '　選べる衣装 ' + st.remaining + '着';
      if (st.remaining === 0 && st.nextThreshold != null) {
        summary += '（次は' + st.nextThreshold + 'pt）';
      }
      els.nigekireOutfitSummary.textContent = summary;
    }

    els.nigekireOutfitGrid.innerHTML = '';
    st.seasons.forEach(function (slot) {
      var meta = NIGEKIRE_SEASON_META[slot.season] || {};
      var cell = document.createElement('div');
      cell.className = 'nigekire-outfit-cell is-' + slot.state;

      var art = document.createElement('div');
      art.className = 'nigekire-outfit-art';
      if (slot.state === 'unimplemented') {
        // 未実装は画像を持たない。空枠のままにする（記号やアイコンを勝手に置かない）。
      } else {
        var img = document.createElement('img');
        img.src = nigekireOutfitImgSrc(ch.key, slot.season);
        img.alt = ch.name + ' ' + (meta.name || slot.season);
        img.loading = 'lazy';
        art.appendChild(img);
      }
      cell.appendChild(art);

      var name = document.createElement('div');
      name.className = 'nigekire-outfit-season';
      name.textContent = meta.name || slot.season;
      cell.appendChild(name);

      var action = document.createElement('div');
      action.className = 'nigekire-outfit-action';
      if (slot.state === 'unimplemented') {
        action.textContent = '準備中';
      } else if (slot.state === 'unlocked') {
        action.textContent = '取得済み';
        action.classList.add('is-owned');
        // 取得済みマスのタップで演出を再生（§6・コレクションを眺める楽しみ）。
        cell.classList.add('is-replayable');
        cell.addEventListener('click', function () {
          playNigekireOutfitReveal(ch, slot.season);
        });
      } else if (slot.state === 'short') {
        action.textContent = slot.shortfall == null ? '受け取れません' : 'あと' + slot.shortfall + 'pt';
      } else {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nigekire-outfit-exchange';
        btn.textContent = '受け取る';
        btn.addEventListener('click', function () {
          confirmNigekireOutfit(ch, slot.season);
        });
        action.appendChild(btn);
      }
      cell.appendChild(action);
      els.nigekireOutfitGrid.appendChild(cell);
    });
  }

  // 交換の確認（§6）。「本当によろしいですか？」ではなく、ちび絵を見せた上での [交換する]。
  function confirmNigekireOutfit(ch, season) {
    if (outfitInFlight) return; // 二度押しロック
    var meta = NIGEKIRE_SEASON_META[season] || {};
    showSystemConfirm(
      ['［ システム ］', '', ch.name + 'の' + (meta.name || season) + '衣装を受け取ります。'],
      [
        {
          label: '受け取る',
          primary: true,
          onSelect: function () { execNigekireOutfitUnlock(ch, season); },
        },
        { label: 'やめる' },
      ]
    );
  }

  // 交換の実行。API 成功後にローカルへ反映して演出を出す。
  //   ★ポイントは減らさない（§2）。失敗しても巻き戻す残高が無い（§7）。
  function execNigekireOutfitUnlock(ch, season) {
    if (outfitInFlight) return;
    var m = ensureMode('nigekire');
    var noteId = m.player && m.player.id ? m.player.id : '';
    if (!noteId) {
      showSystemMessage(['［ システム ］', '', 'プレイヤー情報が見つかりません。']);
      return;
    }
    outfitInFlight = true;
    // 押せなくする（レスポンスが返るまで・§7）。
    if (els.nigekireOutfitGrid) els.nigekireOutfitGrid.classList.add('is-busy');

    fetch(NIGEKIRE_OUTFIT_API + '/api/outfit/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId: noteId, characterId: ch.key, season: season }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error('unlock failed');
        // 既に解放済み（alreadyUnlocked）でもローカルに入れる＝二重タップ対策と整合。
        m.outfitUnlocks = L.nigekireApplyOutfitUnlock(
          m.outfitUnlocks, ch.key, season, data.unlockedAt
        );
        saveState();
        renderNigekireOutfit();
        playNigekireOutfitReveal(ch, season);
      })
      .catch(function () {
        showSystemMessage(['［ システム ］', '', '解放できませんでした。']);
      })
      .then(function () {
        outfitInFlight = false;
        if (els.nigekireOutfitGrid) els.nigekireOutfitGrid.classList.remove('is-busy');
      });
  }

  // 解放の演出（§6）。買っても YOMIASA 側では何も変わらないので、ここが唯一の報酬。
  //   ちび絵を大きく出し、「おへんじ帖で使えるようになりました」を必ず添える。
  function playNigekireOutfitReveal(ch, season) {
    if (!els.nigekireOutfitReveal) return;
    if (els.nigekireOutfitRevealImg) {
      els.nigekireOutfitRevealImg.src = nigekireOutfitImgSrc(ch.key, season);
      els.nigekireOutfitRevealImg.alt = ch.name;
    }
    if (els.nigekireOutfitRevealText) {
      els.nigekireOutfitRevealText.textContent = 'おへんじ帖で使えるようになりました';
    }
    if (ch.color) els.nigekireOutfitReveal.style.setProperty('--char-color', ch.color);
    els.nigekireOutfitReveal.classList.remove('hidden');
    // タップで閉じる（§6 は1〜2秒だが、読み終わる前に消えないようタップでも閉じられる）。
    var close = function () {
      els.nigekireOutfitReveal.classList.add('hidden');
      els.nigekireOutfitReveal.removeEventListener('click', close);
    };
    els.nigekireOutfitReveal.addEventListener('click', close);
  }

  // ---------------------------------------------------------------------------
  // 節目イベント（最終確認）: カットイン → 最終確認画面 → 通過（§9/§10）。
  //   キタコレのボスカットイン相当だが戦闘語彙は使わない。専用オーバーレイ #nigekire-cutin
  //   / #nigekire-final を使う（キタコレのボス戦 DOM とは分離＝キタコレ無改変）。
  // ---------------------------------------------------------------------------

  // 最終確認カットイン（§9）。暗転・曜日キャラ縦カード大・キャラカラー発光枠・システム文・
  //   [画面タップで最終確認へ]案内。画面（背景/カード）タップで最終確認画面へ進む。
  // 段階番号の正規化（1..6 に丸める）。passIndex は logic 側で 1..6 を返すが、
  //   将来 7 回目以降が来ても最終段（6）で頭打ちにして描画が壊れないようにする。
  function nigekireCutinStage(passIndex) {
    var n = typeof passIndex === 'number' && isFinite(passIndex) ? Math.floor(passIndex) : 1;
    if (n < 1) return 1;
    if (n > 6) return 6;
    return n;
  }

  // '#1f3a5f' -> '31, 58, 95'。CSS 側で rgba(var(--char-rgb), a) の形で
  //   キャラカラーを任意の透明度で混ぜられるようにするため。#RGB 短縮形も許容する。
  //   ★演出用に明度を底上げする：月子(#1f3a5f ネイビー)や凛華(#7b1e2b ボルドー)は
  //     そのまま暗転に混ぜても暗いままで、段階が上がった実感が出ないため。
  //     色相は保ったまま、暗い色ほど強く白へ寄せる（明るい色はほぼ素通り）。
  function nigekireHexToRgbTriple(hex) {
    var h = typeof hex === 'string' ? hex.replace('#', '').trim() : '';
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '148, 163, 184'; // フォールバック（既定のスレート）
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    // 知覚輝度（0..255）。低いほど暗い色。
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    var TARGET = 165; // 演出に必要な明るさの目安
    if (lum < TARGET) {
      // 白へ寄せる割合。暗いほど大きく（上限 0.72 で色相を完全には飛ばさない）。
      var mix = Math.min(0.72, (TARGET - lum) / TARGET);
      r = Math.round(r + (255 - r) * mix);
      g = Math.round(g + (255 - g) * mix);
      b = Math.round(b + (255 - b) * mix);
    }
    return [r, g, b].join(', ');
  }

  function openNigekireFinalCutin(charKey) {
    if (!els.nigekireCutin) return;
    var ch = nigekireCharByKey(charKey);
    if (!ch) return;
    // 二重防御: 今 節目が出ていない（ready でない）なら開かない。
    var m = ensureMode('nigekire');
    var readyOut = nigekireReadyOut(m);
    if (!readyOut.ready) return;

    // 段階の描き分け（§spec-cutin-stage-decoration）。
    //   JS は「何段階目か」と「キャラカラー」を渡すだけ。見た目は style.css の
    //   .nigekire-cutin.stage-N が持つ（値は CSS 変数にまとめてある）。
    //   段階 = 通過セリフの回数と同じ数字（readyOut.passIndex・1..6）。
    var stage = nigekireCutinStage(readyOut.passIndex);
    for (var s = 1; s <= 6; s++) els.nigekireCutin.classList.remove('stage-' + s);
    els.nigekireCutin.classList.add('stage-' + stage);
    els.nigekireCutin.style.setProperty('--char-color', ch.color || '#94a3b8');
    els.nigekireCutin.style.setProperty('--char-rgb', nigekireHexToRgbTriple(ch.color));

    if (els.nigekireCutinCard) {
      // 枠色・発光は CSS 側（stage 別）が --char-color から作る。inline 指定は残さない。
      els.nigekireCutinCard.style.borderColor = '';
      els.nigekireCutinCard.style.boxShadow = '';
    }
    if (els.nigekireCutinImg) {
      // 画像は必ず専用定数から引く（後日の専用カットイン画像差し替えを1箇所で済ませるため）。
      els.nigekireCutinImg.src = NIGEKIRE_CUTIN_IMG[charKey] || ('assets/ohakano/' + ch.img);
      els.nigekireCutinImg.alt = ch.name;
    }
    if (els.nigekireCutinName) {
      els.nigekireCutinName.textContent = ch.label + '｜' + ch.name;
      // 色は CSS 側で --char-color に白を混ぜて出す（段階が上がると背景が明るくなり、
      //   暗いキャラカラーのままだと名前が埋もれるため）。
      els.nigekireCutinName.style.removeProperty('color');
      if (ch.color) els.nigekireCutinName.style.setProperty('--char-color', ch.color);
    }
    if (els.nigekireCutinLine) {
      var line = NIGEKIRE_CUTIN_LINES[charKey] || ('〈' + ch.name + '〉が待っている。');
      els.nigekireCutinLine.textContent = line;
    }
    // タップで進む先のキャラを覚えておく（オーバーレイの click ハンドラで参照）。
    activeNigekireFinalChar = charKey;
    els.nigekireCutin.classList.remove('hidden');
  }

  // カットインのタップ → 最終確認画面へ。
  function onNigekireCutinTap() {
    var charKey = activeNigekireFinalChar;
    if (els.nigekireCutin) els.nigekireCutin.classList.add('hidden');
    if (charKey) openNigekireFinalCheck(charKey);
  }

  // 最終確認画面（§10）。「○○の最終確認」＋キャラ別セリフ＋[確認を通過する]（クイズなし・儀式）。
  function openNigekireFinalCheck(charKey) {
    if (!els.nigekireFinal) return;
    var ch = nigekireCharByKey(charKey);
    if (!ch) return;
    var m = ensureMode('nigekire');
    var ready = nigekireReadyOut(m);
    if (!ready.ready) return; // 二重防御（節目が出ていない）

    if (els.nigekireFinalTitle) {
      els.nigekireFinalTitle.textContent = ch.name + 'の最終確認';
      els.nigekireFinalTitle.style.color = ch.color || '';
    }
    if (els.nigekireFinalLine) {
      // 通過セリフ 42本から引く（回 1..6）。セリフに鉤括弧が含まれるのでそのまま入れる。
      var lineKey = L.nigekireOshiPassLineKey(charKey, ready.passIndex);
      els.nigekireFinalLine.textContent = NIGEKIRE_PASS_LINES[lineKey] || '';
    }
    activeNigekireFinalChar = charKey;
    els.nigekireFinal.classList.remove('hidden');
  }

  // 最終確認画面を閉じる。
  function closeNigekireFinalCheck() {
    if (els.nigekireFinal) els.nigekireFinal.classList.add('hidden');
  }

  // [確認を通過する]。節目を通過する（キャラ単位ポイント＋閾値初到達）。
  //   閾値キー（'escape3'..'point15'）が reachedThresholds に無ければ追加＝初到達で
  //   ランクが1段上がる。2人目以降は既に到達済みなので節目は出るがランクは動かない。
  //   ランク A→B の行は rankUp のときだけ出す（動かないのに出すと嘘表示になる）。
  function passNigekireFinalCheck(charKey) {
    var m = ensureMode('nigekire');
    var ready = nigekireReadyOut(m);
    if (!ready.ready) { closeNigekireFinalCheck(); return; }

    var ch = nigekireCharByKey(charKey) || nigekireCharByKey(m.oshiChar);
    var lifeBefore = L.nigekireRankByStage(m.rankStage, NIGEKIRE_LIFE_RANKS);
    var clearedBefore = m.oshiCleared.length;
    var stageBefore = m.rankStage;

    var out = L.nigekirePassOshiMilestone(
      m.reachedThresholds, m.oshiPassCounts, m.oshiCleared, m.oshiChar, ready.kind, ready.need
    );
    if (!out.ok) { closeNigekireFinalCheck(); return; }
    m.reachedThresholds = out.nextReached;
    m.oshiPassCounts = out.nextPassCounts;
    m.oshiCleared = out.nextCleared;
    // rankStage は到達済み閾値の数から導出（rankUp のときだけ実際に動く）。
    m.rankStage = L.nigekireRankStageFromReached(
      m.reachedThresholds, NIGEKIRE_LIFE_RANKS.length - 1
    );
    saveState();

    var lifeAfter = L.nigekireRankByStage(m.rankStage, NIGEKIRE_LIFE_RANKS);
    var label = ch ? ch.label : '曜日';
    var name = ch ? ch.name : '曜日担当';
    var lines = [
      '［ システム ］',
      '',
      label + '担当〈' + name + '〉の最終確認を通過しました。',
    ];
    // ランク更新の行は閾値への初到達（rankUp）のときだけ。2人目以降は動かないので出さない。
    if (out.rankUp && m.rankStage !== stageBefore) {
      lines.push('');
      lines.push('おはカノ生活ランクが更新されました。');
      lines.push((L.nigekireRankLabel(lifeBefore) || '---') + ' → ' + (L.nigekireRankLabel(lifeAfter) || '---'));
    }
    // 3回通過（oshiCleared に積まれた）＝そのキャラの立ち絵が生活カードで見えるようになる。
    //   「生活カードが開きました」だけだと何が起きたか伝わらないので、
    //   どこで何が見られるようになったかを書く。
    if (m.oshiCleared.length > clearedBefore) {
      lines.push('');
      lines.push(name + 'の姿が見えるようになりました。');
      lines.push('ランクをタップすると確認できます。');
      // 1人目の完了（rankStage 3 到達）でだけキャラ変更の解禁を知らせる。
      if (stageBefore < 3 && m.rankStage >= 3) {
        lines.push('');
        lines.push('推しを変えられるようになりました。');
      }
    }
    closeNigekireFinalCheck();
    // 再描画（最終確認見出しが消える・ランク更新）。ヘッダー・記事チップを更新してからメッセージ。
    renderRoute();
    updateReadStatsHeader();
    showSystemMessage(lines);
  }

  // 一言チップのタップ回収 v2（キャラ別・+1・§10）。読了自動ではなくチップタップで回収する。
  //   1記事に複数キャラの一言があるため、どの charKey を回収するかを受ける。
  //   回収キャラは counts[articleId].chars に含まれるもの。二重取りは logic 側で防ぐ。
  //   回収→収集モーダル（§17-1「気配を見つけた」語彙・ポイント文言なし）。
  function nigekireCollect(articleId, charKey) {
    var m = ensureMode('nigekire');
    // 収集ロックは撤去（推し選択構造では rankStage による回収拒否をしない）。
    var out = L.nigekireCollectV2(m.counts, m.collected, m.charCounts, articleId, charKey);
    if (!out.ok) return; // 未検出 / 二重取り防止（回収済み）
    m.collected = out.nextCollected;
    m.charCounts = out.nextCharCounts;
    saveState();
    renderArticles();
    updateReadStatsHeader(); // 節目トリガー到達時はここで見出しが出る（renderNigekireHeader）

    var char = NIGEKIRE_CHARACTERS.filter(function (c) { return c.key === out.charKey; })[0];
    // 収集モーダル（§17-1）。ランクは通過ベースなので収集ではランク更新メッセージを出さない。
    linesModeKey = 'nigekire';
    var lines = nigekireCollectLines(char);
    linesModeKey = null;
    showSystemMessage(lines);
  }

  // ---------------------------------------------------------------------------
  // 日付ユーティリティ
  // ---------------------------------------------------------------------------

  // 日付ユーティリティは logic.js に一元化（二重実装を避ける）。呼び出し側は無変更。
  function parseDate(publishedAt) {
    return L.parseDate(publishedAt);
  }

  function yearOf(a) {
    return L.yearOf(a);
  }

  function monthOf(a) {
    return L.monthOf(a);
  }

  // 記事の公開日「YYYY.MM.DD (曜)」。曜日は JST 基準（logic.js・ニゲキレのチップと必ず一致）。
  //   記事一覧・お気に入り一覧の両方で使う（全モード共通の常時表示）。
  function formatDateDot(a) {
    return L.formatDateWithWeekday(a && a.publishedAt);
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
    return articles.filter(function (a) {
      return L.matchesFilters(a, ui, {
        read: isRead(creatorId, a.id),
        favorite: isFavorite(creatorId, a.id),
      });
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
    favoritesOnly: document.getElementById('favorites-only'),
    sortToggle: document.getElementById('sort-toggle'),
    statusMsg: document.getElementById('status-msg'),
    articles: document.getElementById('articles'),
    favoritesEntry: document.getElementById('favorites-entry'),
    favoritesEntryCount: document.getElementById('favorites-entry-count'),
    favoritesModal: document.getElementById('favorites-modal'),
    favoritesList: document.getElementById('favorites-list'),
    favoritesEmpty: document.getElementById('favorites-empty'),
    favoritesClose: document.getElementById('favorites-close'),

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
    kitacoreQuizLabel: document.getElementById('kitacore-quiz-label'),
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

    // ニゲキレ 節目イベント（最終確認）オーバーレイ ＆ debug（キタコレ DOM とは分離）。
    nigekireCutin: document.getElementById('nigekire-cutin'),
    nigekireCutinCard: document.getElementById('nigekire-cutin-card'),
    nigekireCutinImg: document.getElementById('nigekire-cutin-img'),
    nigekireCutinName: document.getElementById('nigekire-cutin-name'),
    nigekireCutinLine: document.getElementById('nigekire-cutin-line'),
    nigekireFinal: document.getElementById('nigekire-final'),
    nigekireFinalTitle: document.getElementById('nigekire-final-title'),
    nigekireFinalLine: document.getElementById('nigekire-final-line'),
    nigekireFinalPass: document.getElementById('nigekire-final-pass'),
    nigekireDebugBtns: document.getElementById('nigekire-debug-btns'),
    nigekireDebugAddAll: document.getElementById('nigekire-debug-add-all'),
    nigekireDebugAddTsukiko: document.getElementById('nigekire-debug-add-tsukiko'),
    nigekireDebugOver200: document.getElementById('nigekire-debug-over200'),
    nigekireDebugEscape: document.getElementById('nigekire-debug-escape'),
    nigekireDebugPass: document.getElementById('nigekire-debug-pass'),
    nigekireDebugClear: document.getElementById('nigekire-debug-clear'),
    nigekireDebugOshi: document.getElementById('nigekire-debug-oshi'),
    // 推し選択モーダル（初回選択・キャラ変更で共用）。
    nigekireOshi: document.getElementById('nigekire-oshi'),
    nigekireOshiTitle: document.getElementById('nigekire-oshi-title'),
    nigekireOshiNote: document.getElementById('nigekire-oshi-note'),
    nigekireOshiGrid: document.getElementById('nigekire-oshi-grid'),
    nigekireOshiCancel: document.getElementById('nigekire-oshi-cancel'),
    // 交換所（おへんじ帖の季節衣装）
    nigekireOutfit: document.getElementById('nigekire-outfit'),
    nigekireOutfitTitle: document.getElementById('nigekire-outfit-title'),
    nigekireOutfitSummary: document.getElementById('nigekire-outfit-summary'),
    nigekireOutfitGrid: document.getElementById('nigekire-outfit-grid'),
    nigekireOutfitClose: document.getElementById('nigekire-outfit-close'),
    nigekireOutfitReveal: document.getElementById('nigekire-outfit-reveal'),
    nigekireOutfitRevealImg: document.getElementById('nigekire-outfit-reveal-img'),
    nigekireOutfitRevealText: document.getElementById('nigekire-outfit-reveal-text'),
    // システム確認（Yes/No の汎用部品・システムメッセージと同じ見た目）
    systemConfirm: document.getElementById('system-confirm'),
    systemConfirmText: document.getElementById('system-confirm-text'),
    systemConfirmActions: document.getElementById('system-confirm-actions'),
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
    updateFavoritesEntry();
    if (!has) return;
    renderCreatorCards();
    // 各クリエイターの最新状態を取得して新着バッジを更新する
    refreshLatestCounts();
  }

  // ---------------------------------------------------------------------------
  // お気に入り：横断ビュー（クリエイターをまたいで「あとで戻る」ための一覧）
  // ---------------------------------------------------------------------------

  // トップの「⭐ お気に入り」入口の表示と件数を更新する。0件なら隠す。
  function updateFavoritesEntry() {
    if (!els.favoritesEntry) return;
    var n = favoriteCount();
    els.favoritesEntry.classList.toggle('hidden', n === 0);
    if (els.favoritesEntryCount) {
      els.favoritesEntryCount.textContent = n > 0 ? ' ' + n : '';
    }
  }

  // お気に入り一覧の1行を作る。クリエイター横断なので「誰の記事か」を必ず出す。
  function favoriteRowEl(fav) {
    var creator = getCreator(fav.creatorId);
    var creatorName = creator ? creator.displayName || creator.id : fav.creatorId;
    var read = isRead(fav.creatorId, fav.articleId);

    var row = document.createElement('div');
    row.className = 'favorite-row' + (read ? ' is-read' : '');

    // サムネ（あれば。タップで記事を開ける）
    if (fav.thumbnailUrl) {
      var thumb = document.createElement('a');
      thumb.className = 'favorite-thumb';
      thumb.href = fav.url;
      thumb.target = '_blank';
      thumb.rel = 'noopener';
      thumb.tabIndex = -1;
      thumb.setAttribute('aria-hidden', 'true');
      var img = document.createElement('img');
      img.src = fav.thumbnailUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        if (thumb.parentNode) thumb.parentNode.removeChild(thumb);
      });
      thumb.appendChild(img);
      thumb.addEventListener('click', function () {
        rememberPendingArticle(fav.creatorId, favToArticle(fav));
      });
      row.appendChild(thumb);
    }

    var body = document.createElement('div');
    body.className = 'favorite-body';

    var link = document.createElement('a');
    link.className = 'favorite-title';
    link.href = fav.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = fav.title || '(無題)';
    link.addEventListener('click', function () {
      rememberPendingArticle(fav.creatorId, favToArticle(fav));
    });
    body.appendChild(link);

    var meta = document.createElement('div');
    meta.className = 'favorite-meta';

    var who = document.createElement('span');
    who.className = 'favorite-creator';
    who.textContent = creatorName;
    meta.appendChild(who);

    var dot = formatDateDot(fav);
    if (dot) {
      var date = document.createElement('span');
      date.className = 'favorite-date';
      date.textContent = dot;
      meta.appendChild(date);
    }

    if (read) {
      var readBadge = document.createElement('span');
      readBadge.className = 'favorite-read-badge';
      readBadge.textContent = '読了 ✓';
      meta.appendChild(readBadge);
    }

    body.appendChild(meta);

    // お気に入りから外す
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'favorite-remove';
    removeBtn.textContent = '⭐ 外す';
    removeBtn.setAttribute('aria-label', 'お気に入りから外す');
    removeBtn.addEventListener('click', function () {
      toggleFavorite(fav.creatorId, favToArticle(fav));
      saveState();
      renderFavoritesModal();
      updateFavoritesEntry();
      // 記事画面を開いていれば、そのチップ表示も更新
      if (!els.viewRead || !els.viewRead.classList.contains('hidden')) {
        renderArticles();
      }
    });
    body.appendChild(removeBtn);

    row.appendChild(body);
    return row;
  }

  // スナップショット(fav)を、既存ヘルパーが受け取る article 形に戻す。
  function favToArticle(fav) {
    return {
      id: fav.articleId,
      title: fav.title,
      url: fav.url,
      thumbnailUrl: fav.thumbnailUrl,
      publishedAt: fav.publishedAt,
    };
  }

  // モーダル内の一覧を描き直す。
  function renderFavoritesModal() {
    var list = favoritesSorted();
    if (els.favoritesEmpty) {
      els.favoritesEmpty.classList.toggle('hidden', list.length > 0);
    }
    if (!els.favoritesList) return;
    els.favoritesList.innerHTML = '';
    list.forEach(function (fav) {
      els.favoritesList.appendChild(favoriteRowEl(fav));
    });
  }

  function openFavoritesModal() {
    renderFavoritesModal();
    if (els.favoritesModal) els.favoritesModal.classList.remove('hidden');
  }

  function closeFavoritesModal() {
    if (els.favoritesModal) els.favoritesModal.classList.add('hidden');
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
    // 発動対象がモードON中なら金縁。隠しコマンド（ダブルタップ）で切り替える。
    // モード横断で判定する（キタコレ=kitacore / ニゲキレ=nigekire どちらでも金縁）。
    if (isModeCreator(c.id) && isModeOnFor(c.id)) {
      avatar.classList.add('is-awakened');
    }
    if (isModeCreator(c.id)) {
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
    els.favoritesOnly.checked = !!ui.showFavoritesOnly;
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

    // お気に入り（⭐）: メタ行（読んだの隣）に置くチップ。タップで ☆⇄⭐。
    //   一覧の主役は「読む/読んだ」。お気に入りは補助操作。
    //   PC＝読んだの隣にラベル付きチップ／スマホ＝カード右上にアイコンだけ（CSSで切替）。
    var fav = isFavorite(creatorId, article.id);
    var favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'article-fav' + (fav ? ' is-favorite' : '');
    favBtn.setAttribute('aria-label', fav ? 'お気に入りから外す' : 'お気に入りに追加');
    favBtn.setAttribute('aria-pressed', fav ? 'true' : 'false');
    favBtn.title = fav ? 'お気に入りから外す' : 'お気に入りに追加';
    var favStar = document.createElement('span');
    favStar.className = 'article-fav-star';
    favStar.textContent = fav ? '⭐' : '☆';
    favStar.setAttribute('aria-hidden', 'true');
    favBtn.appendChild(favStar);
    var favLabel = document.createElement('span');
    favLabel.className = 'article-fav-label';
    favLabel.textContent = 'お気に入り';
    favBtn.appendChild(favLabel);
    favBtn.addEventListener('click', function () {
      toggleFavorite(creatorId, article);
      saveState();
      renderArticles();
      updateFavoritesEntry();
    });
    meta.appendChild(favBtn);

    // キタコレ覚醒前：クイズがある記事に「光ボタン」を出す（タップでクイズ）。
    //   未正解＝光る（タップ可）/ 正解済み＝光を消し「入手済」表示（タップ不可）。
    //   中身（kitacore-glow / openQuiz / mc().quizTaps）はキタコレ専用なので、
    //   キタコレ限定で判定する（ニゲキレは別チップ＝下の nigekire 分岐で扱う）。
    if (activeModeKey(creatorId) === 'kitacore' && isModeOn(creatorId) && !isPostAwakening(creatorId)) {
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
            ensureMode('kitacore');
            mc().quizTaps = (mc().quizTaps || 0) + 1;
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
    if (activeModeKey(creatorId) === 'kitacore' && isModeOn(creatorId) && isCounted(article.id)) {
      var entry = mc().counts[article.id];
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

    // ── ニゲキレ：記事チップ（v2・二層）＋タップ動作 ──
    //   試練対象（nigekire_quiz.json に載っている推しの曜日の記事）＝「ニゲキレ試練」。
    //   収集対象（本文取得で一言検出済み＝counts[id].chars あり）＝見出しキャラの「一言チップ」（複数可）。
    //   ★試練と収集は独立に出す（else if にしない）。試練の途中でも最新記事の一言チップを
    //     出して回収できるようにする＝あとで記事を二度読む羽目を避けるため（はしゃもさん）。
    //     同じ記事に試練と一言が両方あれば、試練チップと一言チップが並んで出る。
    if (isModeOnFor(creatorId) && activeModeKey(creatorId) === 'nigekire') {
      var nrec = nigekireQuizForArticle(article);
      var nm = ensureMode('nigekire');

      // 試練は推しの曜日の記事にだけ出す。曜日が一致しなければ（クイズがあっても）試練チップは出さない。
      var ntchar = nrec ? nigekireCharForArticle(article, nrec) : null;
      var isOshiDay = !!(ntchar && nm.oshiChar && ntchar.key === nm.oshiChar);

      if (nrec && isOshiDay) {
        // 試練対象：推しの曜日。タップで試練モーダル。逃げ切り済みは非活性。
        var tchar = ntchar;
        if (tchar) {
          var passedAlready = !!(nm.passed && nm.passed[article.id]);
          // 見た目はキタコレの試練チップ（.kitacore-glow・金＋点滅）と同じにする。
          //   両モードで「試練＝ここに挑めるものがある」の見え方を揃える（キャラ色では分けない）。
          var trial = document.createElement('button');
          trial.type = 'button';
          trial.className = 'kitacore-glow nigekire-trial' + (passedAlready ? ' is-cleared is-done' : '');
          trial.textContent = passedAlready ? tchar.name + ' 逃げ切り済み' : '✨ ' + tchar.name + ' 試練';
          trial.disabled = passedAlready;
          if (!passedAlready) {
            trial.addEventListener('click', function () {
              openNigekireTrial(article);
            });
          }
          meta.appendChild(trial);
        }
      }

      // 一言チップ：試練の有無と独立に、検出済みなら常に出す。
      if (nm.counts && nm.counts[article.id] && Array.isArray(nm.counts[article.id].chars)) {
        // 収集対象：本文取得で検出した一言キャラ。1記事に複数キャラの一言があれば
        //   キャラごとにチップを出し、それぞれ独立にタップ回収（+1）する。回収済みは非活性。
        var articleId = article.id;
        var collectedMap = (nm.collected && nm.collected[articleId] &&
          typeof nm.collected[articleId] === 'object') ? nm.collected[articleId] : {};
        nm.counts[articleId].chars.forEach(function (cKey) {
          var cchar = NIGEKIRE_CHARACTERS.filter(function (c) { return c.key === cKey; })[0];
          if (!cchar) return;
          var already = !!collectedMap[cKey];
          // 収集ロックは撤去（rankStage による回収拒否をしない）。
          // 見た目はキタコレのワイチップ（.article-wai）と同じにする＝両モードで
          //   「回収できるチップ」の見え方を揃える（曜日・キャラ色では分けない）。
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'article-wai nigekire-chip' +
            (already ? ' is-collected' : ' is-claimable');
          // 文言はキャラ名のみ。回収済みは ✓ を付ける（キタコレの「ワイ 5 ✓」と同型）。
          chip.textContent = already ? cchar.name + ' ✓' : cchar.name;
          chip.disabled = already;
          if (!already) {
            chip.addEventListener('click', function () {
              nigekireCollect(articleId, cKey);
            });
          }
          meta.appendChild(chip);
        });
      }
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

    // モード別ヘッダー。キタコレはキタコレ発動対象のときだけ描く（無改変）。
    //   ニゲキレはアクティブモードが nigekire のときだけ描く（同じ #kitacore-rank-area を
    //   別モードで排他利用＝同一クリエイターに両モードが同時発動することはない）。
    renderKitacoreHeader();
    renderNigekireHeader();
  }

  // ニゲキレ：ヘッダー（v2・生活ランクバッジ＋最推し＋1本ゲージ）。モードON のときだけ表示。
  //   ※v2で7人水平バーは廃止（1本の「おはカノ生活ゲージ」に統一・§5/§6）。
  //     ゲージの中身は選択中キャラのポイント（次のポイント閾値 5/10/15 まで）。
  //   キタコレの #kitacore-rank-area / #kitacore-stats / #kitacore-progress を排他利用する
  //   （ニゲキレ対象=hasyamo・キタコレ対象=ktcrs1107 で creator が異なるため衝突しない）。
  //   称号エリア（rank-area）タップ→詳細カード（openRankCard がモード分岐）＝キタコレと操作統一。
  //   ボス概念は無いので #kitacore-boss は使わず隠す。
  function renderNigekireHeader() {
    var c = getSelectedCreator();
    var on = c && activeModeKey(c.id) === 'nigekire' && isModeOnFor(c.id);
    // ニゲキレ非該当時は何もしない（キタコレ側の hidden 制御を尊重＝二重制御しない）。
    if (!on) return;

    if (els.kitacoreRankArea) els.kitacoreRankArea.classList.remove('hidden');
    if (els.kitacoreBoss) els.kitacoreBoss.classList.add('hidden');
    // キタコレ用 debug は常に隠す（排他）。ニゲキレ用は下で ?debug=1 のとき出す。
    if (els.debugBtns) els.debugBtns.classList.add('hidden');

    // ニゲキレ用 debug ボタン群: ?debug=1 かつ 記事取得済み のときだけ表示（キタコレと同方式・排他）。
    var hasArticles = c && (state.articlesByCreator[c.id] || []).length > 0;
    if (els.nigekireDebugBtns) els.nigekireDebugBtns.classList.toggle('hidden', !(DEBUG_MODE && hasArticles));

    var m = ensureMode('nigekire');
    // 推し未選択なら選択モーダルを出す（初回・閉じられない）。選択するまで先へ進めない。
    if (!m.oshiChar) openNigekireOshiSelect(false);
    // v2（通過ベース §10-2）：ランクは rankStage（通過した節目数）で決まる。収集数は次の
    //   節目トリガーで、ランク名は決めない。ゲージ（総収集の進捗）と最推しは収集数ベースのまま。
    var life = L.nigekireRankByStage(m.rankStage, NIGEKIRE_LIFE_RANKS);
    // ゲージは選択中キャラのポイント（総収集ではない）。例「8 / 15」・オーバーは「20 / 15」。
    var gauge = L.nigekireOshiGauge(m.charCounts, m.oshiChar, m.oshiPassCounts, NIGEKIRE_THRESHOLDS);
    var top = L.nigekireTopChar(m.charCounts, NIGEKIRE_CHARACTERS);

    // 上段: 生活ランクバッジ（キタコレの paintKitacoreHeader と完全に同じ形式）＋最推し。
    //   バッジ1個に「おはカノ生活ランク ○○」を入れる。クラスも同じ .kitacore-rank-text（button）。
    //   タップで詳細カード（称号名だけがタップ領域・§4 操作統一）。
    els.kitacoreStats.innerHTML = '';
    // ニゲキレは上部を縦積みにする（§6：ランク→逃げ切り記録→節目見出し）。
    //   キタコレの stats は横並び flex なので、ニゲキレ時だけ is-nigekire で縦積みへ切り替える。
    els.kitacoreStats.classList.add('is-nigekire');
    // ランク行：左にランクバッジ、右端に推しバッジ（同じ行に並べる）。
    var rankRow = document.createElement('div');
    rankRow.className = 'nigekire-rank-row';
    var rank = document.createElement('button');
    rank.type = 'button';
    rank.className = 'kitacore-rank-text rank-' + (life.key || 'nigekire');
    // 称号に通過済みキャラの曜日を積む（曜日順固定）。例: 生活防衛中〈月水金〉
    rank.textContent = 'ランク ' +
      L.nigekireRankTitleWithDays(L.nigekireRankLabel(life) || '---', m.oshiCleared, NIGEKIRE_CHARACTERS);
    rank.addEventListener('click', function () { openRankCard(); });
    rankRow.appendChild(rank);

    // 推しバッジ（行の右端）。ランクバッジと同じ質感で、色はキャラ別にしない（共通の落ち着いた色）。
    //   タップで推し選択モーダル＝キャラ変更の導線。変更解禁は rankStage>=3。
    var oshiCh = nigekireCharByKey(m.oshiChar);
    if (oshiCh) {
      var canChange = m.rankStage >= 3;
      var oshiEl = document.createElement('button');
      oshiEl.type = 'button';
      oshiEl.className = 'nigekire-oshi-current' + (canChange ? ' is-changeable' : '');
      oshiEl.textContent = '推し ' + oshiCh.label + '｜' + oshiCh.name;
      oshiEl.disabled = !canChange;
      if (canChange) {
        oshiEl.title = '推しを変える';
        oshiEl.addEventListener('click', function () { openNigekireOshiSelect(true); });
      }
      rankRow.appendChild(oshiEl);
    }
    els.kitacoreStats.appendChild(rankRow);

    // 逃げ切き記録行（ゲージとは別行・絵文字を使わない）。
    //   「逃げ切り 凛華 3/9  ●●●｜○○○｜○○○」。3回通過済み（oshiCleared入り）なら出さない。
    if (oshiCh && m.oshiCleared.indexOf(oshiCh.key) < 0) {
      var esc = L.nigekireOshiEscapeRecord(m.escapeCounts, m.oshiChar);
      var recEl = document.createElement('div');
      recEl.className = 'nigekire-escape-record';

      var recLabel = document.createElement('span');
      recLabel.className = 'nigekire-escape-label';
      recLabel.textContent = '逃げ切り';
      recEl.appendChild(recLabel);

      var recCount = document.createElement('span');
      recCount.className = 'nigekire-escape-count';
      recCount.textContent = esc.count + ' / ' + esc.need;
      recEl.appendChild(recCount);

      // 進捗ドット（文字の●○でなく CSS で描く）。3本ごとに1ブロック＝最終確認の単位。
      var dots = document.createElement('span');
      dots.className = 'nigekire-escape-dots';
      esc.cleared.forEach(function (done, i) {
        var block = document.createElement('span');
        block.className = 'nigekire-escape-block' + (done ? ' is-cleared' : '');
        var filled = done ? 3 : Math.max(0, Math.min(3, esc.count - i * 3));
        for (var d = 0; d < 3; d++) {
          var dot = document.createElement('span');
          dot.className = 'nigekire-escape-dot' + (d < filled ? ' is-on' : '');
          block.appendChild(dot);
        }
        dots.appendChild(block);
      });
      recEl.appendChild(dots);
      els.kitacoreStats.appendChild(recEl);
    }

    // 節目トリガー判定。initial（推しの逃げ切き 3/6/9）と collect（総収集 70/120/200）の2系統。
    var readyOut = nigekireReadyOut(m);

    // 最終確認見出し（§8）。ready のときだけ表示。カルーセルなし＝演出に出るのは推し固定。
    //   キタコレのボス見出し（サムネ＋info＋pillボタン）と同型の節目カードにする（§7 相当表）。
    //   戦闘語彙は使わず、色はキャラカラーにする。
    if (readyOut.ready) {
      var fchar = oshiCh; // 推し固定（選定処理は無い）
      var fname = fchar ? fchar.name : '曜日担当';
      var head = document.createElement('div');
      head.className = 'nigekire-final-head';

      // サムネ（曜日キャラの立ち絵・キタコレの kitacore-boss-thumb 相当）。
      var fthumb = document.createElement('div');
      fthumb.className = 'nigekire-final-head-thumb';
      if (fchar) {
        var fimg = document.createElement('img');
        fimg.src = 'assets/ohakano/' + fchar.img;
        fimg.alt = fname;
        fimg.loading = 'lazy';
        fthumb.appendChild(fimg);
      }

      // 情報カラム（label／本文／pillボタン）。
      var finfo = document.createElement('div');
      finfo.className = 'nigekire-final-head-info';
      var hTitle = document.createElement('div');
      hTitle.className = 'nigekire-final-head-title';
      hTitle.textContent = '最終確認';
      var hBody = document.createElement('div');
      hBody.className = 'nigekire-final-head-body';
      hBody.textContent = fchar ? (fchar.label + '担当 ' + fname + 'が待っています') : (fname + 'が待っています');
      var hBtn = document.createElement('button');
      hBtn.type = 'button';
      hBtn.className = 'nigekire-final-head-btn';
      hBtn.textContent = '言い訳する';
      hBtn.addEventListener('click', function () { openNigekireFinalCutin(m.oshiChar); });
      finfo.appendChild(hTitle);
      finfo.appendChild(hBody);
      finfo.appendChild(hBtn);

      head.appendChild(fthumb);
      head.appendChild(finfo);
      els.kitacoreStats.appendChild(head);
    }

    // 下段: 1本ゲージ（§5/§6）。塗り=次のポイント閾値への進行率(pct)・ラベルはオーバー値表示。
    //   キタコレの progress バー（.progress/.progress-track/.progress-fill/.progress-pct）を流用。
    //   タップ不可（表示専用）。7人水平バーは v2 で廃止。
    els.kitacoreProgress.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'progress';
    var track = document.createElement('div');
    track.className = 'progress-track';
    var fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = Math.max(0, Math.min(100, gauge.pct)) + '%';
    track.appendChild(fill);
    var barLabel = document.createElement('span');
    barLabel.className = 'progress-pct kitacore-wai-count';
    barLabel.textContent = gauge.display; // 例「8 / 15」・閾値超は「20 / 15」
    wrap.appendChild(track);
    wrap.appendChild(barLabel);
    els.kitacoreProgress.appendChild(wrap);
  }

  // キタコレ：ヘッダーにランク行＋進捗バーを出す。モードON のときだけ表示。
  //   覚醒前（A級ボス未撃破）= 覚醒前ランク（E/C/A）＋鍵の数。
  //   覚醒後（wing 撃破済み）= ワイ語ハンターランク＋ワイ累計バー。
  function renderKitacoreHeader() {
    var c = getSelectedCreator();
    var on = c && activeModeKey(c.id) === 'kitacore' && isModeOn(c.id);
    if (els.kitacoreRankArea) els.kitacoreRankArea.classList.toggle('hidden', !on);
    // ニゲキレ用 debug ボタンはキタコレ描画中は常に隠す（排他・キタコレ挙動は無改変）。
    if (els.nigekireDebugBtns) els.nigekireDebugBtns.classList.add('hidden');
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
    ensureMode('kitacore');
    if (!mc().defeatedBosses[creatorId]) mc().defeatedBosses[creatorId] = [];
    mc().defeatedBosses[creatorId].push(boss.key);
    if (mc().pendingPostBoss) delete mc().pendingPostBoss[creatorId];
    saveState();
    // 撃破後、既にワイ閾値を超えている次のボスがあれば出現させる
    var totalWai = mc().totalWai || 0;
    var defeated = mc().defeatedBosses[creatorId];
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
    // キタコレは横並び stats（ニゲキレの縦積みクラスが残っていたら外す）。
    els.kitacoreStats.classList.remove('is-nigekire');
    // ランクバッジ＝ボタン。タップで詳細カード（称号名だけがタップ領域・§9操作統一）。
    var rank = document.createElement('button');
    rank.type = 'button';
    rank.className = 'kitacore-rank-text rank-' + badgeKey;
    rank.textContent = badgeText;
    rank.addEventListener('click', function () { openRankCard(); });
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
    var totalWai = mc().totalWai ? mc().totalWai : 0;
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
    var totalWai = mc().totalWai ? mc().totalWai : 0;
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
    if (activeModeKey(creatorId) === 'kitacore' && isModeOn(creatorId)) {
      fetchAndCountArticle(article, creatorId);
    }
    // ニゲキレ：モードON なら遷移前に裏で本文を取り「◯◯の一言」キャラを検出する。
    //   （回収は後で記事行の一言チップをタップ＝ここでは収集数を入れない）
    if (activeModeKey(creatorId) === 'nigekire' && isModeOnFor(creatorId)) {
      fetchAndDetectNigekireChar(article, creatorId);
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
    // この creator のキタコレ計測を掃除（counts/collected は article.id 単位なので
    // 削除前に拾う。回収済みの累計 totalWai もそのぶん差し引く）。掃除ロジックは
    // logic.js の純関数（非破壊）に切り出し済み。ここは「掃除後 state を計算して代入」する。
    {
      // 物理保存先（state.modes.kitacore）を必ず初期化してから掃除する。
      var kc = ensureMode('kitacore');
      var articleIds = (state.articlesByCreator[id] || []).map(function (a) {
        return a && a.id;
      });
      state.modes.kitacore = L.cleanupKitacoreOnDelete(kc, id, articleIds, id === KITACORE_ID);
    }
    // この creator がニゲキレ対象（hasyamo）なら、ニゲキレ state も掃除する。
    //   キタコレと違いポイントの逆算（記事→キャラ→pt）が煩雑なため、唯一の対象を
    //   削除する＝そのモードの進行を丸ごとリセットする方針（亡霊 state を残さない）。
    if (id === NIGEKIRE_ID) {
      var nm = ensureMode('nigekire');
      state.modes.nigekire = L.cleanupNigekireOnDelete(nm, id === NIGEKIRE_ID);
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

    // お気に入り（横断一覧）モーダル
    if (els.favoritesEntry) {
      els.favoritesEntry.addEventListener('click', openFavoritesModal);
    }
    if (els.favoritesClose) {
      els.favoritesClose.addEventListener('click', closeFavoritesModal);
    }
    if (els.favoritesModal) {
      els.favoritesModal.addEventListener('click', function (e) {
        if (e.target === els.favoritesModal) closeFavoritesModal();
      });
    }

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
    els.favoritesOnly.addEventListener('change', function () {
      creatorUi(state.selectedCreatorId).showFavoritesOnly = els.favoritesOnly.checked;
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
        if (els.favoritesModal && !els.favoritesModal.classList.contains('hidden'))
          closeFavoritesModal();
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
      // #kitacore-quiz はキタコレ試練とニゲキレ試練で DOM 共有。閉じるボタンは
      // 両方の文脈をクリアする（closeQuiz 自体はキタコレ挙動のまま無改変）。
      els.kitacoreQuizClose.addEventListener('click', function () {
        closeQuiz();
        closeNigekireTrial();
      });
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
    // ランクエリア全体のタップは廃止。カードを開くのはランクバッジ（称号名）だけ。
    //   キタコレ＝paintKitacoreHeader、ニゲキレ＝renderNigekireHeader で各バッジに click 登録済み。
    //   （§4/§9「称号名のところをタップ」＝両モードで操作統一）。
    if (els.kitacoreRankCardClose) {
      els.kitacoreRankCardClose.addEventListener('click', closeRankCard);
    }
    if (els.debugAddKeys) {
      els.debugAddKeys.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'kitacore') return;
        ensureMode('kitacore');
        mc().keys[c.id] = keysOf(c.id) + 3;
        saveState();
        renderKitacoreHeader();
      });
    }
    if (els.debugAddWai) {
      els.debugAddWai.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'kitacore') return;
        ensureMode('kitacore');
        var waiRankBefore = kitacoreWaiRankOf(mc().totalWai);
        mc().totalWai += 100;
        saveState();
        var waiRankAfter = kitacoreWaiRankOf(mc().totalWai);
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
        ensureMode('kitacore');
        mc().keys = {};
        mc().quizCleared = {};
        mc().defeatedBosses = {};
        mc().totalWai = 0;
        mc().counts = {};
        mc().collected = {};
        mc().quizTaps = 0;
        mc().pendingPostBoss = {};
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

    // ── ニゲキレ 節目イベント（最終確認）の配線（キタコレ DOM とは分離）──
    //   カットイン：画面（背景/カード）タップで最終確認画面へ。
    if (els.nigekireCutin) {
      els.nigekireCutin.addEventListener('click', onNigekireCutinTap);
    }
    //   最終確認：[確認を通過する]で通過処理（active char を渡す）。
    if (els.nigekireFinalPass) {
      els.nigekireFinalPass.addEventListener('click', function () {
        passNigekireFinalCheck(activeNigekireFinalChar);
      });
    }

    //   推し選択モーダル：[やめる]で閉じる（キャラ変更時のみ表示・初回は閉じられない）。
    if (els.nigekireOshiCancel) {
      els.nigekireOshiCancel.addEventListener('click', closeNigekireOshiSelect);
    }

    //   交換所：[閉じる]で閉じる（カード画面の衣装行を更新して戻る）。
    if (els.nigekireOutfitClose) {
      els.nigekireOutfitClose.addEventListener('click', closeNigekireOutfit);
    }

    // ── ニゲキレ DEBUG（?debug=1・記事取得済み・activeModeKey==='nigekire' のときだけ表示）──
    //   全ボタン activeModeKey==='nigekire' ガード・ensureMode('nigekire')経由・saveState・再描画。
    //   キタコレの debug ボタンとは別 DOM・別ハンドラ（キタコレ挙動は無改変）。
    if (els.nigekireDebugAddAll) {
      els.nigekireDebugAddAll.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        NIGEKIRE_CHARACTERS.forEach(function (ch) {
          m.charCounts[ch.key] = (typeof m.charCounts[ch.key] === 'number' ? m.charCounts[ch.key] : 0) + 5;
        });
        saveState();
        renderRoute();
        updateReadStatsHeader();
      });
    }
    if (els.nigekireDebugAddTsukiko) {
      els.nigekireDebugAddTsukiko.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        m.charCounts.tsukiko = (typeof m.charCounts.tsukiko === 'number' ? m.charCounts.tsukiko : 0) + 5;
        saveState();
        renderRoute();
        updateReadStatsHeader();
      });
    }
    if (els.nigekireDebugOver200) {
      els.nigekireDebugOver200.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        // 推しのポイントを最終閾値(15)超にする。オーバー値表示（20 / 15）の確認用。
        //   ポイントはキャラ単位なので、選択中の推しに入れる。
        var oshi = m.oshiChar || NIGEKIRE_CHARACTERS[0].key;
        m.charCounts[oshi] = 20;
        saveState();
        renderRoute();
        updateReadStatsHeader();
      });
    }
    // 推しを選ぶ/変える: 選択モーダルを開く（DEBUG では rankStage に関係なく開ける）。
    if (els.nigekireDebugOshi) {
      els.nigekireDebugOshi.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        openNigekireOshiSelect(!!m.oshiChar);
      });
    }
    // 逃げ切き+1: 推しのぶんを1本積む（推し未選択なら何もしない）。
    if (els.nigekireDebugEscape) {
      els.nigekireDebugEscape.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        if (!m.oshiChar) return;
        m.totalSuccess = (typeof m.totalSuccess === 'number' ? m.totalSuccess : 0) + 1;
        var prevEsc = typeof m.escapeCounts[m.oshiChar] === 'number' ? m.escapeCounts[m.oshiChar] : 0;
        m.escapeCounts[m.oshiChar] = prevEsc + 1;
        saveState();
        renderRoute();
        updateReadStatsHeader();
      });
    }
    // 節目を通過（通過ベース §10-2）: 今 ready なら通過処理を呼んで rankStage を1段上げる。
    //   収集+5大量→70/120/200到達→このボタンで通常進行の節目を手で通せる（確認用）。
    if (els.nigekireDebugPass) {
      els.nigekireDebugPass.addEventListener('click', function () {
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        if (!nigekireReadyOut(m).ready) return; // まだ節目が出ていない（閾値未到達）
        passNigekireFinalCheck(m.oshiChar); // 演出に出るのは推し固定
      });
    }
    if (els.nigekireDebugClear) {
      els.nigekireDebugClear.addEventListener('click', function () {
        if (!window.confirm('ニゲキレの進行データ（収集・逃げ切り・最終確認）をすべてクリアします。よろしいですか？')) return;
        var c = getSelectedCreator();
        if (!c || activeModeKey(c.id) !== 'nigekire') return;
        var m = ensureMode('nigekire');
        m.charCounts = {};
        m.counts = {};
        m.collected = {};
        m.passed = {};
        m.totalSuccess = 0;
        m.firstTrySuccess = 0;
        m.rankStage = 0;
        m.reachedThresholds = []; // 到達済み閾値も戻す（ランクの源泉）
        // 推し選択構造のぶんも戻す（これを消さないと推し選択モーダルが出ない）。
        m.oshiChar = null;
        m.oshiCleared = [];
        m.escapeCounts = {};
        m.oshiPassCounts = {};
        m.finalCheckChar = null;
        saveState();
        renderRoute();
        updateReadStatsHeader();
      });
    }

    // 直接 #read で来ても選択が無ければ list に落とす（renderRoute 内で処理）
    renderRoute();
    checkVersionUpdate();
    registerServiceWorker();
    loadKitacoreQuizzes();
    loadNigekireQuizzes();
  }

  init();
})();
