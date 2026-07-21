# YOMIASA モードエンジン化 — 最終実装計画書

## 採用方針（結論）

**ベース = 1位「安全第一・段階移行案」**（薄いアクセサ層で新旧両対応 → 物理移動を最後に隔離）を骨格に、
以下を他案から取り込む。

- **1位の穴（クイズのシャッフル）を明示的に温存**する（採点で指摘された致命的欠点。最重要）。
- **DOM の id リネーム（`kitacore-*` → `mode-*`）は今回スコープ外**とし、共有オーバーレイをそのまま流用する（3位の割り切り。速度優先）。
- **マイグレーションは「明示列挙リビルド」形に正確に合わせる**（3位の指摘。実コード `loadState`/`importData` は `next` を1キーずつ再構築しており、`modes:` 行を明示追加しないとデータが黙って消える）。
- **`mc()`（=モード state アクセサ）は固定キー `modeState('kitacore')` に限定**する（3位の指摘。active-mode 解決に使うと未発動時 undefined で黙死）。
- **`player: null` の型ガードを型テーブルで潰さない**（2位の指摘。`ensureMode` は既存 `ensureKitacore` と1対1で同一挙動にする）。
- **覚醒前ランク（E級/C級/A級）は `nextPreBoss().rankBefore` から導く別モデル**を取りこぼさない（2位の指摘）。

**このスコープで完成するもの**: state/ロジック層の複数モード対応の土台（`state.modes` 名前空間 + `MODE_DEFS` + logic 純関数 + マイグレーション）。
**このスコープで未着手のもの**: DOM の多重インスタンス化（id リネーム・els 束縛の関数化）。2モード目の実UI実装時に別フェーズで行う。

不変条件（全ステップで守る）:
- キタコレモードの挙動を**一切変えない**（発動/収集/クイズ/鍵/覚醒前ボス/覚醒/覚醒後ボス/ランクカード/debug/import-export/deleteCreator が完全一致）。
- 既存ユーザーの `localStorage('yomiasa:v0')` を壊さない（進行データ = totalWai/keys/defeatedBosses/player を消さない）。
- `STORAGE_KEY` は `'yomiasa:v0'` 据え置き。
- コミット/push/バージョンbump は本人の明示指示があるまで行わない。

---

## 1. MODE_DEFS 確定スキーマ（キタコレ完全実例つき）

`MODE_DEFS` は**モードの静的定義のみ**を持つ（state ではない）。app.js 冒頭付近（既存 `KITACORE_*` 定数の直後）に定数リテラルで置く。
配列定数（`ranks`/`postBosses`/`preBosses`）は**既存の `KITACORE_RANKS` 等をそのまま参照**して二重定義を避ける（文字列 `rankAfter` 突き合わせズレ防止）。

`challengeType` は `'none' | 'choice_judgement' | 'choice_branch'` の3種を予約。実装は `none`→`choice_judgement`。`choice_branch` は型のみ予約。

```js
// ── モード定義（静的データのみ。関数参照は演出 lines のみ許容）──
var MODE_DEFS = {
  kitacore: {
    key: 'kitacore',
    targetCreatorId: 'ktcrs1107',        // 旧 KITACORE_ID。modeForCreator が逆引き
    challengeType: 'choice_judgement',   // 既存クイズ=正誤判定型。answer:index は読込時に内部変換
    goal: KITACORE_GOAL,                 // 2000（進捗バー最大）
    ranks: KITACORE_RANKS,               // 既存配列参照（覚醒後ランク閾値テーブル）
    postBosses: KITACORE_POST_BOSSES,    // 覚醒後ボス（ワイ閾値で出現）
    preBosses: KITACORE_PRE_BOSSES,      // 覚醒前ボス（鍵消費で挑戦）
    awakenBossKey: 'wing',               // 旧 onBossBattleTap の boss.key==='wing' 分岐を外出し。null なら覚醒概念なし
    quizUrl: 'kitacore_quiz.json',       // fetch 先。null ならクイズ無し
    // 演出テキスト束（今回は既存キタコレ関数を参照。データ化は将来）
    lines: {
      wake:   kitacoreWakeLines,         // モード発動メッセージ
      sleep:  kitacoreSleepLines,        // モード終了メッセージ
      enter:  kitacoreBossEnterLines,    // ボス登場（boss を受ける）
      down:   kitacoreBossDownLines,     // ボス撃破（boss を受ける）
      awaken: kitacoreAwakenLines,       // 覚醒（awakenBossKey 撃破時）
    },
    // 将来フィールド（今回は未使用の予約）:
    //   rewards: null,  // ニゲキレ='external_costume'(Cloudflare側), ねんころ='none'
    //   collect: { kind:'regex_count', pattern:'ワイ' }, // ねんころは 'keyword_set'
    //   presentation: { glitch:true },                    // 演出可否
  },
  // 将来: nigekire(choice_judgement/外部報酬), nenkoro(challengeType:'none'/キーワード収集/Lv画像)
};
```

