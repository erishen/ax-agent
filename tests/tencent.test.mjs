// Regression tests for the Tencent-Video page/pairing heuristics in
// src/tencent.ts. Every case carries the session it was learned from;
// these fixtures are the memory of the 15+ sessions where the rules were
// discovered. Run with: pnpm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  RATING_RE,
  buildPairs,
  detectPage,
  parseMiniTitle,
  sharesBigram,
} from "../src/tencent.ts";

const W = (text, x, y, w = 40, h = 17, confidence = 0.9) => ({
  text,
  x,
  y,
  w,
  h,
  confidence,
});
const joinedOf = (words) =>
  words
    .map((w) => `「${w.text}」(${Math.round(w.w)}×${Math.round(w.h)}) @(${Math.round(w.x)}, ${Math.round(w.y)})`)
    .join("\n");

// ---------------------------------------------------------------- detectPage

test("detectPage: nav home (no ratings) is homeLike (13:55 session step 4)", () => {
  const words = [
    W("仙逆", 599, 144, 31, 15),
    W("腾讯视频", 206, 163, 70, 21),
    W("首页", 214, 215, 31, 15),
    W("你正在追", 216, 254, 59, 15),
    W("VIP会员", 186, 289, 84, 22),
    W("电视剧", 184, 329, 76, 19),
    W("电影", 184, 368, 63, 19),
    W("综艺", 184, 407, 61, 19),
    W("动漫", 184, 446, 61, 17),
    W("少儿", 214, 487, 33, 17),
    W("NBA", 208, 527, 39, 11),
    W("短剧", 184, 562, 61, 19),
    W("飙升总榜第1名", 360, 571, 113, 19),
    W("杜海涛 代旭 社交观察", 358, 601, 147, 17),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.homeLike, true);
  assert.equal(f.channelHome, false);
  assert.equal(f.listPage, false);
  assert.equal(f.detailPage, false);
  assert.equal(f.playing, false);
});

test("detectPage: nav home WITH rated cards is still homeLike (16:43 session step 19)", () => {
  const words = [
    W("心动的信号 第9季", 2042, 87, 112, 15),
    W("腾讯视频", 1604, 108, 70, 19),
    W("你正在追", 1615, 198, 62, 16),
    W("VIP会员", 1587, 234, 84, 22),
    W("电视剧", 1615, 277, 49, 17),
    W("电影", 1613, 315, 33, 17),
    W("综艺", 1585, 353, 62, 21),
    W("动漫", 1615, 395, 31, 17),
    W("少儿", 1615, 433, 33, 17),
    W("NBA", 1617, 473, 33, 15),
    W("短剧", 1615, 513, 31, 17),
    W("马腾你别走", 2694, 874, 90, 17),
    W("9.7", 2660, 900, 28, 15),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.homeLike, true, "home feed ratings must NOT become a candidate pool");
  assert.equal(f.channelHome, false);
});

test("detectPage: film-channel home (热播榜+9.3) is channelHome, NOT homeLike (17:07 session step 8)", () => {
  const words = [
    W("仙逆", 599, 144, 31, 15),
    W("腾讯视频", 206, 163, 70, 21),
    W("首页", 216, 215, 29, 15),
    W("你正在追", 216, 254, 59, 15),
    W("VIP会员", 186, 289, 82, 22),
    W("电视剧", 184, 329, 76, 19),
    W("电影", 212, 370, 33, 15),
    W("综艺", 184, 407, 61, 19),
    W("动漫", 184, 448, 61, 16),
    W("少儿", 214, 487, 33, 15),
    W("NBA", 214, 527, 33, 13),
    W("电影热播榜第1名", 360, 424, 127, 19),
    W("9.3", 501, 426, 57, 17),
    W("肖央 阿云嘎 救灾题材", 360, 454, 143, 17),
    W("立即播放", 388, 532, 98, 21),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.channelHome, true, "rated channel feed must be recognized");
  assert.equal(f.homeLike, false, "must not be swallowed by the nav-home rule");
});

test("detectPage: channel list page (返回+筛选 tabs) is listPage (16:51 session step 14)", () => {
  const words = [
    W("<返回", 209, 128, 44, 17),
    W("最热", 233, 164, 31, 15),
    W("最新", 281, 164, 31, 15),
    W("高分好评", 361, 164, 55, 13),
    W("类型", 233, 200, 29, 15),
    W("动作 喜剧", 281, 200, 165, 15),
    W("爱情", 478, 200, 31, 15),
    W("科幻", 524, 200, 31, 15),
    W("你正在追", 103, 200, 59, 17),
    W("VIP会员", 101, 240, 57, 17),
    W("电影", 103, 318, 31, 17),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.listPage, true);
  assert.equal(f.homeLike, false);
});

test("detectPage: detail page (简介〉 + rating) is detailPage (13:55 session step 19)", () => {
  const words = [
    W("捕风追影 普通话•简介〉", 3050, 189, 177, 22),
    W("内地 2025 动作 警匪较量", 3052, 215, 170, 17),
    W("9.4", 3015, 309, 28, 19),
    W("腾讯视频", 186, 155, 74, 21),
    W("你正在追", 198, 251, 61, 17),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.detailPage, true);
  assert.equal(f.homeLike, false);
});

