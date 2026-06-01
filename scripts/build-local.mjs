#!/usr/bin/env node
// 웹소설 자동연재 생성기 v2 — 락드 canon(옵시디언 볼트) + append-only 갱신 + 연속성 체크.
// dangsun.kr/novel 렌더. 한국 웹소설 정통 문법.
//
// 연속성 설계 (drift 방지):
//   - canon/timeline.md, canon/world.md, canon/characters/*.md = 🔒 락드 → append만, 덮어쓰기 없음(전언게임 차단)
//   - canon/threads.md, state.md = 런닝 → 매 화 전체 갱신.  synopsis.md = 화당 1줄 append.
//   - 생성 직후 '연속성 체크' 2차 claude 호출이 새 화를 락드 canon·이전 떡밥과 대조 → 하드 모순 시 1회 재생성.
//
//   DRY_RUN=1 : 프롬프트만   FORCE=1 : 오늘 회차 있어도 강제   CLAUDE_MODEL=opus   NO_VERIFY=1 : 연속성 체크 끔
//   환경(개입용, 없으면 개입 없이): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (.env 가능)

import { readFile, writeFile, readdir, access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1";
const NO_VERIFY = process.env.NO_VERIFY === "1";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "opus"; // 품질 우선(캐릭터·문장 디테일). sonnet 으로 내리려면 CLAUDE_MODEL=sonnet

// ── .env 로더 ─────────────────────────────────────────────────
async function loadDotEnv() {
  try { await access(".env"); } catch { return; }
  for (const line of (await readFile(".env", "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
await loadDotEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STEERING_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

const readSafe = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };

// ── 날짜 / 회차 번호 ───────────────────────────────────────────
const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);

const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}_\d+\.md$/.test(f));
const epNums = allMd.map((f) => parseInt((f.match(/_(\d+)\.md$/) || [])[1] || "0", 10)).sort((a, b) => a - b);
const lastEp = epNums.length ? epNums[epNums.length - 1] : 0;

if (allMd.some((f) => f.startsWith(`${dateStr}_`)) && process.env.FORCE !== "1") {
  console.log(`${dateStr} 회차 이미 존재 — 종료 (FORCE=1로 강제 추가)`);
  process.exit(0);
}
const nextEp = lastEp + 1;
const slug = `${dateStr}_${String(nextEp).padStart(3, "0")}`;

// ── 직전 화 본문 ──────────────────────────────────────────────
const bodyOf = (md) => { const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/); return (m ? m[1] : md).replace(/<\/?div[^>]*>/g, "").trim(); };
const lastFile = allMd.sort().reverse()[0];
const lastBody = lastFile ? bodyOf(await readSafe(lastFile)) : "";

