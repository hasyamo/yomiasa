#!/usr/bin/env node
/*
 * build-nigekire-quiz.mjs
 *   ニゲキレモードのクイズ/回収データを、澪の抽出 JSONL（7曜日ぶん）から
 *   アプリが読むマップ形式 nigekire_quiz.json に変換して生成する。
 *
 * 入力: hasyamo-vault .../nigekire-quiz/candidates/{mon..sun}.jsonl（無印70本）
 *       ＋ {mon..sun}-r2.jsonl（2周目の追加候補27本・note_key は無印と重複しない）
 *       = 全14ファイル・97本。
 * 出力: <repo>/nigekire_quiz.json  … { quizzes: { <note_key>: {...} } }
 *
 * 方針（handoff・設計メモ・answer-trial-jsonl-count.md 準拠）:
 *   - 文言（question/choices/lines）は JSONL の現在値を「そのまま転記」する（創作しない）。
 *   - スキーマに無いフィールドは勝手に足さない。JSONL の値だけを写す。
 *   - 試練対象＝運用前記事＝ article.has_comment_engine === false でフィルタ。
 *     97本のうち運用前62本だけを出力する（運用後35本は救済検討中のため除外）。
 *   - 澪が candidates/*.jsonl を磨き直したら、本スクリプトを再実行して再生成できる。
 *
 * 使い方:
 *   node tools/build-nigekire-quiz.mjs
 *   （出力先や入力元は環境変数 NIGEKIRE_CANDIDATES_DIR / NIGEKIRE_OUT で上書き可）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// 入力: candidates ディレクトリ（Vault）。環境変数で差し替え可能。
const CANDIDATES_DIR =
  process.env.NIGEKIRE_CANDIDATES_DIR ||
  resolve(
    REPO_ROOT,
    '..',
    'hasyamo-vault',
    '70_projects',
    'yomiasa',
    'nigekire-quiz',
    'candidates'
  );

// 出力: アプリが読む JSON。環境変数で差し替え可能。
const OUT_PATH = process.env.NIGEKIRE_OUT || join(REPO_ROOT, 'nigekire_quiz.json');

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// JSONL を1行1レコードでパースする（空行は無視）。
function parseJsonl(text, file) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${file}:${i + 1} JSON parse error: ${e.message}`);
    }
  }
  return out;
}

// 1レコード → アプリ用の1エントリへ変換。
//   文言はそのまま転記。choices は {text, isCorrect, key} に写す。
function toEntry(rec, file, candidateId) {
  const a = rec.article || {};
  const t = rec.target || {};
  const f = rec.fire_seed || {};
  const q = rec.quiz || {};
  const cl = rec.character_lines || {};

  const noteKey = a.note_key || '';
  if (!noteKey) {
    throw new Error(`${file}: candidate ${candidateId} に note_key がありません`);
  }

  const rawChoices = Array.isArray(q.choices) ? q.choices : [];
  const choices = rawChoices.map((c) => ({
    text: c.text != null ? c.text : '',
    isCorrect: c.is_correct === true,
    key: c.key != null ? c.key : '',
  }));

  return {
    noteKey,
    // 運用前（試練対象）か。has_comment_engine === false が運用前。
    hasCommentEngine: a.has_comment_engine === true,
    entry: {
      weekday: a.weekday || '',
      character: a.character || '',
      targetType: t.target_type || '',
      fireRank: f.rank || '',
      question: q.question != null ? q.question : '',
      choices,
      correctKey: q.correct_choice_key != null ? q.correct_choice_key : '',
      promptLine: cl.prompt_line != null ? cl.prompt_line : '',
      successLine: cl.success_line != null ? cl.success_line : '',
      failureLine: cl.failure_line != null ? cl.failure_line : '',
    },
  };
}

function main() {
  if (!existsSync(CANDIDATES_DIR)) {
    console.error(`[build-nigekire-quiz] candidates ディレクトリが見つかりません: ${CANDIDATES_DIR}`);
    process.exit(1);
  }

  const quizzes = {};
  let total = 0; // 読み込んだ全レコード数（無印＋r2）
  let kept = 0; // 運用前フィルタを通した件数
  let skippedPost = 0; // 運用後（has_comment_engine=true）で除外した件数
  const dupes = [];

  // 無印（{wd}.jsonl）＋2周目（{wd}-r2.jsonl）の全ファイルを読む。
  //   無印は必須、r2 は存在すれば読む（無ければスキップ）。
  const files = [];
  for (const wd of WEEKDAYS) files.push({ name: `${wd}.jsonl`, required: true });
  for (const wd of WEEKDAYS) files.push({ name: `${wd}-r2.jsonl`, required: false });

  for (const { name, required } of files) {
    const file = join(CANDIDATES_DIR, name);
    if (!existsSync(file)) {
      if (required) {
        console.error(`[build-nigekire-quiz] 入力ファイルがありません: ${file}`);
        process.exit(1);
      }
      continue; // r2 が無い曜日はスキップ
    }
    const recs = parseJsonl(readFileSync(file, 'utf8'), name);
    for (const rec of recs) {
      total++;
      const { noteKey, hasCommentEngine, entry } = toEntry(rec, name, rec.candidate_id || '?');
      // 試練対象＝運用前記事だけ（has_comment_engine=false）。運用後は除外（救済検討中）。
      if (hasCommentEngine) {
        skippedPost++;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(quizzes, noteKey)) {
        dupes.push(noteKey); // 後勝ちになるので警告だけ出す
      }
      quizzes[noteKey] = entry;
      kept++;
    }
  }

  const payload = { quizzes };
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const uniqueCount = Object.keys(quizzes).length;
  console.log(`[build-nigekire-quiz] 出力: ${OUT_PATH}`);
  console.log(
    `[build-nigekire-quiz] 読み込み ${total} 件 → 運用前(試練) ${kept} 件 / ` +
      `運用後除外 ${skippedPost} 件 / note_key ユニーク ${uniqueCount} 件`
  );
  if (dupes.length) {
    console.warn(`[build-nigekire-quiz] 警告: note_key 重複 ${dupes.length} 件（後勝ち）: ${dupes.join(', ')}`);
  }
}

main();