test("detectPage: player page (播放中 + time code) is playing (16:33 session)", () => {
  const words = [
    W("播放中 马腾你别走", 337, 136, 106, 13),
    W("腾讯视频", 186, 155, 74, 21),
    W("你正在追", 198, 251, 61, 17),
    W("00:57/2:04:00", 1200, 500, 90, 15),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.playing, true);
  assert.equal(f.homeLike, false);
});

test("detectPage: 你正在追 history page (观看至) is watchedPage (7dafd3e)", () => {
  const words = [
    W("观看至 45%", 400, 300, 80, 15),
    W("兰香如故", 350, 280, 80, 17),
    W("你正在追", 216, 254, 59, 15),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.watchedPage, true);
});

test("RATING_RE: tolerates the colon form (9:0 = 9.0, 8:3 = 8.3)", () => {
  assert.equal(RATING_RE.test("9.0"), true);
  assert.equal(RATING_RE.test("9:0"), true);
  assert.equal(RATING_RE.test("8.3分"), true);
  assert.equal(RATING_RE.test("9.4分"), true);
  assert.equal(RATING_RE.test("2025"), false);
  assert.equal(RATING_RE.test("9"), false);
});

// ---------------------------------------------------------------- buildPairs

test("buildPairs: same-card rating pairs with its title (洛杉矶劫案 8.3)", () => {
  const words = [
    W("洛杉矶劫案", 490, 840, 70, 17),
    W("8.3", 510, 870, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.deepEqual(pairs.map((p) => [p.title, p.score]), [["洛杉矶劫案", "8.3"]]);
});

test("buildPairs: NEIGHBOURING card rating is rejected (16:51: 红海行动 was '9.8', real ~8.3)", () => {
  // rating badge sits under the NEXT card (dx=280 > 100)
  const words = [
    W("红海行动", 1050, 840, 70, 17),
    W("9.8", 790, 865, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs.length, 0, "adjacent-card rating must not pair");
});

test("buildPairs: another neighbouring mis-pair rejected (16:51: 我看见两朵一样的云 '9.0')", () => {
  const words = [
    W("我看见两朵一样的云", 440, 840, 140, 17),
    W("9.0", 700, 870, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs.length, 0);
});

test("buildPairs: detail page pairs title above rating (dx≈109, d≈185 < 220)", () => {
  const words = [
    W("捕风追影", 3050, 189, 90, 22),
    W("9.4", 3015, 309, 28, 19),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: true });
  assert.deepEqual(pairs.map((p) => [p.title, p.score]), [["捕风追影", "9.4"]]);
});

test("buildPairs: detail-style layout NOT paired on a list page (d>150)", () => {
  const words = [
    W("捕风追影", 3050, 189, 90, 22),
    W("9.4", 3015, 309, 28, 19),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs.length, 0);
});

test("buildPairs: a film the user already watched is excluded (seenTitles)", () => {
  const words = [
    W("坚如磐石", 690, 702, 70, 17),
    W("9.4", 700, 730, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: ["坚如磐石"], detailPage: false });
  assert.equal(pairs.length, 0);
});

test("buildPairs: actor/genre row (space-separated) is not a title (14:05)", () => {
  const words = [
    W("雷佳音 张国立 警匪打黑", 690, 702, 180, 17),
    W("9.4", 700, 730, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs.length, 0);
});

test("buildPairs: episode chip (第二部) is not a title (14:05)", () => {
  const words = [
    W("第二部", 3123, 349, 45, 17),
    W("9.4", 3130, 380, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs.length, 0);
});

test("buildPairs: year label far above is not paired with a rating (16:51 年份行 y≈217 vs 评分 y≈850)", () => {
  const words = [
    W("2025", 851, 219, 33, 11),
    W("我看见两朵一样的云", 851, 820, 140, 17),
    W("9.0", 860, 850, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.deepEqual(pairs.map((p) => [p.title, p.score]), [["我看见两朵一样的云", "9.0"]]);
});

test("buildPairs: NAV words (片库/VIP会员/你正在追) are never titles", () => {
  const words = [
    W("你正在追", 216, 254, 59, 15),
    W("VIP会员", 186, 289, 84, 22),
    W("9.1", 200, 320, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs.length, 0);
});

test("buildPairs: detail-verified score overrides an unreliable badge (16:51: badge 9.0, film ~8.3)", () => {
  // The badge OCR lies (9.0); the detail page confirmed 8.3 earlier.
  const words = [
    W("我看见两朵一样的云", 440, 840, 140, 17),
    W("9.0", 450, 870, 30, 15),
  ];
  const verified = new Map([["我看见两朵一样的云", "8.3"]]);
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false, verifiedScores: verified });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].score, "8.3", "verified score must win over the badge");
  assert.equal(pairs[0].verified, true);
});

test("buildPairs: unverified pair is flagged as badge-sourced", () => {
  const words = [
    W("洛杉矶劫案", 490, 840, 70, 17),
    W("8.3", 510, 870, 30, 15),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.equal(pairs[0].score, "8.3");
  assert.equal(pairs[0].verified, false);
});

// -------------------------------------------------------------- parseMiniTitle

test("parseMiniTitle: II prefix stripped (16:51: 'II 两朵一样的云')", () => {
  assert.equal(parseMiniTitle("II 两朵一样的云"), "两朵一样的云");
});

test("parseMiniTitle: I1 口 + 播放中 fragments stripped (13:47: 'II 口播放中 扒特务')", () => {
  assert.equal(parseMiniTitle("II 口播放中 扒特务"), "扒特务");
});

test("parseMiniTitle: 口见 variant (16:51: 'I1 口见两朵一样的')", () => {
  assert.equal(parseMiniTitle("I1 口见两朵一样的"), "见两朵一样的");
});

test("parseMiniTitle: version words stripped (普通话/国语/话版)", () => {
  assert.equal(parseMiniTitle("捕风追影 普通话"), "捕风追影");
  assert.equal(parseMiniTitle("播放中 马腾你别走"), "马腾你别走");
});

// ---------------------------------------------------------------- sharesBigram

test("sharesBigram: mini strip matches candidate title", () => {
  assert.equal(sharesBigram("我看见两朵一样的云", "两朵一样的云"), true);
  assert.equal(sharesBigram("捕风追影", "捕风追影"), true);
  assert.equal(sharesBigram("坚如磐石", "坚如磐石"), true);
  assert.equal(sharesBigram("红海行动", "等风来"), false);
  assert.equal(sharesBigram("仙", "仙逆"), false, "single char never matches");
});

// ------------------------------------------------- ratingText (19:34 session:
// channel-home hero badge OCRs as 白9.3分 — the star icon reads as 白; the
// old exact RATING_RE dropped it, so a 9.3 candidate vanished from the pairs)

import { ratingText } from "../src/tencent.ts";

test("ratingText: tolerates OCR noise prefixes on badges", () => {
  assert.equal(ratingText("白9.3分"), "9.3");
  assert.equal(ratingText("白8.3分"), "8.3");
  assert.equal(ratingText("9.3分"), "9.3");
  assert.equal(ratingText("9:0"), "9:0");
  assert.equal(ratingText("9.0"), "9.0");
});

test("ratingText: player timestamps never qualify (length bound)", () => {
  assert.equal(ratingText("Q:9:99209"), null);
  assert.equal(ratingText("0:9899209"), null);
  assert.equal(ratingText("2025"), null);
  assert.equal(ratingText("9"), null);
});

test("ratingText: long composite heat-tag+badge words (19:47: 三在追破200万白9.7分)", () => {
  assert.equal(ratingText("三在追破200万白9.7分"), "9.7");
  assert.equal(ratingText("在追破300万白9.5分"), "9.5");
  // Only trusted when the word ENDS in 分 — timestamps/dates/IDs stay out.
  assert.equal(ratingText("55692999"), null);
  assert.equal(ratingText("寒1994戰"), null);
  assert.equal(ratingText("2026FIRST盛典"), null);
  assert.equal(ratingText("090909209"), null);
});

test("buildPairs: heat-tag composite badge pairs with the card title (19:47 飞驰人生 9.7)", () => {
  const words = [
    W("飞驰人生", 228, 366, 179, 52),
    W("三在追破200万白9.7分", 235, 436, 178, 20),
    W("沈腾 尹正 体育竞技", 233, 468, 138, 19),
    W("你正在追", 86, 196, 62, 19),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.deepEqual(
    pairs.map((p) => [p.title, p.score]),
    [["飞驰人生", "9.7"]],
  );
});

test("buildPairs: list badge with 白 noise prefix still pairs (19:34 OCR form)", () => {
  // The 19:34 session read the channel-home hero badge as 白9.3分 (star icon
  // → 白). On a LIST page the same noise would have silently dropped a real
  // candidate under the old exact RATING_RE — the loose form must pair.
  const words = [
    W("〈返回", 321, 181, 41, 17),
    W("出入平安", 900, 340, 61, 17),
    W("白9.1分", 920, 370, 20, 15),
    W("抓特务", 500, 340, 47, 17),
  ];
  const pairs = buildPairs(words, { seenTitles: [], detailPage: false });
  assert.deepEqual(
    pairs.map((p) => [p.title, p.score]),
    [["出入平安", "9.1"]],
  );
});

test("detectPage: channel-home hero badge with 白 prefix stays channelHome (19:34)", () => {
  // The hero badge noise must not leak into classification: 热播榜 still
  // wins → channelHome (not the suppress-everything homeLike).
  const words = [
    W("电影热播榜第1名", 360, 424, 127, 19),
    W("白9.3分", 501, 426, 57, 17),
    W("你正在追", 216, 254, 59, 15),
  ];
  const f = detectPage(joinedOf(words));
  assert.equal(f.channelHome, true);
  assert.equal(f.homeLike, false);
});
