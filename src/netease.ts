// NetEase-CloudMusic page / OCR heuristics — pure functions, no AX or UI
// dependencies. Same convention as tencent.ts: every rule here was learned
// from a real session (2026-09-15 probe: window 1064×752, self-drawn
// Chromium UI, AX tree empty apart from the menu bar), so the page
// classification and song-pairing rules can be regression-tested without
// driving a real instance.

import type { OcrScreenWord } from "./types";

export const NET_NAV_RE =
  /^(推荐|精选|播客|漫游|关注|我的|我喜欢的音乐|最近播放|我的播客|更多|创建的歌单|歌曲|每日推荐|心动模式|私人漫游|私人雷达|相似歌曲|网易云音乐|下载|播放全部|风格推荐|历史日推|喜欢|时长|专辑|标题|#)$/;

export interface NeteasePageFlags {
  /** 推荐首页: 功能卡行 (每日推荐/心动模式/…) + 推荐歌单卡. */
  homeLike: boolean;
  /** 歌曲列表页 (每日推荐/歌单): 播放全部 + 下载 或 序号/歌名/时长 表头. */
  songList: boolean;
  /** 歌词/播放页: 歌词正文特征, 无列表表头. */
  playPage: boolean;
}

/** Classify the current NetEase screen from the OCR text. */
export function detectPage(joined: string): NeteasePageFlags {
  const hasListHeader = /#\s*标题|标题\s*专辑|专辑\s*喜欢|喜欢\s*时长/.test(joined);
  const hasPlayAll = /播放全部/.test(joined);
  const songList = hasListHeader || hasPlayAll;
  const homeLike =
    !songList && /推荐歌单|每日推荐|心动模式|私人漫游|私人雷达|相似歌曲/.test(joined);
  const playPage = !songList && !homeLike && /歌词|词$/.test(joined);
  return { homeLike, songList, playPage };
}

const SONG_TIME_RE = /^(\d{1,2}):(\d{2})$/;
const SONG_NUM_RE = /^(\d{2})$/;

/** True when the two strings share any 2-char substring. */
export function sharesBigram(a: string, b: string): boolean {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < 2) return false;
  for (let i = 0; i + 2 <= short.length; i++) {
    if (long.includes(short.slice(i, i + 2))) return true;
  }
  return false;
}

/** Longest common substring length (case-insensitive). */
function lcsLen(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best) best = dp[i][j];
      }
    }
  }
  return best;
}

/** Song-title equivalence for playback evidence / played-song exclusion.
 * Bigram matching is fine for Chinese titles but explodes on English ones
 * (Cruel Summer vs Remember Our Summer share "er"), so require either a
 * containment match or a long common substring (≥60% of the shorter
 * title). */
export function titlesMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const short = Math.min(x.length, y.length);
  if (short < 4) return false;
  const lcs = lcsLen(x, y);
  return lcs >= 4 && lcs / short >= 0.6;
}

/** Normalise a song title for matching: drop play-state glyphs (II/I1/►),
 * 超清母带/VIP/试听/MV chips and trailing whitespace. */
export function cleanSongTitle(raw: string): string {
  return raw
    .replace(/^[I1►▶\s]+/, "")
    .replace(/超清母带|母带|VIP|试听|MV|独家|新歌发布/g, "")
    .replace(/[（）()]/g, "")
    .trim();
}

export interface SongCandidate {
  /** 歌名 (cleaned). */
  title: string;
  /** 歌手名 (second line under the title), may be empty. */
  artist: string;
  x: number;
  y: number;
}

/** Pair each song row in a NetEase song list: a duration (02:59) anchors
 * the row, the title is the text at the same height left of it, and the
 * artist is the subtitle line right below the title. Returns candidates
 * with the title's center coordinates for click_at. */
