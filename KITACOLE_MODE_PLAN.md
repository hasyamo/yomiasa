# キタコレモード 実装計画（YOMIASA 第2弾）

> 別セッションで実装するための引き継ぎドキュメント。作成: 2026-06-06
> 更新: 2026-06-06（0.1.5「しおり機能」リリース後にコード現状へ追従。行番号・バージョン・関数シグネチャを更新）
>
> **行番号は app.js (0.1.5 = commit af3af37 時点) 基準。** 実装前に該当関数を grep で再確認すること（編集で必ずズレる）。

## 背景・文脈

- **第1弾（2026-06-06 公開済み）**: YOMIASA本体の紹介note記事「推しクリエイターの記事を初期からたどりたくて、YOMIASAを作った｜おはようカノジョ #180」(https://note.com/hasyamo/n/nc6178c9cfe10)。動機として「KITAさん(KITAcore)の月間ランキング上位を狙いたいから記事を読みたい」と言及済み＝伏線が張られた状態。
- **第2弾（これから）**: YOMIASAに「キタコレモード（ワイ語可視化）」を追加し、それをネタにした記事を出して **KITAさん本人をびっくりさせる**。
- **公開方針**: アプリのデプロイを**第2弾記事の公開と同時**に行う（サプライズの瞬間にアプリが動く状態にする）。
- **品質方針**: 単に動くだけでなく、**記事のスクショで映える**仕上がりにする（ワイ語数・関西度・日次グラフのビジュアル）。KITAさんが見て「自分の文章がこう遊ばれてて嬉しい」と感じる温度感を狙う。
- KITAさんは公開記事ほぼ全てで一人称「ワイ」を使う関西弁キャラ。初期記事では「ワイ」を使っていなかった疑いがあり、いつキャラが確立したかの可視化も面白いポイント。

## 記事公開時のTODO（月曜「キタコレだけレベルアップな件」）

> KITAさん本人の依頼・許可あり。記事は note 側の作業で、YOMIASA のコードには手を入れない。

