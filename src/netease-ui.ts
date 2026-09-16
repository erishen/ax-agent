// NeteaseUiState — the NetEase-CloudMusic decision state machine.
//
// Same architecture as TencentUiState: chat.ts owns one instance per target
// app family and routes ocr / click_at / scroll through it, so the page
// classification, song pairing, bottom-bar playback evidence and the guard
// are all regression-testable (tests/netease-ui.test.mjs).
//
// NetEase is a self-drawn Chromium UI (probe 2026-09-15: AX tree has only
// the menu bar; window 1064×752). Unlike Tencent there is no rating system —
// the agent picks a song from the 每日推荐 list / a playlist by matching the
// user profile (profile_search) against song titles and playlist themes, then
// clicks a song row and verifies the bottom bar switched to that song.
import type { OcrScreenWord } from "./types.ts";
import {
  MIN_CONFIDENCE,
  buildNeteaseClickGuard,
  buildSongPairs,
  cleanSongTitle,
  detectPage,
  titlesMatch,
  type SongCandidate,
} from "./netease.ts";

const PLAYED_KEY = "axAgent.neteasePlayed.v1";

/** NetEase always shows the currently playing song in the bottom bar —
 * including a song the user was playing before the task. Playback evidence
 * therefore is NOT "a song is in the bar", it is "the bar shows the song
 * the model just clicked". This class tracks that pending song. */
export class NeteaseUiState {
  /** Songs the user already played (persisted) — never re-offered. */
  playedTitles: string[] = loadPlayed();

  /** The song the model just clicked in the list (awaiting bottom-bar
   * confirmation). Cleared when the bar matches it. */
  pendingSong = "";

  /** Song candidates from the most recent OCR, with click coordinates. */
  lastSongs: SongCandidate[] = [];

  lastOcrHome = false;
  lastOcrSongList = false;
  lastOcrPlayPage = false;

  /** Bottom bar (current playback) from the most recent OCR. */
  bottomBar: { song: string; y: number } | null = null;

  /** Which page-classification hints were shown last OCR (dedup). */
  lastHints = "";

  /** open_app reset: a new target app has no stale NetEase page state.
   * playedTitles intentionally survives. */
  resetForOpenApp(): void {
    this.pendingSong = "";
    this.lastSongs = [];
    this.lastOcrHome = false;
    this.lastOcrSongList = false;
    this.lastOcrPlayPage = false;
    this.bottomBar = null;
    this.lastHints = "";
  }

  rememberPlayed(title: string): void {
    if (!this.playedTitles.includes(title)) {
      this.playedTitles.push(title);
      try {
        localStorage.setItem(PLAYED_KEY, JSON.stringify(this.playedTitles));
      } catch {
        /* storage unavailable — in-memory is fine */
      }
    }
  }

  /** The bottom bar: the song title + artist band at the bottom of the
   * window (the rows with the largest y). Requires a bar signature (点赞数
   * w+/音质/歌词按钮) in the same band, so a list that merely reaches the
   * bottom of the window is not mistaken for the bar. Returns
   * {song, y} when found. */
  private detectBottomBar(words: OcrScreenWord[]): { song: string; y: number } | null {
    if (!words.length) return null;
    const maxY = Math.max(...words.map((w) => w.y));
    const band = words.filter((w) => w.y >= maxY - 130);
    if (!band.length) return null;
    const hasBarSignature = band.some((w) =>
      /^(词|歌词|极高|无损|标准|音质|赞|评论|分享|收藏|100w\+|\d+w\+)$/.test(w.text.trim()),
    );
    if (!hasBarSignature) return null;
    // The bar's song row: the leftmost text with a plausible title length,
    // typically next to the play-state glyph (II/I1/►).
    const title = band
      .filter(
        (w) =>
          w.confidence >= MIN_CONFIDENCE &&
          w.text.length >= 2 &&
          w.x < 500 &&
          !/^(100w\+|\d+w\+|极高|词|歌|赞|评论|分享|下载|MV)$/.test(w.text.trim()),
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!title) return null;
    const clean = cleanSongTitle(title.text);
    return clean.length >= 2 ? { song: clean, y: title.y } : null;
  }

  /** The whole NetEase OCR decision: classify the page, pair song rows,
   * detect the bottom bar, match pendingSong against it, and assemble the
   * hints for the model. */
  processOcr(words: OcrScreenWord[]): { joined: string; hints: string } {
    const joined = words
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, 60)
      .map(
        (w) =>
          `「${w.text}」${w.w > 0 ? ` (${Math.round(w.w)}×${Math.round(w.h)})` : ""} @(${Math.round(w.x)}, ${Math.round(w.y)})` +
          (w.confidence < 0.5 ? ` 置信${(w.confidence * 100).toFixed(0)}%` : ""),
      )
      .join("\n");
    const flags = detectPage(joined);
    this.lastOcrHome = flags.homeLike;
    this.lastOcrSongList = flags.songList;
    this.lastOcrPlayPage = flags.playPage;
    this.bottomBar = this.detectBottomBar(words);
    this.lastSongs = flags.songList
      ? buildSongPairs(words, { playedTitles: this.playedTitles })
      : [];

