// Regression tests for TencentUiState — the decision state machine that
// used to live as ~20 module-level flags + a 300-line ocr case in chat.ts.
// processOcr is now a pure class method: given a session word-list it
// fully determines the hint output + state delta, so the 11-hint assembly
// is finally testable with the REAL session OCR data.
import test from "node:test";
import assert from "node:assert/strict";
import { TencentUiState } from "../src/tencent-ui.ts";

const W = (text, x, y, w = 40, h = 17, confidence = 0.9) => ({
  text,
  x,
  y,
  w,
  h,
  confidence,
});

test("processOcr: list page → pairs hint with title coords (16:51 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("<返回", 196, 121, 44, 17),
    W("电影•最热•院线电影", 769, 149, 134, 13),
    W("我看见两朵一样的云", 851, 820, 140, 17),
    W("9.0", 860, 850, 30, 15),
  ];
  const { joined, hints } = tui.processOcr(words);
  assert.match(joined, /我看见两朵一样的云/);
  assert.match(hints, /我看见两朵一样的云/);
  assert.match(hints, /评分 9.0 分/);
  assert.match(hints, /点片名坐标/);
});

test("processOcr: detail page sub-9 → ratingGuard hard hint (13:22 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("捕风追影 普通话•简介〉", 3050, 189, 177, 22),
    W("内地 2025 动作 警匪较量", 3052, 215, 170, 17),
    W("8.1", 3015, 309, 28, 19),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /评分 8.1 分 < 9/);
  assert.match(hints, /不达标/);
  // verified score cached for the return-to-list override
  assert.equal(tui.detailVerifiedScores.get("捕风追影"), "8.1");
});

test("processOcr: nav home with rated cards → homeHint, no pairs (16:43 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("心动的信号 第9季", 2042, 87, 112, 15),
    W("你正在追", 1615, 198, 62, 16),
    W("电影", 1613, 315, 33, 17),
    W("马腾你别走", 2694, 874, 90, 17),
    W("9.7", 2660, 900, 28, 15),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /首页\/导航页/);
  assert.doesNotMatch(hints, /【评分-片名配对】/);
});

test("processOcr: channel home (热播榜+9.3) → hero hint, pairs suppressed (14:23 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("电影热播榜第1名", 360, 424, 127, 19),
    W("出入平安", 440, 420, 70, 17),
    W("9.3", 470, 450, 30, 15),
    W("肖央 阿云嘎 救灾题材", 360, 454, 143, 17),
  ];
  const { hints } = tui.processOcr(words);
  assert.doesNotMatch(hints, /首页\/导航页/);
  // Hero cards rotate and PLAY on click — pairing them invites a click
  // that plays an unverified film (14:23: 庇护之地 9.7 hero clicked,
  // played whatever was under the cursor).
  assert.match(hints, /频道首页/);
  assert.doesNotMatch(hints, /【评分-片名配对】/);
});

test("processOcr: playing player → playingHint (16:33 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("播放中 马腾你别走", 500, 400, 106, 13),
    W("00:57/2:04:00", 1200, 500, 90, 15),
    W("选集", 800, 700, 40, 17),
    W("倍速", 900, 700, 40, 17),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /播放中.*播放.*done/);
});

test("processOcr: 继续播放 toast → dialogHint", () => {
  const tui = new TencentUiState();
  const words = [W("继续播放之前关闭的2个视频", 1156, 196, 211, 17)];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /继续播放.*弹窗/);
});

test("processOcr: 你正在追 history page → watchedHint (7dafd3e)", () => {
  const tui = new TencentUiState();
  const words = [
    W("观看至 45%", 400, 300, 80, 15),
    W("兰香如故", 350, 280, 80, 17),
    W("你正在追", 216, 254, 59, 15),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /你正在追\/历史观看/);
});

test("processOcr: mini-strip task film → miniPlayingTitle set + replay warning", () => {
  const tui = new TencentUiState();
  const words = [
    W("II 播放中 捕风追影", 337, 136, 120, 13),
    W("捕风追影", 700, 700, 70, 17),
    W("9.4", 710, 730, 30, 15),
  ];
  const { hints } = tui.processOcr(words);
  assert.equal(tui.miniPlayingTitle, "捕风追影");
  assert.match(hints, /任务播放【已开始】/);
});