export function buildSongPairs(
  words: OcrScreenWord[],
  opts: { playedTitles: string[] },
): SongCandidate[] {
  const cx = (w: OcrScreenWord) => w.x + w.w / 2;
  const out: SongCandidate[] = [];
  const used = new Set<OcrScreenWord>();
  for (const dur of words) {
    if (!SONG_TIME_RE.test(dur.text.trim()) || dur.confidence < 0.5) continue;
    // the title is the LEFTMOST text on the same row (±30px) left of the
    // duration: the song column sits at x≈320 in the window while the
    // album column is x≈620-820 — "nearest" would pick the album.
    const title = words
      .filter(
        (t) =>
          t !== dur &&
          !used.has(t) &&
          t.confidence >= 0.5 &&
          t.text.length >= 2 &&
          !NET_NAV_RE.test(t.text) &&
          !SONG_TIME_RE.test(t.text.trim()) &&
          !SONG_NUM_RE.test(t.text.trim()) &&
          // badge lines (超清母带 VIP 试听 MV) clean to empty — never a title
          cleanSongTitle(t.text).length >= 1 &&
          Math.abs(t.y - dur.y) <= 30 &&
          t.x + t.w < dur.x, // strictly left of the duration
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!title) continue;
    // artist: nearest text under the title, same column, within 40px;
    // badge lines (超清母带 VIP 试听 MV) clean to empty and are skipped.
    const artist = words
      .filter(
        (a) =>
          a !== title &&
          !used.has(a) &&
          a.confidence >= 0.5 &&
          a.text.length >= 1 &&
          a.y > title.y &&
          a.y - title.y <= 40 &&
          Math.abs(cx(a) - cx(title)) <= 90 &&
          cleanSongTitle(a.text).length >= 1,
      )
      .sort((a, b) => Math.abs(a.y - title.y) - Math.abs(b.y - title.y))[0];
    const clean = cleanSongTitle(title.text);
    if (clean.length < 2) continue;
    // 已播过的不再作为候选 (类似腾讯已看过的片)
    if (opts.playedTitles.some((s) => titlesMatch(clean, s))) continue;
    used.add(title);
    if (artist) used.add(artist);
    out.push({
      title: clean,
      artist: artist ? cleanSongTitle(artist.text) : "",
      x: Math.round(cx(title)),
      y: Math.round(title.y + title.h / 2),
    });
  }
  const seenKey = new Set<string>();
  return out.filter((p) => {
    const k = p.title;
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });
}

export const MIN_CONFIDENCE = 0.5;

export interface NeteaseClickGuardOpts {
  x: number;
  y: number;
  verb: string;
  songs: SongCandidate[];
  homeLike: boolean;
  songList: boolean;
  playPage: boolean;
  bottomBar: { song: string; y: number } | null;
  pendingSong: string;
}

export interface NeteaseClickGuardResult {
  note: string;
  blocked?: string;
}

/** Click guard for the NetEase self-drawn UI:
 * - a song-title row in the list starts playback (the task's action) — free;
 * - the home page's 播放全部/歌单卡 are navigation, but clicking a song
 *   CARD on the home (每日推荐 card etc.) is how the agent enters the list,
 *   which is safe; however clicking the bottom bar controls (切歌/暂停/音质)
 *   touches the CURRENT playback and is never the task action — blocked;
 * - the top bar (search box / VIP / user) is off-task — soft hint. */
export function buildNeteaseClickGuard(opts: NeteaseClickGuardOpts): NeteaseClickGuardResult {
  const { x, y, verb, songs, bottomBar, pendingSong } = opts;
  const base: NeteaseClickGuardResult = { note: "" };
  if (y < 100 && x >= 200) {
    return {
      note: `\n（顶部 y<100 是搜索栏/VIP/用户区：点它会进入搜索或设置，与听歌任务无关。回列表挑歌名点击播放，不要点顶部。${verb} (${x}, ${y})）`,
    };
  }
  if (bottomBar && y >= bottomBar.y - 20) {
    return {
      note: `\n⚠️ ${verb} (${x}, ${y}) 落在底部播放栏（当前播放「${bottomBar.song}」）：播放栏的切歌/暂停/音质/歌词按钮操作的是当前播放，不是任务动作。回列表点歌名行播放。`,
    };
  }
  if (!songs.length) return base;
  const onSong = songs.find(
    (s) => Math.abs(x - s.x) <= 80 && Math.abs(y - s.y) <= 30,
  );
  if (onSong) {
    const playing = bottomBar && titlesMatch(onSong.title, bottomBar.song);
    const replay = pendingSong && titlesMatch(onSong.title, pendingSong);
    if (playing) {
      return {
        note: `\n（✅ 底栏正在播放「${onSong.title}」——播放证据成立。用 done 汇报，不要再点击）`,
      };
    }
    if (replay) {
      // Same song clicked again but the bottom bar never switched to it.
      // The 9/16 14:05 session showed this note wrongly claiming "播放已
      // 开始" while the bar still showed the old song, so the agent kept
      // re-clicking the same spot. With a visible mismatched bar, block
      // further repeats and steer to a different song.
      if (bottomBar) {
        return {
          note: "",
          blocked:
            `⛔ 你再次点击「${onSong.title}」但底栏歌名未变为它（当前仍在播「${bottomBar.song}」），播放未生效。` +
            `可能原因：①该曲需 VIP 会员（此前可能弹过付费窗）②单击未命中播放区。换列表里另一首歌点播，不要在同一位置反复点击。`,
        };
      }
      return {
        note: `\n（你再次点击「${onSong.title}」：底栏状态未知。先 ocr 确认底栏歌名是否已变为它——若已播放直接 done，若没变则换一首歌）`,
      };
    }
    return {
      note: `\n（将播放「${onSong.title}」${onSong.artist ? ` — ${onSong.artist}` : ""}：点击后底栏歌名应变为它，ocr 确认底栏歌名匹配后再 done）`,
    };
  }
  return base;
}