- 記事内で、KITAさん自作のヴィラン6体（ボスキャラ）を紹介する。元ネタは KITAさんの記事「ヴィランを1体ずつ作っていたら、『終焉の評議会』みたいな絵ができた話」(#379, key=n30fd3f84486c)。6体: REAPER / ARMORED WARRIOR / CAEL NOX / WING OF DEATH / REQUIEM OF SHADOWS / ASHEN REAPER。
- **ヴィラン画像に KITAさんのアフィリエイトリンクを仕込む**: `https://amzn.to/4uufD4c`（= Aulumu G05 Air MagSafe リング, ブラック）。KITAさん本人からの依頼。
- リンクが**アフィリエイトだと分かる一言を添える**（読者への誠実さ ＋ Amazonアソシエイト規約「リンク先を誤認させない」）。画像とリンク先商品（MagSafeリング）は無関係なので明示は必須。KITAさんが普段使う「▼画像をクリックして〜」の導線スタイルに寄せると自然。
- **アプリ（YOMIASA）側にはアフィリンクを貼らない**（認証不要・広告なしの清潔なツールという性格を保つ）。リンクは記事のみ。
- 公開タイミング: アプリのデプロイ＝記事公開と同時（サプライズ）。

## 確定仕様

1. **クリエーター一覧の各カードに「キタコレモード」トグル**を設置（クリエーターごとにON/OFF、stateに保存）。ONのクリエーターだけ以下が有効＝KITAさん専用にできるが汎用性も残る。
2. キタコレモードONのクリエーターの**記事一覧で、記事ごとに「ワイ語」出現数を数字＋進捗バー**で表示。
3. **本文取得は「記事タップ時」**（rememberPendingArticleのフック）。タップ→裏で本文取得→カウント→localStorageにキャッシュ。読みに行くほど埋まるコレクション体験。未計測は「ワイ?」表示。本文HTMLは保存せずカウントのみ残す。
4. カウントは2系統: (a)「ワイ」単独 (b)関西語セット合計=「関西度」。両方保存・表示。
5. **記事一覧ヘッダーに、ワイ数の日次グラフ（記事の投稿日基準）**。計測済み記事だけプロット。外部ライブラリ無し（インラインSVG）。
6. モードOFF時は従来のYOMIASAと完全に同一動作（非破壊）。

## 確定仕様・第2版（2026-06-06 設計セッションで追加。俺レベ風 覚醒演出）

> 初期の「ワイ語可視化」に、ゲーム的な覚醒演出を上乗せした確定版。経緯・ネタの背景は KITACOLE_STORY_NOTES.md 参照。

### 発動・モード
- **note ID `ktcrs1107` 限定**。それ以外のクリエイターはダブルタップ無反応・金縁も出ない（汎用化しない）。
- 発動: クリエイター一覧カードの**プロフィールアイコンをダブルタップ** → アイコンの縁がゴールドに覚醒 → システムメッセージ表示 → ON。
- 解除: 再度ダブルタップ → 金縁解除 → 終了メッセージ → OFF。

### システムメッセージ演出
- 俺レベの「システム」風（無機質・`［ システム ］`・命令調）。
- **タイプライター表示**（1文字ずつ）。**画面タップで全文即表示（スキップ）**。
- プレイヤー名は **〈ktcrs1107〉固定**。
- ON例:「プレイヤー〈ktcrs1107〉が覚醒しました。」「『キタコレモード』が解放されました。」など（文面は後で磨く）。

### ランク（8段階）
`E級 → D級 → C級 → B級 → A級 → S級 → 国家級 → 君主（シャドウモナーク）`
俺レベ準拠。S級＝覚醒の到達点、君主＝最強・ラスボス格。

### 二部構成
- **第1部 覚醒前（クイズ修行編）**: ワイ語ほぼ無しの黎明期記事（〜2025.9、約57本）。**記事クイズ**で戦う。
- **覚醒（2025.10）**: 第1部のボスを倒し切ると **S級覚醒**。実データ上、ワイ語が爆発した月＝2025年10月に対応。演出の山場。
- **第2部 覚醒後（ワイ収集編）**: **ワイ語の累計**でランクアップ。クイズなし（＝これから先の新記事にクイズを作らなくてよい）。

### 鍵システム（軽め設計）
- **ボスのいない通常記事のクイズを正解 → 鍵を入手**（雑魚戦＝鍵稼ぎ）。
- **鍵を消費してボスに挑戦**。撃破でランクアップ＆次のボス解放。
- ランクに応じて挑戦できるボスに制限（低ランクは上位ボスに挑めない）。
- 難易度は**軽め**（KITAさん本人が試してもダレない量。スクショ映え優先）。最後のボス（覚醒/君主）だけ少し重くして達成感。レート例: クイズ1問正解＝鍵1つ、各ボス挑戦に鍵3つ前後、最終ボスのみ多め。

### ボス6体の配置（KITAさん自作ヴィラン「終焉六座」#379 / key=n30fd3f84486c）
| ランク | ヴィラン | 二つ名 |
|---|---|---|
| E級（最初の門番） | REAPER | 終焉の執行者 |
| C級 | ARMORED WARRIOR | 戦場の死 |
| A級（中盤の壁） | WING OF DEATH | 収穫の獣 |
| — S級覚醒 — | （ボスなし・覚醒演出） | |
| 国家級 | REQUIEM OF SHADOWS | 鎮魂の司祭 |
| 君主前 | CAEL NOX | 記憶する堕天使（エモ枠） |
| 君主（ラスボス） | ASHEN REAPER | 灰の審判者（最後に判決を下す者） |

- 覚醒前3体＝クイズ＋鍵で撃破 / 覚醒後3体＝ワイ語累計で挑戦。
- 画像はアプリ同梱（note直リンクは不安定）。要 WebP化・圧縮。**KITAさんの使用許可済み**。

### 記事一覧の演出（光）
- クイズがある記事 = ほんのり光る（読む価値の示唆）。
- ボス戦がある記事 = より強く光る（節目）。
- 実装は 0.1.5 の栞マーク同様、記事に状態クラスを付けて box-shadow/グローで段階表現。

### 未確定（次に詰める）
- ワイ語累計→覚醒後ランク（S/国家級/君主）の具体的閾値。現状の累計≒1774を使い「全部読むと君主の一歩手前」等に調整可。
- クイズの形式（選択式/一問一答）、覚醒前ボス3体に紐づく問題の作成（黎明期57記事から出題）。
- 鍵レートの最終数値。

## アプリ現状（確認済みの実コード / 0.1.5 時点）

- app.js は IIFE。状態は localStorage('yomiasa:v0')。state構造: `{creators:[], selectedCreatorId, articlesByCreator:{}, readArticles:{}, uiState:{}, uiByCreator:{}}`
  - ※ `uiByCreator` は 0.1.5 で追加（年月/未読のみ/ソート順をクリエイター別に記憶）。`kitacole` を足す際は **`uiByCreator` の追加実装が良い手本**（`defaultState`(33)・`loadState`(111)・`importData`(159)・`deleteCreator`(1723) の4箇所で拾う/掃除するパターンを踏襲）。
- note APIは CORSプロキシ(PROXY_URL = Cloudflare Worker `https://falling-mouse-736b.hasyamo.workers.dev/`, app.js:14)経由。任意の note APIパスは `PROXY_URL + '?path=' + encodeURIComponent(notePath)` で中継（記事一覧の `buildContentsUrl`(253) 内 265 行がこの組み方の実例。本文取得用の専用ヘルパは未定義なので Step 2 で同形に組む）。本文は `/api/v3/notes/{key}` で取得（`data.body` にHTML、※実機で1件叩いて要確認＝リスク2）。
- `normalizeArticle`(268) は `key` を保存していない。article.url = `https://note.com/{creatorId}/n/{key}` 固定形式なのでURLからスラッグ抽出可能 → normalizeArticle改修不要。
- 記事描画: `renderArticles`(1086), 1記事=`articleEl(article, creatorId, isBookmark)`(1138) ← **0.1.5 で第3引数 `isBookmark` 追加**。タップで `rememberPendingArticle(creatorId, article)`(1662) を呼ぶ（中身は sessionStorage 保存のみ＝フック追加先として無害）。
- 戻り処理: `handleReturn`(1687)。ヘッダー集計: `renderReadHeaderStats`(1237)/`renderReadView`(926)。カード描画: `renderCreatorCards`(769)/`creatorCardEl`(776)。既読: isRead/setRead(407,413)。
- **0.1.5 由来の重要な変更**: 既読チップ操作・フィルタ変更で `renderArticles()` が**全再描画**される作りに倒れた（しおり=未読最古を毎回再計算するため）。`articleEl` 内 meta(1201) に既読チップ(1208)が並ぶ。→ キタコレの行内ワイ表示も、軽量更新にこだわらず全再描画に乗せる方が整合する（リスク6を参照）。

## 実装手順（最小追加・大改造なし）

### Step 1: state初期化
- `defaultState`(33) に `kitacole: { counts: {} }` を追加。
- `ensureKitacole()` ヘルパを追加（`state.kitacole`/`.counts` の遅延初期化）。`loadState`(111)・`importData`(159) でも新キーを拾う（0.1.5 の `uiByCreator` の拾い方が手本＝`incoming.kitacole && typeof ... === 'object' ? ... : base.kitacole`）。export は state丸ごとなので自動。
- **migrate不要**（article構造を触らない。`creator.kitacole` は `!!c.kitacole` で読めば未定義=OFF）。

### Step 2: カウントロジック（読了セクション ＝ isRead/setRead 407〜 の後ろに新セクション）
- 定数 `WAI_RE = /ワイ/g`、`KANSAI_WORDS`（正規表現配列）。
- `stripHtml(html)`: `replace(/<[^>]*>/g,'')` ＋ 最低限の実体参照デコード。
- `countWai(text)` / `countKansai(text)`: `(text.match(re)||[]).length` を合算。
- `articleKeyFromUrl(url)`: `url.match(/\/n\/([A-Za-z0-9]+)/)`。
- `fetchAndCountArticle(article)`: 計測済みskip / in-flight Setで二重発火防止 / `fetch(PROXY_URL+'?path='+encodeURIComponent('/api/v3/notes/'+key))` → `json.data.body` → strip → count → `state.kitacole.counts[article.id]={wai,kansai,countedAt}` → saveState → 表示中なら該当行とグラフを軽量更新。`body`が文字列でなければ握りつぶし未計測のまま。

関西語セット案（誤爆少なめの初期リスト。後追い調整可）:
`ワイ / せや / ほんま / やで / めっちゃ / ちゃう / あかん / なんでやねん / おる / しはる / おおきに / かまへん`。
「〜や」断定は誤爆多いので初期は句読点直前の `や[。、！？\n]` のみ緩く拾うか、外す。

### Step 3: タップフック（`rememberPendingArticle` 1662 末尾）
ON かつ未計測なら `fetchAndCountArticle(article)` を **awaitせず**発火（既存遷移をブロックしない）。現状この関数は sessionStorage 保存のみなので、末尾に1行足すだけで安全。

### Step 4: カードにトグル（`creatorCardEl` 776、編集/削除ボタン付近）
`c.kitacole` の真偽で表示切替、クリックで反転→saveState→`renderCreatorCards()`(769)。

### Step 5: 記事行にワイ表示（`articleEl(article, creatorId, isBookmark)` 1138）
`on = !!getCreator(creatorId).kitacole` のときだけ meta(1201) に「ワイ N / 関西度 M」+ 専用ミニ進捗バーを追加（`progressBarEl`は既読率専用なので流用せず軽量バーを新設）。未計測は「ワイ?」。OFF時は生成しない。既読チップ(1208)の隣に並べる想定。

### Step 6: ヘッダー日次グラフ（`renderReadHeaderStats` 1237 / `renderReadView` 926）
- index.html `#read-progress`(98) 直後に `<div id="kitacole-graph" class="kitacole-graph hidden">` を追加、els に登録。
  - 注: `#read-progress` は **read-sticky 内**（固定ヘッダー）。グラフをここに入れると固定ヘッダーが高くなり、0.1.5 で入れた「続きから」スクロール時のオフセット（`scrollToBookmark` が `.read-sticky` の実高さを毎回実測）に自動追従するので破綻はしないが、ヘッダーが縦に伸びる点は留意。記事一覧が窮屈なら sticky 外（`.filters` 付近）に置く案も。
- `renderKitacoleGraph(creatorId)`: ON かつ計測済み2件以上で、counts持ち記事を publishedAt 日次集計→インラインSVG棒グラフ。OFF/データ不足なら hidden。`renderReadView` と Step2の計測完了後に呼ぶ。SVGに `role="img"` ＋ aria-label。

### Step 7: CSS（style.css 末尾、既存トークン使用）
`.kitacole-toggle` / `.article-wai` / `.kitacole-bar` / `.kitacole-graph`。必要なら `:root`(1) に1変数。

### Step 8: バージョン/キャッシュ更新（リリース時・忘れるとSWが旧JSを返す）
**0.1.5 は「しおり機能」で消費済み。キタコレモードは 0.1.6 以降。** 6箇所をまとめて更新:
- app.js `APP_VERSION`(22)
- sw.js `CACHE`(5)
- sw.js SHELL の `./style.css?v=`(13)・`./app.js?v=`(14)
- index.html `style.css?v=`(48)・`app.js?v=`(293)
- updates.json 先頭に新バージョンのお知らせを追加
（0.1.5 の commit af3af37 がこの6箇所更新の実例。同じ要領で。）

## リスク・注意点

1. プロキシ負荷: タップ毎に本文取得。計測済みskip＋in-flight Setで多重発火防止。
2. `data.body` の形式は実機未確認 → 防御コード必須、まず1件叩いて確認。
3. URLスラッグ抽出失敗時は計測スキップ。
4. saveState頻度（毎計測でlocalStorage全書き）→ 重ければデバウンス。
5. `deleteCreator`(1723) は creator削除時に `readArticles`・`articlesByCreator`・`uiByCreator` を掃除済み。`kitacole.counts` も同様に掃除を1行足す（counts は article.id 単位なので残っても無害だが、揃える）。
6. 再描画コスト → **0.1.5 でしおり実装により `renderArticles()` は全再描画方針になった**（チップ操作・フィルタ変更で毎回フル再描画）。当初プランの「該当行DOMだけ差し替え」は今のコードと逆。キタコレの行内ワイ表示も全再描画に乗せれば整合する。記事数が多いクリエイター（KITAさんは約400件）で体感が重ければ、しおり側ともども差分更新を別途検討。

## 改修規模
app.js: 新セクション約80-120行＋既存4関数への小フック。index.html: 1要素＋els 2行。style.css: 30-50行。**大改造なし**。

## 倫理メモ
KITAさんの記事本文を取得・解析するアプリを公開する点。仲良い相手への遊び心あるネタとして歓迎される前提だが、本人の受け取り方は配慮する（公開前に一声かけるか、サプライズの温度感を見極める）。