### クイズ内部表現（ジュリ確定形）

`kitacore_quiz.json` は現状 `{ q, choices:[string], answer:index }`（実ファイル確認済み）。
**読込時に一度だけ**正規形へ変換する。正規形は `choices[].result` / `choices[].reaction` を持ち、正解 index を持たない。

```
正規形: { q, choices: [ { text, result:'success'|'wrong'|'wrong_funny', reaction }, ... ] }
  - answer:index 形式:  choices[i] => { text: choices[i], result: i===answer ? 'success':'wrong', reaction:'' }
  - 新形式（result/reaction 直書き）: そのまま採用（両対応）
```

- `challengeType:'choice_judgement'` は「`result==='success'` の選択肢のみ進行」。
- **重要（1位の穴の対策）**: 正規化は**並び順を固定しない**。openQuiz 側の `shuffled()` によるシャッフルは従来どおり温存する（正解位置のランダム性はキタコレ現行仕様）。正規化＝並び固定と誤解しないこと。

---

## 2. state 名前空間とマイグレーション

### 2.1 最終構造

```
state.modes = {
  kitacore: { mode:{}, counts:{}, collected:{}, totalWai:0, keys:{},
              defeatedBosses:{}, quizCleared:{}, player:null, quizTaps:0, pendingPostBoss:{} }
}
```

サブキー構造は現行 `state.kitacore` と**完全に同一**（形を変えない）。名前空間だけ `state.modes.kitacore` へ移す。

### 2.2 アクセサ集約（物理移動より先に・挙動不変）

現行の全 `state.kitacore.X` 直接参照を**固定キーのアクセサ 1本**に置換する。

```js
// 現在は state.kitacore を返す薄いラッパ（Step1 時点）。Step5 で state.modes.kitacore を返す実装へ差し替える。
// 【固定キー】active-mode 解決には使わない。未発動時にも呼ばれる読取経路があるため必ず 'kitacore' 固定。
function mc() { return modeState('kitacore'); }

function modeState(modeKey) {
  ensureMode(modeKey);
  return state.modes ? state.modes[modeKey] : ensureKitacore(); // Step1 時点は下記参照
}
```

置換対象（調査1の read/write 全経路。1件でも残すと undefined 黙死）:
`isModeOn`(L159) / `defeatedBossesOf`(L164) / `keysOf`(L175) / `playerName`(L98) / `isQuizCleared`(L577) /
`challengeBoss`(L191-198) / `awardKey`(L584-587) / `collectWai` / `fetchAndCountArticle`(L1353) /
`isCounted`(L1328) / `isCollected`(L1332) / `openRankCard`(L437,444-447,510) / `renderKitacorePreHeader`/`PostHeader` /
`challengePostBoss`(L2645-2652) / `showPostBoss`(L1394-1405) / `pendingPostBossOf`(L1412) /
`debugAddKeys`/`debugAddWai`/`debugClear`(L3787-3795) / `deleteCreator`(L3202-3219) 他。
完了条件: `grep 'state\.kitacore'` が **アクセサ本体（`mc`/`ensureMode`/`migrate`）以外で 0 件**。

### 2.3 ensureMode（旧 ensureKitacore と1対1で同一挙動）

**`player:null` を型テーブルで潰さない**（2位の指摘）。既存 `ensureKitacore`（L76-90）のガードを**そのまま**移植する（`player` だけ null 許容の特殊ガード）。

