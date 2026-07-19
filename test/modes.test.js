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

// ---- nigekireLifeRank（生活ランク境界） ----

test('nigekireLifeRank: 4段階の境界（29/30/69/70/119/120）', () => {
  assert.strictEqual(L.nigekireLifeRank(0, NIGEKIRE_LIFE_RANKS).name, '言い訳見習い');
  assert.strictEqual(L.nigekireLifeRank(29, NIGEKIRE_LIFE_RANKS).name, '言い訳見習い');
  assert.strictEqual(L.nigekireLifeRank(30, NIGEKIRE_LIFE_RANKS).name, '生活防衛中');
  assert.strictEqual(L.nigekireLifeRank(30, NIGEKIRE_LIFE_RANKS).stage, 2);
  assert.strictEqual(L.nigekireLifeRank(69, NIGEKIRE_LIFE_RANKS).name, '生活防衛中');
  assert.strictEqual(L.nigekireLifeRank(70, NIGEKIRE_LIFE_RANKS).name, '火種処理係');
  assert.strictEqual(L.nigekireLifeRank(119, NIGEKIRE_LIFE_RANKS).name, '火種処理係');
  assert.strictEqual(L.nigekireLifeRank(120, NIGEKIRE_LIFE_RANKS).name, 'おはカノ生活継続者');
  assert.strictEqual(L.nigekireLifeRank(120, NIGEKIRE_LIFE_RANKS).stage, 4);
  assert.strictEqual(L.nigekireLifeRank(9999, NIGEKIRE_LIFE_RANKS).name, 'おはカノ生活継続者');
});

test('nigekireLifeRank: ranks 空/不正は stage0', () => {
  assert.deepStrictEqual(L.nigekireLifeRank(100, []), { stage: 0, name: '', key: '' });
  assert.deepStrictEqual(L.nigekireLifeRank(100, null), { stage: 0, name: '', key: '' });
});