test("processOcr: task film stays 'playing' on the NEXT ocr of the same screen — seenTitles must NOT swallow it (21:24 session: 出入平安)", () => {
  // 21:24 repro: after clicking 出入平安 the strip showed 「出入平安 播放中」
  // on every ocr. Bug: rememberSeen added the TASK film to seenTitles, the
  // next buildPairs filtered it out of candidates, isTaskFilm flipped, and
  // the model was told the playing task film was "a previously watched film
  // to exclude" — it abandoned the playback and burned the budget hunting
  // for 鹿鼎记.
  const tui = new TencentUiState();
  const words = [
    W("I1 平安 播放中", 337, 136, 106, 13, 0.3),
    W("9.3", 1361, 212, 20, 12),
    W("8.3", 560, 212, 20, 12),
    W("9.7", 1093, 212, 20, 12),
    W("黑道中人•首播", 608, 241, 98, 20),
    W("出入平安•首播", 1144, 244, 98, 17),
    W("鹿鼎记I•独播", 876, 244, 90, 15),
    W("洛杉矶劫案•首播", 341, 244, 113, 17),
    W("昌电影热播榜第1名", 1152, 268, 108, 15, 0.3),
    W("首页", 198, 210, 29, 17),
    W("你正在追", 196, 251, 63, 15, 0.3),
    W("电视剧", 194, 331, 49, 18, 0.3),
    W("电影", 196, 373, 33, 17, 0.3),
    W("为你推荐", 341, 340, 157, 27, 0.3),
  ];
  const r1 = tui.processOcr(words);
  assert.equal(tui.miniPlayingTitle, "平安");
  assert.match(r1.hints, /任务播放【已开始】/);
  // Same screen read again (strip text OCRs slightly differently):
  const r2 = tui.processOcr(words.map((w) => (w.text === "I1 平安 播放中" ? { ...w, text: "II 口、平安 播放中" } : w)));
  assert.equal(tui.miniPlayingTitle, "平安", "task film must stay playing on the next ocr");
  assert.match(r2.hints, /任务播放【已开始】/);
  assert.doesNotMatch(r2.hints, /之前看过的片/);
  assert.ok(tui.lastListPairs.some((p) => p.title.includes("出入平安")), "task film must still be a candidate");
});

test("processOcr: mini-strip auto-resumed OLD film → remembered as seen, excluded from pairs", () => {
  const tui = new TencentUiState();
  const words = [
    W("II 口播放中 扒特务", 337, 136, 130, 13),
    W("兰香如故", 700, 700, 80, 17),
    W("9.1", 710, 730, 30, 15),
  ];
  tui.processOcr(words);
  assert.ok(tui.seenTitles.includes("扒特务"));
  assert.equal(tui.miniPlayingTitle, "");
});

test("processOcr: quality note gated — first low-quality read stays silent", () => {
  const tui = new TencentUiState();
  const bad = W("食王王沙", 216, 254, 59, 15, 0.3);
  const words = [bad, bad, bad, bad, bad];
  const r1 = tui.processOcr(words);
  assert.doesNotMatch(r1.hints, /识别质量差/);
  const r2 = tui.processOcr(words);
  assert.doesNotMatch(r2.hints, /识别质量差/, "needs streak>=2 AND ≥3 OCRs since last note");
  const r3 = tui.processOcr(words);
  assert.match(r3.hints, /识别质量差/);
});

test("processOcr: scrollsSinceRating escalates the list hint", () => {
  const tui = new TencentUiState();
  // no 「最热/最新」sort header → the scrolls-since-rating counter branch
  const words = [W("<返回", 196, 121, 44, 17), W("电影", 769, 149, 80, 13)];
  const r0 = tui.processOcr(words);
  assert.doesNotMatch(r0.hints, /已连续/);
  const r1 = tui.processOcr(words);
  assert.match(r1.hints, /已连续 2 次列表页未见评分数字/);
  const r2 = tui.processOcr(words);
  assert.match(r2.hints, /已连续 3 次列表页未见评分数字/);
});

test("processOcr: detail-verified score overrides badge on return (16:51 flow)", () => {
  const tui = new TencentUiState();
  // Visit the detail page: verified 8.3
  tui.processOcr([
    W("我看见两朵一样的云 普通话•简介〉", 3050, 189, 200, 22),
    W("8.3", 3015, 309, 28, 19),
  ]);
  // Back on the list: badge OCR lies (9.0), verified wins
  const { hints } = tui.processOcr([
    W("<返回", 196, 121, 44, 17),
    W("我看见两朵一样的云", 851, 820, 140, 17),
    W("9.0", 860, 850, 30, 15),
  ]);
  assert.match(hints, /评分 8.3 分【不达标】（详情页已复核）/);
});