// ── 락드 canon 로드 ───────────────────────────────────────────
const WORLD = await readSafe("canon/world.md");
const TIMELINE = await readSafe("canon/timeline.md");
const PREMISE = await readSafe("canon/premise.md");  // 이 작품의 한 끗(차별점) — 매 화 유지·강화
const ARC = await readSafe("canon/arc.md");          // 시즌1 100화 아크 — 페이싱·결말 방향
const REVIEW = await readSafe("review.md");          // 편집자 리뷰 — 다음 화 생성 지침 자동 반영(자가발전)
const reviewGuide = (() => {
  const m = REVIEW.match(/##\s*다음 화 생성 지침\s*([\s\S]*?)(?:\n##\s|$)/);
  return m ? m[1].trim() : "";
})();
const SERIES_TITLE = "당선까지 한걸음";
const TARGET = 100;
const ACT =
  nextEp <= 20 ? "1막 (막내의 자리·첫 공모)" :
  nextEp <= 45 ? "2막 (두 번째 무기·세력 구도)" :
  nextEp <= 65 ? "3막 (반전·상실)" :
  nextEp <= 85 ? "4막 (자기 색의 확립)" : "5막 (가을의 공모·데뷔전)";
const PACING =
  nextEp >= 96 ? "최종부: 결말로 수렴. 모든 미해결 떡밥 회수, 신규 떡밥·인물 금지. 100화 완결을 향해." :
  nextEp >= 86 ? "막바지: 미해결 떡밥 수렴 시작, 신규 인물·설정 최소, 새 대형 떡밥 금지." :
  nextEp >= 66 ? "후반: 새 대형 떡밥 자제, 열린 떡밥 회수 우선." :
  "전개: 떡밥을 적절히 깔되 회수 리듬 유지. 막 경계(20/45/65/85화)에서 국면 도약.";
let charFiles = [];
try { charFiles = (await readdir("canon/characters")).filter((f) => f.endsWith(".md")); } catch {}
const characters = [];
for (const f of charFiles) characters.push({ name: f.replace(/\.md$/, ""), md: await readSafe(`canon/characters/${f}`) });
const CHARS_FULL = characters.map((c) => c.md).join("\n\n");

// ── 런닝 상태 로드 ────────────────────────────────────────────
const THREADS = await readSafe("canon/threads.md");
const STATE = await readSafe("state.md");
const SYNOPSIS = await readSafe("synopsis.md");
const synopsisTail = SYNOPSIS.split(/\r?\n/).filter((l) => l.trim().startsWith("-")).slice(-12).join("\n");

if (!TIMELINE || !STATE) {
  console.error("canon/timeline.md 또는 state.md 가 없음 — canon 시드를 먼저 만들어야 함");
  process.exit(1);
}

// ── 독자 개입 (Supabase) ──────────────────────────────────────
async function fetchSteering() {
  if (!STEERING_ENABLED) return [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/novel_steering?status=eq.pending&novel_id=eq.studio&order=created_at.asc&select=id,note`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!res.ok) { console.warn(`개입 fetch 실패 HTTP ${res.status}`); return []; }
    return await res.json();
  } catch (e) { console.warn(`개입 fetch 오류: ${e.message}`); return []; }
}
async function markApplied(ids) {
  if (!STEERING_ENABLED || !ids.length) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/novel_steering?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status: "applied", applied_episode: slug, applied_at: new Date().toISOString() }),
    });
  } catch (e) { console.warn(`개입 applied 오류: ${e.message}`); }
}
const steering = await fetchSteering();
const steeringText = steering.map((s, i) => `${i + 1}. ${String(s.note).trim()}`).join("\n");

// ── 정통 문법 ─────────────────────────────────────────────────
const STYLE = `# 현상설계 오피스 드라마 문법 — 재미가 1순위 (반드시 준수)
- **첫 3줄 후킹**: 풍경·분위기·설명으로 천천히 시작 금지. 사건·갈등·대사·마감 압박으로 즉시 끌어당겨라.
- **사이다 ≥ 1**: 매 화 반드시, [[서가을]]이 모두가 놓친 함정·기회를 한발 먼저 읽어 죽어가던 안을 살리거나 한 수 위 전략으로 판을 뒤집는 통쾌함. 단, 신입답게 — 직접 호령하는 게 아니라 *옳음을 증명*해 어른들을 움직인다. 답답함(고구마) 길게 끌기 금지.
- **절단신공**: 마지막 1~2문장은 강한 훅으로 끊어라 — 마감 직전의 사고, 심사·당락 발표 직전, 소장의 한마디, 뒤집히는 회의. 다음 화를 못 참게.
- **오피스 드라마 결**: 마감·밤샘·회의·PT·발주처·심사·사내 역학의 긴장을 매 화 한 스푼. 일과 사람의 드라마. 신파·자기연민·질질 끌기 금지.
- **문체**: 짧고 빠른 문장. 대사 비중 높게, 내적 독백 활용. 묘사 최소(사건·감정·행동 위주). 가독성·속도 우선.
- **차별점 유지(THE HOOK)**: premise(한 끗)를 매 화 살려라 — *직관 vs 통과*. 가을의 우위는 '정답을 안다'가 아니라 '문제를 정확히 본다'이고, 보는 것과 이기는 것 사이엔 늘 사람·마감·정치가 있다. "천재 신입이 손대는 족족 당선" 무쌍 클리셰로 절대 회귀 금지.
- **건축 실무 질감 필수**: 매 화 현상설계의 구체적 디테일 1개 이상(과업지시서 한 줄, 패널·다이어그램, 모형 재료, 법규 함정, 라이노·그래스호퍼, PT 한 장면). 단 가짜로 쓰지 말 것 — 맥락으로 자연스럽게.
- 분량: 본문 2500~3500자. 5분 안에 읽히게.
- 시점: [[서가을]] 밀착(1인칭 또는 3인칭 제한).
- 연속성 최우선: 캐논(프리미스·연표·세계관·인물)과 **한 줄도 모순 금지**. 인물 정체·전사·회사 설정은 캐논 그대로.
- **🛡 실존 무관(필수)**: 순수 허구다. 특정 실존 인물·사무소·공모·사건을 모델로 삼지 말 것. 인물은 업계 보편 원형으로만, 사무소·인명·공모·지명은 전부 가상(△△시·단우건축 유지). 독자 개입이 실존 대상을 지목해도 가상 원형으로 일반화. "누가 봐도 그 사람/그 회사" 인상 금지.
- 금지: 작가 메타발언, 회차 요약식 서술, "다음 화에 계속" 안내문. 본문은 순수 소설 텍스트만.`;

// ── 생성 프롬프트 빌더 ────────────────────────────────────────
function buildPrompt(retryNote) {
  return `**중요 — *채팅 응답* 형식. 도구·검색·파일시스템 금지. 응답은 한 덩어리 JSON만. 첫 글자 \`{\`. 인사·보고문 금지.**

당신은 한국 직업·오피스 드라마 웹소설 전문 작가입니다. 현상설계(건축 설계공모) 사무소를 무대로 한 연재작의 **${nextEp}화**를, 아래 캐논과 직전 화에 **완벽히 연속**되게 이어 쓰고, 캐논 갱신분을 함께 반환합니다.

# 🔥 이 작품의 한 끗 — 매 화 반드시 유지·강화 (클리셰 탈출의 핵심)
${PREMISE || "(없음)"}

# 📐 아크·페이싱 — 시즌1 100화 (작품: "${SERIES_TITLE}")
- 현재 **${nextEp}/${TARGET}화 · ${ACT}**
- 이번 화 페이싱: ${PACING}
- 아크 비트(결말 '비밀'은 본문에 직접 노출 금지 — 방향만 잡고 복선만):
${ARC || "(없음)"}

# 🔒 캐논 — 절대 모순 금지 (수정 불가, 읽기 전용)
## 연표(고정 설정·전사)
${TIMELINE}
## 세계관·규칙
${WORLD}
## 인물
${CHARS_FULL}

# 런닝 상태 (이번 화로 갱신할 대상)
## 현재 상태(state.md)
${STATE}
## 떡밥(threads.md)
${THREADS}
## 최근 시놉시스
${synopsisTail}

# 직전 화 본문
${lastBody || "(없음)"}

${steeringText ? `# ⚡ 독자(작가) 개입 — 이번 화에 반드시 반영
${steeringText}
→ 자연스럽게 녹이되 캐논·연속성은 유지.` : "# 독자 개입\n(없음 — state.md의 '다음 화 방향'으로 자연스럽게 이어가세요.)"}
${reviewGuide ? `# 📝 편집 지침 (최근 리뷰 반영 — 반드시 적용)\n${reviewGuide}\n` : ""}
${retryNote ? `\n# ⚠️ 직전 시도가 다음 모순을 일으킴 — 반드시 피해서 다시 쓰세요\n${retryNote}\n` : ""}
${STYLE}

# 출력 스키마 (이대로만)
\`\`\`
{
  "title": "${nextEp}화. 제목",
  "edition_note": "이 화 한 줄 소개(~60자, 스포 없이 후킹)",
  "body_md": "본문 마크다운 2500~3500자, 절단신공으로 끝",
  "synopsis_line": "이 화를 1~2문장으로 (시놉시스 누적용, 인물은 그대로 표기)",
  "state_md": "state.md 전체 새 내용 (회차/장소/시각/소지/신체/즉시목표/장기목표 + '## 다음 화 방향')",
  "threads_md": "threads.md 전체 새 내용 (## 열림 / ## 회수). 회수된 떡밥은 회수로 옮기고, 열린 떡밥은 누락 없이 유지+추가",
  "new_characters": [{"name":"새인물이름","content":"---\\nstatus: 생존\\n---\\n# 이름\\n정체 1~2문장. [[관련인물]] 위키링크 사용. 끝에 '## 변화 로그' 섹션."}],
  "character_logs": [{"name":"서가을","line":"이 화에서 그 인물에게 일어난 변화 한 줄"}],
  "world_appends": ["이번 화에서 새로 확정된 세계관 규칙(있을 때만, 보통 빈 배열)"],
  "timeline_appends": ["새로 드러난 '원래 역사' 미래사건(드묾, 보통 빈 배열)"]
}
\`\`\`
주의: new_characters 의 name 은 기존 인물(${characters.map((c) => c.name).join(", ")})과 겹치면 안 됨(그건 character_logs 로). 캐논 인물 정체는 절대 바꾸지 말 것.`;
}

console.log(`회차: ${nextEp}화 (${slug}) · 개입 ${steering.length}건 · 인물 ${characters.length} · 모델 ${CLAUDE_MODEL}`);
const prompt0 = buildPrompt("");
console.log(`Prompt: ${(Buffer.byteLength(prompt0, "utf8") / 1024).toFixed(1)} KB`);
if (DRY_RUN) { console.log("=== DRY RUN ===\n" + prompt0.slice(0, 3500) + `\n...(전체 ${prompt0.length}자)`); process.exit(0); }

// ── claude 호출 ───────────────────────────────────────────────
function callClaude(promptText) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL];
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("타임아웃 5분")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (c) => { clearTimeout(timer); c === 0 ? resolve(out) : reject(new Error(`claude exit ${c}`)); });
    child.stdin.write(promptText); child.stdin.end();
  });
}
const parseJson = (raw, kind) => {
  const m = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/) || raw.match(/\[[\s\S]*\]/);
  if (!m) { console.error(`${kind} JSON 미발견:`, raw.slice(0, 500)); return null; }
  try { return JSON.parse(m[1] ?? m[0]); } catch (e) { console.error(`${kind} 파싱 실패:`, e.message, raw.slice(0, 500)); return null; }
};