test('nigekireLifeRank: key を返す（バッジ色クラス rank-<key> の元）', () => {
  var ranks = [
    { stage: 1, min: 0, name: '言い訳見習い', key: 'nige1' },
    { stage: 2, min: 30, name: '生活防衛中', key: 'nige2' },
  ];
  assert.strictEqual(L.nigekireLifeRank(0, ranks).key, 'nige1');
  assert.strictEqual(L.nigekireLifeRank(30, ranks).key, 'nige2');
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

// ---- nigekireTopCharacter（同点の曜日順優先・全0） ----

test('nigekireTopCharacter: 最大ポイントのキャラ', () => {
  const pts = { tsukiko: 3, you: 10, runa: 7 };
  assert.strictEqual(L.nigekireTopCharacter(pts, NIGEKIRE_CHARACTERS).name, '陽');
});

test('nigekireTopCharacter: 同点は曜日順で先を採る', () => {
  // 月子(mon) と 陽(tue) が同点10 → 先（曜日順で早い月子）が残る。
  const pts = { tsukiko: 10, you: 10 };
  assert.strictEqual(L.nigekireTopCharacter(pts, NIGEKIRE_CHARACTERS).key, 'tsukiko');
});

test('nigekireTopCharacter: 全0なら先頭（月子）', () => {
  assert.strictEqual(L.nigekireTopCharacter({}, NIGEKIRE_CHARACTERS).key, 'tsukiko');
  assert.strictEqual(L.nigekireTopCharacter(null, NIGEKIRE_CHARACTERS).key, 'tsukiko');
});

test('nigekireTopCharacter: characters 空/不正は null', () => {
  assert.strictEqual(L.nigekireTopCharacter({ tsukiko: 5 }, []), null);
  assert.strictEqual(L.nigekireTopCharacter({ tsukiko: 5 }, null), null);
});

// ---- nigekireTotalPoints ----

test('nigekireTotalPoints: 全キャラ合算', () => {
  assert.strictEqual(L.nigekireTotalPoints({ tsukiko: 3, you: 10, runa: 7 }), 20);
  assert.strictEqual(L.nigekireTotalPoints({}), 0);
  assert.strictEqual(L.nigekireTotalPoints(null), 0);
});

// ---- nigekireTrialPoints（ポイント表 light/medium/heavy × 通常/一発） ----

test('nigekireTrialPoints: 火種ランク×通常/一発', () => {
  assert.strictEqual(L.nigekireTrialPoints('light', false, NIGEKIRE_POINTS), 1);
  assert.strictEqual(L.nigekireTrialPoints('light', true, NIGEKIRE_POINTS), 2);
  assert.strictEqual(L.nigekireTrialPoints('medium', false, NIGEKIRE_POINTS), 2);
  assert.strictEqual(L.nigekireTrialPoints('medium', true, NIGEKIRE_POINTS), 3);
  assert.strictEqual(L.nigekireTrialPoints('heavy', false, NIGEKIRE_POINTS), 3);
  assert.strictEqual(L.nigekireTrialPoints('heavy', true, NIGEKIRE_POINTS), 4);
});

test('nigekireTrialPoints: 未定義ランクは0', () => {
  assert.strictEqual(L.nigekireTrialPoints('unknown', false, NIGEKIRE_POINTS), 0);
  assert.strictEqual(L.nigekireTrialPoints('light', false, {}), 0);
});

// ---- nigekireSuccessOutcome（試練通過） ----

test('nigekireSuccessOutcome: medium一発で+3・成功数と一発数が増える', () => {
  const out = L.nigekireSuccessOutcome(
    { tsukiko: 5 }, 3, 1, {},
    'tsukiko', 'a1', 'medium', true, NIGEKIRE_POINTS, NIGEKIRE_LIFE_RANKS
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.awardedPoints, 3);
  assert.strictEqual(out.nextCharPoints.tsukiko, 8); // 5 + 3
  assert.strictEqual(out.nextTotalSuccess, 4);
  assert.strictEqual(out.nextFirstTrySuccess, 2);
  assert.strictEqual(out.nextPassed['a1'], true);
});

test('nigekireSuccessOutcome: 通常成功は一発数を増やさない', () => {
  const out = L.nigekireSuccessOutcome(
    {}, 0, 0, {},
    'runa', 'a2', 'light', false, NIGEKIRE_POINTS, NIGEKIRE_LIFE_RANKS
  );
  assert.strictEqual(out.awardedPoints, 1);
  assert.strictEqual(out.nextCharPoints.runa, 1);
  assert.strictEqual(out.nextTotalSuccess, 1);
  assert.strictEqual(out.nextFirstTrySuccess, 0); // 一発でないので据え置き
});

test('nigekireSuccessOutcome: passed 済みは ok:false（二重取り防止）', () => {
  const out = L.nigekireSuccessOutcome(
    { tsukiko: 5 }, 1, 0, { a1: true },
    'tsukiko', 'a1', 'heavy', true, NIGEKIRE_POINTS, NIGEKIRE_LIFE_RANKS
  );
  assert.deepStrictEqual(out, { ok: false });
});

test('nigekireSuccessOutcome: rankUpdated — 境界跨ぎ(29→30)でtrue', () => {
  // 総29pt（tsukiko29）で light通常(+1) → 30到達 → 段階1→2 に上がる。
  const out = L.nigekireSuccessOutcome(
    { tsukiko: 29 }, 5, 0, {},
    'you', 'a3', 'light', false, NIGEKIRE_POINTS, NIGEKIRE_LIFE_RANKS
  );
  assert.strictEqual(out.lifeRankBefore.name, '言い訳見習い');
  assert.strictEqual(out.lifeRankAfter.name, '生活防衛中');
  assert.strictEqual(out.rankUpdated, true);
});

test('nigekireSuccessOutcome: rankUpdated — 跨がなければ false', () => {
  const out = L.nigekireSuccessOutcome(
    { tsukiko: 10 }, 5, 0, {},
    'you', 'a3', 'light', false, NIGEKIRE_POINTS, NIGEKIRE_LIFE_RANKS
  );
  assert.strictEqual(out.rankUpdated, false);
  assert.strictEqual(out.lifeRankBefore.name, '言い訳見習い');
  assert.strictEqual(out.lifeRankAfter.name, '言い訳見習い');
});

test('nigekireSuccessOutcome: 非破壊（入力を書き換えない）', () => {
  const charPoints = { tsukiko: 5 };
  const passed = {};
  const out = L.nigekireSuccessOutcome(
    charPoints, 0, 0, passed,
    'tsukiko', 'a1', 'medium', true, NIGEKIRE_POINTS, NIGEKIRE_LIFE_RANKS
  );
  assert.deepStrictEqual(charPoints, { tsukiko: 5 }); // 入力そのまま
  assert.deepStrictEqual(passed, {});
  assert.notStrictEqual(out.nextCharPoints, charPoints);
  assert.notStrictEqual(out.nextPassed, passed);
});

// ---- nigekireCollectOutcome（回収型 +1pt） ----

test('nigekireCollectOutcome: タップ回収で担当キャラ +1', () => {
  const out = L.nigekireCollectOutcome({ runa: 4 }, {}, 'runa', 'a1', NIGEKIRE_LIFE_RANKS);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.awardedPoints, 1);
  assert.strictEqual(out.nextCharPoints.runa, 5);
  assert.strictEqual(out.nextCollected['a1'], true);
});

test('nigekireCollectOutcome: collected 済みは ok:false（二重取り防止）', () => {
  const out = L.nigekireCollectOutcome({ runa: 4 }, { a1: true }, 'runa', 'a1', NIGEKIRE_LIFE_RANKS);
  assert.deepStrictEqual(out, { ok: false });
});

test('nigekireCollectOutcome: rankUpdated — 境界跨ぎ(29→30)でtrue', () => {
  const out = L.nigekireCollectOutcome({ tsukiko: 29 }, {}, 'you', 'a1', NIGEKIRE_LIFE_RANKS);
  assert.strictEqual(out.rankUpdated, true);
  assert.strictEqual(out.lifeRankAfter.name, '生活防衛中');
});

test('nigekireCollectOutcome: 非破壊（入力を書き換えない）', () => {
  const charPoints = { runa: 4 };
  const collected = {};
  const out = L.nigekireCollectOutcome(charPoints, collected, 'runa', 'a1', NIGEKIRE_LIFE_RANKS);
  assert.deepStrictEqual(charPoints, { runa: 4 });
  assert.deepStrictEqual(collected, {});
  assert.notStrictEqual(out.nextCharPoints, charPoints);
  assert.notStrictEqual(out.nextCollected, collected);
});

// ============================================================================
// G群: クリエイター削除時のモード掃除（純関数・非破壊）
//   app.js deleteCreator の副作用ロジックを切り出したゴールデン。挙動を1バイトも変えない。
//   本質: モードは creator に「横断」で紐づく。キタコレ本体(KITACORE_ID)だけ player リセット、
//   ニゲキレ本体(NIGEKIRE_ID)だけ丸ごとリセット。取り違え（キタコレ固定 vs 横断）を守る。
// ============================================================================

const KITACORE_ID = 'ktcrs1107';
const NIGEKIRE_ID = 'hasyamo';

// app.js の MODE_DEFS と同一（ゴールデン基準）。逆引き対象クリエイター。
const MODE_DEFS_REAL = {
  kitacore: { key: 'kitacore', targetCreatorId: KITACORE_ID },
  nigekire: { key: 'nigekire', targetCreatorId: NIGEKIRE_ID },
};

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

// ---- H1: nigekireLifeRankV2（5段階境界） ----

test('nigekireLifeRankV2: 5段階境界（29/30/69/70/119/120/199/200）', () => {
  const R = NIGEKIRE_LIFE_RANKS_V2;
  assert.strictEqual(L.nigekireLifeRankV2(0, R).stage, 1);
  assert.strictEqual(L.nigekireLifeRankV2(29, R).stage, 1);
  assert.strictEqual(L.nigekireLifeRankV2(30, R).stage, 2);
  assert.strictEqual(L.nigekireLifeRankV2(69, R).stage, 2);
  assert.strictEqual(L.nigekireLifeRankV2(70, R).stage, 3);
  assert.strictEqual(L.nigekireLifeRankV2(119, R).stage, 3);
  assert.strictEqual(L.nigekireLifeRankV2(120, R).stage, 4);
  assert.strictEqual(L.nigekireLifeRankV2(199, R).stage, 4);
  assert.strictEqual(L.nigekireLifeRankV2(200, R).stage, 5);
  assert.strictEqual(L.nigekireLifeRankV2(999, R).stage, 5);
});

test('nigekireLifeRankV2: name/key も段階に対応（200→おはカノ生活管理人/nige5）', () => {
  const out = L.nigekireLifeRankV2(200, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.name, 'おはカノ生活管理人');
  assert.strictEqual(out.key, 'nige5');
});

test('nigekireLifeRankV2: 空/不正 ranks は stage0/name空/key空', () => {
  assert.deepStrictEqual(L.nigekireLifeRankV2(50, []), { stage: 0, name: '', key: '' });
  assert.deepStrictEqual(L.nigekireLifeRankV2(50, null), { stage: 0, name: '', key: '' });
  // 非数の totalCollected は 0 扱い → 先頭段階
  assert.strictEqual(L.nigekireLifeRankV2('x', NIGEKIRE_LIFE_RANKS_V2).stage, 1);
});

// ---- H2: nigekireGaugeProgress（進行率・オーバー） ----

test('nigekireGaugeProgress: pct計算（42→30%・現min30/次min70）', () => {
  const out = L.nigekireGaugeProgress(42, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.cur, 42);
  assert.strictEqual(out.curMin, 30);
  assert.strictEqual(out.nextMin, 70);
  assert.strictEqual(out.pct, 30); // (42-30)/(70-30)*100
  assert.strictEqual(out.over, false);
  assert.strictEqual(out.display, '42 / 200');
});

test('nigekireGaugeProgress: 最終ランクは pct=100 固定（cur=200）', () => {
  const out = L.nigekireGaugeProgress(200, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.pct, 100);
  assert.strictEqual(out.over, false); // 200 は over ではない（>200 が over）
  assert.strictEqual(out.display, '200 / 200');
});

test('nigekireGaugeProgress: over（255→over:true・display 255/200・pct100）', () => {
  const out = L.nigekireGaugeProgress(255, NIGEKIRE_LIFE_RANKS_V2);
  assert.strictEqual(out.over, true);
  assert.strictEqual(out.display, '255 / 200');
  assert.strictEqual(out.pct, 100); // 最終ランク帯なので満タン
});

test('nigekireGaugeProgress: 先頭ランク帯 pct（0→0%・15→50%）', () => {
  assert.strictEqual(L.nigekireGaugeProgress(0, NIGEKIRE_LIFE_RANKS_V2).pct, 0);
  assert.strictEqual(L.nigekireGaugeProgress(15, NIGEKIRE_LIFE_RANKS_V2).pct, 50); // (15-0)/(30-0)*100
});

test('nigekireGaugeProgress: 空 ranks はゼロ・display は cur/200・over判定は生きる', () => {
  const a = L.nigekireGaugeProgress(50, []);
  assert.strictEqual(a.pct, 0);
  assert.strictEqual(a.display, '50 / 200');
  assert.strictEqual(a.over, false);
  const b = L.nigekireGaugeProgress(300, null);
  assert.strictEqual(b.over, true);
  assert.strictEqual(b.display, '300 / 200');
});

// ---- H3: nigekireTotalCollected ----

test('nigekireTotalCollected: 7人合算', () => {
  assert.strictEqual(
    L.nigekireTotalCollected({ tsukiko: 3, you: 5, shizuku: 0, rinka: 2, runa: 1, mahiru: 4, hiyori: 6 }),
    21
  );
});

test('nigekireTotalCollected: 非オブジェクト/空は0・非数は無視', () => {
  assert.strictEqual(L.nigekireTotalCollected(null), 0);
  assert.strictEqual(L.nigekireTotalCollected(undefined), 0);
  assert.strictEqual(L.nigekireTotalCollected('x'), 0);
  assert.strictEqual(L.nigekireTotalCollected({}), 0);
  assert.strictEqual(L.nigekireTotalCollected({ tsukiko: 2, bad: 'x', you: 3 }), 5);
});

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

// ---- H5: detectHitokotoChar（一言抽出＋ホワイトリスト） ----

test('detectHitokotoChar: <h2 name="x">陽の一言</h2> → you', () => {
  assert.strictEqual(L.detectHitokotoChar('<h2 name="x">陽の一言</h2>', NAME_TO_KEY), 'you');
});

test('detectHitokotoChar: 素の <h2>月子の一言</h2> → tsukiko', () => {
  assert.strictEqual(L.detectHitokotoChar('前置き<h2>月子の一言</h2>本文', NAME_TO_KEY), 'tsukiko');
});

test('detectHitokotoChar: KITAさんはホワイトリスト外 → null', () => {
  assert.strictEqual(L.detectHitokotoChar('<h2>KITAさんの一言</h2>', NAME_TO_KEY), null);
});

test('detectHitokotoChar: 見出しなし → null', () => {
  assert.strictEqual(L.detectHitokotoChar('<p>一言も見出しもない</p>', NAME_TO_KEY), null);
  assert.strictEqual(L.detectHitokotoChar('<h2>ただの見出し</h2>', NAME_TO_KEY), null);
});

test('detectHitokotoChar: 非文字列 body は null', () => {
  assert.strictEqual(L.detectHitokotoChar(null, NAME_TO_KEY), null);
  assert.strictEqual(L.detectHitokotoChar(undefined, NAME_TO_KEY), null);
  assert.strictEqual(L.detectHitokotoChar(123, NAME_TO_KEY), null);
});

test('detectHitokotoChar: 最初の一言見出しを採る（複数あっても先頭）', () => {
  const html = '<h2>しずくの一言</h2>中略<h2>凛華の一言</h2>';
  assert.strictEqual(L.detectHitokotoChar(html, NAME_TO_KEY), 'shizuku');
});

test('detectHitokotoChar: 7人ホワイトリスト全員が引ける', () => {
  const cases = [
    ['月子', 'tsukiko'], ['陽', 'you'], ['しずく', 'shizuku'], ['凛華', 'rinka'],
    ['るな', 'runa'], ['まひる', 'mahiru'], ['日和', 'hiyori'],
  ];
  cases.forEach(([name, key]) => {
    assert.strictEqual(L.detectHitokotoChar('<h2>' + name + 'の一言</h2>', NAME_TO_KEY), key);
  });
});

// ---- H6: nigekireCollectV2（一言回収・二重取り防止・非破壊） ----

test('nigekireCollectV2: 回収で charCounts+1・collected 立つ・charKey 返る', () => {
  const counts = { a1: { char: 'you' } };
  const collected = {};
  const charCounts = { you: 2 };
  const out = L.nigekireCollectV2(counts, collected, charCounts, 'a1');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.charKey, 'you');
  assert.strictEqual(out.nextCharCounts.you, 3);
  assert.strictEqual(out.nextCollected.a1, true);
});