test("sortVerifyReminder: one-shot — armed then consumed", () => {
  const tui = new TencentUiState();
  tui.pendingSortVerify = true;
  assert.match(tui.sortVerifyReminder(), /排序\/筛选标签/);
  assert.equal(tui.sortVerifyReminder(), "");
});

test("clickGuard: wires state through and arms sort verify", () => {
  const tui = new TencentUiState();
  tui.lastOcrList = true;
  const r = tui.clickGuard(435, 217, "单击");
  assert.equal(tui.pendingSortVerify, true, "sort-tab click arms verify");
  assert.match(r.note, /排序\/筛选标签/);
  const r2 = tui.clickGuard(435, 217, "单击");
  assert.equal(tui.pendingSortVerify, true, "stays armed until an ocr consumes it");
  void r2;
});

test("scrollBounced: opposite-direction repeat at same spot is a bounce", () => {
  const tui = new TencentUiState();
  assert.equal(tui.scrollBounced(700, 500, -1), false);
  assert.equal(tui.scrollBounced(700, 500, 1), true);
  assert.equal(tui.scrollBounced(701, 501, -1), true);
});

test("scrollAwayNote: clears pairs and reports the left-behind candidate", () => {
  const tui = new TencentUiState();
  tui.lastListPairs = [
    { title: "小气鬼", score: "9.1", x: 100, y: 200 },
    { title: "洛杉矶劫案", score: "8.3", x: 300, y: 400 },
  ];
  const { qualifiedNote } = tui.scrollAwayNote();
  assert.match(qualifiedNote, /小气鬼.*9.1/);
  assert.doesNotMatch(qualifiedNote, /洛杉矶劫案/);
  assert.equal(tui.lastListPairs.length, 0, "stale coordinates must not survive a scroll");
});

test("trackMove: three same-spot clicks with no observation → block", () => {
  const tui = new TencentUiState();
  assert.equal(tui.trackMove("ocr", null, null).block, undefined);
  assert.equal(tui.trackMove("click_at", 100, 100).block, undefined);
  assert.equal(tui.trackMove("click_at", 101, 100).block, undefined);
  const r = tui.trackMove("click_at", 102, 101);
  assert.match(r.block ?? "", /同一区域连续点击 3 次/);
});

test("trackMove: observation resets the blindness run", () => {
  const tui = new TencentUiState();
  tui.trackMove("click_at", 100, 100);
  tui.trackMove("click_at", 101, 100);
  tui.trackMove("ocr", null, null);
  const r = tui.trackMove("click_at", 102, 101);
  assert.equal(r.block, undefined);
  assert.equal(r.warn, undefined);
});

test("trackMove: different-spot clicks get a warning, not a block", () => {
  const tui = new TencentUiState();
  tui.trackMove("click_at", 100, 100);
  tui.trackMove("click_at", 300, 300);
  const r = tui.trackMove("click_at", 500, 500);
  assert.equal(r.block, undefined);
  assert.match(r.warn ?? "", /连续点击 3 次/);
});

test("resetForOpenApp: clears per-app state, keeps seen titles", () => {
  const tui = new TencentUiState();
  tui.lastOcrDetail = true;
  tui.miniPlayingTitle = "捕风追影";
  tui.pendingSortVerify = true;
  tui.detailVerifiedScores.set("捕风追影", "9.4");
  tui.seenTitles.push("兰香如故");
  tui.resetForOpenApp();
  assert.equal(tui.lastOcrDetail, false);
  assert.equal(tui.miniPlayingTitle, "");
  assert.equal(tui.pendingSortVerify, false);
  assert.equal(tui.detailVerifiedScores.size, 0);
  assert.ok(tui.seenTitles.includes("兰香如故"));
});

test("processOcr: personal-center page → account hint, not home hint (22:41 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("首页", 1771, 200, 63, 20, 0.3),
    W("你正在追", 1802, 241, 61, 17),
    W("风行万里", 430, 209, 68, 17),
    W("积分0 钻石0 账号设置", 319, 181, 165, 15),
    W("我的主页", 255, 189, 46, 13),
    W("加追", 294, 241, 37, 20),
    W("收藏", 426, 241, 35, 20),
    W("看过", 229, 241, 37, 22),
    W("下载", 554, 241, 37, 22),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /个人中心/);
  assert.match(hints, /没有/);
  assert.match(hints, /电影/);
  assert.doesNotMatch(hints, /请点左侧导航「电影」重新进入频道列表/);
});