```js
function blankModeState() {
  // defaultState L71 の kitacore リテラルと同一形
  return { mode:{}, counts:{}, collected:{}, totalWai:0, keys:{}, defeatedBosses:{},
           quizCleared:{}, player:null, quizTaps:0, pendingPostBoss:{} };
}

function ensureModes() {
  if (!state.modes || typeof state.modes !== 'object') state.modes = {};
  return state.modes;
}

function ensureMode(modeKey) {
  ensureModes();
  var m = state.modes[modeKey];
  if (!m || typeof m !== 'object') m = state.modes[modeKey] = blankModeState();
  // ↓ 既存 ensureKitacore と同一のサブキー型チェック（player は null 許容のまま）
  if (!m.mode || typeof m.mode !== 'object') m.mode = {};
  if (!m.counts || typeof m.counts !== 'object') m.counts = {};
  if (!m.collected || typeof m.collected !== 'object') m.collected = {};
  if (typeof m.totalWai !== 'number') m.totalWai = 0;
  if (!m.keys || typeof m.keys !== 'object') m.keys = {};
  if (!m.defeatedBosses || typeof m.defeatedBosses !== 'object') m.defeatedBosses = {};
  if (!m.quizCleared || typeof m.quizCleared !== 'object') m.quizCleared = {};
  if (m.player !== null && typeof m.player !== 'object') m.player = null;  // ← null 許容の特殊ガード
  if (typeof m.quizTaps !== 'number') m.quizTaps = 0;
  if (!m.pendingPostBoss || typeof m.pendingPostBoss !== 'object') m.pendingPostBoss = {};
  return m;
}
```

### 2.4 マイグレーション（loadState と importData の両方・明示列挙リビルドに合わせる）

**3位の致命的指摘への対応**: 実コードの `loadState`(L938-953) / `importData`(L992-1011) は `next` を**1キーずつ明示列挙して再構築**している（`favorites: L.sanitizeFavorites(...)` 等）。
`next` に**明示的に足さないキーは存在しなくなる**。したがって、両所で `kitacore:` 行を**削除**し `modes:` 行を**明示追加**する。この両方をやらないと進行データが読込時に黙って消える。

純粋部分は logic.js へ:

```js
// logic.js（純粋・副作用なし）
// parsed: ロード/インポートされた state。破壊してよいコピー前提だが、念のため非破壊で新オブジェクトを返す。
function migrateModes(parsed) {
  var modes = (parsed.modes && typeof parsed.modes === 'object') ? parsed.modes : {};
  // 旧フラット state.kitacore を新パスへ移送（modes.kitacore が未定義のときだけ＝新が勝つ＝冪等）
  if (parsed.kitacore && typeof parsed.kitacore === 'object' && !modes.kitacore) {
    modes = Object.assign({}, modes, { kitacore: parsed.kitacore });
  }
  return modes; // ← modes マップを返す。呼び出し側で next.modes に載せる
}
```

app.js の `loadState` / `importData` 内（両方）:

```js
// 変更前:
//   kitacore: parsed.kitacore && typeof parsed.kitacore==='object' ? parsed.kitacore : base.kitacore,
// 変更後（kitacore 行を削除し、modes 行を追加）:
    modes: L.migrateModes(parsed),   // importData 側は incoming を渡す
```

- `defaultState()` は L71 の `kitacore:{...}` を**削除**し `modes: {}` を**追加**する。
- 旧 `parsed.kitacore` は `next` に載らない → 次回 `saveState`（state 全体保存）で自動的に消え、二重化しない。
- `exportData` は state 全体を出すので、移行後は自動的に新構造（`modes` のみ）になる。
- schemaVersion フラグは不要: `next` に `kitacore` を載せない設計なので、移行は構造的に一度きり（旧 `kitacore` が存在する状態は初回ロード時だけ）。

**部分欠損の保持**（2位の指摘）: `modes.kitacore` が既にあってサブキーだけ欠ける中間状態は、`migrateModes` が丸ごと採用 → `ensureMode` が既存値を保持しつつ欠損だけ補完する（`ensureMode` が既存値を上書きしないことをテストで固定）。