test('nigekireCollectV2: 初回収集キャラは 0→1', () => {
  const out = L.nigekireCollectV2({ a1: { char: 'runa' } }, {}, {}, 'a1');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextCharCounts.runa, 1);
});

test('nigekireCollectV2: 未取得（counts に char なし）は {ok:false}', () => {
  assert.deepStrictEqual(L.nigekireCollectV2({}, {}, {}, 'a1'), { ok: false });
  assert.deepStrictEqual(L.nigekireCollectV2({ a1: {} }, {}, {}, 'a1'), { ok: false });
});

test('nigekireCollectV2: 二重取り（collected 済み）は {ok:false}', () => {
  const out = L.nigekireCollectV2({ a1: { char: 'you' } }, { a1: true }, { you: 1 }, 'a1');
  assert.deepStrictEqual(out, { ok: false });
});

test('nigekireCollectV2: 非破壊（入力 collected/charCounts を書き換えない）', () => {
  const counts = { a1: { char: 'you' } };
  const collected = {};
  const charCounts = { you: 2 };
  const before = JSON.stringify({ collected, charCounts });
  const out = L.nigekireCollectV2(counts, collected, charCounts, 'a1');
  assert.strictEqual(JSON.stringify({ collected, charCounts }), before);
  assert.notStrictEqual(out.nextCollected, collected);
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
// I群: ニゲキレ 節目イベント（最終確認）純ロジック
// ---------------------------------------------------------------------------

// ---- I1: nigekireEscapeRecord（逃げ切り記録 n/3・最終確認見出し判定） ----

test('nigekireEscapeRecord: (0,false) → count0・ready false', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(0, false), {
    count: 0, need: 3, ready: false, done: false,
  });
});