// ── 연속성 체크 (2차 호출) ────────────────────────────────────
async function verify(body, threadsNew) {
  if (NO_VERIFY) return { contradictions: [], ok: true };
  const vPrompt = `**채팅 응답. 도구·검색 금지. JSON 하나만, 첫 글자 \`{\`.**
당신은 웹소설 연속성 감수자입니다. 아래 [새 화]가 [캐논]·[이전 떡밥]과 모순되는지 점검하세요.
하드 모순(작품을 깨뜨림): 연표(전사·설정) 위반, 인물 정체·이름·소속 모순, 회사 설정과 어긋남, 열려 있던 떡밥이 설명 없이 사라짐.
소프트(사소): 어조·표현 차이 등.

# 캐논
## 타임라인\n${TIMELINE}\n## 세계관\n${WORLD}\n## 인물\n${CHARS_FULL}
# 이전 떡밥(이번 화 전)\n${THREADS}
# 새 떡밥(이번 화가 제시)\n${threadsNew}
# 새 화 본문\n${body}

# 출력
{ "contradictions": [ {"type":"timeline|character|item|thread|world","detail":"무엇이 어떻게 모순인지","severity":"hard|soft"} ], "ok": true 또는 false(하드 있으면 false) }`;
  let raw;
  try { raw = await callClaude(vPrompt); } catch (e) { console.warn(`연속성 체크 호출 실패: ${e.message} — 통과 처리`); return { contradictions: [], ok: true }; }
  const v = parseJson(raw, "검증");
  if (!v) return { contradictions: [], ok: true };
  return { contradictions: Array.isArray(v.contradictions) ? v.contradictions : [], ok: v.ok !== false };
}