    const hints: string[] = [];
    // 1. Playback evidence: did the bottom bar switch to the pending song?
    const bar = this.bottomBar;
    if (this.pendingSong) {
      if (bar && titlesMatch(bar.song, this.pendingSong)) {
        this.rememberPlayed(this.pendingSong);
        this.pendingSong = "";
        hints.push(
          `\n🎯 播放已确认：底栏正在播放「${bar.song}」——就是你刚点开的那首，任务完成，done 汇报（歌名 + 为什么选它）。`,
        );
      } else {
        hints.push(
          `\n（你刚点了「${this.pendingSong}」但底栏还在播「${bar?.song ?? "…"}」：点击可能未生效或歌还在加载。若底栏歌名未变，回到列表重新点歌名行；若已切到别的歌，说明点错行，按 esc/重选）`,
        );
      }
    } else if (bar) {
      // No pending click: the bar shows whatever was playing before the
      // task (e.g. 用户之前听的歌) — explicitly NOT task evidence.
      hints.push(
        `\n（底部播放栏显示「${bar.song}」——这是网易云常驻的当前播放栏，播的是你之前听的歌，【不是】本次任务播放的证据。选歌并点歌名行后，底栏切到该歌才算完成）`,
      );
    }

    // 2. Page guidance.
    if (flags.homeLike) {
      hints.push(
        "\n（这是网易云【首页/推荐】：①点「每日推荐」卡（按你的音乐口味生成、每天6:00更新）进入今日歌单挑歌；②或点下方推荐歌单卡（如欧美歌单）进歌单；③「心动模式/私人漫游/私人雷达」也是入口。不要点歌单卡下方的「播放全部」直接开播整单——先看歌单内容挑一首）",
      );
    } else if (flags.songList) {
      if (this.lastSongs.length) {
        const list = this.lastSongs
          .slice(0, 8)
          .map(
            (s) =>
              `「${s.title}」${s.artist ? `(${s.artist})` : ""} → 点歌名坐标 (${s.x}, ${s.y})`,
          )
          .join("\n");
        hints.push(
          `\n\n【歌曲候选】（结合画像/歌单主题挑一首点歌名行播放）：\n${list}\n（也可点「播放全部」整单播放，但任务推荐单曲更精准）`,
        );
      } else {
        hints.push(
          "\n（当前是歌曲列表页：读本屏歌名 + 歌手，结合用户画像挑一首；列表可滚动查看更多。点歌名行即播放该歌——点击后看底部播放栏是否切到它）",
        );
      }
    } else if (flags.playPage) {
      hints.push(
        "\n（当前是歌词/播放页：如果这就是你点的歌且底栏已匹配，任务完成 done；若想换歌，按 esc 或点返回回列表）",
      );
    }

    // 3. Cross-cutting hints (dedup per OCR, and never on every read).
    const seenPlayed = this.playedTitles.filter((s) =>
      words.some((w) => w.text.length >= 2 && titlesMatch(w.text, s)),
    );
    if (seenPlayed.length && flags.songList) {
      hints.push(
        `\n（已从候选排除你播过的歌：${[...new Set(seenPlayed)].join("、")}——它们不会再作为推荐候选）`,
      );
    }
    const lowConf = words.filter((w) => w.confidence < MIN_CONFIDENCE).length;
    if (words.length > 3 && (lowConf / words.length > 0.5 || lowConf >= 10)) {
      hints.push(
        "\n⚠️ 识别质量差（大量低置信/乱码词）：页面可能在加载/动画。wait_for 1-2s 后再 ocr，或确认窗口在前台/未遮挡。",
      );
    }

    const hintsStr = hints.join("");
    this.lastHints = hintsStr;
    return { joined, hints: hintsStr };
  }

  /** Click guard: wire state into the pure guard; block bottom-bar and
   * top-bar clicks. */
  clickGuard(x: number, y: number, verb: string): { note: string; blocked?: string } {
    return buildNeteaseClickGuard({
      x,
      y,
      verb,
      songs: this.lastSongs,
      homeLike: this.lastOcrHome,
      songList: this.lastOcrSongList,
      playPage: this.lastOcrPlayPage,
      bottomBar: this.bottomBar,
      pendingSong: this.pendingSong,
    });
  }

  /** When a click lands on a paired song title, remember it as the pending
   * song so the next OCR can confirm the bottom bar switched to it. */
  noteSongClick(x: number, y: number): void {
    const hit = this.lastSongs.find(
      (s) => Math.abs(x - s.x) <= 80 && Math.abs(y - s.y) <= 30,
    );
    if (hit) this.pendingSong = hit.title;
  }

  /** After a scroll every song coordinate is stale. */
  scrollAwayNote(): string {
    const had = this.lastSongs.length;
    this.lastSongs = [];
    return had
      ? "\n（已滚动：上一屏歌曲候选的坐标已失效，先 ocr 刷新列表再用新坐标点击）"
      : "";
  }
}

/** Load played-song titles from localStorage (missing/unparsable → []). */
function loadPlayed(): string[] {
  try {
    const raw = localStorage.getItem(PLAYED_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.length >= 2) : [];
  } catch {
    return [];
  }
}