test('nigekireEscapeRecord: (2,false) → count2・まだ ready でない', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(2, false), {
    count: 2, need: 3, ready: false, done: false,
  });
});

test('nigekireEscapeRecord: (3,false) → count3・ready true（3/3到達・未通過）', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(3, false), {
    count: 3, need: 3, ready: true, done: false,
  });
});

test('nigekireEscapeRecord: (5,false) → count は 3 に上限クランプ・ready true', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(5, false), {
    count: 3, need: 3, ready: true, done: false,
  });
});

test('nigekireEscapeRecord: (3,true) → 通過済みは ready false・done true', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(3, true), {
    count: 3, need: 3, ready: false, done: true,
  });
});

test('nigekireEscapeRecord: (5,true) → クランプ3・通過済みで ready false', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(5, true), {
    count: 3, need: 3, ready: false, done: true,
  });
});

test('nigekireEscapeRecord: 未到達×通過済み (2,true) も ready false', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(2, true), {
    count: 2, need: 3, ready: false, done: true,
  });
});

test('nigekireEscapeRecord: 負数は 0 扱い', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord(-1, false), {
    count: 0, need: 3, ready: false, done: false,
  });
});

test('nigekireEscapeRecord: 非数は 0 扱い（ready false）', () => {
  assert.deepStrictEqual(L.nigekireEscapeRecord('x', false), {
    count: 0, need: 3, ready: false, done: false,
  });
  assert.deepStrictEqual(L.nigekireEscapeRecord(undefined, false), {
    count: 0, need: 3, ready: false, done: false,
  });
});