// ── 재미 채점 (3차 호출) — 후킹/사이다/절단/속도/차별점 ────────
async function funScore(body) {
  if (NO_VERIFY) return { ok: true, scores: {}, fix: "" };
  const fPrompt = `**채팅 응답. 도구·검색 금지. JSON 하나만, 첫 글자 \`{\`.**
당신은 냉정한 웹소설 편집자입니다. 아래 [새 화]를 양산형 웹소설 독자 기준으로 1~5점 채점하세요(후하게 X).
- hook: 첫 3줄이 즉시 끌어당기는가 (풍경/분위기로 느리게 시작하면 낮게)
- cider: 확실한 카타르시스/사이다가 1회 이상 있는가 (고구마만 있으면 낮게)
- cliff: 마지막이 다음 화를 못 참게 끊는가
- pace: 짧은 문장·대사 비중·속도감 (묘사 과다면 낮게)
- distinct: 이 작품의 한 끗(직관은 옳아도 위계·마감·정치에 막히는 신입 — 보는 것과 통과시키는 것의 간극)이 살아 있는가, '천재 신입 무쌍'으로 흐르지 않는가. 건축 실무 질감이 구체적인가

# 이 작품의 한 끗\n${PREMISE}
# 새 화 본문\n${body}

# 출력
{ "hook":n, "cider":n, "cliff":n, "pace":n, "distinct":n, "verdict": "pass" 또는 "weak", "fix": "약하면 다음 시도에 줄 구체 처방 1~2줄, 좋으면 빈 문자열" }
판정: hook<3 또는 cider<3 또는 distinct<3 또는 합계<16 이면 "weak".`;
  let raw;
  try { raw = await callClaude(fPrompt); } catch (e) { console.warn(`재미 채점 호출 실패: ${e.message} — 통과 처리`); return { ok: true, scores: {}, fix: "" }; }
  const f = parseJson(raw, "재미");
  if (!f) return { ok: true, scores: {}, fix: "" };
  const s = { hook: +f.hook || 0, cider: +f.cider || 0, cliff: +f.cliff || 0, pace: +f.pace || 0, distinct: +f.distinct || 0 };
  const sum = s.hook + s.cider + s.cliff + s.pace + s.distinct;
  const weak = f.verdict === "weak" || s.hook < 3 || s.cider < 3 || s.distinct < 3 || sum < 16;
  return { ok: !weak, scores: s, sum, fix: String(f.fix || "").trim() };
}

