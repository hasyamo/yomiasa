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
