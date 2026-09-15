// Tests for the NetEase-CloudMusic pure heuristics (netease.ts): page
// classification, song-row pairing from OCR words, title cleaning and the
// click guard. Word-lists below come from the 2026-09-15 probe session
// (window 1064×752, self-drawn Chromium UI).
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanSongTitle,
  detectPage,
  buildSongPairs,
  sharesBigram,
  titlesMatch,
  buildNeteaseClickGuard,
} from "../src/netease.ts";

const w = (text, x, y, confidence = 0.9) => ({
  text, x, y, w: Math.max(10, text.length * 8), h: 30, confidence,
});

test("detectPage: home has 每日推荐 cards, no list header", () => {
  const home = detectPage("推荐歌单 >\n每日推荐\n心动模式\n私人漫游\n推荐歌单（欧美零前奏…）");
  assert.equal(home.homeLike, true);
  assert.equal(home.songList, false);
  assert.equal(home.playPage, false);
});

test("detectPage: daily-recommendation page is a song list", () => {
  const list = detectPage("15/9 每日推荐\n播放全部\n下载\n# 标题 专辑 喜欢 时长");
  assert.equal(list.homeLike, false);
  assert.equal(list.songList, true);
});

test("detectPage: lyrics page is a play page", () => {
  const pp = detectPage("歌词\nConquest of Paradise\n[00:12.5] 你好\n词");
  assert.equal(pp.playPage, true);
  assert.equal(pp.songList, false);
});

test("cleanSongTitle: strips play glyphs and quality chips", () => {
  assert.equal(cleanSongTitle("II Remember Our Summer"), "Remember Our Summer");
  assert.equal(cleanSongTitle("超清母带 Vangelis"), "Vangelis");
  assert.equal(cleanSongTitle("Nevada (内华达)"), "Nevada 内华达");
  assert.equal(cleanSongTitle("超清母带 VIP 试听 MV"), "");
});

test("sharesBigram: works on Chinese and English titles", () => {
  assert.ok(sharesBigram("Conquest of Paradise", "Conquest of Paradise (征服天堂)"));
  assert.ok(sharesBigram("Nevada", "Nevada (内华达)"));
  assert.ok(!sharesBigram("abc", "xyz"));
});

test("buildSongPairs: duration-anchored rows from the probe OCR", () => {
  // Real probe rows (x/y in window thousandths, relative geometry kept).
  const words = [
    w("01", 240, 376),
    w("Conquest of Paradise (征服天堂)", 320, 366),
    w("超清母带", 320, 396),
    w("Vangelis", 380, 396),
    w("Reprise 1990-1999 (Atlantic Versi...", 620, 376),
    w("04:44", 880, 376),
    w("02", 240, 446),
    w("Go Again (feat. ELYSA)", 320, 436),
    w("King CAAN / Elysa", 380, 466),
    w("Go Again (feat. ELYSA)", 620, 436),
    w("02:59", 880, 436),
    w("03", 240, 506),
    w("Nevada (内华达)", 320, 496),
    w("超清母带", 320, 526),
    w("VIP 试听 MV", 400, 526),
    w("Vicetone / Cozi Zuehlsd...", 420, 526),
    w("Nevada", 620, 496),
    w("03:28", 880, 496),
    w("04", 240, 566),
    w("Cruel Summer", 320, 556),
    w("Taylor Swift", 380, 586),
    w("Lover", 620, 556),
    w("02:58", 880, 556),
  ];
  const songs = buildSongPairs(words, { playedTitles: [] });
  const byTitle = Object.fromEntries(songs.map((s) => [s.title, s]));
  assert.ok(byTitle["Conquest of Paradise 征服天堂"], "行1标题应配对");
  assert.equal(byTitle["Conquest of Paradise 征服天堂"].artist, "Vangelis");
  assert.ok(byTitle["Go Again feat. ELYSA"], "行2标题应配对");
  assert.ok(byTitle["Nevada 内华达"], "行3标题应配对");
  assert.ok(byTitle["Cruel Summer"], "行4标题应配对");
  assert.equal(byTitle["Cruel Summer"].artist, "Taylor Swift");
  // played songs are excluded (via the strict titlesMatch, not bigram)
  const fresh = buildSongPairs(words, { playedTitles: ["Cruel Summer"] });
  assert.ok(!fresh.some((s) => titlesMatch(s.title, "Cruel Summer")));
});

test("buildNeteaseClickGuard: song-row click is the task action", () => {
  const songs = [{ title: "Cruel Summer", artist: "Taylor Swift", x: 400, y: 560 }];
  const r = buildNeteaseClickGuard({
    x: 400, y: 560, verb: "单击", songs,
    homeLike: false, songList: true, playPage: false,
    bottomBar: null, pendingSong: "",
  });
  assert.match(r.note, /将播放「Cruel Summer」/);
  assert.equal(r.blocked, undefined);
});

test("buildNeteaseClickGuard: bottom bar controls are never the task", () => {
  const r = buildNeteaseClickGuard({
    x: 100, y: 940, verb: "单击", songs: [],
    homeLike: false, songList: true, playPage: false,
    bottomBar: { song: "Remember Our Summer", y: 920 }, pendingSong: "",
  });
  assert.match(r.note, /底部播放栏/);
});

test("buildNeteaseClickGuard: top bar (search/VIP) is off-task", () => {
  const r = buildNeteaseClickGuard({
    x: 350, y: 60, verb: "单击", songs: [],
    homeLike: true, songList: false, playPage: false,
    bottomBar: null, pendingSong: "",
  });
  assert.match(r.note, /顶部/);
});

test("buildNeteaseClickGuard: replaying the pending song is flagged", () => {
  const songs = [{ title: "Nevada 内华达", artist: "Vicetone", x: 400, y: 500 }];
  const r = buildNeteaseClickGuard({
    x: 400, y: 500, verb: "单击", songs,
    homeLike: false, songList: true, playPage: false,
    bottomBar: null, pendingSong: "Nevada",
  });
  assert.match(r.note, /不要重复点播/);
});