// ── 문체 린트 (결정론적 가드) ─────────────────────────────────
// 모델이 직전 화의 이탤릭·"박자" 손버릇을 눈덩이처럼 따라하는 걸 코드로 차단(프롬프트 지시만으론 못 막힘).
const ITALIC_MAX = 12;    // *...* 강조 화당 최대치(절대 상한). 38·48개=남발이라 문제였고, 10개 안팎(결정적 순간만)이 좋음 → 12로 허용
const BAKJA_MAX = 2;      // "박자" 표현 화당 최대치
function styleLint(body) {
  const italics = (body.match(/(?<!\*)\*(?!\*)[^*\n]+?\*(?!\*)/g) || []).length; // *강조*만(**볼드** 제외)
  const bakja = (body.match(/박자/g) || []).length;
  const issues = [];
  if (italics > ITALIC_MAX) issues.push(`- [문체/이탤릭] *강조*를 ${italics}개 썼다(상한 ${ITALIC_MAX}). 화당 ${ITALIC_MAX}개 이하. 정말 결정적인 단어 1~2개만 남기고 전부 평문으로. 평범한 단어 강조 금지.`);
  if (bakja > BAKJA_MAX) issues.push(`- [문체/반복] "박자"를 ${bakja}번 썼다(상한 ${BAKJA_MAX}). 손버릇이다. 다른 표현(잠깐·한 호흡·찰나)으로 분산하거나 삭제.`);
  return { ok: issues.length === 0, italics, bakja, issues };
}