---

## 3. logic.js に切り出す純粋関数（完全リスト）

logic.js は factory 形式（`window.YomiasaLogic` / `module.exports`）。既存 `matchesFilters` 流儀（state ではなく値を引数で受ける）に合わせる。
定数（RANKS/BOSSES）は各モードで異なるため logic 内定数化せず、**配列を引数で受ける**（3位の速度優先方針）。app.js 側は `MODE_DEFS.kitacore.ranks` 等を渡す。

各関数に対応する `test/modes.test.js` のテストケース案を併記。

### A群: 完全純粋（そのまま移設）

| 関数 | シグネチャ | テストケース案 |
|---|---|---|
| `stripHtml` | `(html) -> string` | `'<b>あ</b>&amp;い'` → `'あ&い'` / `'&lt;&gt;&nbsp;&quot;&#39;'` → `'<> "\''` / 非文字列 `null` → `'null'`（現行 `String()` 挙動維持） |
| `countWai` | `(text) -> number` | `'ワイワイ'` → 2 / `'なし'` → 0 / `''` → 0 / 連続呼び出しで同値（lastIndex 事故がないこと）。**WAI_RE は関数内リテラル `/ワイ/g` 生成**（exec/test に変えない） |
| `articleKeyFromUrl` | `(url) -> string|null` | `'https://note.com/x/n/nabc123'` → `'nabc123'` / `'https://note.com/x/nabc123'`（`/n/` なし）→ 現行正規表現に従う（`/\/n\/([A-Za-z0-9]+)/`）→ `null` / `null` → `null` / `''` → `null` |

### B群: 配列/フラグを引数化して純化（creatorId 依存を除去）

| 関数 | シグネチャ | 備考 / テストケース案 |
|---|---|---|
| `kitacoreWaiRankOf` | `(ranks, totalWai) -> rankObj` | 旧 `kitacoreWaiRankOf(totalWai)` に ranks 引数追加。`(RANKS, 0)`→S級覚醒 / `(RANKS, 600)`→国家級 / `(RANKS, 1999)`→君主前 / `(RANKS, 2000)`→君主 |
| `kitacoreRankOf` | `(ranks, postBosses, defeated) -> rankObj` | 旧 `kitacoreRankOf(creatorId)`。`defeated`=撃破key配列。`(R,PB,[])`→S級覚醒 / `[requiem]`→国家級 / `[requiem,cael]`→君主前 / `[cael]` のみ→君主前（閾値でなく撃破で導出。ワイ数無関係） |
| `isPostAwakening` | `(defeated, awakenBossKey) -> boolean` | 'wing' ハードコードを引数化。`([...,'wing'],'wing')`→true / `(['reaper'],'wing')`→false / `awakenBossKey==null`→常に false（覚醒概念なしモード） / **`creatorId` を誤って渡さない**回帰（文字列.indexOf 誤判定防止） |
| `nextPreBoss` | `(preBosses, defeated) -> bossObj|null` | 旧 `nextPreBoss(creatorId)`。`(PRE,[])`→reaper / `[reaper]`→armored / `[reaper,armored]`→wing / `[reaper,armored,wing]`→null |

**覚醒前ランク導出（2位の指摘・取りこぼし注意）**: E級/C級/A級 は `nextPreBoss(...).rankBefore` / `.rankBeforeKey` から引く（`openRankCard` L443,485）。これは B群 `nextPreBoss` の戻り値で賄えるため新関数は不要だが、`nextPreBoss` が `null`（全撃破=覚醒後）を返すケースの分岐を app 側で保つこと。テストで `rankBefore`/`rankBeforeKey` を含む boss オブジェクトが返ることを確認。

### C群: クイズ（D群 + ジュリ確定形）

