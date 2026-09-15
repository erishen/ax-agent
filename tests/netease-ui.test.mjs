// Tests for the NeteaseUiState decision machine (netease-ui.ts): page
// routing through processOcr, the bottom-bar playback-evidence contract
// (a pre-task song in the bar is NOT evidence; the pending clicked song
// matching the bar IS), and scroll coordinate invalidation.
import test from "node:test";
import assert from "node:assert/strict";
import { NeteaseUiState } from "../src/netease-ui.ts";

const w = (text, x, y, confidence = 0.9) => ({
  text, x, y, w: Math.max(10, text.length * 8), h: 30, confidence,
});

function freshState() {
  const s = new NeteaseUiState();
  s.playedTitles = [];
  return s;
}

test("processOcr: home page → home hint, no song candidates", () => {
  const s = freshState();
  const { hints } = s.processOcr([
    w("每日推荐", 234, 126),
    w("心动模式", 374, 126),
    w("推荐歌单 >", 234, 416),
    w("欧美零前奏 |开口跪秒杀的无前奏欧美神旋", 234, 676),
    w("Remember Our Summer", 80, 916), // pre-task song in bottom bar
    w("FrogMonster 蛙蛙", 80, 946),
    w("极高", 800, 916),
    w("词", 840, 916),
  ]);
  assert.match(hints, /首页\/推荐/);
  assert.match(hints, /每日推荐/);
  // the bar song is flagged as NOT task evidence
  assert.match(hints, /不是.*任务播放的证据/);
  assert.ok(s.lastOcrHome);
  assert.equal(s.lastSongs.length, 0);
});

test("processOcr: daily-list page pairs songs with click coordinates", () => {
  const s = freshState();
  const { hints } = s.processOcr([
    w("15/9 每日推荐", 220, 120),
    w("播放全部", 240, 226),
    w("下载", 330, 226),
    w("01", 240, 376),
    w("Conquest of Paradise (征服天堂)", 320, 366),
    w("Vangelis", 380, 396),
    w("04:44", 880, 376),
    w("02", 240, 446),
    w("Nevada (内华达)", 320, 496),
    w("Vicetone", 400, 526),
    w("03:28", 880, 496),
  ]);
  assert.match(hints, /歌曲候选/);
  assert.match(hints, /Conquest of Paradise/);
  assert.match(hints, /Nevada/);
  assert.ok(s.lastSongs.length >= 2);
  assert.ok(s.lastSongs.every((p) => p.x > 0 && p.y > 0));
});

test("pendingSong → bottom bar match is playback evidence (task done)", () => {
  const s = freshState();
  // the model clicked Nevada (song row @ y≈500), recorded as pending
  s.pendingSong = "Nevada 内华达";
  s.lastSongs = [{ title: "Nevada 内华达", artist: "Vicetone", x: 400, y: 500 }];
  const { hints } = s.processOcr([
    w("02", 240, 446),
    w("Nevada (内华达)", 320, 436),
    w("03:28", 880, 496),
    w("Nevada", 80, 916), // bottom bar switched to it
    w("Vicetone", 80, 946),
    w("极高", 800, 916),
    w("词", 840, 916),
  ]);
  assert.match(hints, /播放已确认/);
  assert.match(hints, /done/);
  assert.equal(s.pendingSong, "");
  assert.ok(s.playedTitles.some((t) => t.includes("Nevada")));
});

test("pendingSong without bar switch → click may not have landed", () => {
  const s = freshState();
  s.pendingSong = "Cruel Summer";
  const { hints } = s.processOcr([
    w("04", 240, 566),
    w("Cruel Summer", 320, 556),
    w("02:58", 880, 556),
    w("Remember Our Summer", 80, 916), // bar still shows the old song
    w("FrogMonster 蛙蛙", 80, 946),
    w("极高", 800, 916),
    w("词", 840, 916),
  ]);
  assert.match(hints, /可能未生效/);
  assert.equal(s.pendingSong, "Cruel Summer"); // still pending
});

test("clickGuard + noteSongClick: song-row click arms the pending song", () => {
  const s = freshState();
  s.lastSongs = [{ title: "Nevada 内华达", artist: "Vicetone", x: 400, y: 500 }];
  const guard = s.clickGuard(400, 500, "单击");
  assert.match(guard.note, /将播放/);
  s.noteSongClick(400, 500);
  assert.equal(s.pendingSong, "Nevada 内华达");
});

test("scrollAwayNote: clears stale song coordinates", () => {
  const s = freshState();
  s.lastSongs = [{ title: "Nevada 内华达", artist: "Vicetone", x: 400, y: 500 }];
  const note = s.scrollAwayNote();
  assert.match(note, /坐标已失效/);
  assert.equal(s.lastSongs.length, 0);
  // second call is quiet
  assert.equal(s.scrollAwayNote(), "");
});