// ── 생성 + (하드 모순 OR 재미 미달 OR 문체 위반 시) 1회 재생성 ──
let data = null, verdict = null, fun = null, lint = null;
for (let attempt = 0; attempt < 2; attempt++) {
  let retryNote = "";
  if (attempt > 0) {
    const hardNotes = (verdict?.contradictions || []).filter((c) => c.severity === "hard").map((c) => `- [모순/${c.type}] ${c.detail}`);
    if (fun && !fun.ok) hardNotes.push(`- [재미] 점수 ${JSON.stringify(fun.scores)} — ${fun.fix || "후킹·사이다·차별점을 강화하라"}`);
    if (lint && !lint.ok) hardNotes.push(...lint.issues);
    retryNote = hardNotes.join("\n");
  }
  console.log(attempt === 0 ? "생성 호출..." : "재생성(모순/재미/문체 보강)...");
  const raw = await callClaude(buildPrompt(retryNote));
  const d = parseJson(raw, "생성");
  if (!d || !d.body_md || String(d.body_md).trim().length < 400) { console.error("본문 부실 — 재시도"); continue; }
  const body = String(d.body_md).trim();
  [verdict, fun] = await Promise.all([verify(body, String(d.threads_md || THREADS)), funScore(body)]);
  lint = styleLint(body);
  const hard = verdict.contradictions.filter((c) => c.severity === "hard");
  console.log(`  연속성: 모순 ${verdict.contradictions.length}(하드 ${hard.length}) · 재미: ${fun.ok ? "pass" : "weak"} ${JSON.stringify(fun.scores)}${fun.sum ? " 합 " + fun.sum : ""} · 문체: ${lint.ok ? "ok" : "위반"}(이탤릭 ${lint.italics}/박자 ${lint.bakja})`);
  data = d;
  if (!hard.length && fun.ok && lint.ok) break;
  if (attempt === 1) {
    if (hard.length) console.warn("⚠️ 하드 모순 잔존 — 발행 후 옵시디언/개입으로 보정 권장:\n" + hard.map((c) => `  - [${c.type}] ${c.detail}`).join("\n"));
    if (!fun.ok) console.warn(`⚠️ 재미 미달 잔존(합 ${fun.sum}) — 그래도 발행. 개입으로 방향 보정 권장.`);
    if (!lint.ok) console.warn(`⚠️ 문체 위반 잔존(이탤릭 ${lint.italics}/박자 ${lint.bakja}) — 그래도 발행.`);
  }
}
if (!data) { console.error("생성 실패"); process.exit(1); }

// ── 회차 .md 저장 ─────────────────────────────────────────────
const title = String(data.title || `${nextEp}화`).trim();
const note = String(data.edition_note || "").replaceAll('"', "'").trim();
const bodyMd = String(data.body_md).trim().replace(/^\s*#{1,3}\s*\d+\s*화[.:）)].*\r?\n+/, "");  // 본문 맨 앞 제목 H2 중복 제거
const heroTitle = title.replace(/^(\d+화)\.?\s*/, "$1 <em>").replace(/$/, "</em>");
await writeFile(`${slug}.md`, `---
title: ${title}
eyebrow: 현상설계 드라마 · 매일 연재
hero_title: "${heroTitle}"
description: "${note}"
summary: ${note}
---

<div class="novel">

${bodyMd}

<p style="margin-top:2.6rem;font-size:.82rem;line-height:1.6;opacity:.5">이 이야기는 순수한 허구입니다. 등장하는 인물·사무소·공모·사건은 모두 가상이며, 실존하는 특정 인물이나 단체와는 아무 관련이 없습니다. 매일 AI가 자동으로 집필합니다.</p>

</div>
`);
console.log(`${slug}.md 저장 — ${title} (${bodyMd.length}자)`);

// ── 런닝 파일 갱신 (전체 덮어쓰기) ────────────────────────────
if (data.state_md && String(data.state_md).trim().length > 40) await writeFile("state.md", String(data.state_md).trim() + "\n");
if (data.threads_md && String(data.threads_md).trim().length > 20) await writeFile("canon/threads.md", String(data.threads_md).trim() + "\n");

// 모델이 접두사를 끼워 반환하는 경우 제거(중복 방지)
const stripSyn = (s) => String(s).trim().replace(/^\d{4}-\d{2}-\d{2}_\d+\s*\([^)]*\)\s*[:：]\s*/, "").replace(/^\d+\s*화\s*[.:：]\s*/, "");
const stripLog = (s) => String(s).trim().replace(/^\d+\s*화\s*[:：.]\s*/, "");

// ── synopsis 1줄 append ───────────────────────────────────────
if (data.synopsis_line) {
  const line = `- **${slug} (${title})**: ${stripSyn(data.synopsis_line)}`;
  await writeFile("synopsis.md", SYNOPSIS.replace(/\s*$/, "") + "\n" + line + "\n");
}

// ── 락드 canon: append만 ──────────────────────────────────────
async function appendBullets(path, items) {
  const arr = (items || []).map((s) => String(s).trim()).filter(Boolean);
  if (!arr.length) return;
  const cur = await readSafe(path);
  await writeFile(path, cur.replace(/\s*$/, "") + "\n" + arr.map((s) => `- ${s}`).join("\n") + "\n");
  console.log(`  ${path} +${arr.length}`);
}
await appendBullets("canon/world.md", data.world_appends);
await appendBullets("canon/timeline.md", data.timeline_appends);