| 関数 | シグネチャ | テストケース案 |
|---|---|---|
| `normalizeQuiz` | `(raw) -> { q, choices:[{text,result,reaction}] }` | answer:index 形式 `{q,choices:['A','B','C','D'],answer:2}` → choices[2].result==='success'、他は 'wrong'、各 reaction==='' / 新形式 `{q,choices:[{text,result,reaction}]}` → そのまま / `answer` 範囲外 → 全 wrong（例外を出さない） |
| `normalizeQuizMap` | `(rawMap) -> normalizedMap` | `{quizzes:{}}` 内の値を全件 normalize。`null`/`undefined` → `{}`（未ロード安全） |
| `quizForArticle` | `(quizzes, article) -> quiz|null` | 旧 `quizForArticle(article)` に quizzes 引数追加。null ガード込み。`(null, a)`→null / `({}, a)`→null / `({nabc:{...}}, {url:'.../n/nabc'})`→該当quiz |
| `quizChoiceOutcome` | `(normalizedQuiz, choiceIndex) -> 'success'|'wrong'|'wrong_funny'` | 正誤判定の純化。success index→'success' / 他→'wrong' / 範囲外 index→'wrong'（防御） |

**シャッフル温存（最重要）**: `quizChoiceOutcome` は「**シャッフル後の** `choices[i].result` を返す」純関数に閉じる。シャッフルは app.js の `openQuiz` 内 `shuffled()` に残す。`normalizeQuiz` は順序を変えない。

### D群: マイグレーション純粋部分

| 関数 | シグネチャ | テストケース案 |
|---|---|---|
| `migrateModes` | `(parsed) -> modesMap` | `{kitacore:{totalWai:5}}` → `{kitacore:{totalWai:5}}` / `{modes:{kitacore:{totalWai:9}}, kitacore:{totalWai:5}}` → `{kitacore:{totalWai:9}}`（新が勝つ・冪等）/ `{}` → `{}` / 進行データ（keys/defeatedBosses/player）が保持される |
| `modeForCreator` | `(modeDefs, creatorId) -> def|null` | `targetCreatorId` 逆引き。`(MODE_DEFS,'ktcrs1107')`→kitacore def / `(MODE_DEFS,'other')`→null |

### app.js に残すもの（state 直読みアクセサ = C群供給役）

`defeatedBossesOf` / `keysOf` / `isModeOn` / `playerName` / `isQuizCleared` は `mc()` を読む薄いラッパのまま app.js に残す。
呼び出し側は `L.kitacoreRankOf(def.ranks, def.postBosses, defeatedBossesOf(id))` の形で MODE_DEFS の配列を渡す。

### logic.js の export 追加

既存 return オブジェクトに以下を追加（既存 export は無変更）:
`stripHtml, countWai, articleKeyFromUrl, kitacoreWaiRankOf, kitacoreRankOf, isPostAwakening, nextPreBoss, normalizeQuiz, normalizeQuizMap, quizForArticle, quizChoiceOutcome, migrateModes, modeForCreator`。

---

## 4. DOM 汎用化の方針

**今回は DOM を移動・複製・リネームしない**（3位の割り切り。速度優先・回帰面最小）。

- `els.kitacore*` 全23個の `getElementById` 束縛（L1611-1709）は**そのまま**。
- `index.html` の `kitacore-*` id は**変更しない**。
- 共有オーバーレイ（system / quiz / battle / rank-card / player）は全モード共有ノードとして使い回す前提。中身（テキスト・画像・選択肢・演出文言）だけを現モードの `MODE_DEFS` から流し込む。
- モジュールスコープ単一グローバル（`activeBattle` L240 / `activeQuiz` L592 / `systemMsg` L818）は据え置き。「1画面1クリエイター=1モード、同時に複数オーバーレイを開かない」前提で単一で足りる。

**分岐条件の外出しのみ実施**（値は同一なので挙動不変）:
- `onBossBattleTap`(L279): `boss.key === 'wing'` → `boss.key === def.awakenBossKey`。`awakenBossKey==null` なら常に通常撃破。
- `articleEl`(L2421-2440) の光ボタン条件 `isKitacoreTarget && isModeOn && !isPostAwakening` → `modeForCreator(creatorId)` で def 解決 + `def.challengeType !== 'none'` ガードを1つ追加（`none` モードは光ボタンを出さない）。
- `creatorCardEl`(L1952-1960) の `attachDoubleTap` / 金縁: `isKitacoreTarget(c.id)` → `modeForCreator(c.id) != null`。1 avatar = 1 モードなので多重ハンドラ問題は起きない。
- `openRankCard`(L439) の `creatorId = KITACORE_ID` 固定 → 現在選択中クリエイターから `modeForCreator` で対象解決。他モードで常にキタコレ表示にならないようにする。

