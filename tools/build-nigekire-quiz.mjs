#!/usr/bin/env node
/*
 * build-nigekire-quiz.mjs
 *   ニゲキレモードのクイズ/回収データを、澪の抽出 JSONL（7曜日ぶん）から
 *   アプリが読むマップ形式 nigekire_quiz.json に変換して生成する。
 *
 * 入力: hasyamo-vault .../nigekire-quiz/candidates/{mon..sun}.jsonl（7曜日×10本＝70本）
 * 出力: <repo>/nigekire_quiz.json  … { quizzes: { <note_key>: {...} } }
 *
 * 方針（handoff・設計メモ準拠）:
 *   - 文言（question/choices/lines）は JSONL の現在値を「そのまま転記」する（創作しない）。
 *   - スキーマに無いフィールドは勝手に足さない。JSONL の値だけを写す。
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
  const perDay = {};
  let total = 0;
  const dupes = [];

  for (const wd of WEEKDAYS) {
    const file = join(CANDIDATES_DIR, `${wd}.jsonl`);
    if (!existsSync(file)) {
      console.error(`[build-nigekire-quiz] 入力ファイルがありません: ${file}`);
      process.exit(1);
    }
    const recs = parseJsonl(readFileSync(file, 'utf8'), `${wd}.jsonl`);
    perDay[wd] = recs.length;
    for (const rec of recs) {
      const { noteKey, entry } = toEntry(rec, `${wd}.jsonl`, rec.candidate_id || '?');
      if (Object.prototype.hasOwnProperty.call(quizzes, noteKey)) {
        dupes.push(noteKey); // 後勝ちになるので警告だけ出す
      }
      quizzes[noteKey] = entry;
      total++;
    }
  }

  const payload = { quizzes };
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const uniqueCount = Object.keys(quizzes).length;
  console.log(`[build-nigekire-quiz] 出力: ${OUT_PATH}`);
  console.log(`[build-nigekire-quiz] 曜日別件数: ${WEEKDAYS.map((w) => `${w}=${perDay[w]}`).join(' ')}`);
  console.log(`[build-nigekire-quiz] 読み込み ${total} 件 / note_key ユニーク ${uniqueCount} 件`);
  if (dupes.length) {
    console.warn(`[build-nigekire-quiz] 警告: note_key 重複 ${dupes.length} 件（後勝ち）: ${dupes.join(', ')}`);
  }
}

main();
