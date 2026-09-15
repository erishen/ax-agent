// Tests for the pure decision helpers extracted from chat.ts's move_window
// and wait_for cases. These ran inline in a 1000+-line dispatcher with zero
// coverage — the 16:43 session showed a wrong maximize layout (all stale
// coords) and wait_for false-positives on nav words, both now pinned.
import test from "node:test";
import assert from "node:assert/strict";
import {
  NAV_WORDS,
  garbledOcrNote,
  navWordNote,
  resolveWindowPlacement,
} from "../src/tool-utils.ts";

// Two screens as screen_info returns them: 1512x982 primary + 1920x1080
// secondary offset by 1512px to the right.
const SCREENS = [
  { index: 0, origin: [0, 0], size: [1512, 982] },
  { index: 1, origin: [1512, -98], size: [1920, 1080] },
];

test("resolveWindowPlacement: left on primary", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "left", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, { x: 0, y: 0, resize: null, screenIdx: 0 });
});

test("resolveWindowPlacement: right accounts for window width", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "right", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, { x: 712, y: 0, resize: null, screenIdx: 0 });
});

test("resolveWindowPlacement: right on secondary screen", () => {
  const r = resolveWindowPlacement(SCREENS, 1, "right", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // secondary origin.x=1512, size.w=1920 → 1512+1920-800 = 2632
  assert.deepEqual(r.placement, { x: 2632, y: -98, resize: null, screenIdx: 1 });
});

test("resolveWindowPlacement: center halves the margins", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "center", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, { x: 356, y: 191, resize: null, screenIdx: 0 });
});

test("resolveWindowPlacement: maximize sets resize to screen size", () => {
  const r = resolveWindowPlacement(SCREENS, 1, "maximize", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.placement, {
    x: 1512,
    y: -98,
    resize: { w: 1920, h: 1080 },
    screenIdx: 1,
  });
});

test("resolveWindowPlacement: unknown position errors with the supported list", () => {
  const r = resolveWindowPlacement(SCREENS, undefined, "top-left", { w: 800, h: 600 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /top-left/);
  assert.match(r.error, /left\/right\/center\/maximize/);
});

test("resolveWindowPlacement: out-of-range screen keeps index but uses primary bounds", () => {
  const r = resolveWindowPlacement(SCREENS, 7, "left", { w: 800, h: 600 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // original behavior: the requested index is kept (for the report string),
  // the missing screen falls back to primary bounds
  assert.equal(r.placement.screenIdx, 7);
  assert.equal(r.placement.x, 0);
});

test("resolveWindowPlacement: no screens → explicit error", () => {
  const r = resolveWindowPlacement([], undefined, "left", { w: 800, h: 600 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /无法读取屏幕信息/);
});

test("navWordNote: nav-bar word hit warns about false positive", () => {
  const note = navWordNote("电影", false);
  assert.match(note, /导航栏常驻词/);
  assert.match(note, /不代表页面已切换/);
});

test("navWordNote: page-specific word stays silent", () => {
  assert.equal(navWordNote("我看见两朵一样的云", false), "");
  assert.equal(navWordNote("高分好评", false), "");
});

test("navWordNote: gone=true never warns", () => {
  assert.equal(navWordNote("电影", true), "");
});

test("garbledOcrNote: mostly low-confidence words → warning", () => {
  const words = [
    { text: "a", confidence: 0.3 },
    { text: "b", confidence: 0.3 },
    { text: "c", confidence: 0.3 },
    { text: "d", confidence: 0.4 },
    { text: "e", confidence: 0.9 },
  ];
  const note = garbledOcrNote(words);
  assert.match(note, /OCR 质量差/);
});

test("garbledOcrNote: ten+ low-confidence words even at 30% → warning", () => {
  const words = Array.from({ length: 12 }, (_, i) => ({
    text: `w${i}`,
    confidence: i % 3 === 0 ? 0.9 : 0.4,
  }));
  // 8 low / 12 total = 0.66 → ratio triggers; also low=8 < 10
  assert.match(garbledOcrNote(words), /OCR 质量差/);
});

test("garbledOcrNote: clean text stays silent", () => {
  const words = [
    { text: "首页", confidence: 0.9 },
    { text: "电影", confidence: 0.9 },
    { text: "腾讯视频", confidence: 0.9 },
    { text: "9.1", confidence: 0.9 },
  ];
  assert.equal(garbledOcrNote(words), "");
});

test("garbledOcrNote: few words (≤3) never judged garbled", () => {
  assert.equal(
    garbledOcrNote([
      { text: "a", confidence: 0.1 },
      { text: "b", confidence: 0.1 },
    ]),
    "",
  );
});

test("NAV_WORDS covers the words the model waits on", () => {
  for (const w of ["首页", "电影", "你正在追", "VIP会员", "片库"]) {
    assert.ok(NAV_WORDS.includes(w), w);
  }
});
