// Regression tests for buildClickGuard — the anti-misplay firewall for
// Tencent-Video self-drawn UI. A card/poster click PLAYS the film directly,
// so clicks that miss every paired title must be blocked or flagged.
// These are the exact guard branches that used to be duplicated inline in
// click_at / double_click_at with zero coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { buildClickGuard } from "../src/tencent.ts";

const pair = (title, score, x, y) => ({ title, score, x, y });

const base = {
  x: 0,
  y: 0,
  verb: "单击",
  pairs: [],
  miniPlayingTitle: "",
  lastOcrDetail: false,
  lastOcrList: false,
  lastOcrChannelHome: false,
  lastOcrPlayer: false,
};

test("guard: no pairs, no page flags → nothing to say, not blocked", () => {
  const r = buildClickGuard(base);
  assert.equal(r.note, "");
  assert.equal(r.blocked, undefined);
  assert.equal(r.setSortVerify, false);
});

test("guard: click on a paired title → soft '将打开' hint, not blocked", () => {
  const r = buildClickGuard({
    ...base,
    x: 490,
    y: 840,
    pairs: [pair("洛杉矶劫案", "8.3", 490, 840)],
  });
  assert.equal(r.blocked, undefined);
  assert.match(r.note, /将打开「洛杉矶劫案」/);
});

test("guard: click on a paired title already playing in the mini-strip → replay warning", () => {
  const r = buildClickGuard({
    ...base,
    x: 490,
    y: 840,
    pairs: [pair("捕风追影", "9.4", 490, 840)],
    miniPlayingTitle: "捕风追影",
  });
  assert.equal(r.blocked, undefined);
  assert.match(r.note, /已在顶部小窗播放中/);
  assert.match(r.note, /不要再点它/);
});

test("guard: list-page click missing every title (d<180, y>280) → HARD BLOCK (14:05: 坚如磐石 mis-play)", () => {
  const r = buildClickGuard({
    ...base,
    x: 650,
    y: 650,
    pairs: [pair("坚如磐石", "9.4", 690, 700)],
    lastOcrDetail: false,
  });
  assert.match(r.blocked ?? "", /被守卫拦截/);
  assert.match(r.blocked ?? "", /评分徽标\/海报边缘\/演员行会打开错误的片/);
});

test("guard: verb appears in the block message (双击)", () => {
  const r = buildClickGuard({
    ...base,
    verb: "双击",
    x: 650,
    y: 650,
    pairs: [pair("坚如磐石", "9.4", 690, 700)],
  });
  assert.match(r.blocked ?? "", /⛔ 双击/);
});

test("guard: detail-page off-title click → soft hint, NOT blocked (detail pairs are wider)", () => {
  const r = buildClickGuard({
    ...base,
    x: 3165,
    y: 350,
    pairs: [pair("捕风追影", "9.4", 3095, 309)],
    lastOcrDetail: true,
  });
  assert.equal(r.blocked, undefined);
  assert.match(r.note, /不在配对清单/);
});

test("guard: off-title but far away (d≥180) → no note, not blocked", () => {
  const r = buildClickGuard({
    ...base,
    x: 100,
    y: 100,
    pairs: [pair("洛杉矶劫案", "8.3", 490, 840)],
  });
  assert.equal(r.note, "");
  assert.equal(r.blocked, undefined);
});

test("guard: sort-tab click on a rating-less list → note + setSortVerify", () => {
  const r = buildClickGuard({
    ...base,
    x: 435,
    y: 217,
    lastOcrList: true,
  });
  assert.equal(r.setSortVerify, true);
  assert.match(r.note, /排序\/筛选标签/);
});

test("guard: channel-home click (rated feed, no detail markers) → note, no sort verify", () => {
  const r = buildClickGuard({
    ...base,
    x: 500,
    y: 500,
    lastOcrChannelHome: true,
  });
  assert.equal(r.setSortVerify, false);
  assert.match(r.note, /频道首页/);
});

test("guard: top strip click (y<150, x≥400) → hot-list warning (16:43 session)", () => {
  const r = buildClickGuard({
    ...base,
    x: 2426,
    y: 87,
  });
  assert.match(r.note, /顶部 y<150 是热搜榜/);
});

test("guard: nav-home card-zone click (no pairs, y>280, x≥300) → HARD BLOCK (16:33 + 19:34 sessions)", () => {
  // 19:34: the model clicked the home card zone 3× after a warn-only hint —
  // a warning was not enough; the click must not fire at all.
  const r = buildClickGuard({
    ...base,
    x: 646,
    y: 747,
  });
  assert.ok(r.blocked, "must be blocked, not warned");
  assert.match(r.blocked, /首页\/导航页/);
  assert.match(r.blocked, /不要点首页卡片/);
  assert.match(r.blocked, /左侧导航「电影」/);
});

test("guard: channel-home hero-card title click → HARD BLOCK (auto-rotate, 19:47)", () => {
  // pairs exist from the last ocr, but the carousel has rotated by click
  // time — clicking 吴樾包贝尔 9.0 actually played 飞驰人生 9.7.
  const r = buildClickGuard({
    ...base,
    pairs: [
      { title: "吴樾包贝尔两代伪钞教父狂飙对决", score: "9.0", x: 362, y: 493 },
    ],
    lastOcrChannelHome: true,
    x: 362,
    y: 493,
  });
  assert.ok(r.blocked, "channel-home hero click must be blocked");
  assert.match(r.blocked, /轮播/);
  assert.match(r.blocked, /列表页/);
});

test("guard: DETAIL-page title click still allowed (no rotation on details)", () => {
  const r = buildClickGuard({
    ...base,
    pairs: [
      { title: "马腾你别走", score: "9.5", x: 3052, y: 216 },
    ],
    lastOcrDetail: true,
    x: 3052,
    y: 216,
  });
  assert.equal(r.blocked, undefined);
  assert.match(r.note, /将打开「马腾你别走」/);
});

test("guard: nav-home LEFT NAV click (x<250) still allowed (电影 entry)", () => {
  const r = buildClickGuard({
    ...base,
    x: 200,
    y: 370,
  });
  assert.equal(r.blocked, undefined);
  assert.equal(r.note, "");
});