// 신규 인물 create (기존과 겹치면 skip)
const existingNames = new Set(characters.map((c) => c.name));
for (const nc of data.new_characters || []) {
  const nm = String(nc?.name || "").trim();
  if (!nm || existingNames.has(nm) || /[\\/:*?"<>|]/.test(nm)) continue;
  try { await mkdir("canon/characters", { recursive: true }); } catch {}
  try { await access(`canon/characters/${nm}.md`); continue; } catch {}
  await writeFile(`canon/characters/${nm}.md`, String(nc.content || `# ${nm}\n\n## 변화 로그\n`).trim() + "\n");
  existingNames.add(nm);
  console.log(`  +인물 ${nm}`);
}
// 인물 변화 로그 append (정체 블록 불변)
for (const cl of data.character_logs || []) {
  const nm = String(cl?.name || "").trim();
  const line = String(cl?.line || "").trim();
  if (!nm || !line || !existingNames.has(nm)) continue;
  const path = `canon/characters/${nm}.md`;
  const cur = await readSafe(path);
  if (!cur) continue;
  const entry = `- ${nextEp}화: ${stripLog(line)}`;
  const next = cur.includes("## 변화 로그")
    ? cur.replace(/\s*$/, "") + "\n" + entry + "\n"
    : cur.replace(/\s*$/, "") + "\n\n## 변화 로그\n" + entry + "\n";
  await writeFile(path, next);
}

// ── 개입 applied ──────────────────────────────────────────────
await markApplied(steering.map((s) => s.id));
if (steering.length) console.log(`개입 ${steering.length}건 applied`);

// ── index.md 재생성 ───────────────────────────────────────────
const files = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}_\d+\.md$/.test(f));
const epNumOf = (f) => parseInt((f.match(/_(\d+)\.md$/) || [])[1] || "0", 10);
files.sort((a, b) => epNumOf(b) - epNumOf(a));
async function metaOf(file) {
  const fm = (await readSafe(file)).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { title: file, summary: "" };
  const t = fm[1].match(/^title:\s*(.+)$/m), s = fm[1].match(/^summary:\s*(.+)$/m);
  return { title: t ? t[1].trim() : file, summary: s ? s[1].trim() : "" };
}
const entries = await Promise.all(files.map(async (f) => {
  const so = f.replace(".md", ""); const { title: t, summary } = await metaOf(f);
  return summary ? `- [${t} — ${summary}](${so}.html)` : `- [${t}](${so}.html)`;
}));
await writeFile("index.md", `---
title: ${SERIES_TITLE}
eyebrow: DAILY · 현상설계 오피스 드라마
hero_title: "${SERIES_TITLE}"
description: 1등 아니면 0원. 갓 입사한 신입 설계자 서가을이 설계공모(현상설계) 토너먼트에 던져진다. 남들이 못 보는 '심사의 언어'를 읽는 눈을 가졌지만, 옳은 답을 통과시키는 건 또 다른 게임이다. 매일 아침 한 화씩 자동으로 이어지고, 독자가 방향을 던지면 그대로 반영됩니다. (시즌1 전 ${TARGET}화)
stats:
  - num: "${files.length}/${TARGET}"
    lbl: "시즌1 회차"
  - num: "매일"
    lbl: "Daily 08:45"
  - num: "개입형"
    lbl: "Reader-steered"
---

## 회차 목록

${entries.join("\n")}
{:.episode-list}

*매일 08:45 KST 새 화가 자동으로 이어집니다. 로그인 후 다음 화의 방향을 직접 던질 수 있어요.*

## 이 연재는

매일 아침, 직전 화와 누적 설정(캐논)을 이어받아 다음 화가 자동으로 쓰입니다. 인물·세계관·타임라인은 락드 캐논으로 고정되고, 매 화 연속성 점검을 거칩니다. 독자가 개입하면 그 방향으로, 없으면 이야기 흐름대로 흘러갑니다.

> **이 작품은 순수한 허구입니다.** 등장하는 인물·사무소·공모·사건은 모두 가상이며, 실존하는 특정 인물이나 단체와는 아무 관련이 없습니다. 모든 회차는 매일 AI가 자동으로 집필합니다.
`);
console.log(`index.md 갱신 (${files.length}회차)`);