test('nigekireEscapeRecord: finalCheckDone は真偽値化（truthy/falsy）', () => {
  assert.strictEqual(L.nigekireEscapeRecord(3, 1).done, true);
  assert.strictEqual(L.nigekireEscapeRecord(3, 1).ready, false);
  assert.strictEqual(L.nigekireEscapeRecord(3, 0).done, false);
  assert.strictEqual(L.nigekireEscapeRecord(3, 0).ready, true);
});

// ---- I2: nigekirePassFinalCheck（最終確認通過・二重通過防止・非破壊） ----

test('nigekirePassFinalCheck: 未通過 → {ok:true, nextFinalCheckDone:true}', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheck(false), {
    ok: true, nextFinalCheckDone: true,
  });
});

test('nigekirePassFinalCheck: 通過済み(true) → {ok:false}（二重通過防止）', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheck(true), { ok: false });
});

test('nigekirePassFinalCheck: 非破壊（引数はプリミティブ・状態を書き換えない）', () => {
  var done = false;
  var out = L.nigekirePassFinalCheck(done);
  assert.strictEqual(done, false); // 入力そのまま
  assert.strictEqual(out.nextFinalCheckDone, true);
});

// ---------------------------------------------------------------------------
// J群: ニゲキレ 通過ベースランク（rankStage・§10-2）
//   ランクは「収集数の自動判定」→「通過した節目の数（rankStage 0〜4）」で決まる。
//   閾値は ranks の min 由来（70/120/200 をハードコードしない）。
//   ※節目キャラ選定（selectFinalCheckChar）は推し1人選択構造で廃止・削除済み。
// ---------------------------------------------------------------------------

// J群で使う曜日順キャラリスト（§10-2）
const NIGEKIRE_CHAR_ORDER = ['tsukiko', 'you', 'shizuku', 'rinka', 'runa', 'mahiru', 'hiyori'];

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

// ---- J2: nigekireFinalCheckReady（次の節目を出すべきか・閾値は ranks.min 由来） ----

test('nigekireFinalCheckReady: rankStage 0 は totalSuccess>=3（初期試練・2/3は not ready）', () => {
  const R = NIGEKIRE_LIFE_RANKS_V2;
  assert.deepStrictEqual(
    L.nigekireFinalCheckReady(0, 2, 999, R),
    { ready: false, needCollected: null }
  );
  assert.deepStrictEqual(
    L.nigekireFinalCheckReady(0, 3, 0, R),
    { ready: true, needCollected: null }
  );
});

test('nigekireFinalCheckReady: rankStage 1 は総収集>=ranks[2].min（69/70境界）', () => {
  const R = NIGEKIRE_LIFE_RANKS_V2;
  assert.strictEqual(R[2].min, 70); // 閾値は ranks 由来
  assert.deepStrictEqual(
    L.nigekireFinalCheckReady(1, 0, 69, R),
    { ready: false, needCollected: 70 }
  );
  assert.deepStrictEqual(
    L.nigekireFinalCheckReady(1, 0, 70, R),
    { ready: true, needCollected: 70 }
  );
});

test('nigekireFinalCheckReady: rankStage 2 は総収集>=ranks[3].min（119/120境界）', () => {
  const R = NIGEKIRE_LIFE_RANKS_V2;
  assert.strictEqual(R[3].min, 120);
  assert.strictEqual(L.nigekireFinalCheckReady(2, 0, 119, R).ready, false);
  assert.strictEqual(L.nigekireFinalCheckReady(2, 0, 119, R).needCollected, 120);
  assert.strictEqual(L.nigekireFinalCheckReady(2, 0, 120, R).ready, true);
});

test('nigekireFinalCheckReady: rankStage 3 は総収集>=ranks[4].min（199/200境界）', () => {
  const R = NIGEKIRE_LIFE_RANKS_V2;
  assert.strictEqual(R[4].min, 200);
  assert.strictEqual(L.nigekireFinalCheckReady(3, 0, 199, R).ready, false);
  assert.strictEqual(L.nigekireFinalCheckReady(3, 0, 199, R).needCollected, 200);
  assert.strictEqual(L.nigekireFinalCheckReady(3, 0, 200, R).ready, true);
});

test('nigekireFinalCheckReady: rankStage 4 は常に ready false（最終・節目なし）', () => {
  const R = NIGEKIRE_LIFE_RANKS_V2;
  assert.deepStrictEqual(
    L.nigekireFinalCheckReady(4, 999, 9999, R),
    { ready: false, needCollected: null }
  );
});

