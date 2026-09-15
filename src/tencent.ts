// Tencent-Video page / OCR heuristics — pure functions, no AX or UI
// dependencies. Extracted from the chat.ts ocr case so the page
// classification and rating-pairing rules accumulated over many sessions
// can be regression-tested (tests/tencent.test.mjs) without driving a
// real Tencent Video instance.
//
// Every rule here was learned from a real session; the session tag in
// each comment is the reference for why the rule exists.

import type { OcrScreenWord } from "./types";

export const NAV_RE =
  /^(电影|电视剧|综艺|动漫|少儿|首页|片库|NBA|VIP会员|VIP|独播|返回|播放中|正在播放|立即播放|最热|最新|高分好评|免费|付费|资费|类型|全选|筛选|你正在追|腾讯视频)$/;
export const RATING_RE = /^(\d[.:]\d)(分)?$/;
const TITLE_CHARS = /^[\u4e00-\u9fa5《》·\s0-9A-Za-z]+$/;

/** True when the two strings share any 2-char substring (used to match a
 * mini-player strip title against a list candidate, and to exclude films
 * the user already watched). */
export function sharesBigram(a: string, b: string): boolean {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < 2) return false;
  for (let i = 0; i + 2 <= short.length; i++) {
    if (long.includes(short.slice(i, i + 2))) return true;
  }
  return false;
}

/** Normalise a mini-player strip title: drop the play-state prefix
 * (II/I1/口), the 播放中/第N话 fragments and trailing version words
 * (国语/普通话/粤语/…), leaving the bare title for matching. */
export function parseMiniTitle(raw: string): string {
  return raw
    .replace(/^[I1口]{1,2}\s*/, "")
    .replace(/播放中|正在播放|播放[片日F！]|放中|第\d+[话集期][^，。\s（【]*/g, "")
    .replace(/^\s*口/, "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")
    .replace(/(国语|普通话|粤语|原声|普通|英文|双语|高清|蓝光|话版)+$/g, "")
    .trim();
}

export interface PageFlags {
  /** 你正在追 history page: cards carry viewing progress and clicking
   * resumes playback — its ratings are not a candidate pool. */
  watchedPage: boolean;
  /** Detail page markers (简介〉/选集/播放列表). */
  detailPage: boolean;
  /** Rated channel feed (电影热播榜第1名 + 9.3 badge): not the nav home. */
  channelHome: boolean;
  /** Nav home / navigation page (carries 你正在追, no list/detail/player
   * markers). Suppresses pairing — home cards play directly. */
  homeLike: boolean;
  /** Channel list page (has a back button, no decimal ratings). */
  listPage: boolean;
  /** Player page / mini-player marker (播放中/正在播放…). */
  playing: boolean;
}

/** Classify the current Tencent-Video screen from the OCR text. */
export function detectPage(joined: string): PageFlags {
  const watchedPage = /观看至\s*\d+\s*%|已看完|继续观看/.test(joined);
  const detailPage = /简介[＞>〉]|选集|播放列表/.test(joined);
  // 热播榜 appears only on channel feeds (the nav home shows 飙升总榜 /
  // 热搜总榜) — 17:07 session: the film-channel home (电影热播榜 + 9.3)
  // was misread as the nav home, its 9.3 candidate was suppressed and the
  // model was told "no candidates" with a 9.3 on screen.
  const channelHome =
    !/返回|最热|最新|高分好评|简介[＞>〉]|选集|播放列表|播放中|正在播放/.test(joined) &&
    /热播榜/.test(joined);
  const homeLike =
    !/(返回|最热|最新|高分好评|类型|资费|地区|简介[＞>〉]|选集|播放列表|播放中|正在播放|播放[片日F！]|放中|热播榜)/.test(
      joined,
    ) && /你正在追/.test(joined);
  const playing = /播放中|正在播放|播放[片日F！]|放中/.test(joined);
  const listPage =
    /〈返回|‹返回|←返回|<返回|›返回/.test(joined) &&
    !/\d+\.\d/.test(joined) &&
    !playing;
  return { watchedPage, detailPage, channelHome, homeLike, listPage, playing };
}

export interface PairCandidate {
  title: string;
  score: string;
  x: number;
  y: number;
}

/** Pair each high-confidence rating with the title text of the same
 * poster (nearest plausible Chinese text), so the model clicks the
 * TITLE's coordinates — clicking near the rating badge lands on the
 * neighbouring poster (the 8.7-film-instead-of-9.1 bug).
 *
 * Returns candidates only; the caller owns the module state (lastListPairs
 * / seenTitles). */
export function buildPairs(
  words: OcrScreenWord[],
  opts: { seenTitles: string[]; detailPage: boolean },
): PairCandidate[] {
  const cx = (w: OcrScreenWord) => w.x + w.w / 2;
  const seen = opts.seenTitles;
  const out: PairCandidate[] = [];
  for (const r of words) {
    if (!RATING_RE.test(r.text) || r.confidence < 0.5) continue;
    const title = words
      .filter(
        (t) =>
          t !== r &&
          !RATING_RE.test(t.text) &&
          t.confidence >= 0.5 &&
          t.text.length >= 2 &&
          TITLE_CHARS.test(t.text) &&
          !NAV_RE.test(t.text) &&
          !/月\d+日|定档|上映|巨制|打爆/.test(t.text) &&
          // Actor/genre rows read as "雷佳音 张国立 警匪打黑" —
          // space-separated multi-word lines are cast + genre, not a film
          // title (14:05 session: it was paired with a 9.4 rating that
          // belonged to the neighbouring film).
          !/\s/.test(t.text) &&
          // Episode/series labels (第二部/第3集) are episode chips, not
          // titles (14:05 session: 「第二部」 scored 9.4).
          !/^第[一二三四五六七八九十百\d]+[部集话期]/.test(t.text) &&
          // List pages: rating badges sit directly below their own card's
          // title (dx < 100; columns ~200px apart), so a title paired with
          // a NEIGHBOURING card's rating is a mis-pair (16:51 session:
          // 我看见两朵一样的云 9.0 / 红海行动 9.8 / 等风来 9.1 were all
          // adjacent-card ratings; the films are ~8.3). Detail pages pair
          // differently (title above rating, dx≈109).
          (opts.detailPage || Math.abs(cx(t) - cx(r)) < 100),
      )
      .map((t) => ({
        t,
        d: Math.abs(cx(t) - cx(r)) * 0.6 + Math.abs(t.y - r.y),
      }))
      .sort((a, b) => a.d - b.d)[0];
    if (title && title.d < (opts.detailPage ? 220 : 150)) {
      const t = title.t.text.trim();
      // The user already watched this film (mini-player resume, 你正在追
      // history): it must not be offered as the pick.
      if (seen.some((s) => sharesBigram(t, s))) continue;
      out.push({
        title: t,
        score: r.text.replace("分", ""),
        x: Math.round(title.t.x + title.t.w / 2),
        y: Math.round(title.t.y + title.t.h / 2),
      });
    }
  }
  // Dedup by title+score (two ratings can resolve to the same title).
  const seenKey = new Set<string>();
  return out.filter((p) => {
    const k = `${p.title}\u0000${p.score}`;
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });
}