**将来（今回スコープ外）**: 2モード目の実UI実装時に、id リネーム（`kitacore-*`→`mode-*`）・els 束縛の関数化・オーバーレイ状態のモードキー付き管理を別フェーズで行う。

---

## 5. 実装ステップ（各ステップが独立検証可能）

各ステップは「`node --test` 成功」または「ブラウザでキタコレモードが従来通り動く」で検証できる単位。Step0〜4 は物理移動を伴わず可逆。Step5 のみ不可逆。

### Step0 — セーフティネット（app.js 未変更）
`test/modes.test.js` を新設し、切り出し予定関数の**現行入出力を固定するゴールデンテスト**を書く（§3 のテストケース案）。この時点では logic.js に関数がまだ無いので、まず現行 app.js のロジックを logic.js へコピーしてから（Step1 と一体でも可）テストを書く。
実装順の推奨: Step0 と Step1 を「logic.js に関数追加 → テスト作成」として1コミットにまとめてよい。

### Step1 — logic.js へ純関数切り出し（挙動不変）
A/B/C/D群を logic.js に追加。app.js 側は `L.xxx` へ委譲する薄いラッパに差し替え。
- `stripHtml`/`countWai`/`articleKeyFromUrl` → `L.` 委譲。
- `kitacoreWaiRankOf`/`kitacoreRankOf`/`isPostAwakening`/`nextPreBoss` → app 側は `defeatedBossesOf(id)` を挟んで `L.` の配列引数版を呼ぶ。全呼び出し箇所（L440,443,485,496,510,2423,2525,2540,2656,2690,2704 等）を **grep 一括修正**。
- `quizForArticle` → `L.quizForArticle(kitacoreQuizzes, article)`。

### Step2 — クイズ正規化層（挙動不変・シャッフル温存）
`loadKitacoreQuizzes` の `.then` で `kitacoreQuizzes = L.normalizeQuizMap(data.quizzes)` を通す（`kitacore_quiz.json` は無改変）。
`openQuiz`(L677-717) を正規化形に対応: `quiz.choices` は `{text,result,reaction}[]`。`shuffled()` は**維持**。正誤判定を `L.quizChoiceOutcome(quiz, chosenIndex)`（シャッフル後 index に対して）へ。`answerQuiz`(L719-744) の answered ロック・リトライ・quizTaps 加算・awardKey は**そのまま温存**。

### Step3 — アクセサ集約（挙動不変・物理移動なし）
`mc()` / `modeState('kitacore')` を導入。この時点では `state.modes` はまだ無いので、`mc()` は当面 `ensureKitacore()`（=旧 `state.kitacore`）を返す実装にする。
`state.kitacore.X` 直接参照を全て `mc().X` へ機械置換（§2.2 の全経路）。`defaultState`/`ensureKitacore`/`loadState`/`importData`/`debugClear`(L3787-3795, mode/player を残す部分リセット挙動を維持) も対象。
**保存先は物理的に旧 `state.kitacore` のまま**。`grep 'state\.kitacore'` がアクセサ本体以外 0 件を確認。

### Step4 — MODE_DEFS 導入（データのみ・分岐を寄せるが挙動不変）
`MODE_DEFS.kitacore` を定義（§1）。`isKitacoreTarget` → `modeForCreator`、`onBossBattleTap` の 'wing' 分岐 → `def.awakenBossKey`、`openRankCard` の `KITACORE_ID` 固定 → `modeForCreator` 解決、光ボタン条件 → `modeForCreator + challengeType!=='none'` へ置換（§4）。値は同一なので挙動不変。

### Step5 — state 物理移行（不可逆・最後に独立）
`defaultState` を `kitacore:{...}` 削除・`modes:{}` 追加。`ensureKitacore` → `ensureMode`/`ensureModes`（§2.3）。`loadState`/`importData` の `kitacore:` 行削除・`modes: L.migrateModes(...)` 追加（§2.4）。`mc()` の中身を `state.modes.kitacore` を返す実装へ差し替え（他経路は `mc()` 経由なので無変更）。
**実施前に既存 export でバックアップ**。