// ---- J3: nigekirePassFinalCheckV2（節目通過で rankStage+1・最終で止まる・非破壊） ----

test('nigekirePassFinalCheckV2: 0 → {ok:true, nextRankStage:1}', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV2(0), { ok: true, nextRankStage: 1 });
});

test('nigekirePassFinalCheckV2: 3 → {ok:true, nextRankStage:4}', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV2(3), { ok: true, nextRankStage: 4 });
});

test('nigekirePassFinalCheckV2: 4 → {ok:false}（最終で止まる・これ以上上がらない）', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV2(4), { ok: false });
});

test('nigekirePassFinalCheckV2: 非破壊（引数プリミティブを書き換えない）', () => {
  var s = 2;
  var out = L.nigekirePassFinalCheckV2(s);
  assert.strictEqual(s, 2); // 入力そのまま
  assert.strictEqual(out.nextRankStage, 3);
});

// ============================================================================
// K群: 記事一覧の日付表示（YYYY.MM.DD (曜)・JST基準・全モード共通）
// ============================================================================

test('weekdayLabelJa: weekday キー → 日本語1文字（7通り）', () => {
  assert.strictEqual(L.weekdayLabelJa('mon'), '月');
  assert.strictEqual(L.weekdayLabelJa('tue'), '火');
  assert.strictEqual(L.weekdayLabelJa('wed'), '水');
  assert.strictEqual(L.weekdayLabelJa('thu'), '木');
  assert.strictEqual(L.weekdayLabelJa('fri'), '金');
  assert.strictEqual(L.weekdayLabelJa('sat'), '土');
  assert.strictEqual(L.weekdayLabelJa('sun'), '日');
});

test('weekdayLabelJa: 不正な値は空文字', () => {
  assert.strictEqual(L.weekdayLabelJa('xxx'), '');
  assert.strictEqual(L.weekdayLabelJa(null), '');
  assert.strictEqual(L.weekdayLabelJa(undefined), '');
});

test('formatDateWithWeekday: 日付のみの文字列を YYYY.MM.DD (曜) にする', () => {
  assert.strictEqual(L.formatDateWithWeekday('2025-12-15'), '2025.12.15 (月)');
  assert.strictEqual(L.formatDateWithWeekday('2026-07-14'), '2026.07.14 (火)');
  assert.strictEqual(L.formatDateWithWeekday('2025-12-21'), '2025.12.21 (日)');
});

test('formatDateWithWeekday: 曜日は weekdayOf（JST基準）と必ず一致する', () => {
  // ニゲキレのチップ（weekdayOf）と一覧の曜日がズレないことを守る回帰テスト。
  const map = { sun: '日', mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土' };
  const dates = [
    '2025-12-15', '2025-12-16', '2025-12-17', '2025-12-18',
    '2025-12-19', '2025-12-20', '2025-12-21', '2026-07-14',
  ];
  for (const s of dates) {
    const label = L.formatDateWithWeekday(s);
    const expected = map[L.weekdayOf(s)];
    assert.ok(label.endsWith('(' + expected + ')'), `${s}: ${label} が weekdayOf(${expected}) と不一致`);
  }
});

test('formatDateWithWeekday: JST 深夜（UTCでは前日）でも JST の暦日・曜日で出す', () => {
  // 2025-12-15T00:30:00+09:00 は UTC では 12/14 15:30。JST の月曜として出す。
  assert.strictEqual(L.formatDateWithWeekday('2025-12-15T00:30:00+09:00'), '2025.12.15 (月)');
  // 2025-12-15T23:30:00+09:00 も同じ JST 暦日。
  assert.strictEqual(L.formatDateWithWeekday('2025-12-15T23:30:00+09:00'), '2025.12.15 (月)');
});

test('formatDateWithWeekday: パース不能・空は空文字', () => {
  assert.strictEqual(L.formatDateWithWeekday(''), '');
  assert.strictEqual(L.formatDateWithWeekday(null), '');
  assert.strictEqual(L.formatDateWithWeekday(undefined), '');
  assert.strictEqual(L.formatDateWithWeekday('not-a-date'), '');
});

// ============================================================================
// M群: ニゲキレ 推し1人選択構造（answer-oshi-select-CONFIRMED.md 確定）
//   推し1人・逃げ切り9本・3本ごとに最終確認3回 → rankStage 3（キャラ変更解禁）。
//   2人目以降の初期試練では rankStage は動かず oshiCleared にだけ積む。
//   収集の節目の閾値は ranks の min 由来（70/120/200 をハードコードしない）。
// ============================================================================

// 7段階ランク（確定値・rankStage 0..6）。min は 4/5/6 のみ参照される。
const NIGEKIRE_RANKS_M = [
  { stage: 0, min: 0, name: '言い訳見習い', key: 'nige1' },
  { stage: 1, min: 0, name: '言い訳準備中', key: 'nige2' },
  { stage: 2, min: 0, name: '生活立て直し中', key: 'nige3' },
  { stage: 3, min: 0, name: '生活防衛中', key: 'nige4' },
  { stage: 4, min: 70, name: '火種処理係', key: 'nige5' },
  { stage: 5, min: 120, name: 'おはカノ生活継続者', key: 'nige6' },
  { stage: 6, min: 200, name: 'おはカノ生活管理人', key: 'nige7' },
];

// label 付きキャラ配列（曜日順・称号の曜日連結に使う）
const NIGEKIRE_CHARS_M = [
  { key: 'tsukiko', weekday: 'mon', label: '月曜', name: '月子' },
  { key: 'you', weekday: 'tue', label: '火曜', name: '陽' },
  { key: 'shizuku', weekday: 'wed', label: '水曜', name: 'しずく' },
  { key: 'rinka', weekday: 'thu', label: '木曜', name: '凛華' },
  { key: 'runa', weekday: 'fri', label: '金曜', name: 'るな' },
  { key: 'mahiru', weekday: 'sat', label: '土曜', name: 'まひる' },
  { key: 'hiyori', weekday: 'sun', label: '日曜', name: '日和' },
];

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

// ---- M2: nigekireOshiFinalCheckReady（節目判定・mode/passIndex） ----

test('nigekireOshiFinalCheckReady: 1人目 通過0回・2本 → initial・未ready・n=1', () => {
  const out = L.nigekireOshiFinalCheckReady(
    0, { tsukiko: 2 }, {}, 'tsukiko', [], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.mode, 'initial');
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.passIndex, 1);
});