test("processOcr: film channel list with 你正在追 nav → NOT home, pairs built (22:52 session)", () => {
  const tui = new TencentUiState();
  const words = [
    W("首页", 1753, 195, 63, 20, 0.3),
    W("你正在追", 1784, 237, 63, 18),
    W("VIP会员", 1782, 278, 59, 18),
    W("电视剧", 1784, 318, 47, 20),
    W("电影", 1784, 360, 31, 18),
    W("极限审判", 1946, 425, 157, 31),
    W("30 倒计时", 2305, 441, 52, 13),
    W("90:00", 2303, 456, 74, 22),
    W("9.2分", 1935, 488, 58, 18),
    W("克里斯•帕拉特 丽贝卡•弗格森 科幻悬疑", 1933, 519, 276, 18),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /「极限审判」评分 9.2 分/);
  assert.doesNotMatch(hints, /当前是首页\/导航页/);
  // the pair's click coordinate (score-badge position, what the hint
  // advertises) must NOT be blocked — home-guard misclassification used
  // to fire here before the homeLike fix
  const g = tui.clickGuard(2025, 441, "单击");
  assert.equal(g.blocked, undefined, "list-page candidate click must pass the guard");
  assert.match(g.note ?? "", /极限审判/);
});

test("processOcr: nav home → home hint carries nav coords", () => {
  const tui = new TencentUiState();
  const words = [
    W("首页", 1805, 200, 29, 17),
    W("你正在追", 1802, 241, 61, 17),
    W("VIP会员", 1802, 279, 56, 18),
    W("电视剧", 1771, 316, 79, 22),
    W("电影", 1800, 357, 34, 19),
    W("心动的信号 第9季", 2238, 129, 216, 15),
    W("综艺飙升榜第1名", 2238, 129, 216, 15),
  ];
  const { hints } = tui.processOcr(words);
  assert.match(hints, /当前是首页\/导航页/);
  assert.match(hints, /电影@\(1817,367\)/);
});


test("processOcr + clickGuard: icon-prefixed nav words still fill lastNavItems and let the 电影 nav click through (09-18 session)", () => {
  // The left-rail icons OCR as stray prefixes (③电影 / 凶 电视剧 / ◎ 综艺 /
  // V VIP会员). NAV_RE's exact ^$ match used to reject them, lastNavItems
  // dropped 电影/电视剧/综艺, and the click guard's onNav let-through
  // never fired — the correct 电影 nav click (185,370) was blocked as a
  // hero-card click. Now navLabelOf strips the prefix.
  const tui = new TencentUiState();
  const words = [
    W("交锋 当悬疑剧榜第1名", 593, 136, 127, 17, 0.3),
    W("片库", 974, 136, 31, 17, 0.3),
    W("腾讯视频", 206, 163, 74, 21, 0.3),
    W("首页", 200, 208, 28, 21, 0.3),
    W("你正在追", 196, 251, 63, 15, 0.3),
    W("V VIP会员", 184, 289, 86, 22, 0.3),
    W("凶 电视剧", 167, 329, 77, 20, 0.3),
    W("③电影", 165, 370, 65, 20, 0.3),
    W("◎ 综艺", 165, 411, 65, 21, 0.3),
    W("动漫", 165, 453, 65, 19, 0.3),
    W("少儿", 194, 495, 35, 17, 0.3),
    W("④", 167, 533, 22, 19, 0.3),
    W("NBA", 192, 537, 39, 15, 0.3),
    W("短剧", 196, 576, 33, 17, 0.3),
    W("鸟热搜总榜第1名 三在追破300万", 347, 586, 239, 17, 0.3),
    W("刘学义 谭松韵 古装爱情", 358, 601, 160, 17, 0.3),
  ];
  tui.processOcr(words);
  const film = tui.lastNavItems.find((n) => n.title === "电影");
  assert.ok(film, "lastNavItems must include 电影 from the prefixed ③电影");
  // 电影 word at (165,370) 65x20 → center ≈(198, 380); a click near it
  // must hit onNav and pass, not be blocked as a hero-card click.
  const guard = tui.clickGuard(185, 370, "单击");
  assert.equal(guard.blocked, undefined, "nav click must not be blocked");
  assert.match(guard.note, /电影/);
});