### Step6（任意・予約）
2モード目（ニゲキレ / ねんころ）は `MODE_DEFS` にエントリ追加で立ち上げる土台が完成した状態。実UI実装（DOM多重化）は別フェーズ。

---

## 6. 各ステップの検証方法

| Step | 検証（これが通れば OK） |
|---|---|
| Step0/1 | `node --test`（=`npm test`）が緑。§3 の全ケースが現行 app.js と同一出力。ブラウザで #read → キタコレ発動 → ワイ収集 → 光ボタン → クイズ正解で鍵+1 → 覚醒前ボス撃破 → 覚醒 → 覚醒後ボス → ランクカード表示 が従来通り。 |
| Step2 | `node --test` の `normalizeQuiz`/`quizChoiceOutcome` が緑。ブラウザでクイズを開き**選択肢の並びが毎回変わる**こと（シャッフル温存）、正解で鍵獲得・再挑戦可・正解済み記事は「取得済み」表示、が従来通り。 |
| Step3 | `grep 'state\.kitacore'` がアクセサ本体（mc/ensure/migrate）以外 0 件。ブラウザで全フロー + **既存 `localStorage('yomiasa:v0')` を読み込んでも進行データが無傷**（totalWai/keys/defeatedBosses/player が表示される）。`?debug=1` の debugClear が mode/player を残し進行のみ消すこと。 |
| Step4 | `node --test` の `modeForCreator` が緑。ブラウザで全フローが Step3 と一致（挙動不変）。 |
| Step5 | 既存 export JSON を import して進行データ（totalWai/keys/defeatedBosses/player）が失われないこと。export→import 往復でロストしないこと（両経路移行の検証）。`node --test` の `migrateModes` が緑（冪等・二重化なし・部分欠損保持）。ブラウザで旧 localStorage を読み → `state.modes.kitacore` に載って全フロー動作。DevTools で `localStorage` を確認し `state.kitacore` が消え `state.modes.kitacore` のみになっていること。 |

手動チェックリスト（Step0 で作成、各 UI ステップで参照）:
発動 / ワイ収集チップ / 光ボタン出現 / クイズ4択シャッフル / 正解→鍵+1 / 正解済み再挑戦 / 覚醒前ボス3体（鍵消費）/ 覚醒演出（wing）/ 覚醒後ボス3体（ワイ閾値出現）/ ランクカード（覚醒前=rankBefore・覚醒後=rankOf）/ debugClear（mode・player残す）/ deleteCreator（KITACORE_ID 削除で player=null）/ export・import 往復。

---

## 7. リスクと対策