test('nigekireOshiFinalCheckReady: 1人目 通過0回・3本 → ready・n=1', () => {
  const out = L.nigekireOshiFinalCheckReady(
    0, { tsukiko: 3 }, {}, 'tsukiko', [], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 1);
});

test('nigekireOshiFinalCheckReady: 通過1回・3本 → 次は6本なので未ready・n=2', () => {
  const out = L.nigekireOshiFinalCheckReady(
    1, { tsukiko: 3 }, { tsukiko: 1 }, 'tsukiko', [], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.passIndex, 2);
});

test('nigekireOshiFinalCheckReady: 通過1回・6本 → ready・n=2', () => {
  const out = L.nigekireOshiFinalCheckReady(
    1, { tsukiko: 6 }, { tsukiko: 1 }, 'tsukiko', [], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 2);
});

test('nigekireOshiFinalCheckReady: 通過2回・9本 → ready・n=3', () => {
  const out = L.nigekireOshiFinalCheckReady(
    2, { tsukiko: 9 }, { tsukiko: 2 }, 'tsukiko', [], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 3);
});

test('nigekireOshiFinalCheckReady: 通過2回・8本（在庫不足キャラ）→ 未ready', () => {
  const out = L.nigekireOshiFinalCheckReady(
    2, { shizuku: 8 }, { shizuku: 2 }, 'shizuku', [], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.mode, 'initial');
});

test('nigekireOshiFinalCheckReady: 2人目の初期試練 rankStage3・通過0回・3本 → ready・n=1', () => {
  const out = L.nigekireOshiFinalCheckReady(
    3, { rinka: 3 }, { tsukiko: 3 }, 'rinka', ['tsukiko'], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.mode, 'initial');
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 1); // rankStage ではなく通過回数+1
});

test('nigekireOshiFinalCheckReady: 2人目 通過2回・9本 → n=3（rankStage 由来でない）', () => {
  const out = L.nigekireOshiFinalCheckReady(
    5, { rinka: 9 }, { rinka: 2 }, 'rinka', ['tsukiko'], 0, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 3);
});

test('nigekireOshiFinalCheckReady: collect rankStage3・収集69 → 未ready（ranks[4].min=70）', () => {
  const out = L.nigekireOshiFinalCheckReady(
    3, { tsukiko: 9 }, { tsukiko: 3 }, 'tsukiko', ['tsukiko'], 69, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.mode, 'collect');
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.passIndex, 4);
});

test('nigekireOshiFinalCheckReady: collect rankStage3・収集70 → ready・n=4', () => {
  const out = L.nigekireOshiFinalCheckReady(
    3, { tsukiko: 9 }, { tsukiko: 3 }, 'tsukiko', ['tsukiko'], 70, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 4);
});

test('nigekireOshiFinalCheckReady: collect rankStage4・収集120 → ready・n=5', () => {
  const out = L.nigekireOshiFinalCheckReady(
    4, { tsukiko: 9 }, { tsukiko: 3 }, 'tsukiko', ['tsukiko'], 120, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.passIndex, 5);
});

test('nigekireOshiFinalCheckReady: collect rankStage5・収集199/200 境界 → n=6', () => {
  const ng = L.nigekireOshiFinalCheckReady(
    5, { tsukiko: 9 }, { tsukiko: 3 }, 'tsukiko', ['tsukiko'], 199, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(ng.ready, false);
  const ok = L.nigekireOshiFinalCheckReady(
    5, { tsukiko: 9 }, { tsukiko: 3 }, 'tsukiko', ['tsukiko'], 200, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(ok.ready, true);
  assert.strictEqual(ok.passIndex, 6);
});

test('nigekireOshiFinalCheckReady: 最終ランク到達済み → mode done・未ready', () => {
  const out = L.nigekireOshiFinalCheckReady(
    6, { tsukiko: 9 }, { tsukiko: 3 }, 'tsukiko', ['tsukiko'], 999, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.mode, 'done');
  assert.strictEqual(out.ready, false);
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

// ---- M5: nigekirePassOshiFinalCheck（通過処理・rankStage/cleared/passCounts） ----

test('nigekirePassOshiFinalCheck: 1人目1回目 → rankStage 0→1・通過1回・未cleared', () => {
  const out = L.nigekirePassOshiFinalCheck(0, 'tsukiko', [], {}, NIGEKIRE_RANKS_M);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextRankStage, 1);
  assert.deepStrictEqual(out.nextCleared, []);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 1 });
});

test('nigekirePassOshiFinalCheck: 1人目3回目 → rankStage 2→3・cleared に追加', () => {
  const out = L.nigekirePassOshiFinalCheck(2, 'tsukiko', [], { tsukiko: 2 }, NIGEKIRE_RANKS_M);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextRankStage, 3);
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 3 });
});

