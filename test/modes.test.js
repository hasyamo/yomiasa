/*
 * モードエンジン（キタコレ等）純ロジックのテスト。
 * 実行: npm test   （= node --test）
 *
 * ここで守るのは「キタコレモードの挙動を1バイトも変えない」核の部分。
 * app.js の切り出し元と同一入出力であること（ゴールデン）を機械的に固定する。
 * UI/見た目は TESTING.md のチェックリスト（手動＋AI検証）でカバーする。
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

// app.js の定数と同一（ゴールデン基準）。
const RANKS = [
  { rank: 'S級覚醒', key: 's', min: 0, bossKey: null },
  { rank: '国家級', key: 'national', min: 600, bossKey: 'requiem' },
  { rank: '君主前', key: 'lord-prev', min: 1200, bossKey: 'cael' },
  { rank: '君主', key: 'monarch', min: 2000, bossKey: 'ashen' },
];
const POST_BOSSES = [
  { key: 'requiem', name: 'REQUIEM OF SHADOWS', rankAfter: '国家級' },
  { key: 'cael', name: 'CAEL NOX', rankAfter: '君主前' },
  { key: 'ashen', name: 'ASHEN REAPER', rankAfter: '君主' },
];
const PRE_BOSSES = [
  { key: 'reaper', rankBefore: 'E級', rankBeforeKey: 'e', rankAfter: 'C級' },
  { key: 'armored', rankBefore: 'C級', rankBeforeKey: 'c', rankAfter: 'A級' },
  { key: 'wing', rankBefore: 'A級', rankBeforeKey: 'a', rankAfter: 'S級覚醒' },
];

// ============================================================================
// A群: 完全純粋（そのまま移設）
// ============================================================================

test('stripHtml: タグ除去 + 実体参照デコード', () => {
  assert.strictEqual(L.stripHtml('<b>あ</b>&amp;い'), 'あ&い');
  assert.strictEqual(L.stripHtml('&lt;&gt;&nbsp;&quot;&#39;'), '<> "\'');
});

test('stripHtml: 非文字列は String() 挙動を維持', () => {
  assert.strictEqual(L.stripHtml(null), 'null');
  assert.strictEqual(L.stripHtml(undefined), 'undefined');
  assert.strictEqual(L.stripHtml(123), '123');
});

test('countWai: 出現数を数える', () => {
  assert.strictEqual(L.countWai('ワイワイ'), 2);
  assert.strictEqual(L.countWai('なし'), 0);
  assert.strictEqual(L.countWai(''), 0);
  assert.strictEqual(L.countWai('ワイはワイやで、ワイ'), 3);
});

test('countWai: 連続呼び出しで同値（lastIndex 事故がないこと）', () => {
  const s = 'ワイワイワイ';
  const first = L.countWai(s);
  assert.strictEqual(first, 3);
  // g フラグ共有インスタンスなら lastIndex 残留で 2回目以降がズレる。関数内リテラルなら不変。
  assert.strictEqual(L.countWai(s), 3);
  assert.strictEqual(L.countWai(s), 3);
  assert.strictEqual(L.countWai(s), 3);
});

test('countWai: 非文字列でも落ちない', () => {
  assert.strictEqual(L.countWai(null), 0);
  assert.strictEqual(L.countWai(undefined), 0);
});

test('articleKeyFromUrl: /n/ 以降のスラッグを抜く', () => {
  assert.strictEqual(L.articleKeyFromUrl('https://note.com/x/n/nabc123'), 'nabc123');
});

test('articleKeyFromUrl: /n/ が無ければ null（現行正規表現に従う）', () => {
  assert.strictEqual(L.articleKeyFromUrl('https://note.com/x/nabc123'), null);
  assert.strictEqual(L.articleKeyFromUrl(null), null);
  assert.strictEqual(L.articleKeyFromUrl(''), null);
  assert.strictEqual(L.articleKeyFromUrl(undefined), null);
});

// ============================================================================
// B群: 配列/フラグを引数化して純化
// ============================================================================

test('kitacoreWaiRankOf: ワイ数から閾値ランク', () => {
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 0).rank, 'S級覚醒');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 599).rank, 'S級覚醒');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 600).rank, '国家級');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 1199).rank, '国家級');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 1200).rank, '君主前');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 1999).rank, '君主前');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 2000).rank, '君主');
  assert.strictEqual(L.kitacoreWaiRankOf(RANKS, 99999).rank, '君主');
});

test('kitacoreRankOf: 撃破ベースで導出（ワイ数無関係）', () => {
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, []).rank, 'S級覚醒');
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, ['requiem']).rank, '国家級');
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, ['requiem', 'cael']).rank, '君主前');
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, ['requiem', 'cael', 'ashen']).rank, '君主');
});

test('kitacoreRankOf: 順番が飛んでいても最上位を採用（[cael]のみでも君主前）', () => {
  // requiem 未撃破でも cael 撃破済みなら君主前（撃破集合の最上位で決まる）。
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, ['cael']).rank, '君主前');
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, ['ashen']).rank, '君主');
});

test('kitacoreRankOf: defeated が配列でなくても落ちない', () => {
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, null).rank, 'S級覚醒');
  assert.strictEqual(L.kitacoreRankOf(RANKS, POST_BOSSES, undefined).rank, 'S級覚醒');
});

test('isPostAwakening: awakenBossKey 撃破で true', () => {
  assert.strictEqual(L.isPostAwakening(['reaper', 'armored', 'wing'], 'wing'), true);
  assert.strictEqual(L.isPostAwakening(['reaper'], 'wing'), false);
  assert.strictEqual(L.isPostAwakening([], 'wing'), false);
});

test('isPostAwakening: awakenBossKey==null なら常に false（覚醒概念なしモード）', () => {
  assert.strictEqual(L.isPostAwakening(['wing'], null), false);
  assert.strictEqual(L.isPostAwakening(['wing'], undefined), false);
  assert.strictEqual(L.isPostAwakening([], null), false);
});

test('isPostAwakening: creatorId 文字列を渡さない回帰（配列でなければ false）', () => {
  // 誤って creatorId('ktcrs1107wing' 等)を渡しても String.indexOf 誤判定にならないこと。
  assert.strictEqual(L.isPostAwakening('ktcrs1107wing', 'wing'), false);
  assert.strictEqual(L.isPostAwakening('wing', 'wing'), false);
});

test('nextPreBoss: 未撃破の先頭を返す', () => {
  assert.strictEqual(L.nextPreBoss(PRE_BOSSES, []).key, 'reaper');
  assert.strictEqual(L.nextPreBoss(PRE_BOSSES, ['reaper']).key, 'armored');
  assert.strictEqual(L.nextPreBoss(PRE_BOSSES, ['reaper', 'armored']).key, 'wing');
  assert.strictEqual(L.nextPreBoss(PRE_BOSSES, ['reaper', 'armored', 'wing']), null);
});

test('nextPreBoss: 戻り値は rankBefore/rankBeforeKey を含む（覚醒前ランク導出元）', () => {
  const b = L.nextPreBoss(PRE_BOSSES, []);
  assert.strictEqual(b.rankBefore, 'E級');
  assert.strictEqual(b.rankBeforeKey, 'e');
  const b2 = L.nextPreBoss(PRE_BOSSES, ['reaper']);
  assert.strictEqual(b2.rankBefore, 'C級');
  assert.strictEqual(b2.rankBeforeKey, 'c');
});

test('nextPreBoss: defeated が配列でなくても先頭を返す', () => {
  assert.strictEqual(L.nextPreBoss(PRE_BOSSES, null).key, 'reaper');
});

// ============================================================================
// C群: クイズ（正規化＝ジュリ確定形）
// ============================================================================

test('normalizeQuiz: answer:index 形式を変換', () => {
  const raw = { q: '問？', choices: ['A', 'B', 'C', 'D'], answer: 2 };
  const n = L.normalizeQuiz(raw);
  assert.strictEqual(n.q, '問？');
  assert.strictEqual(n.choices.length, 4);
  assert.strictEqual(n.choices[2].result, 'success');
  assert.strictEqual(n.choices[0].result, 'wrong');
  assert.strictEqual(n.choices[1].result, 'wrong');
  assert.strictEqual(n.choices[3].result, 'wrong');
  n.choices.forEach((c) => assert.strictEqual(c.reaction, ''));
});

test('normalizeQuiz: 並び順は変えない（シャッフルは app 側の責務）', () => {
  const raw = { q: 'q', choices: ['A', 'B', 'C', 'D'], answer: 2 };
  const n = L.normalizeQuiz(raw);
  assert.deepStrictEqual(n.choices.map((c) => c.text), ['A', 'B', 'C', 'D']);
});

test('normalizeQuiz: 新形式（result/reaction 直書き）はそのまま採用', () => {
  const raw = {
    q: 'q',
    choices: [
      { text: 'A', result: 'wrong', reaction: 'ちがう' },
      { text: 'B', result: 'success', reaction: 'せいかい' },
      { text: 'C', result: 'wrong_funny', reaction: 'おもしろ' },
    ],
  };
  const n = L.normalizeQuiz(raw);
  assert.strictEqual(n.choices[0].result, 'wrong');
  assert.strictEqual(n.choices[0].reaction, 'ちがう');
  assert.strictEqual(n.choices[1].result, 'success');
  assert.strictEqual(n.choices[2].result, 'wrong_funny');
  assert.strictEqual(n.choices[2].reaction, 'おもしろ');
});

test('normalizeQuiz: answer 範囲外は全 wrong（例外を出さない）', () => {
  const n = L.normalizeQuiz({ q: 'q', choices: ['A', 'B', 'C'], answer: 9 });
  assert.deepStrictEqual(n.choices.map((c) => c.result), ['wrong', 'wrong', 'wrong']);
  const n2 = L.normalizeQuiz({ q: 'q', choices: ['A', 'B'] }); // answer 無し
  assert.deepStrictEqual(n2.choices.map((c) => c.result), ['wrong', 'wrong']);
});

test('normalizeQuiz: null/不正でも落ちない', () => {
  assert.deepStrictEqual(L.normalizeQuiz(null), { q: '', choices: [] });
  assert.deepStrictEqual(L.normalizeQuiz(undefined), { q: '', choices: [] });
  assert.deepStrictEqual(L.normalizeQuiz({}), { q: '', choices: [] });
});

test('normalizeQuizMap: マップ内を全件 normalize', () => {
  const raw = {
    nabc: { q: 'q1', choices: ['A', 'B'], answer: 0 },
    ndef: { q: 'q2', choices: ['X', 'Y'], answer: 1 },
  };
  const m = L.normalizeQuizMap(raw);
  assert.strictEqual(m.nabc.choices[0].result, 'success');
  assert.strictEqual(m.ndef.choices[1].result, 'success');
});

test('normalizeQuizMap: null/undefined は {}', () => {
  assert.deepStrictEqual(L.normalizeQuizMap(null), {});
  assert.deepStrictEqual(L.normalizeQuizMap(undefined), {});
  assert.deepStrictEqual(L.normalizeQuizMap({}), {});
});

test('quizForArticle: スラッグで引く（quizzes 引数）', () => {
  const quizzes = { nabc: { q: 'q', choices: ['A'] } };
  const quiz = L.quizForArticle(quizzes, { url: 'https://note.com/x/n/nabc' });
  assert.strictEqual(quiz.q, 'q');
});

test('quizForArticle: null 安全', () => {
  assert.strictEqual(L.quizForArticle(null, { url: 'https://note.com/x/n/nabc' }), null);
  assert.strictEqual(L.quizForArticle({}, { url: 'https://note.com/x/n/nabc' }), null);
  assert.strictEqual(L.quizForArticle({ nabc: {} }, null), null);
  assert.strictEqual(L.quizForArticle({ nabc: {} }, {}), null); // url 無し
});

test('quizChoiceOutcome: シャッフル後 index から result', () => {
  const n = L.normalizeQuiz({ q: 'q', choices: ['A', 'B', 'C', 'D'], answer: 2 });
  assert.strictEqual(L.quizChoiceOutcome(n, 2), 'success');
  assert.strictEqual(L.quizChoiceOutcome(n, 0), 'wrong');
  assert.strictEqual(L.quizChoiceOutcome(n, 1), 'wrong');
});

test('quizChoiceOutcome: 範囲外 index は wrong（防御）', () => {
  const n = L.normalizeQuiz({ q: 'q', choices: ['A', 'B'], answer: 0 });
  assert.strictEqual(L.quizChoiceOutcome(n, 9), 'wrong');
  assert.strictEqual(L.quizChoiceOutcome(n, -1), 'wrong');
  assert.strictEqual(L.quizChoiceOutcome({}, 0), 'wrong');
  assert.strictEqual(L.quizChoiceOutcome(null, 0), 'wrong');
});

test('quizChoiceOutcome: wrong_funny も返せる', () => {
  const n = L.normalizeQuiz({
    q: 'q',
    choices: [{ text: 'A', result: 'wrong_funny', reaction: '' }],
  });
  assert.strictEqual(L.quizChoiceOutcome(n, 0), 'wrong_funny');
});

// ============================================================================
// D群: マイグレーション純粋部分
// ============================================================================

test('migrateModes: 旧フラット kitacore を modes.kitacore へ移送', () => {
  assert.deepStrictEqual(
    L.migrateModes({ kitacore: { totalWai: 5 } }),
    { kitacore: { totalWai: 5 } }
  );
});

test('migrateModes: 新 modes が勝つ（冪等・二重化なし）', () => {
  const out = L.migrateModes({
    modes: { kitacore: { totalWai: 9 } },
    kitacore: { totalWai: 5 },
  });
  assert.deepStrictEqual(out, { kitacore: { totalWai: 9 } });
});

test('migrateModes: 既に移行済み（modes のみ）はそのまま返す（冪等）', () => {
  const already = { kitacore: { totalWai: 9 } };
  const out = L.migrateModes({ modes: already });
  assert.deepStrictEqual(out, already);
  // 冪等: 出力を再度通しても不変。
  assert.deepStrictEqual(L.migrateModes({ modes: out }), already);
});

test('migrateModes: {} 入力は {}', () => {
  assert.deepStrictEqual(L.migrateModes({}), {});
  assert.deepStrictEqual(L.migrateModes(null), {});
  assert.deepStrictEqual(L.migrateModes(undefined), {});
});

test('migrateModes: 進行データ（keys/defeatedBosses/player）を保持', () => {
  const parsed = {
    kitacore: {
      totalWai: 1234,
      keys: { ktcrs1107: 2 },
      defeatedBosses: { ktcrs1107: ['reaper', 'armored', 'wing'] },
      player: { id: 'me', displayName: '僕', iconUrl: 'x' },
      quizCleared: { a1: true },
      quizTaps: 7,
    },
  };
  const out = L.migrateModes(parsed);
  assert.strictEqual(out.kitacore.totalWai, 1234);
  assert.deepStrictEqual(out.kitacore.keys, { ktcrs1107: 2 });
  assert.deepStrictEqual(out.kitacore.defeatedBosses, { ktcrs1107: ['reaper', 'armored', 'wing'] });
  assert.deepStrictEqual(out.kitacore.player, { id: 'me', displayName: '僕', iconUrl: 'x' });
  assert.strictEqual(out.kitacore.quizCleared.a1, true);
  assert.strictEqual(out.kitacore.quizTaps, 7);
});

test('migrateModes: 非破壊（入力を書き換えない）', () => {
  const parsed = { modes: { nenkoro: { x: 1 } }, kitacore: { totalWai: 5 } };
  const before = JSON.stringify(parsed);
  L.migrateModes(parsed);
  assert.strictEqual(JSON.stringify(parsed), before);
});

test('migrateModes: 他モードが既にある modes へ旧 kitacore を足す', () => {
  const out = L.migrateModes({
    modes: { nenkoro: { x: 1 } },
    kitacore: { totalWai: 5 },
  });
  assert.deepStrictEqual(out, { nenkoro: { x: 1 }, kitacore: { totalWai: 5 } });
});

test('modeForCreator: targetCreatorId 逆引き', () => {
  const MODE_DEFS = {
    kitacore: { key: 'kitacore', targetCreatorId: 'ktcrs1107' },
    nenkoro: { key: 'nenkoro', targetCreatorId: 'nenko99' },
  };
  assert.strictEqual(L.modeForCreator(MODE_DEFS, 'ktcrs1107').key, 'kitacore');
  assert.strictEqual(L.modeForCreator(MODE_DEFS, 'nenko99').key, 'nenkoro');
  assert.strictEqual(L.modeForCreator(MODE_DEFS, 'other'), null);
});

test('modeForCreator: null/不正でも落ちない', () => {
  assert.strictEqual(L.modeForCreator(null, 'x'), null);
  assert.strictEqual(L.modeForCreator({}, 'x'), null);
  assert.strictEqual(L.modeForCreator(undefined, 'x'), null);
});

// ============================================================================
// E群: 状態遷移（次状態の計算のみ・非破壊）
// ============================================================================

const CID = 'ktcrs1107';

test('awardKeyOutcome: 未クリアで鍵+1・quizCleared 立つ', () => {
  const out = L.awardKeyOutcome({}, {}, CID, 'a1');
  assert.strictEqual(out.nextQuizCleared['a1'], true);
  assert.strictEqual(out.nextKeys[CID], 1);
});

test('awardKeyOutcome: 既存鍵に +1（現在値||0 起点）', () => {
  const out = L.awardKeyOutcome({}, { [CID]: 2 }, CID, 'a1');
  assert.strictEqual(out.nextKeys[CID], 3);
});

test('awardKeyOutcome: クリア済みは null（no-op）', () => {
  assert.strictEqual(L.awardKeyOutcome({ a1: true }, { [CID]: 5 }, CID, 'a1'), null);
});

test('awardKeyOutcome: 非破壊（入力を書き換えない）', () => {
  const quizCleared = {};
  const keys = { [CID]: 0 };
  const out = L.awardKeyOutcome(quizCleared, keys, CID, 'a1');
  assert.deepStrictEqual(quizCleared, {}); // 入力そのまま
  assert.deepStrictEqual(keys, { [CID]: 0 });
  assert.notStrictEqual(out.nextQuizCleared, quizCleared); // 新オブジェクト
  assert.notStrictEqual(out.nextKeys, keys);
});

test('challengeBossOutcome: 鍵不足で ok:false', () => {
  const boss = { key: 'reaper', cost: 3 };
  assert.deepStrictEqual(L.challengeBossOutcome({ [CID]: 2 }, {}, CID, boss), { ok: false });
});

test('challengeBossOutcome: 足りれば消費・defeated 追加', () => {
  const boss = { key: 'reaper', cost: 3 };
  const out = L.challengeBossOutcome({ [CID]: 3 }, {}, CID, boss);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextKeys[CID], 0); // 3 - 3
  assert.deepStrictEqual(out.nextDefeated[CID], ['reaper']);
});

test('challengeBossOutcome: 既存 defeated に追加（先勝ちを消さない）', () => {
  const boss = { key: 'armored', cost: 3 };
  const out = L.challengeBossOutcome({ [CID]: 5 }, { [CID]: ['reaper'] }, CID, boss);
  assert.strictEqual(out.nextKeys[CID], 2); // 5 - 3
  assert.deepStrictEqual(out.nextDefeated[CID], ['reaper', 'armored']);
});

test('challengeBossOutcome: 鍵ちょうど（cost と同数）は挑戦可', () => {
  const boss = { key: 'reaper', cost: 3 };
  const out = L.challengeBossOutcome({ [CID]: 3 }, {}, CID, boss);
  assert.strictEqual(out.ok, true); // cur === cost は < でないので挑戦可
  assert.strictEqual(out.nextKeys[CID], 0);
});

test('challengeBossOutcome: 非破壊（入力を書き換えない）', () => {
  const boss = { key: 'reaper', cost: 3 };
  const keys = { [CID]: 3 };
  const defeated = { [CID]: [] };
  const out = L.challengeBossOutcome(keys, defeated, CID, boss);
  assert.deepStrictEqual(keys, { [CID]: 3 });
  assert.deepStrictEqual(defeated, { [CID]: [] });
  assert.notStrictEqual(out.nextKeys, keys);
  assert.notStrictEqual(out.nextDefeated[CID], defeated[CID]);
});

test('collectWaiOutcome: counts 無しは ok:false', () => {
  const r = L.collectWaiOutcome(RANKS, POST_BOSSES, {}, {}, 0, 'a1');
  assert.deepStrictEqual(r, { ok: false });
});

test('collectWaiOutcome: collected 済みは ok:false', () => {
  const r = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 10 } }, { a1: true }, 0, 'a1');
  assert.deepStrictEqual(r, { ok: false });
});

test('collectWaiOutcome: wai<=0 は ok:false', () => {
  const r = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 0 } }, {}, 0, 'a1');
  assert.deepStrictEqual(r, { ok: false });
});

test('collectWaiOutcome: 回収可で totalWai 加算・collected 立つ', () => {
  const out = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 50 } }, {}, 100, 'a1');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextTotalWai, 150);
  assert.strictEqual(out.nextCollected['a1'], true);
  assert.strictEqual(out.summonBossKey, null); // 閾値跨がず
});

test('collectWaiOutcome: 閾値跨ぎ(599→600)でのみ summonBossKey', () => {
  const out = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 1 } }, {}, 599, 'a1');
  assert.strictEqual(out.nextTotalWai, 600);
  assert.strictEqual(out.summonBossKey, 'requiem'); // 国家級ボス
});

test('collectWaiOutcome: 閾値を跨がなければ summonBossKey は null', () => {
  const out = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 1 } }, {}, 597, 'a1');
  assert.strictEqual(out.nextTotalWai, 598);
  assert.strictEqual(out.summonBossKey, null);
});

test('collectWaiOutcome: 閾値通過後の同一ランク内(600→601)は再出現しない', () => {
  const out = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 1 } }, {}, 600, 'a1');
  assert.strictEqual(out.nextTotalWai, 601);
  assert.strictEqual(out.summonBossKey, null); // 既に国家級圏内、跨がないので再召喚なし
});

test('collectWaiOutcome: 1200 跨ぎで cael、2000 跨ぎで ashen', () => {
  const a = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 1 } }, {}, 1199, 'a1');
  assert.strictEqual(a.summonBossKey, 'cael');
  const b = L.collectWaiOutcome(RANKS, POST_BOSSES, { a1: { wai: 1 } }, {}, 1999, 'a1');
  assert.strictEqual(b.summonBossKey, 'ashen');
});

test('collectWaiOutcome: 非破壊（入力を書き換えない）', () => {
  const counts = { a1: { wai: 50 } };
  const collected = {};
  L.collectWaiOutcome(RANKS, POST_BOSSES, counts, collected, 100, 'a1');
  assert.deepStrictEqual(collected, {}); // 入力そのまま
  assert.deepStrictEqual(counts, { a1: { wai: 50 } });
});

test('canSummonPostBoss: 撃破済みは出さない（null）', () => {
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, ['requiem'], null, 'requiem'), null);
});

test('canSummonPostBoss: pending 中は上書きしない（null）', () => {
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, [], 'requiem', 'cael'), null);
});

test('canSummonPostBoss: 順序ガード — 中間ボス未撃破なら ashen は出ない', () => {
  // 2000ワイ相当でも requiem/cael 未撃破なら ashen(index2) は出せない
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, [], null, 'ashen'), null);
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, ['requiem'], null, 'ashen'), null);
});

test('canSummonPostBoss: 先頭ボス(requiem)は前提なしで出る', () => {
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, [], null, 'requiem'), 'requiem');
});

test('canSummonPostBoss: 前が全撃破済みなら出る', () => {
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, ['requiem'], null, 'cael'), 'cael');
  assert.strictEqual(
    L.canSummonPostBoss(POST_BOSSES, ['requiem', 'cael'], null, 'ashen'),
    'ashen'
  );
});

test('canSummonPostBoss: defeated が配列でなくても落ちない', () => {
  assert.strictEqual(L.canSummonPostBoss(POST_BOSSES, null, null, 'requiem'), 'requiem');
});

// ============================================================================
// F群: ニゲキレモード純ロジック（フェーズ1）
//   確定値: 生活ランク §10.5 / キャラ称号 §10.6 / ポイント §10.2,§10.4
// ============================================================================

// app.js の MODE_DEFS.nigekire に載る想定のゴールデン定数（曜日順固定）。
const NIGEKIRE_CHARACTERS = [
  { key: 'tsukiko', weekday: 'mon', name: '月子' },
  { key: 'you', weekday: 'tue', name: '陽' },
  { key: 'shizuku', weekday: 'wed', name: 'しずく' },
  { key: 'rinka', weekday: 'thu', name: '凛華' },
  { key: 'runa', weekday: 'fri', name: 'るな' },
  { key: 'mahiru', weekday: 'sat', name: 'まひる' },
  { key: 'hiyori', weekday: 'sun', name: '日和' },
];
// 生活ランク（総ポイント判定4段階・§10.5）
const NIGEKIRE_LIFE_RANKS = [
  { stage: 1, name: '言い訳見習い', min: 0 },
  { stage: 2, name: '生活防衛中', min: 30 },
  { stage: 3, name: '火種処理係', min: 70 },
  { stage: 4, name: 'おはカノ生活継続者', min: 120 },
];
// キャラ別称号（キャラ別ポイント判定4段階・§10.6）
const NIGEKIRE_TITLE_TABLE = {
  thresholds: [0, 10, 25, 45],
  names: {
    tsukiko: ['呼び止められ中', '説明準備中', '予定確認済み', '月曜逃げ切り'],
    you: ['勢いで弁明中', '笑ってごまかし中', '火曜突破中', '火曜逃げ切り'],
    shizuku: ['そっと確認中', '迷い回収中', '静かに通過中', '水曜逃げ切り'],
    rinka: ['見られてる', '言い訳審査中', '別に許してない', '木曜逃げ切り'],
    runa: ['追いかけられ中', '全力弁明中', '勢いで突破中', '金曜逃げ切り'],
    mahiru: ['寝たふり中', '見抜かれ中', 'まだ許され中', '土曜逃げ切り'],
    hiyori: ['やさしく確認中', '生活立て直し中', 'そっと通過中', '日曜逃げ切り'],
  },
};
// ポイント表（火種ランク×通常/一発・§10.2）
const NIGEKIRE_POINTS = {
  light: [1, 2],
  medium: [2, 3],
  heavy: [3, 4],
};

// ---- weekdayOf（published_at → JST曜日） ----

test('weekdayOf: 日付文字列からJST曜日を求める（7通り）', () => {
  // 2025-12-15(月) 起点に7日ぶん。JST の暦日で判定。
  assert.strictEqual(L.weekdayOf('2025-12-15'), 'mon');
  assert.strictEqual(L.weekdayOf('2025-12-16'), 'tue');
  assert.strictEqual(L.weekdayOf('2025-12-17'), 'wed');
  assert.strictEqual(L.weekdayOf('2025-12-18'), 'thu');
  assert.strictEqual(L.weekdayOf('2025-12-19'), 'fri');
  assert.strictEqual(L.weekdayOf('2025-12-20'), 'sat');
  assert.strictEqual(L.weekdayOf('2025-12-21'), 'sun');
});

test('weekdayOf: JST境界（UTC前日夜→JST当日）でも曜日がずれない', () => {
  // 2025-12-14T23:00:00Z は JST では 2025-12-15 08:00（月曜）。
  assert.strictEqual(L.weekdayOf('2025-12-14T23:00:00Z'), 'mon');
  // 2025-12-15T00:00:00+09:00（JST月曜0時）も月曜。
  assert.strictEqual(L.weekdayOf('2025-12-15T00:00:00+09:00'), 'mon');
});

test('weekdayOf: パース不能は null', () => {
  assert.strictEqual(L.weekdayOf(''), null);
  assert.strictEqual(L.weekdayOf(null), null);
  assert.strictEqual(L.weekdayOf('not-a-date'), null);
});

// ---- weekdayCharOf（曜日→キャラ7通り） ----

test('weekdayCharOf: 7曜日→担当キャラ', () => {
  assert.strictEqual(L.weekdayCharOf('mon', NIGEKIRE_CHARACTERS).name, '月子');
  assert.strictEqual(L.weekdayCharOf('tue', NIGEKIRE_CHARACTERS).name, '陽');
  assert.strictEqual(L.weekdayCharOf('wed', NIGEKIRE_CHARACTERS).name, 'しずく');
  assert.strictEqual(L.weekdayCharOf('thu', NIGEKIRE_CHARACTERS).name, '凛華');
  assert.strictEqual(L.weekdayCharOf('fri', NIGEKIRE_CHARACTERS).name, 'るな');
  assert.strictEqual(L.weekdayCharOf('sat', NIGEKIRE_CHARACTERS).name, 'まひる');
  assert.strictEqual(L.weekdayCharOf('sun', NIGEKIRE_CHARACTERS).name, '日和');
});

test('weekdayCharOf: 該当なし/不正は null', () => {
  assert.strictEqual(L.weekdayCharOf('xxx', NIGEKIRE_CHARACTERS), null);
  assert.strictEqual(L.weekdayCharOf('mon', null), null);
  assert.strictEqual(L.weekdayCharOf(null, NIGEKIRE_CHARACTERS), null);
});

// ---- nigekireCharTitle（称号境界 9/10/24/25/44/45） ----

test('nigekireCharTitle: 段階境界（月子で 9/10/24/25/44/45）', () => {
  const t = (p) => L.nigekireCharTitle({ tsukiko: p }, 'tsukiko', NIGEKIRE_TITLE_TABLE);
  assert.deepStrictEqual(t(0), { stage: 1, name: '呼び止められ中' });
  assert.deepStrictEqual(t(9), { stage: 1, name: '呼び止められ中' });
  assert.deepStrictEqual(t(10), { stage: 2, name: '説明準備中' });
  assert.deepStrictEqual(t(24), { stage: 2, name: '説明準備中' });
  assert.deepStrictEqual(t(25), { stage: 3, name: '予定確認済み' });
  assert.deepStrictEqual(t(44), { stage: 3, name: '予定確認済み' });
  assert.deepStrictEqual(t(45), { stage: 4, name: '月曜逃げ切り' });
  assert.deepStrictEqual(t(999), { stage: 4, name: '月曜逃げ切り' });
});

test('nigekireCharTitle: 7人ぶんの段階4（逃げ切り）名を引ける', () => {
  const t = (k) => L.nigekireCharTitle({ [k]: 50 }, k, NIGEKIRE_TITLE_TABLE).name;
  assert.strictEqual(t('tsukiko'), '月曜逃げ切り');
  assert.strictEqual(t('you'), '火曜逃げ切り');
  assert.strictEqual(t('shizuku'), '水曜逃げ切り');
  assert.strictEqual(t('rinka'), '木曜逃げ切り');
  assert.strictEqual(t('runa'), '金曜逃げ切り');
  assert.strictEqual(t('mahiru'), '土曜逃げ切り');
  assert.strictEqual(t('hiyori'), '日曜逃げ切り');
});

test('nigekireCharTitle: ポイント未登録キャラは段階1', () => {
  assert.deepStrictEqual(
    L.nigekireCharTitle({}, 'tsukiko', NIGEKIRE_TITLE_TABLE),
    { stage: 1, name: '呼び止められ中' }
  );
});

// ---------------------------------------------------------------------------
// 共有フィクスチャ（複数の群から参照する）
// ---------------------------------------------------------------------------

const KITACORE_ID = 'ktcrs1107';
const NIGEKIRE_ID = 'hasyamo';

// app.js の MODE_DEFS と同一（ゴールデン基準）。逆引き対象クリエイター。
const MODE_DEFS_REAL = {
  kitacore: { key: 'kitacore', targetCreatorId: KITACORE_ID },
  nigekire: { key: 'nigekire', targetCreatorId: NIGEKIRE_ID },
};

// 曜日順キャラ（app.js の NIGEKIRE_CHARACTERS と同じ並び・key と weekday が要る分だけ）。
const NIGEKIRE_CHARS_M = [
  { key: 'tsukiko', weekday: 'mon', label: '月曜', name: '月子' },
  { key: 'you', weekday: 'tue', label: '火曜', name: '陽' },
  { key: 'shizuku', weekday: 'wed', label: '水曜', name: 'しずく' },
  { key: 'rinka', weekday: 'thu', label: '木曜', name: '凛華' },
  { key: 'runa', weekday: 'fri', label: '金曜', name: 'るな' },
  { key: 'mahiru', weekday: 'sat', label: '土曜', name: 'まひる' },
  { key: 'hiyori', weekday: 'sun', label: '日曜', name: '日和' },
];

// 閾値テーブル（app.js の NIGEKIRE_THRESHOLDS と同値）。
const NIGEKIRE_TH = { escape: [3, 6, 9], point: [5, 10, 15] };

// ---- cleanupKitacoreOnDelete ----

// ensureMode('kitacore') 後の物理保存先を模した完全形（各マップ既定つき）。
function freshKitacore(overrides) {
  return Object.assign(
    {
      mode: {},
      counts: {},
      collected: {},
      totalWai: 0,
      keys: {},
      defeatedBosses: {},
      quizCleared: {},
      player: null,
      quizTaps: 0,
      pendingPostBoss: {},
    },
    overrides || {}
  );
}

test('cleanupKitacoreOnDelete: 回収済み記事削除で totalWai が正しく差し引かれる（複数記事）', () => {
  const s = freshKitacore({
    totalWai: 100,
    counts: { a1: { wai: 30 }, a2: { wai: 20 }, a3: { wai: 5 } },
    collected: { a1: true, a2: true }, // a3 は未回収なので totalWai には効かない
  });
  const out = L.cleanupKitacoreOnDelete(s, KITACORE_ID, ['a1', 'a2', 'a3'], true);
  assert.strictEqual(out.totalWai, 50); // 100 - 30 - 20（a3 は未回収）
});

test('cleanupKitacoreOnDelete: totalWai の下限は Math.max(0,...)（マイナスにならない）', () => {
  const s = freshKitacore({
    totalWai: 10,
    counts: { a1: { wai: 30 } },
    collected: { a1: true },
  });
  const out = L.cleanupKitacoreOnDelete(s, KITACORE_ID, ['a1'], true);
  assert.strictEqual(out.totalWai, 0); // 10 - 30 = -20 → 0 で下限
});

test('cleanupKitacoreOnDelete: counts/collected/quizCleared/mode/keys/defeatedBosses が該当id分だけ消える', () => {
  const s = freshKitacore({
    totalWai: 100,
    counts: { a1: { wai: 10 }, keep: { wai: 99 } },
    collected: { a1: true, keep: true },
    quizCleared: { a1: true, keep: true },
    mode: { [KITACORE_ID]: 'x', other: 'y' },
    keys: { [KITACORE_ID]: 3, other: 5 },
    defeatedBosses: { [KITACORE_ID]: ['reaper'], other: ['wing'] },
    pendingPostBoss: { [KITACORE_ID]: 'requiem', other: 'cael' },
  });
  const out = L.cleanupKitacoreOnDelete(s, KITACORE_ID, ['a1'], true);
  // 記事単位（a1）は消え、無関係(keep)は残る。
  assert.deepStrictEqual(out.counts, { keep: { wai: 99 } });
  assert.deepStrictEqual(out.collected, { keep: true });
  assert.deepStrictEqual(out.quizCleared, { keep: true });
  // creator単位（KITACORE_ID）は消え、無関係(other)は残る。
  assert.deepStrictEqual(out.mode, { other: 'y' });
  assert.deepStrictEqual(out.keys, { other: 5 });
  assert.deepStrictEqual(out.defeatedBosses, { other: ['wing'] });
  assert.deepStrictEqual(out.pendingPostBoss, { other: 'cael' });
});

test('cleanupKitacoreOnDelete: isTargetCreator=true で player=null / quizTaps=0', () => {
  const s = freshKitacore({ player: { id: 'me' }, quizTaps: 7 });
  const out = L.cleanupKitacoreOnDelete(s, KITACORE_ID, [], true);
  assert.strictEqual(out.player, null);
  assert.strictEqual(out.quizTaps, 0);
});

test('cleanupKitacoreOnDelete: isTargetCreator=false は player/quizTaps を保持', () => {
  const s = freshKitacore({ player: { id: 'me' }, quizTaps: 7 });
  const out = L.cleanupKitacoreOnDelete(s, 'someOther', [], false);
  assert.deepStrictEqual(out.player, { id: 'me' });
  assert.strictEqual(out.quizTaps, 7);
});

test('cleanupKitacoreOnDelete: articleIds に falsy（idなし記事）が混ざっても落ちない', () => {
  const s = freshKitacore({
    totalWai: 10,
    counts: { a1: { wai: 5 } },
    collected: { a1: true },
  });
  const out = L.cleanupKitacoreOnDelete(s, KITACORE_ID, [null, undefined, '', 'a1'], true);
  assert.strictEqual(out.totalWai, 5);
  assert.deepStrictEqual(out.collected, {});
});

test('cleanupKitacoreOnDelete: 非破壊（入力 state を書き換えない）', () => {
  const s = freshKitacore({
    totalWai: 100,
    counts: { a1: { wai: 30 } },
    collected: { a1: true },
    quizCleared: { a1: true },
    mode: { [KITACORE_ID]: 'x' },
    keys: { [KITACORE_ID]: 3 },
    defeatedBosses: { [KITACORE_ID]: ['reaper'] },
    pendingPostBoss: { [KITACORE_ID]: 'requiem' },
    player: { id: 'me' },
    quizTaps: 7,
  });
  const before = JSON.stringify(s);
  const out = L.cleanupKitacoreOnDelete(s, KITACORE_ID, ['a1'], true);
  assert.strictEqual(JSON.stringify(s), before); // 入力そのまま
  assert.notStrictEqual(out, s); // 新オブジェクト
  assert.notStrictEqual(out.counts, s.counts);
  assert.notStrictEqual(out.collected, s.collected);
});

// ---- cleanupNigekireOnDelete ----

function freshNigekire(overrides) {
  return Object.assign(
    {
      mode: { a1: true },
      charPoints: { tsukiko: 30, runa: 5 },
      passed: { a1: true },
      collected: { a2: true },
      totalSuccess: 9,
      firstTrySuccess: 4,
      player: { id: 'me' },
    },
    overrides || {}
  );
}

test('cleanupNigekireOnDelete: isTargetCreator=true で全 state がリセット', () => {
  const out = L.cleanupNigekireOnDelete(freshNigekire(), true);
  assert.deepStrictEqual(out.mode, {});
  assert.deepStrictEqual(out.charPoints, {});
  assert.deepStrictEqual(out.passed, {});
  assert.deepStrictEqual(out.collected, {});
  assert.strictEqual(out.totalSuccess, 0);
  assert.strictEqual(out.firstTrySuccess, 0);
  assert.strictEqual(out.player, null);
});

test('cleanupNigekireOnDelete: isTargetCreator=false は変更なし（将来の防御）', () => {
  const s = freshNigekire();
  const out = L.cleanupNigekireOnDelete(s, false);
  assert.deepStrictEqual(out.mode, { a1: true });
  assert.deepStrictEqual(out.charPoints, { tsukiko: 30, runa: 5 });
  assert.deepStrictEqual(out.passed, { a1: true });
  assert.strictEqual(out.totalSuccess, 9);
  assert.strictEqual(out.firstTrySuccess, 4);
  assert.deepStrictEqual(out.player, { id: 'me' });
});

test('cleanupNigekireOnDelete: 非破壊（入力 state を書き換えない）', () => {
  const s = freshNigekire();
  const before = JSON.stringify(s);
  const out = L.cleanupNigekireOnDelete(s, true);
  assert.strictEqual(JSON.stringify(s), before); // 入力そのまま
  assert.notStrictEqual(out, s); // 新オブジェクト
});

// ---- 今回のバグの本質を守る: modeForCreator（横断の逆引き）を実 MODE_DEFS で ----

test('modeForCreator[本質]: hasyamo は nigekire、ktcrs1107 は kitacore、無関係は null', () => {
  // 「キタコレ固定 vs モード横断の取り違え」の核。creator→mode は横断で決まる。
  assert.strictEqual(L.modeForCreator(MODE_DEFS_REAL, NIGEKIRE_ID).key, 'nigekire');
  assert.strictEqual(L.modeForCreator(MODE_DEFS_REAL, KITACORE_ID).key, 'kitacore');
  assert.strictEqual(L.modeForCreator(MODE_DEFS_REAL, 'unrelated'), null);
});

// ============================================================================
// H群: ニゲキレ v2 純ロジック（一言チップ収集・1本ゲージ・生活カード）
//   確定値: 生活ランク5段階 0/30/70/120/200（§10.4）/ カード段階 0/1/5/10（§10-1）
//           ホワイトリスト7人（§10.7）。KITAさん等は除外。
// ============================================================================

// v2 生活ランク5段階（+「おはカノ生活管理人」200・key nige5）
const NIGEKIRE_LIFE_RANKS_V2 = [
  { stage: 1, min: 0, name: '言い訳見習い', key: 'nige1' },
  { stage: 2, min: 30, name: '生活防衛中', key: 'nige2' },
  { stage: 3, min: 70, name: '火種処理係', key: 'nige3' },
  { stage: 4, min: 120, name: 'おはカノ生活継続者', key: 'nige4' },
  { stage: 5, min: 200, name: 'おはカノ生活管理人', key: 'nige5' },
];
// 名前→charKey ホワイトリスト（7人・§10.7）
const NAME_TO_KEY = {
  '月子': 'tsukiko', '陽': 'you', 'しずく': 'shizuku', '凛華': 'rinka',
  'るな': 'runa', 'まひる': 'mahiru', '日和': 'hiyori',
};

// ---- H4: nigekireTopChar（最推し） ----

test('nigekireTopChar: 最多収集キャラ', () => {
  const cc = { tsukiko: 2, you: 7, shizuku: 3, rinka: 1, runa: 0, mahiru: 4, hiyori: 6 };
  assert.strictEqual(L.nigekireTopChar(cc, NIGEKIRE_CHARACTERS).key, 'you');
});

test('nigekireTopChar: 同数は配列順（曜日順）で先', () => {
  // tsukiko(月) と you(火) が同数5 → 曜日順で先の tsukiko
  const cc = { tsukiko: 5, you: 5, shizuku: 1 };
  assert.strictEqual(L.nigekireTopChar(cc, NIGEKIRE_CHARACTERS).key, 'tsukiko');
});

test('nigekireTopChar: 全0は null', () => {
  assert.strictEqual(L.nigekireTopChar({ tsukiko: 0, you: 0 }, NIGEKIRE_CHARACTERS), null);
  assert.strictEqual(L.nigekireTopChar({}, NIGEKIRE_CHARACTERS), null);
});

test('nigekireTopChar: characters 空/不正は null', () => {
  assert.strictEqual(L.nigekireTopChar({ tsukiko: 5 }, []), null);
  assert.strictEqual(L.nigekireTopChar({ tsukiko: 5 }, null), null);
});

// ---- H5: detectHitokotoChars（一言抽出＝全部拾う＋ホワイトリスト） ----

test('detectHitokotoChars: 単一見出し → [charKey]', () => {
  assert.deepStrictEqual(L.detectHitokotoChars('<h2 name="x">陽の一言</h2>', NAME_TO_KEY), ['you']);
  assert.deepStrictEqual(L.detectHitokotoChars('前置き<h2>月子の一言</h2>本文', NAME_TO_KEY), ['tsukiko']);
});

test('detectHitokotoChars: 複数見出しは全員拾う（出現順）', () => {
  // 「日和の一言」「しずくの一言」が別々の見出しで並ぶケース。
  const html = '<h3>日和の一言</h3>中略<h2>しずくの一言</h2>';
  assert.deepStrictEqual(L.detectHitokotoChars(html, NAME_TO_KEY), ['hiyori', 'shizuku']);
});

test('detectHitokotoChars: 1見出しに複数名（「るな・陽の一言」）を分解する', () => {
  assert.deepStrictEqual(L.detectHitokotoChars('<h2>るな・陽の一言</h2>', NAME_TO_KEY), ['runa', 'you']);
  // 区切りは記号（・、，,／/＆&）を許容。
  assert.deepStrictEqual(L.detectHitokotoChars('<h3>月子、日和の一言:</h3>', NAME_TO_KEY), ['tsukiko', 'hiyori']);
});

test('detectHitokotoChars: 並列助詞「と」「や」区切りも分解する（実データ 5/5「月子と陽の一言」）', () => {
  assert.deepStrictEqual(L.detectHitokotoChars('<h2>月子と陽の一言</h2>', NAME_TO_KEY), ['tsukiko', 'you']);
  assert.deepStrictEqual(L.detectHitokotoChars('<h3>しずくや凛華の一言:</h3>', NAME_TO_KEY), ['shizuku', 'rinka']);
  // 7人名に「と」「や」を含む名前は無いので、名前自体は壊れない。
  assert.deepStrictEqual(L.detectHitokotoChars('<h2>まひるの一言</h2>', NAME_TO_KEY), ['mahiru']);
});

test('detectHitokotoChars: 重複は除去（出現順は保つ）', () => {
  const html = '<h2>陽の一言</h2>...<h3>陽の一言:</h3>';
  assert.deepStrictEqual(L.detectHitokotoChars(html, NAME_TO_KEY), ['you']);
});

test('detectHitokotoChars: 対象外は混ざっても除外（ジュリ＋日和 → 日和だけ）', () => {
  // 2/22 の実データ相当（ジュリの一言＝対象外・日和の一言＝対象）。
  const html = '<h2>ジュリの一言</h2>中略<h3>日和の一言</h3>';
  assert.deepStrictEqual(L.detectHitokotoChars(html, NAME_TO_KEY), ['hiyori']);
});

test('detectHitokotoChars: 見出しタグ h1〜h6・末尾コロンでも引ける（実データの回）', () => {
  // 2/19 凛華・2/20 るなは <h3>「凛華の一言:」（コロン付き）。
  assert.deepStrictEqual(L.detectHitokotoChars('<h3 id="x">凛華の一言:</h3>', NAME_TO_KEY), ['rinka']);
  assert.deepStrictEqual(L.detectHitokotoChars('<h3>るなの一言：</h3>', NAME_TO_KEY), ['runa']);
});

test('detectHitokotoChars: 該当なし・見出しなし・非文字列は []', () => {
  assert.deepStrictEqual(L.detectHitokotoChars('<h2>KITAさんの一言</h2>', NAME_TO_KEY), []);
  assert.deepStrictEqual(L.detectHitokotoChars('<p>一言も見出しもない</p>', NAME_TO_KEY), []);
  assert.deepStrictEqual(L.detectHitokotoChars('<h2>ただの見出し</h2>', NAME_TO_KEY), []);
  assert.deepStrictEqual(L.detectHitokotoChars(null, NAME_TO_KEY), []);
  assert.deepStrictEqual(L.detectHitokotoChars(undefined, NAME_TO_KEY), []);
  assert.deepStrictEqual(L.detectHitokotoChars(123, NAME_TO_KEY), []);
});

test('detectHitokotoChars: 7人ホワイトリスト全員が引ける', () => {
  const cases = [
    ['月子', 'tsukiko'], ['陽', 'you'], ['しずく', 'shizuku'], ['凛華', 'rinka'],
    ['るな', 'runa'], ['まひる', 'mahiru'], ['日和', 'hiyori'],
  ];
  cases.forEach(([name, key]) => {
    assert.deepStrictEqual(L.detectHitokotoChars('<h2>' + name + 'の一言</h2>', NAME_TO_KEY), [key]);
  });
});

// ---- H6: nigekireCollectV2（キャラ別回収・二重取り防止・非破壊） ----

test('nigekireCollectV2: 回収で charCounts+1・collected[id][char] 立つ・charKey 返る', () => {
  const counts = { a1: { chars: ['you'] } };
  const collected = {};
  const charCounts = { you: 2 };
  const out = L.nigekireCollectV2(counts, collected, charCounts, 'a1', 'you');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.charKey, 'you');
  assert.strictEqual(out.nextCharCounts.you, 3);
  assert.strictEqual(out.nextCollected.a1.you, true);
});

test('nigekireCollectV2: 初回収集キャラは 0→1', () => {
  const out = L.nigekireCollectV2({ a1: { chars: ['runa'] } }, {}, {}, 'a1', 'runa');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextCharCounts.runa, 1);
});

test('nigekireCollectV2: 複数キャラは片方ずつ独立に回収できる', () => {
  const counts = { a1: { chars: ['hiyori', 'shizuku'] } };
  // 日和だけ回収 → しずくはまだ未回収
  const first = L.nigekireCollectV2(counts, {}, {}, 'a1', 'hiyori');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.nextCollected.a1.hiyori, true);
  assert.strictEqual(first.nextCollected.a1.shizuku, undefined);
  // 続けてしずくを回収 → 日和の回収済みは保たれる
  const second = L.nigekireCollectV2(counts, first.nextCollected, first.nextCharCounts, 'a1', 'shizuku');
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.nextCollected.a1.hiyori, true);
  assert.strictEqual(second.nextCollected.a1.shizuku, true);
  assert.strictEqual(second.nextCharCounts.hiyori, 1);
  assert.strictEqual(second.nextCharCounts.shizuku, 1);
});

test('nigekireCollectV2: この記事の一言キャラでない charKey は {ok:false}', () => {
  assert.deepStrictEqual(L.nigekireCollectV2({}, {}, {}, 'a1', 'you'), { ok: false });
  assert.deepStrictEqual(L.nigekireCollectV2({ a1: { chars: ['runa'] } }, {}, {}, 'a1', 'you'), { ok: false });
  // charKey 未指定も false
  assert.deepStrictEqual(L.nigekireCollectV2({ a1: { chars: ['you'] } }, {}, {}, 'a1'), { ok: false });
});

test('nigekireCollectV2: 同じキャラの二重取りは {ok:false}（別キャラは可）', () => {
  const counts = { a1: { chars: ['you', 'runa'] } };
  const collected = { a1: { you: true } };
  // you は回収済み → false
  assert.deepStrictEqual(L.nigekireCollectV2(counts, collected, { you: 1 }, 'a1', 'you'), { ok: false });
  // runa はまだ → 可
  assert.strictEqual(L.nigekireCollectV2(counts, collected, { you: 1 }, 'a1', 'runa').ok, true);
});

test('nigekireCollectV2: 非破壊（入力 collected/charCounts を書き換えない）', () => {
  const counts = { a1: { chars: ['you'] } };
  const collected = { a1: {} };
  const charCounts = { you: 2 };
  const before = JSON.stringify({ collected, charCounts });
  const out = L.nigekireCollectV2(counts, collected, charCounts, 'a1', 'you');
  assert.strictEqual(JSON.stringify({ collected, charCounts }), before);
  assert.notStrictEqual(out.nextCollected, collected);
  assert.notStrictEqual(out.nextCollected.a1, collected.a1);
  assert.notStrictEqual(out.nextCharCounts, charCounts);
});

// ---- H7: nigekireTrialV2（試練通過・ポイントなし・非破壊） ----

test('nigekireTrialV2: 一発通過で totalSuccess+1・firstTrySuccess+1', () => {
  const out = L.nigekireTrialV2({}, 5, 2, 'a1', true);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextPassed.a1, true);
  assert.strictEqual(out.nextTotalSuccess, 6);
  assert.strictEqual(out.nextFirstTrySuccess, 3);
});

test('nigekireTrialV2: 非一発は totalSuccess+1・firstTrySuccess 据え置き', () => {
  const out = L.nigekireTrialV2({}, 5, 2, 'a1', false);
  assert.strictEqual(out.nextTotalSuccess, 6);
  assert.strictEqual(out.nextFirstTrySuccess, 2);
});

test('nigekireTrialV2: 二重通過は {ok:false}', () => {
  assert.deepStrictEqual(L.nigekireTrialV2({ a1: true }, 5, 2, 'a1', true), { ok: false });
});

test('nigekireTrialV2: 非破壊（入力 passed を書き換えない）', () => {
  const passed = {};
  const out = L.nigekireTrialV2(passed, 0, 0, 'a1', true);
  assert.deepStrictEqual(passed, {}); // 入力そのまま
  assert.notStrictEqual(out.nextPassed, passed);
});

// ---- H8: nigekireCardStage（生活カード4段階 0/1/5/10） ----

test('nigekireCardStage: 0→未観測 / 1→観測 / 5→定着 / 10→中核', () => {
  assert.deepStrictEqual(L.nigekireCardStage(0), { stage: 1, name: '未観測' });
  assert.deepStrictEqual(L.nigekireCardStage(1), { stage: 2, name: '観測' });
  assert.deepStrictEqual(L.nigekireCardStage(5), { stage: 3, name: '定着' });
  assert.deepStrictEqual(L.nigekireCardStage(10), { stage: 4, name: '中核' });
});

test('nigekireCardStage: 境界直下は前段階（4→観測 / 9→定着）', () => {
  assert.strictEqual(L.nigekireCardStage(4).name, '観測');
  assert.strictEqual(L.nigekireCardStage(9).name, '定着');
  assert.strictEqual(L.nigekireCardStage(99).name, '中核');
});

test('nigekireCardStage: 非数は 0 扱い（未観測）', () => {
  assert.strictEqual(L.nigekireCardStage('x').name, '未観測');
  assert.strictEqual(L.nigekireCardStage(undefined).name, '未観測');
});

// ---------------------------------------------------------------------------
// J群: ニゲキレ ランク（rankStage → ランク名・等級記号）
//   ランクは閾値への初到達で上がる（逃げ切き 3/6/9 → ポイント 5/10/15・全7段）。
// ---------------------------------------------------------------------------

// ---- J1: nigekireRankByStage（通過段→ランク名） ----

test('nigekireRankByStage: 0 → 言い訳見習い/nige1', () => {
  const out = L.nigekireRankByStage(0, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.name, '言い訳見習い');
  assert.strictEqual(out.key, 'nige1');
});

test('nigekireRankByStage: 1 → 生活防衛中/nige2', () => {
  const out = L.nigekireRankByStage(1, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.name, '生活防衛中');
  assert.strictEqual(out.key, 'nige2');
});

test('nigekireRankByStage: 4 → おはカノ生活管理人/nige5（最終段）', () => {
  const out = L.nigekireRankByStage(4, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.name, 'おはカノ生活管理人');
  assert.strictEqual(out.key, 'nige5');
});

test('nigekireRankByStage: 範囲外は 0〜(length-1) にクランプ（5→4, -1→0）', () => {
  assert.strictEqual(L.nigekireRankByStage(5, NIGEKIRE_LIFE_RANKS_V2).key, 'nige5'); // index4へ
  assert.strictEqual(L.nigekireRankByStage(99, NIGEKIRE_LIFE_RANKS_V2).key, 'nige5');
  assert.strictEqual(L.nigekireRankByStage(-1, NIGEKIRE_LIFE_RANKS_V2).key, 'nige1'); // index0へ
});

test('nigekireRankByStage: 非数は 0 扱い（先頭段）', () => {
  assert.strictEqual(L.nigekireRankByStage('x', NIGEKIRE_LIFE_RANKS_V2).key, 'nige1');
  assert.strictEqual(L.nigekireRankByStage(undefined, NIGEKIRE_LIFE_RANKS_V2).key, 'nige1');
});

test('nigekireRankByStage: 空/不正 ranks は stage0/name空/key空', () => {
  assert.deepStrictEqual(L.nigekireRankByStage(1, []), { stage: 0, name: '', key: '' });
  assert.deepStrictEqual(L.nigekireRankByStage(1, null), { stage: 0, name: '', key: '' });
});

// ---- M1: nigekireOshiEscapeRecord（逃げ切り記録 n/9・3本ごとの節目） ----

test('nigekireOshiEscapeRecord: 0本 → count0・全未達・次の節目3', () => {
  const out = L.nigekireOshiEscapeRecord({}, 'rinka');
  assert.strictEqual(out.count, 0);
  assert.strictEqual(out.need, 9);
  assert.deepStrictEqual(out.cleared, [false, false, false]);
  assert.strictEqual(out.nextMilestone, 3);
});

test('nigekireOshiEscapeRecord: 2本 → まだ節目未達・次は3', () => {
  const out = L.nigekireOshiEscapeRecord({ rinka: 2 }, 'rinka');
  assert.strictEqual(out.count, 2);
  assert.deepStrictEqual(out.cleared, [false, false, false]);
  assert.strictEqual(out.nextMilestone, 3);
});

test('nigekireOshiEscapeRecord: 3本 → 節目①到達・次は6', () => {
  const out = L.nigekireOshiEscapeRecord({ rinka: 3 }, 'rinka');
  assert.strictEqual(out.count, 3);
  assert.deepStrictEqual(out.cleared, [true, false, false]);
  assert.strictEqual(out.nextMilestone, 6);
});

test('nigekireOshiEscapeRecord: 6本 → 節目①②到達・次は9', () => {
  const out = L.nigekireOshiEscapeRecord({ rinka: 6 }, 'rinka');
  assert.deepStrictEqual(out.cleared, [true, true, false]);
  assert.strictEqual(out.nextMilestone, 9);
});

test('nigekireOshiEscapeRecord: 9本 → 全節目到達・次はnull', () => {
  const out = L.nigekireOshiEscapeRecord({ rinka: 9 }, 'rinka');
  assert.strictEqual(out.count, 9);
  assert.deepStrictEqual(out.cleared, [true, true, true]);
  assert.strictEqual(out.nextMilestone, null);
});

test('nigekireOshiEscapeRecord: 9本超は9にクランプ', () => {
  assert.strictEqual(L.nigekireOshiEscapeRecord({ rinka: 40 }, 'rinka').count, 9);
});

test('nigekireOshiEscapeRecord: 負数/非数/未選択は0扱い', () => {
  assert.strictEqual(L.nigekireOshiEscapeRecord({ rinka: -5 }, 'rinka').count, 0);
  assert.strictEqual(L.nigekireOshiEscapeRecord({ rinka: 'x' }, 'rinka').count, 0);
  assert.strictEqual(L.nigekireOshiEscapeRecord(null, 'rinka').count, 0);
  assert.strictEqual(L.nigekireOshiEscapeRecord({ rinka: 5 }, null).count, 0);
});

test('nigekireOshiEscapeRecord: 選択中キャラのぶんだけ見る（他キャラは無視）', () => {
  const out = L.nigekireOshiEscapeRecord({ tsukiko: 9, rinka: 3 }, 'rinka');
  assert.strictEqual(out.count, 3);
});

// ---- M3: nigekireOshiPassLineKey（通過セリフのキー） ----

test('nigekireOshiPassLineKey: 1..6 をそのまま連結', () => {
  assert.strictEqual(L.nigekireOshiPassLineKey('tsukiko', 1), 'tsukiko_1');
  assert.strictEqual(L.nigekireOshiPassLineKey('rinka', 4), 'rinka_4');
  assert.strictEqual(L.nigekireOshiPassLineKey('hiyori', 6), 'hiyori_6');
});

test('nigekireOshiPassLineKey: 範囲外は 1..6 にクランプ', () => {
  assert.strictEqual(L.nigekireOshiPassLineKey('runa', 0), 'runa_1');
  assert.strictEqual(L.nigekireOshiPassLineKey('runa', -3), 'runa_1');
  assert.strictEqual(L.nigekireOshiPassLineKey('runa', 9), 'runa_6');
  assert.strictEqual(L.nigekireOshiPassLineKey('runa', 'x'), 'runa_1');
});

test('nigekireOshiPassLineKey: charKey 不正は空文字', () => {
  assert.strictEqual(L.nigekireOshiPassLineKey('', 1), '');
  assert.strictEqual(L.nigekireOshiPassLineKey(null, 1), '');
});

// ---- M4: nigekireRankTitleWithDays（称号に曜日を積む） ----

test('nigekireRankTitleWithDays: 1人 → 生活防衛中〈月〉', () => {
  assert.strictEqual(
    L.nigekireRankTitleWithDays('生活防衛中', ['tsukiko'], NIGEKIRE_CHARS_M),
    '生活防衛中〈月〉'
  );
});

test('nigekireRankTitleWithDays: 3人・通過順に関係なく曜日順に並ぶ', () => {
  assert.strictEqual(
    L.nigekireRankTitleWithDays('生活防衛中', ['runa', 'tsukiko', 'shizuku'], NIGEKIRE_CHARS_M),
    '生活防衛中〈月水金〉'
  );
});

test('nigekireRankTitleWithDays: 7人コンプ → 〈月火水木金土日〉', () => {
  assert.strictEqual(
    L.nigekireRankTitleWithDays(
      'おはカノ生活管理人',
      ['hiyori', 'mahiru', 'runa', 'rinka', 'shizuku', 'you', 'tsukiko'],
      NIGEKIRE_CHARS_M
    ),
    'おはカノ生活管理人〈月火水木金土日〉'
  );
});

test('nigekireRankTitleWithDays: oshiCleared 空 → 括弧なし', () => {
  assert.strictEqual(
    L.nigekireRankTitleWithDays('言い訳見習い', [], NIGEKIRE_CHARS_M),
    '言い訳見習い'
  );
});

test('nigekireRankTitleWithDays: 不正入力は rankName をそのまま', () => {
  assert.strictEqual(L.nigekireRankTitleWithDays('生活防衛中', null, NIGEKIRE_CHARS_M), '生活防衛中');
  assert.strictEqual(L.nigekireRankTitleWithDays('生活防衛中', ['tsukiko'], null), '生活防衛中');
  assert.strictEqual(L.nigekireRankTitleWithDays('生活防衛中', ['nazo'], NIGEKIRE_CHARS_M), '生活防衛中');
});

test('nigekireRankTitleWithDays: rankName 不正は空文字', () => {
  assert.strictEqual(L.nigekireRankTitleWithDays(null, ['tsukiko'], NIGEKIRE_CHARS_M), '');
});

// ---- N1: nigekireThresholdKey ----

test('nigekireThresholdKey: escape/point のキーを作る', () => {
  assert.strictEqual(L.nigekireThresholdKey('escape', 3), 'escape3');
  assert.strictEqual(L.nigekireThresholdKey('escape', 9), 'escape9');
  assert.strictEqual(L.nigekireThresholdKey('point', 5), 'point5');
  assert.strictEqual(L.nigekireThresholdKey('point', 15), 'point15');
});

test('nigekireThresholdKey: 不正な kind / need は空文字', () => {
  assert.strictEqual(L.nigekireThresholdKey('done', 3), '');
  assert.strictEqual(L.nigekireThresholdKey('escape', null), '');
  assert.strictEqual(L.nigekireThresholdKey(null, 3), '');
  assert.strictEqual(L.nigekireThresholdKey('point', Infinity), '');
});

// ---- N2: nigekireOshiMilestone（初期試練フェーズ・逃げ切き 3/6/9） ----

test('nigekireOshiMilestone: 通過0回・逃げ切き2本 → 3本に届かず ready=false', () => {
  const out = L.nigekireOshiMilestone({ tsukiko: 2 }, {}, {}, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: false, kind: 'escape', need: 3, passIndex: 1 });
});

test('nigekireOshiMilestone: 通過0回・逃げ切き3本 → ready=true（境界）', () => {
  const out = L.nigekireOshiMilestone({ tsukiko: 3 }, {}, {}, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: true, kind: 'escape', need: 3, passIndex: 1 });
});

test('nigekireOshiMilestone: 通過1回 → 次は6本・5本では出ない', () => {
  const counts = { tsukiko: 1 };
  assert.strictEqual(L.nigekireOshiMilestone({ tsukiko: 5 }, {}, counts, 'tsukiko', NIGEKIRE_TH).ready, false);
  const out = L.nigekireOshiMilestone({ tsukiko: 6 }, {}, counts, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: true, kind: 'escape', need: 6, passIndex: 2 });
});

test('nigekireOshiMilestone: 通過2回 → 次は9本・passIndex=3', () => {
  const out = L.nigekireOshiMilestone({ tsukiko: 9 }, {}, { tsukiko: 2 }, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: true, kind: 'escape', need: 9, passIndex: 3 });
});

// ---- N3: nigekireOshiMilestone（収集フェーズ・ポイント 5/10/15） ----

test('nigekireOshiMilestone: 通過3回・ポイント4 → 5点に届かず ready=false', () => {
  const out = L.nigekireOshiMilestone({}, { tsukiko: 4 }, { tsukiko: 3 }, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: false, kind: 'point', need: 5, passIndex: 4 });
});

test('nigekireOshiMilestone: 通過3回・ポイント5 → ready=true（境界）', () => {
  const out = L.nigekireOshiMilestone({}, { tsukiko: 5 }, { tsukiko: 3 }, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: true, kind: 'point', need: 5, passIndex: 4 });
});

test('nigekireOshiMilestone: 通過4回 → 10点・通過5回 → 15点', () => {
  const a = L.nigekireOshiMilestone({}, { tsukiko: 10 }, { tsukiko: 4 }, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(a, { ready: true, kind: 'point', need: 10, passIndex: 5 });
  const b = L.nigekireOshiMilestone({}, { tsukiko: 15 }, { tsukiko: 5 }, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(b, { ready: true, kind: 'point', need: 15, passIndex: 6 });
});

test('nigekireOshiMilestone: 収集フェーズはキャラ単位（他キャラのポイントは効かない）', () => {
  const out = L.nigekireOshiMilestone({}, { you: 99, tsukiko: 1 }, { tsukiko: 3 }, 'tsukiko', NIGEKIRE_TH);
  assert.strictEqual(out.ready, false);
});

test('nigekireOshiMilestone: 通過6回 → kind=done・ready=false', () => {
  const out = L.nigekireOshiMilestone({ tsukiko: 99 }, { tsukiko: 99 }, { tsukiko: 6 }, 'tsukiko', NIGEKIRE_TH);
  assert.deepStrictEqual(out, { ready: false, kind: 'done', need: null, passIndex: 6 });
});

test('nigekireOshiMilestone: 不正入力（推し未選択・非数）でも落ちない', () => {
  assert.strictEqual(L.nigekireOshiMilestone({}, {}, {}, null, NIGEKIRE_TH).ready, false);
  assert.strictEqual(L.nigekireOshiMilestone(null, null, null, 'tsukiko', NIGEKIRE_TH).ready, false);
  assert.strictEqual(L.nigekireOshiMilestone({ tsukiko: 'x' }, {}, {}, 'tsukiko', NIGEKIRE_TH).ready, false);
  assert.strictEqual(L.nigekireOshiMilestone({ tsukiko: 9 }, {}, {}, 'tsukiko', null).ready, false);
});

// ---- N4: nigekirePassOshiMilestone ----

test('nigekirePassOshiMilestone: 初到達 → rankUp=true・閾値キーが積まれる', () => {
  const out = L.nigekirePassOshiMilestone([], {}, [], 'tsukiko', 'escape', 3);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.rankUp, true);
  assert.deepStrictEqual(out.nextReached, ['escape3']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 1 });
  assert.deepStrictEqual(out.nextCleared, []);
});

test('nigekirePassOshiMilestone: 2人目（既に到達済み）→ rankUp=false・通過回数だけ進む', () => {
  const out = L.nigekirePassOshiMilestone(['escape3'], { you: 0 }, ['tsukiko'], 'you', 'escape', 3);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.rankUp, false);
  assert.deepStrictEqual(out.nextReached, ['escape3']); // 増えない
  assert.deepStrictEqual(out.nextPassCounts, { you: 1 });
});

test('nigekirePassOshiMilestone: 3回目の通過で oshiCleared に積まれる', () => {
  const out = L.nigekirePassOshiMilestone(['escape3', 'escape6'], { tsukiko: 2 }, [], 'tsukiko', 'escape', 9);
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 3 });
  assert.strictEqual(out.rankUp, true);
});

test('nigekirePassOshiMilestone: oshiCleared は重複しない（4回目以降）', () => {
  const out = L.nigekirePassOshiMilestone(['point5'], { tsukiko: 3 }, ['tsukiko'], 'tsukiko', 'point', 5);
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 4 });
  assert.strictEqual(out.rankUp, false);
});

test('nigekirePassOshiMilestone: 6回通過済み → ok:false', () => {
  const out = L.nigekirePassOshiMilestone([], { tsukiko: 6 }, ['tsukiko'], 'tsukiko', 'point', 15);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.rankUp, false);
});

test('nigekirePassOshiMilestone: 不正入力（推し未選択・kind=done）→ ok:false', () => {
  assert.strictEqual(L.nigekirePassOshiMilestone([], {}, [], null, 'escape', 3).ok, false);
  assert.strictEqual(L.nigekirePassOshiMilestone([], {}, [], 'tsukiko', 'done', null).ok, false);
});

test('nigekirePassOshiMilestone: 非破壊（入力の配列/マップを書き換えない）', () => {
  const reached = ['escape3'];
  const counts = { tsukiko: 2 };
  const cleared = [];
  const out = L.nigekirePassOshiMilestone(reached, counts, cleared, 'tsukiko', 'escape', 9);
  assert.deepStrictEqual(reached, ['escape3']);
  assert.deepStrictEqual(counts, { tsukiko: 2 });
  assert.deepStrictEqual(cleared, []);
  assert.deepStrictEqual(out.nextReached, ['escape3', 'escape9']);
});

test('nigekirePassOshiMilestone: 6回とおすと閾値6つが順に積まれる（1人目）', () => {
  let reached = [];
  let counts = {};
  let cleared = [];
  const seq = [['escape', 3], ['escape', 6], ['escape', 9], ['point', 5], ['point', 10], ['point', 15]];
  seq.forEach(([kind, need]) => {
    const out = L.nigekirePassOshiMilestone(reached, counts, cleared, 'tsukiko', kind, need);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.rankUp, true); // 1人目は毎回 初到達
    reached = out.nextReached; counts = out.nextPassCounts; cleared = out.nextCleared;
  });
  assert.deepStrictEqual(reached, ['escape3', 'escape6', 'escape9', 'point5', 'point10', 'point15']);
  assert.deepStrictEqual(counts, { tsukiko: 6 });
  assert.deepStrictEqual(cleared, ['tsukiko']);
});

test('nigekirePassOshiMilestone: 2人目は6回とも rankUp=false（ランクは動かない）', () => {
  const full = ['escape3', 'escape6', 'escape9', 'point5', 'point10', 'point15'];
  let reached = full.slice();
  let counts = {};
  let cleared = ['tsukiko'];
  const seq = [['escape', 3], ['escape', 6], ['escape', 9], ['point', 5], ['point', 10], ['point', 15]];
  seq.forEach(([kind, need]) => {
    const out = L.nigekirePassOshiMilestone(reached, counts, cleared, 'you', kind, need);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.rankUp, false);
    reached = out.nextReached; counts = out.nextPassCounts; cleared = out.nextCleared;
  });
  assert.deepStrictEqual(reached, full); // 増えない
  assert.deepStrictEqual(counts, { you: 6 });
  assert.deepStrictEqual(cleared, ['tsukiko', 'you']);
});

// ---- N5: nigekireOshiGauge ----

test('nigekireOshiGauge: 分母は常に最終閾値 15（通過回数によらず目盛りが動かない）', () => {
  const g = L.nigekireOshiGauge({ tsukiko: 2 }, 'tsukiko', {}, NIGEKIRE_TH);
  assert.strictEqual(g.cur, 2);
  assert.strictEqual(g.need, 15);
  assert.strictEqual(g.display, '2 / 15');
  assert.strictEqual(g.over, false);
  assert.strictEqual(Math.round(g.pct), 13);
});

test('nigekireOshiGauge: 通過5回・8点 → 「8 / 15」', () => {
  const g = L.nigekireOshiGauge({ tsukiko: 8 }, 'tsukiko', { tsukiko: 5 }, NIGEKIRE_TH);
  assert.strictEqual(g.need, 15);
  assert.strictEqual(g.display, '8 / 15');
  assert.strictEqual(g.over, false);
});

test('nigekireOshiGauge: オーバー値は分子だけ伸びる（20 / 15）・pct は100止まり', () => {
  const g = L.nigekireOshiGauge({ tsukiko: 20 }, 'tsukiko', { tsukiko: 6 }, NIGEKIRE_TH);
  assert.strictEqual(g.cur, 20);
  assert.strictEqual(g.need, 15);
  assert.strictEqual(g.display, '20 / 15');
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.pct, 100);
});

test('nigekireOshiGauge: 途中の閾値(10点)でも分母は15のまま・over=false', () => {
  const g = L.nigekireOshiGauge({ tsukiko: 10 }, 'tsukiko', { tsukiko: 4 }, NIGEKIRE_TH);
  assert.strictEqual(g.display, '10 / 15');
  assert.strictEqual(g.over, false);
  assert.strictEqual(Math.round(g.pct), 67);
});

test('nigekireOshiGauge: ちょうど最終閾値(15点)なら over=false・pct=100', () => {
  const g = L.nigekireOshiGauge({ tsukiko: 15 }, 'tsukiko', { tsukiko: 6 }, NIGEKIRE_TH);
  assert.strictEqual(g.display, '15 / 15');
  assert.strictEqual(g.over, false);
  assert.strictEqual(g.pct, 100);
});

test('nigekireOshiGauge: 選択中キャラのぶんだけ見る（他キャラは無関係）', () => {
  const g = L.nigekireOshiGauge({ you: 99, tsukiko: 3 }, 'tsukiko', { tsukiko: 3 }, NIGEKIRE_TH);
  assert.strictEqual(g.display, '3 / 15');
});

test('nigekireOshiGauge: 不正入力（推し未選択・非数）でも落ちない', () => {
  const a = L.nigekireOshiGauge({}, null, {}, NIGEKIRE_TH);
  assert.strictEqual(a.cur, 0);
  assert.strictEqual(a.display, '0 / 15');
  const b = L.nigekireOshiGauge({ tsukiko: 'x' }, 'tsukiko', null, NIGEKIRE_TH);
  assert.strictEqual(b.cur, 0);
  const c = L.nigekireOshiGauge(null, 'tsukiko', {}, null);
  assert.strictEqual(c.cur, 0);
  assert.strictEqual(c.need, 0);
  assert.strictEqual(c.pct, 0);
});

// ---- N6: nigekireRankStageFromReached ----

test('nigekireRankStageFromReached: 到達数がそのまま段になる', () => {
  assert.strictEqual(L.nigekireRankStageFromReached([], 6), 0);
  assert.strictEqual(L.nigekireRankStageFromReached(['escape3'], 6), 1);
  assert.strictEqual(L.nigekireRankStageFromReached(['escape3', 'escape6', 'escape9'], 6), 3);
  assert.strictEqual(
    L.nigekireRankStageFromReached(['escape3', 'escape6', 'escape9', 'point5', 'point10', 'point15'], 6), 6
  );
});

test('nigekireRankStageFromReached: maxStage でクランプ・不正入力は0', () => {
  assert.strictEqual(L.nigekireRankStageFromReached(['a', 'b', 'c'], 2), 2);
  assert.strictEqual(L.nigekireRankStageFromReached(null, 6), 0);
  assert.strictEqual(L.nigekireRankStageFromReached(['a'], null), 0);
  assert.strictEqual(L.nigekireRankStageFromReached(['a'], -3), 0);
});

// ---- nigekireRankLabel（等級記号の前置） ----

test('nigekireRankLabel: grade があれば「SS:名前」の形にする', () => {
  assert.strictEqual(L.nigekireRankLabel({ grade: 'SS', name: 'おはカノ生活管理人' }), 'SS:おはカノ生活管理人');
  assert.strictEqual(L.nigekireRankLabel({ grade: 'E', name: '言い訳見習い' }), 'E:言い訳見習い');
});

test('nigekireRankLabel: grade が無ければ名前だけ返す', () => {
  assert.strictEqual(L.nigekireRankLabel({ name: '生活防衛中' }), '生活防衛中');
  assert.strictEqual(L.nigekireRankLabel({ grade: '', name: '生活防衛中' }), '生活防衛中');
});

test('nigekireRankLabel: 不正入力は空文字', () => {
  assert.strictEqual(L.nigekireRankLabel(null), '');
  assert.strictEqual(L.nigekireRankLabel({}), '');
  assert.strictEqual(L.nigekireRankLabel({ grade: 'S' }), '');
});

test('nigekireRankLabel: 曜日の積み上げと併用できる（SS:名前〈月水〉）', () => {
  const chars = [
    { key: 'tsukiko', label: '月曜' },
    { key: 'you', label: '火曜' },
    { key: 'shizuku', label: '水曜' },
  ];
  const label = L.nigekireRankLabel({ grade: 'SS', name: 'おはカノ生活管理人' });
  assert.strictEqual(
    L.nigekireRankTitleWithDays(label, ['tsukiko', 'shizuku'], chars),
    'SS:おはカノ生活管理人〈月水〉'
  );
});

// ---------------------------------------------------------------------------
// P群: 通しの進行（純関数の組み合わせ）＋ クイズデータの実体検証
//   個々の関数は上で固定済み。ここで守るのは「つなげたときに完走できるか」。
//   ニゲキレv2は構造が4回変わっており、関数単体が正しくても
//   組み合わせ（節目→通過→rankStage）が崩れる事故が実際に起きたため、
//   推し1人ぶんの初期試練を最後まで通して固定する。
// ---------------------------------------------------------------------------

// app.js の NIGEKIRE_LIFE_RANKS と同一（ゴールデン基準・全7段）。
const NIGEKIRE_LIFE_RANKS_P = [
  { stage: 1, min: 0, grade: 'E', name: '言い訳見習い', key: 'nige1' },
  { stage: 2, min: 0, grade: 'D', name: '言い訳準備中', key: 'nige2' },
  { stage: 3, min: 0, grade: 'C', name: '生活立て直し中', key: 'nige3' },
  { stage: 4, min: 0, grade: 'B', name: '生活防衛中', key: 'nige4' },
  { stage: 5, min: 70, grade: 'A', name: '火種処理係', key: 'nige5' },
  { stage: 6, min: 120, grade: 'S', name: 'おはカノ生活継続者', key: 'nige6' },
  { stage: 7, min: 200, grade: 'SS', name: 'おはカノ生活管理人', key: 'nige7' },
];

// 推し1人の初期試練を n 本ぶん通す（app.js の呼び出し順と同じ組み合わせ）。
//   逃げ切り1本 = nigekireTrialV2 → escapeCounts+1 → 節目判定 → 出ていれば通過。
//   返り値で「何回節目を通過したか」「rankStage がいくつか」を観測する。
function runOshiTrial(oshiChar, books) {
  let escapeCounts = {};
  let oshiPassCounts = {};
  let reached = [];
  let oshiCleared = [];
  let passed = {};
  let totalSuccess = 0;
  const passes = [];

  for (let i = 0; i < books; i++) {
    const articleId = oshiChar + '_' + i;
    const t = L.nigekireTrialV2(passed, totalSuccess, 0, articleId, true);
    assert.strictEqual(t.ok, true, articleId + ' で試練が通らない');
    passed = Object.assign({}, passed, { [articleId]: true });
    totalSuccess = t.nextTotalSuccess;
    escapeCounts = Object.assign({}, escapeCounts, {
      [oshiChar]: (escapeCounts[oshiChar] || 0) + 1,
    });

    const m = L.nigekireOshiMilestone(
      escapeCounts, {}, oshiPassCounts, oshiChar, NIGEKIRE_TH
    );
    if (!m.ready) continue;
    const p = L.nigekirePassOshiMilestone(
      reached, oshiPassCounts, oshiCleared, oshiChar, m.kind, m.need
    );
    if (!p.ok) continue;
    reached = p.nextReached;
    oshiPassCounts = p.nextPassCounts;
    oshiCleared = p.nextCleared;
    passes.push({ atBook: i + 1, need: m.need, rankUp: p.rankUp });
  }

  const rankStage = L.nigekireRankStageFromReached(
    reached, NIGEKIRE_LIFE_RANKS_P.length - 1
  );
  return { passes, rankStage, reached, oshiCleared, escapeCounts };
}

test('通し: 推し1人の初期試練9本で 3/6/9 の節目を3回通過する', () => {
  const out = runOshiTrial('shizuku', 9);
  assert.strictEqual(out.passes.length, 3);
  assert.deepStrictEqual(
    out.passes.map((p) => p.atBook),
    [3, 6, 9]
  );
  assert.deepStrictEqual(
    out.passes.map((p) => p.need),
    [3, 6, 9]
  );
});

test('通し: 初期試練3回でランクは E(0) → B(3) まで上がる', () => {
  const out = runOshiTrial('shizuku', 9);
  assert.strictEqual(out.rankStage, 3);
  const rank = L.nigekireRankByStage(out.rankStage, NIGEKIRE_LIFE_RANKS_P);
  assert.strictEqual(L.nigekireRankLabel(rank), 'B:生活防衛中');
});

test('通し: 3回通過した推しは oshiCleared に載る（キャラ変更が解禁される）', () => {
  const out = runOshiTrial('shizuku', 9);
  assert.deepStrictEqual(out.oshiCleared, ['shizuku']);
});

test('通し: 8本では3回目の節目に届かない（rankStage は 2 で止まる）', () => {
  // クイズが9本ないキャラが出ると初期試練を完了できない。
  // 「止まるだけでクラッシュしない」ことも同時に固定する。
  const out = runOshiTrial('runa', 8);
  assert.strictEqual(out.passes.length, 2);
  assert.strictEqual(out.rankStage, 2);
  assert.deepStrictEqual(out.oshiCleared, []);
});

test('通し: 2人目の初期試練ではランクが動かない（節目は出るが初到達でない）', () => {
  // 1人目で reached に escape_3/6/9 が入っているので、2人目は rankUp しない。
  const first = runOshiTrial('shizuku', 9);
  let reached = first.reached;
  let oshiPassCounts = {};
  let oshiCleared = first.oshiCleared;
  let escapeCounts = {};
  const rankUps = [];

  for (let i = 0; i < 9; i++) {
    escapeCounts = Object.assign({}, escapeCounts, { runa: (escapeCounts.runa || 0) + 1 });
    const m = L.nigekireOshiMilestone(escapeCounts, {}, oshiPassCounts, 'runa', NIGEKIRE_TH);
    if (!m.ready) continue;
    const p = L.nigekirePassOshiMilestone(
      reached, oshiPassCounts, oshiCleared, 'runa', m.kind, m.need
    );
    reached = p.nextReached;
    oshiPassCounts = p.nextPassCounts;
    oshiCleared = p.nextCleared;
    rankUps.push(p.rankUp);
  }

  // 節目は3回出るが、いずれも初到達ではないのでランクは上がらない。
  assert.strictEqual(rankUps.length, 3);
  assert.deepStrictEqual(rankUps, [false, false, false]);
  assert.strictEqual(
    L.nigekireRankStageFromReached(reached, NIGEKIRE_LIFE_RANKS_P.length - 1),
    3
  );
  // 進行感は称号の曜日積み上げで出る（〈水金〉）。
  assert.deepStrictEqual(oshiCleared, ['shizuku', 'runa']);
  const rank = L.nigekireRankByStage(3, NIGEKIRE_LIFE_RANKS_P);
  assert.strictEqual(
    L.nigekireRankTitleWithDays(L.nigekireRankLabel(rank), oshiCleared, NIGEKIRE_CHARS_M),
    'B:生活防衛中〈水金〉'
  );
});

// ---- P2: nigekire_quiz.json（生成物）の実体検証 ----
//   生成物は tools/build-nigekire-quiz.mjs の出力。再生成し忘れると
//   古い本数のまま残り、特定キャラが初期試練を完走できなくなる
//   （実際に 62本のまま残っていて しずく/るな/まひる が8本で止まった）。

const NIGEKIRE_QUIZ = require('../nigekire_quiz.json');
const NIGEKIRE_NAME_BY_KEY = {
  tsukiko: '月子', you: '陽', shizuku: 'しずく', rinka: '凛華',
  runa: 'るな', mahiru: 'まひる', hiyori: '日和',
};

test('quizデータ: 全7人が初期試練を完走できる本数（9本以上）を持つ', () => {
  const byChar = {};
  for (const key of Object.keys(NIGEKIRE_QUIZ.quizzes)) {
    const c = NIGEKIRE_QUIZ.quizzes[key].character;
    byChar[c] = (byChar[c] || 0) + 1;
  }
  for (const charKey of Object.keys(NIGEKIRE_NAME_BY_KEY)) {
    const name = NIGEKIRE_NAME_BY_KEY[charKey];
    assert.ok(
      (byChar[name] || 0) >= 9,
      name + ' のクイズが ' + (byChar[name] || 0) + '本しかない（9本必要・要 build-nigekire-quiz.mjs 再実行）'
    );
  }
});

test('quizデータ: weekday とキャラの対応が NIGEKIRE_CHARS_M と一致する', () => {
  const weekdayByName = {};
  NIGEKIRE_CHARS_M.forEach((ch) => {
    weekdayByName[ch.name] = ch.weekday;
  });
  for (const key of Object.keys(NIGEKIRE_QUIZ.quizzes)) {
    const q = NIGEKIRE_QUIZ.quizzes[key];
    assert.strictEqual(
      q.weekday, weekdayByName[q.character],
      key + ' の weekday が キャラ(' + q.character + ') と食い違う'
    );
  }
});

test('quizデータ: 全問が3択で正解がちょうど1つ・correctKey と一致する', () => {
  for (const key of Object.keys(NIGEKIRE_QUIZ.quizzes)) {
    const q = NIGEKIRE_QUIZ.quizzes[key];
    assert.ok(q.question, key + ' に question がない');
    assert.strictEqual(q.choices.length, 3, key + ' が3択でない');
    const correct = q.choices.filter((c) => c.isCorrect);
    assert.strictEqual(correct.length, 1, key + ' の正解が1つでない');
    assert.strictEqual(correct[0].key, q.correctKey, key + ' の correctKey が正解肢と食い違う');
  }
});

// ---------------------------------------------------------------------------
// X群: ニゲキレ交換所（おへんじ帖の季節衣装）
//   参照: nigekire-exchange-spec.md
//   ★ここで最も強く守るのは「ポイントが減らない」こと（§2）。
//     減算を入れるとランク（初到達ベース）と食い違い、
//     「最高ランクなのにゲージが満タンでない」状態が起きる。
// ---------------------------------------------------------------------------

// §2 の到達表（app.js の NIGEKIRE_OUTFIT_THRESHOLDS と同値）。
const OUTFIT_TH = [5, 10, 15, 20];
// 現時点で画像がある季節（assets/ohakano/chibi-summer/ のみ）。
const OUTFIT_AVAIL = ['summer'];

test('交換所: 到達数で着数が決まる（0/5/10/15/20 の境界）', () => {
  assert.strictEqual(L.nigekireOutfitAllowance(0, OUTFIT_TH), 0);
  assert.strictEqual(L.nigekireOutfitAllowance(4, OUTFIT_TH), 0);
  assert.strictEqual(L.nigekireOutfitAllowance(5, OUTFIT_TH), 1);
  assert.strictEqual(L.nigekireOutfitAllowance(9, OUTFIT_TH), 1);
  assert.strictEqual(L.nigekireOutfitAllowance(10, OUTFIT_TH), 2);
  assert.strictEqual(L.nigekireOutfitAllowance(15, OUTFIT_TH), 3);
  assert.strictEqual(L.nigekireOutfitAllowance(20, OUTFIT_TH), 4);
});

test('交換所: 20pt超（オーバー値）でも4着で頭打ち', () => {
  assert.strictEqual(L.nigekireOutfitAllowance(23, OUTFIT_TH), 4);
  assert.strictEqual(L.nigekireOutfitAllowance(999, OUTFIT_TH), 4);
});

test('交換所: 次の閾値（「次は10pt」の 10）', () => {
  assert.strictEqual(L.nigekireOutfitNextThreshold(0, OUTFIT_TH), 5);
  assert.strictEqual(L.nigekireOutfitNextThreshold(5, OUTFIT_TH), 10);
  assert.strictEqual(L.nigekireOutfitNextThreshold(19, OUTFIT_TH), 20);
  assert.strictEqual(L.nigekireOutfitNextThreshold(20, OUTFIT_TH), null); // 全部到達
});

test('交換所: 解放済み季節をキャラで絞り、春夏秋冬順に正規化する', () => {
  const unlocks = [
    { characterId: 'tsukiko', season: 'winter' },
    { characterId: 'shizuku', season: 'summer' },
    { characterId: 'tsukiko', season: 'summer' },
  ];
  // APIの返却順（winter→summer）に依存せず、必ず春夏秋冬順。
  assert.deepStrictEqual(L.nigekireUnlockedSeasons(unlocks, 'tsukiko'), ['summer', 'winter']);
  assert.deepStrictEqual(L.nigekireUnlockedSeasons(unlocks, 'shizuku'), ['summer']);
  assert.deepStrictEqual(L.nigekireUnlockedSeasons(unlocks, 'runa'), []);
});

test('交換所: 5pt未満は交換できない（夏は short・「あと5pt」）', () => {
  const st = L.nigekireOutfitState(0, [], OUTFIT_AVAIL, OUTFIT_TH);
  assert.strictEqual(st.allowance, 0);
  assert.strictEqual(st.remaining, 0);
  const summer = st.seasons.find((s) => s.season === 'summer');
  assert.strictEqual(summer.state, 'short');
  assert.strictEqual(summer.shortfall, 5); // 不足分を出す（「5pt」ではなく「あと5pt」）
});

test('交換所: 2pt なら「あと3pt」（不足分であって閾値ではない）', () => {
  const st = L.nigekireOutfitState(2, [], OUTFIT_AVAIL, OUTFIT_TH);
  assert.strictEqual(st.seasons.find((s) => s.season === 'summer').shortfall, 3);
});

test('交換所: 5ptで夏が交換可能になる（未実装の春秋冬は unimplemented のまま）', () => {
  const st = L.nigekireOutfitState(5, [], OUTFIT_AVAIL, OUTFIT_TH);
  assert.strictEqual(st.allowance, 1);
  assert.strictEqual(st.remaining, 1);
  const byKey = Object.fromEntries(st.seasons.map((s) => [s.season, s.state]));
  assert.deepStrictEqual(byKey, {
    spring: 'unimplemented',
    summer: 'exchangeable',
    autumn: 'unimplemented',
    winter: 'unimplemented',
  });
});

test('交換所: 5pt・1着取得済み → 残り0着・次は10pt（§5の表示例）', () => {
  const st = L.nigekireOutfitState(5, ['summer'], OUTFIT_AVAIL, OUTFIT_TH);
  assert.strictEqual(st.allowance, 1);
  assert.strictEqual(st.usedCount, 1);
  assert.strictEqual(st.remaining, 0);
  assert.strictEqual(st.nextThreshold, 10);
  assert.strictEqual(st.seasons.find((s) => s.season === 'summer').state, 'unlocked');
});

test('交換所: 15pt・1着取得済み → 残り2着（§5の表示例）', () => {
  const st = L.nigekireOutfitState(15, ['summer'], OUTFIT_AVAIL, OUTFIT_TH);
  assert.strictEqual(st.allowance, 3);
  assert.strictEqual(st.remaining, 2);
});

test('交換所: 取得済みは実装状況より優先（未実装季節でも unlocked で出す）', () => {
  // 将来 autumn を配ったあと画像だけ差し戻る等でも、解放済みは必ず表示する。
  const st = L.nigekireOutfitState(10, ['autumn'], OUTFIT_AVAIL, OUTFIT_TH);
  assert.strictEqual(st.seasons.find((s) => s.season === 'autumn').state, 'unlocked');
});

test('交換所: 枠を使い切ると未取得の実装済み季節は short に落ちる', () => {
  // 10pt=2着だが、実装済みが夏だけなので夏を取ると残り1着が余る。
  // ここでは available を広げて枠切れを作る。
  const st = L.nigekireOutfitState(5, ['summer'], ['summer', 'autumn'], OUTFIT_TH);
  assert.strictEqual(st.remaining, 0);
  assert.strictEqual(st.seasons.find((s) => s.season === 'autumn').state, 'short');
  assert.strictEqual(st.seasons.find((s) => s.season === 'autumn').shortfall, 5); // 10pt まであと5
});

test('交換所: canUnlock は exchangeable のときだけ true', () => {
  assert.strictEqual(L.nigekireCanUnlockOutfit(5, [], OUTFIT_AVAIL, 'summer', OUTFIT_TH), true);
  assert.strictEqual(L.nigekireCanUnlockOutfit(4, [], OUTFIT_AVAIL, 'summer', OUTFIT_TH), false);
  // 取得済みは再交換できない
  assert.strictEqual(L.nigekireCanUnlockOutfit(5, ['summer'], OUTFIT_AVAIL, 'summer', OUTFIT_TH), false);
  // 未実装は交換できない
  assert.strictEqual(L.nigekireCanUnlockOutfit(20, [], OUTFIT_AVAIL, 'autumn', OUTFIT_TH), false);
});

test('交換所: 解放の反映は非破壊・二重登録しない', () => {
  const before = [{ characterId: 'tsukiko', season: 'summer', unlockedAt: 'A' }];
  const after = L.nigekireApplyOutfitUnlock(before, 'shizuku', 'summer', 'B');
  assert.strictEqual(before.length, 1); // 入力を書き換えない
  assert.strictEqual(after.length, 2);
  // 同じ組み合わせをもう一度 → 増えない（APIの alreadyUnlocked と対応）
  const again = L.nigekireApplyOutfitUnlock(after, 'shizuku', 'summer', 'C');
  assert.strictEqual(again.length, 2);
});

test('交換所[★核心]: 解放してもポイントは減らない', () => {
  // ポイントを引数に取る関数はどれも state を持たない＝減算のしようがないことを、
  // 「解放前後で allowance が下がらない」形で固定する。
  const points = 15;
  const before = L.nigekireOutfitState(points, [], OUTFIT_AVAIL, OUTFIT_TH);
  const unlocks = L.nigekireApplyOutfitUnlock([], 'tsukiko', 'summer', 'X');
  const seasons = L.nigekireUnlockedSeasons(unlocks, 'tsukiko');
  const after = L.nigekireOutfitState(points, seasons, OUTFIT_AVAIL, OUTFIT_TH);

  // 到達数（＝ランクと共通の閾値判定）は解放しても不変。
  assert.strictEqual(before.allowance, 3);
  assert.strictEqual(after.allowance, 3);
  // 減るのは「残り枠」だけで、ポイント由来の allowance ではない。
  assert.strictEqual(after.remaining, 2);
});