| # | リスク | 対策 |
|---|---|---|
| R1 | **クイズのシャッフルを落とす**（1位の致命的欠点）。正規化=並び固定と誤解すると選択肢が固定順になり毎回同じ位置が正解に。テストは result 判定だけ通り黙って壊れる。 | `normalizeQuiz` は順序を変えない純変換に限定。`shuffled()` は `openQuiz` 内に温存。`quizChoiceOutcome` はシャッフル後 index に対して判定。Step2 の受け入れ条件に「選択肢の並びが毎回変わる」を必須で入れる。 |
| R2 | **マイグレーション擬似コードと実コードの齟齬**（3位の致命的指摘）。`loadState`/`importData` は `next` を明示列挙リビルド。`modes:` 行を明示追加し忘れると進行データが黙って消える（例外なし・0クランプ）。 | 両所で `kitacore:` 行を削除し `modes: L.migrateModes(...)` を明示追加。`defaultState` も `modes:{}` 追加。Step5 検証で export→import 往復・旧 localStorage 読込でデータ不変を必ず確認。 |
| R3 | **`mc()` を active-mode 解決にしてしまう**（3位の指摘）。読取経路（isModeOn/isCounted/keysOf 等）は未発動時にも呼ばれ、active-mode が null で undefined 黙死。 | `mc()` は `modeState('kitacore')` 固定キーに限定。active-mode 解決ヘルパ（`modeForCreator`）は分岐外出し用に別関数として分離。 |
| R4 | **`player:null` の型テーブル潰し**（2位の指摘）。単純型テーブルで `player` を `{}` 初期化すると `playerName`/`openRankCard` の `if(!player) return` が壊れ未認証で誤表示。 | `ensureMode` を既存 `ensureKitacore` と1対1で移植（`player` だけ null 許容の特殊ガード `if (m.player !== null && typeof m.player !== 'object') m.player = null`）。テストで player=null が保持されることを固定。 |
| R5 | **覚醒前ランク導出の取りこぼし**（2位の指摘）。E級/C級/A級 は `ranks` 閾値でなく `nextPreBoss().rankBefore` から導く別モデル。 | `nextPreBoss` の戻り値（rankBefore/rankBeforeKey 含む）を保持。`openRankCard` の覚醒前分岐（L443,485）を温存。テストで `nextPreBoss` が rankBefore を含むこと・全撃破時 null を確認。 |
| R6 | B群シグネチャ変更で1箇所でも旧 `creatorId` を渡すと `文字列.indexOf('wing')` 誤判定（creatorId に 'wing' 含めば true 等）。 | Step1 で grep 全置換を一度に実施。`defeatedBossesOf(id)` を必ず挟む。`node --test` で回帰固定。 |
| R7 | 定数 `rankAfter` 文字列（'国家級'等）の突き合わせズレ。 | 定数は app.js の `KITACORE_*` を唯一の出所とし、`MODE_DEFS` と logic 引数は同じ配列参照を渡す（二重定義しない）。 |
| R8 | `countWai` の WAI_RE が g フラグ共有インスタンス。将来 exec/test に変えると lastIndex 残留で結果が呼び出しごとに変わる。 | logic.js では関数内で `/ワイ/g` をリテラル生成（または match 限定を明記）。exec/test に書き換えない。テストで連続呼び出し同値を固定。 |
| R9 | `totalWai` と collected 記事のワイ合計のズレ（collectWai↔deleteCreator の加減算対）。移行漏れで片方だけ移ると `Math.max(0,...)` で無言 0 クランプ。 | Step3 のアクセサ集約で collectWai(L1379-1385)/deleteCreator(L3205) を同時に `mc()` 化。Step3 検証で既存データ読込時に totalWai が正しく表示されることを確認。 |
| R10 | DOM を今回一般化しないため 2モード目で id 衝突（同 id を2モードが持つと getElementById が先頭のみ拾い後発が無反応）。 | 今回スコープ外と明記。2モード目実装時に id リネーム・els 束縛関数化を別フェーズで行う（本計画は state/ロジック土台まで）。 |

---

## 付録: 主要な現行コード位置（実装者向け索引）

- `defaultState` L42-73 / `ensureKitacore` L76-91 / `KITACORE_*` 定数 L93,105-118,146-150
- `kitacoreRankOf` L122-132 / `kitacoreWaiRankOf` L135-141 / `isKitacoreTarget` L153-154 / `isModeOn` L158-160
- `defeatedBossesOf` L163-166 / `isPostAwakening` L169-171 / `keysOf` L174-177 / `nextPreBoss` L180-186
- `openRankCard` L435-541（覚醒前 rankBefore 分岐 L440,443,485）
- `loadKitacoreQuizzes` L550-566 / `quizForArticle` L569-573 / `isQuizCleared` L576-579 / `awardKey` L582-589
- `openQuiz` L677-717（`shuffled()` L679）/ `answerQuiz` L719-744 / `shuffled` L595-604
- `stripHtml` L1305-1314 / `countWai` L1317-1319（`WAI_RE` L1300）/ `articleKeyFromUrl` L1322-1325
- `startBossBattle` L239-262 / `onBossBattleTap` L264-281（'wing' 分岐 L279）/ `challengePostBoss` L2644-2659
- `loadState` L938-953 / `saveState` L960-967 / `exportData` L970-981 / `importData` L985-1016
- `debugClear` L3782-3799（mode/player を残す）/ `deleteCreator` L3202-3219
- logic.js: factory L13-20、export return L111-末尾 / test: `test/favorites.test.js`（`node --test` スタイル）