test('nigekirePassOshiFinalCheck: 2人目の初期試練は rankStage が動かない（1回目）', () => {
  const out = L.nigekirePassOshiFinalCheck(3, 'rinka', ['tsukiko'], { tsukiko: 3 }, NIGEKIRE_RANKS_M);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextRankStage, 3); // 動かない
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 3, rinka: 1 });
});

test('nigekirePassOshiFinalCheck: 2人目3回目も rankStage は動かず cleared にだけ積む', () => {
  const out = L.nigekirePassOshiFinalCheck(
    5, 'rinka', ['tsukiko'], { tsukiko: 3, rinka: 2 }, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextRankStage, 5); // 動かない
  assert.deepStrictEqual(out.nextCleared, ['tsukiko', 'rinka']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 3, rinka: 3 });
});

test('nigekirePassOshiFinalCheck: 収集の節目（cleared済み）→ rankStage +1・cleared 据え置き', () => {
  const out = L.nigekirePassOshiFinalCheck(
    3, 'tsukiko', ['tsukiko'], { tsukiko: 3 }, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.nextRankStage, 4);
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
  assert.deepStrictEqual(out.nextPassCounts, { tsukiko: 3 });
});

test('nigekirePassOshiFinalCheck: 最終ランク（6）でこれ以上上がらない', () => {
  const out = L.nigekirePassOshiFinalCheck(
    6, 'tsukiko', ['tsukiko'], { tsukiko: 3 }, NIGEKIRE_RANKS_M
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.nextRankStage, 6);
});

test('nigekirePassOshiFinalCheck: cleared 重複追加しない（通過3回済みで再呼び出し）', () => {
  const out = L.nigekirePassOshiFinalCheck(
    5, 'rinka', ['tsukiko', 'rinka'], { tsukiko: 3, rinka: 3 }, NIGEKIRE_RANKS_M
  );
  // cleared 済み → collect 扱いで rankStage が上がるが cleared は増えない
  assert.deepStrictEqual(out.nextCleared, ['tsukiko', 'rinka']);
  assert.strictEqual(out.nextRankStage, 6);
});

test('nigekirePassOshiFinalCheck: oshiChar 不正 → ok:false・state 据え置き', () => {
  const out = L.nigekirePassOshiFinalCheck(1, null, ['tsukiko'], { tsukiko: 3 }, NIGEKIRE_RANKS_M);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.nextRankStage, 1);
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
});

test('nigekirePassOshiFinalCheck: 非破壊（入力の配列/マップを書き換えない）', () => {
  const cleared = [];
  const counts = { tsukiko: 2 };
  const out = L.nigekirePassOshiFinalCheck(2, 'tsukiko', cleared, counts, NIGEKIRE_RANKS_M);
  assert.deepStrictEqual(cleared, []); // 入力そのまま
  assert.deepStrictEqual(counts, { tsukiko: 2 }); // 入力そのまま
  assert.deepStrictEqual(out.nextCleared, ['tsukiko']);
});

// ---- M6: nigekirePassFinalCheckV3（段数を ranks から取る版） ----

test('nigekirePassFinalCheckV3: 0 → 1', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(0, NIGEKIRE_RANKS_M), { ok: true, nextRankStage: 1 });
});

test('nigekirePassFinalCheckV3: 5 → 6（最終手前）', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(5, NIGEKIRE_RANKS_M), { ok: true, nextRankStage: 6 });
});

test('nigekirePassFinalCheckV3: 6（最終・ranks.length-1）→ ok:false', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(6, NIGEKIRE_RANKS_M), { ok: false });
});

test('nigekirePassFinalCheckV3: 段数は ranks 由来（5要素なら上限4）', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(4, NIGEKIRE_LIFE_RANKS_V2), { ok: false });
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(3, NIGEKIRE_LIFE_RANKS_V2), { ok: true, nextRankStage: 4 });
});

test('nigekirePassFinalCheckV3: ranks 不正/空 → ok:false', () => {
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(0, []), { ok: false });
  assert.deepStrictEqual(L.nigekirePassFinalCheckV3(0, null), { ok: false });
});

test('nigekirePassFinalCheckV3: 非破壊（引数プリミティブを書き換えない）', () => {
  var s = 2;
  var out = L.nigekirePassFinalCheckV3(s, NIGEKIRE_RANKS_M);
  assert.strictEqual(s, 2);
  assert.strictEqual(out.nextRankStage, 3);
});

// ============================================================================
// N群: ニゲキレ キャラ単位ポイント＋閾値初到達ランク
//   参照: nigekire-percharacter-points.md
//   ポイントは charCounts[charKey]（キャラ単位）。節目は1キャラ6回
//   （逃げ切き 3/6/9 → ポイント 5/10/15）。ランクは閾値への初到達でだけ上がる。
// ============================================================================

const NIGEKIRE_TH = { escape: [3, 6, 9], point: [5, 10, 15] };

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
