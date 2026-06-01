#!/usr/bin/env node
// 편집자 리뷰 — 최근 회차 + 캐논을 읽고 발전 리뷰 + 다음 화 생성 지침을 review.md 로 저장.
// build-local.mjs 가 review.md 의 '다음 화 생성 지침'을 읽어 다음 생성에 반영(자가발전 루프).
//   사용: node scripts/review.mjs   (옵션: REVIEW_LAST=8 최근 N화만)

import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "opus";
const LAST = parseInt(process.env.REVIEW_LAST || "10", 10);
const readSafe = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };
const bodyOf = (md) => { const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/); return (m ? m[1] : md).replace(/<\/?div[^>]*>/g, "").trim(); };

const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}_\d+\.md$/.test(f));
const epNumOf = (f) => parseInt((f.match(/_(\d+)\.md$/) || [])[1] || "0", 10);
allMd.sort((a, b) => epNumOf(a) - epNumOf(b));
if (!allMd.length) { console.error("회차 없음"); process.exit(1); }
const recent = allMd.slice(-LAST);

const episodes = [];
for (const f of recent) {
  const n = epNumOf(f);
  const fm = (await readSafe(f)).match(/title:\s*(.+)/);
  episodes.push(`### ${n}화 (${fm ? fm[1].trim() : ""})\n${bodyOf(await readSafe(f))}`);
}

const PREMISE = await readSafe("canon/premise.md");
const ARC = await readSafe("canon/arc.md");
const WORLD = await readSafe("canon/world.md");
const TIMELINE = await readSafe("canon/timeline.md");
const THREADS = await readSafe("canon/threads.md");
let charFiles = [];
try { charFiles = (await readdir("canon/characters")).filter((f) => f.endsWith(".md")); } catch {}
const CHARS = (await Promise.all(charFiles.map((f) => readSafe(`canon/characters/${f}`)))).join("\n\n");

const total = epNumOf(allMd[allMd.length - 1]);

const prompt = `**채팅 응답. 도구·검색 금지. 마크다운만 출력. 인사·서론 금지.**

당신은 한국 웹소설 베테랑 편집자입니다. 아래 연재작의 **최근 ${recent.length}개 회차**(현재 ${total}/100화)와 **캐논**을 읽고, 작품을 *발전*시킬 냉정하고 구체적인 편집 리뷰를 쓰세요. 칭찬용 무난한 말 금지. 실제 본문의 문장·전개를 근거로.

# 작품의 한 끗(차별점)
${PREMISE}
# 아크(100화 설계)
${ARC}
# 캐논 — 세계관
${WORLD}
# 캐논 — 타임라인(미래지식)
${TIMELINE}
# 캐논 — 인물
${CHARS}
# 현재 떡밥
${THREADS}

# 최근 회차 본문
${episodes.join("\n\n---\n\n")}

# 출력 형식 (이 마크다운 구조 그대로, 각 항목 구체적으로)
## 총평
(2~3문장. 지금 작품 상태를 솔직하게.)

## 잘되는 점
- (3~4개)

## 약점·위험
- (3~5개. 구체적으로 — 어느 화/어떤 전개가 왜 문제인지)

## 플롯홀·논리오류
- (있으면 어느 화 어디서. 없으면 "특이사항 없음")

## 반복·매너리즘
- (표현·전개·구조의 반복 패턴. 예: 매 화 "흉터" 반복 등)

## 캐릭터
- (주인공·핵심 조연의 매력/일관성/평면성)

## 사실·캐논 오류 (소프트 모순 포함)
- (캐논·현실·내적 논리와 어긋난 사소한 것들. 어느 화)

## 다음 ${Math.min(10, 100 - total)}화 방향 제안
- (큰 그림. 어디로 끌고 가면 더 재밌어질지 2~4개)

## 다음 화 생성 지침
(생성기에 바로 먹일 명령형 지침 5~8개. 짧고 실행가능하게. 예: "흉터 묘사 반복 금지", "이정민에게 능동적 행동 1개 부여", "정오 사건을 다음 화에서 터뜨려라")
- `;

function callClaude(p) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL], { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = ""; const t = setTimeout(() => { child.kill(); reject(new Error("타임아웃")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (c) => { clearTimeout(t); c === 0 ? resolve(out) : reject(new Error(`exit ${c}`)); });
    child.stdin.write(p); child.stdin.end();
  });
}

console.log(`리뷰: 최근 ${recent.length}화 (${total}/100) · ${CLAUDE_MODEL}`);
const raw = (await callClaude(prompt)).trim();
const md = raw.replace(/^```(?:markdown)?\s*|\s*```$/g, "");
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
await writeFile("review.md", `# 편집 리뷰 — ${total}화 시점 (${stamp} UTC, 최근 ${recent.length}화 기준)\n\n${md}\n`);
console.log("review.md 저장됨");
