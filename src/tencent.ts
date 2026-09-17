// Tencent-Video page / OCR heuristics — pure functions, no AX or UI
// dependencies. Extracted from the chat.ts ocr case so the page
// classification and rating-pairing rules accumulated over many sessions
// can be regression-tested (tests/tencent.test.mjs) without driving a
// real Tencent Video instance.
//
// Every rule here was learned from a real session; the session tag in
// each comment is the reference for why the rule exists.

import type { OcrScreenWord } from "./types.ts";

export const NAV_RE =
  /^(电影|电视剧|综艺|动漫|少儿|首页|片库|NBA|VIP会员|VIP|独播|返回|播放中|正在播放|立即播放|最热|最新|高分好评|免费|付费|资费|类型|全选|筛选|你正在追|腾讯视频)$/;
export const RATING_RE = /^(\d[.:]\d)(分)?$/;

/** Extract a rating from badge OCR text, tolerating noise prefixes like
 *  白9.3分 (the channel-home hero badge reads its star icon as 白/★).
 *  Loose matching is bounded by length so player timestamps
 *  (Q:9:99209 / 0:9899209 — 19:34 session) never qualify. Returns the
 *  bare "9.3" form or null. */
export function ratingText(text: string): string | null {
  // Badge with OCR noise prefix: 白9.3分 / 9.3分 / 9.3 (hero star icon → 白).
  // Bounded by length so player timestamps (Q:9:99209 / 0:9899209 — 19:34
  // session) never qualify.
  const m = text.match(/^\D*(\d[.:]\d)(分)?\D*$/);
  if (m && text.length <= 6) return m[1];
  // Long composite word: heat tag glued to the badge (三在追破200万白9.7分 —
  // 19:47 session). Only trusted when it ENDS in 分 (a real badge), so
  // timestamps / dates / IDs are still excluded.
  const m2 = text.match(/^.*?(\d[.:]\d)分$/);
  if (m2 && text.length <= 16) return m2[1];
  return null;
}
const TITLE_CHARS = /^[\u4e00-\u9fa5《》·•\s0-9A-Za-z]+$/;

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
  /** Personal-center / account page (账号设置/我的主页/积分/钻石 banner).
   * Its left nav has NO channel entries (电影/电视剧 …) — the model must
   * go back to 首页 first (22:41 session: Tencent opened on the "我的"
   * page, the model hunted for 电影, clicked guessed coordinates, and
   * burned 25 steps on an unchanged screen). */
  accountPage: boolean;
  /** Channel list page (has a back button, no decimal ratings). */
  listPage: boolean;
  /** Player page / mini-player marker (播放中/正在播放…). */
  playing: boolean;
}

/** Classify the current Tencent-Video screen from the OCR text. */
export function detectPage(joined: string): PageFlags {
  // 「已为您更新到最新内容」is a transient update toast that appears on
  // the channel home — its "最新" must not flip the page into a list page
  // (14:23 session: the toast let the 电影热播榜 channel-home hero card
  // through as a list page, and clicking the hero played an unverified
  // film). Strip it before classifying.
  const j = joined.replace(/已为您更新到最新内容/g, "");
  const watchedPage = /观看至\s*\d+\s*%|已看完|继续观看/.test(j);
  const detailPage = /简介[＞>〉]|选集|播放列表/.test(j);
  // 热播榜 appears only on channel feeds (the nav home shows 飙升总榜 /
  // 热搜总榜) — 17:07 session: the film-channel home (电影热播榜 + 9.3)
  // was misread as the nav home, its 9.3 candidate was suppressed and the
  // model was told "no candidates" with a 9.3 on screen.
  // But the NAV home ALSO carries 热播榜 in its top ticker strip
  // (「竖屏短剧热播榜第1名」@y≈137 — 17:57 session: the nav home was
  // misread as a channel home, the guard told the model "you are on the
  // channel home" while the 电影 nav clicks were not switching pages, and
  // the model burned 25 steps re-clicking the nav). A real channel-home
  // hero card sits in the content area (y≥250) and the page has no
  // 热搜总榜/飙升总榜 ticker.
  const hotWordsY = j
    .split("\n")
    .filter((l) => /热播榜/.test(l))
    .map((l) => {
      const m = l.match(/@\(\d+, (\d+)\)/);
      return m ? +m[1] : 0;
    });
  const channelHome =
    !/返回|最热|最新|高分好评|简介[＞>〉]|选集|播放列表|播放中|正在播放|热搜总榜|飙升总榜/.test(j) &&
    hotWordsY.some((y) => y >= 250);
  // Account / personal-center page: the top banner carries the user's
  // account info (账号设置 / 我的主页 / 积分 / 钻石). Its left nav has no
  // channel entries — classify it separately so the model isn't told to
  // click a 电影 nav item that does not exist there.
  const accountPage = /账号设置|我的主页|积分|钻石/.test(j);
  // Channel-list pages also carry the 你正在追 left-nav entry — a page
  // with ratings (9.2分) or a 立即播放 button is a film list, not the
  // home (22:52 session: the model clicked 极限审判's name on the film
  // channel and the home-guard blocked the correct click 3 times).
  const homeLike =
    !accountPage &&
    !/(返回|最热|最新|高分好评|类型|资费|地区|简介[＞>〉]|选集|播放列表|播放中|正在播放|播放[片日F！]|放中|热播榜|立即播放)/.test(
      j,
    ) &&
    !/\d+\.\d\s*分/.test(j) &&
    /你正在追/.test(j);
  const playing = /播放中|正在播放|播放[片日F！]|放中/.test(j);
  // Channel-list page: has a back button OR the filter/sort band
  // (高分/最新/推荐/类型/院线…). 17:06 session: the 高分-sorted film list
  // shows ratings (8.7/9.7) and the filter band but no back-button OCR
  // text — the old rule (back button AND no ratings) classified it as
  // unknown, so the click guard blocked every card click as a "home"
  // click and the task burned 25 steps. A list page is a list page even
  // when it shows ratings; the home page never carries the filter band.
  const listPage =
    !detailPage &&
    !playing &&
    (/〈返回|‹返回|←返回|<返回|›返回/.test(j) ||
      /高分|最热|最新|推荐|免费|即将上线|类型|院线|地区|年份|获奖佳片/.test(j));
  return { watchedPage, detailPage, channelHome, homeLike, accountPage, listPage, playing };
}

export const MIN_CONFIDENCE = 0.5; // word-confidence floor for ratings/titles
// List pages have two card layouts: rating directly under the title
// (dx≈0-100) and rating badge at the card's top-right with the title
// below it (dx≈260 on 高分-sorted lists, 17:06 session). A card-wide
// horizontal bound + a row bound (|dy| < one card height) pairs both
// layouts while keeping neighbouring cards out (16:51 mis-pairs).
export const PAIR_COL_DX = 100; // tight same-column bound (layout A)
export const PAIR_CARD_DX = 300; // card-wide horizontal bound (layout B)
export const PAIR_CARD_DY = 100; // same-card vertical bound (both layouts)
export const PAIR_MAX_D_LIST = 220; // pair distance budget on list pages
export const PAIR_MAX_D_DETAIL = 220; // detail page: title sits above rating (dx≈109)
export const MINI_STRIP_Y = 150; // top strip / mini-player band
export const MAX_PAIR_HINTS = 6; // candidate hints cap per OCR

export interface PairCandidate {
  title: string;
  score: string;
  x: number;
  y: number;
  /** True when score came from a detail-page verification, not the list
   * badge (badge OCR is unreliable — 16:51 session: badges paired as
   * 9.0/9.8/9.1 while the films are ~8.3). */
  verified?: boolean;
}

export interface ClickGuardOpts {
  x: number;
  y: number;
  /** "单击" | "双击" — used in the guard messages. */
  verb: string;
  pairs: PairCandidate[];
  miniPlayingTitle: string;
  /** Left-side channel nav (首页/电视剧/电影/…) with OCR coordinates.
   * Clicking one is the correct way into a channel, so the card-zone
   * block must let it through (14:23 session: on a secondary-screen
   * window the nav sits at x≈1750, far past the x≥300 threshold). */
  navItems: { title: string; x: number; y: number }[];
  lastOcrDetail: boolean;
  lastOcrList: boolean;
  lastOcrChannelHome: boolean;
  lastOcrPlayer: boolean;
}

export interface ClickGuardResult {
  /** Soft hint appended to the click result (may be empty). */
  note: string;
  /** Non-empty = hard block: the click must not fire. */
  blocked?: string;
  /** A sort/filter tab click: caller should arm the one-shot sort verify. */
  setSortVerify: boolean;
}

/** Click guard for Tencent-Video self-drawn UI. A card/poster click PLAYS
 * the film directly (no detail page), so a click that misses every paired
 * title — rating badge edge, actor row, poster border — opens a wrong or
 * sub-9 film (14:05 session: 坚如磐石 was played this way; the 8.7-
 * instead-of-9.1 bug). Pure so the guard itself is regression-tested
 * (it is the anti-misplay firewall, and was duplicated across click_at /
 * double_click_at with zero coverage). */
export function buildClickGuard(opts: ClickGuardOpts): ClickGuardResult {
  const { x, y, verb, pairs, miniPlayingTitle } = opts;
  const navItems = opts.navItems ?? [];
  const base: ClickGuardResult = { note: "", setSortVerify: false };
  // A click on a left-nav channel entry is always the right move — let it
  // through before the home/card-zone blocks (nav coordinates come from
  // the same OCR that classified the page, so window position is handled).
  const onNav = navItems.find(
    (n) => Math.abs(x - n.x) <= 80 && Math.abs(y - n.y) <= 30,
  );
  if (onNav) {
    return {
      note: `\n（点左侧导航「${onNav.title}」进入对应频道——这是进频道的正确路径）`,
      setSortVerify: false,
    };
  }
  if (!pairs.length) {
    if (opts.lastOcrList && y <= 280 && x >= 330) {
      // No rating pairs on screen (rating-less list): a click in the top
      // filter/sort band is probably a sort tab (the back button sits at
      // x≈320, so the band starts at 330). Sorting switches can be slow or
      // fail silently — arm verification.
      return {
        note:
          "\n（若点的是排序/筛选标签（最热/高分好评/类型等）：点击后用 ocr 确认顶部排序字样与列表内容已变化，切换/加载可能要 1-2s，必要时 wait_for；点击后 ocr 无变化说明没点中或该项已选中，不要原地重复点击）",
        setSortVerify: true,
      };
    }
    if (opts.lastOcrChannelHome && !opts.lastOcrDetail && !opts.lastOcrPlayer) {
      return {
        note:
          "\n⚠️ 当前是频道首页（热播榜大卡）：大卡评分真实（可作候选提示），但点大卡会【直接播放】未经复核的片。正确路径：① 若配对清单里有候选片名，点它的片名坐标进详情页，复核评分与题材后再点播放；② 若无候选或想浏览更多，向下滚动进入列表页（出现「最热/高分好评」筛选栏）再选片。不要在频道首页点非片名区域。",
        setSortVerify: false,
      };
    }
    if (!opts.lastOcrDetail && !opts.lastOcrPlayer && y < MINI_STRIP_Y && x >= 400) {
      return {
        note:
          "\n⚠️ 顶部 y<150 是热搜榜/片库/搜索条：点热搜条目会打开（可能直接播放）该片，与评分任务无关。回列表滚动读评分挑 ≥9 候选，不要点顶部条目。",
        setSortVerify: false,
      };
    }
    if (opts.lastOcrList && !opts.lastOcrDetail && !opts.lastOcrPlayer && y > 280 && x >= 300) {
      // Filtered list page whose ratings did not pair with titles this
      // frame (rating badge sits far right of the title on 高分-sorted
      // lists, dx≈260 > the 100px pair column). A card click here opens
      // the film's detail page where the model can verify the rating —
      // that is the task's intended flow, so warn instead of blocking.
      return {
        note:
          "\n（列表页但本屏无评分配对：可直接点卡片进详情页，用详情页评分复核是否 ≥9——评分以详情页为准；若想按片名精确定位，可滚动或点顶部排序刷新后再点）",
        setSortVerify: false,
      };
    }
    if (!opts.lastOcrList && !opts.lastOcrDetail && !opts.lastOcrPlayer && y > 280 && x >= 300) {
      // Nav-home / navigation page with NO rating pairs: the card area
      // plays arbitrary content on click (16:33 心动的信号9; 19:34 the
      // model clicked the card zone 3× after the warn-only hint). Warn was
      // not enough — refuse to fire, steer to the left nav instead.
      return {
        blocked:
          `⛔ 当前是首页/导航页（本屏无评分候选）：${verb} (${x}, ${y}) 落在推荐卡片区，点卡会直接播放无关内容（16:33 会话先点开了《心动的信号9》）。` +
          "不要点首页卡片。正确路径：点左侧导航「电影」（用最近 ocr 里它的实际坐标——窗口可能在副屏，参考 ocr 输出中「电影」项的坐标）进入频道列表，滚动读评分挑 ≥9 候选，进详情页复核评分与题材后再点播放。",
        note: "",
        setSortVerify: false,
      };
    }
    return base;
  }
  const onTitle = pairs.find(
    (p) => Math.abs(x - p.x) <= 60 && Math.abs(y - p.y) <= 40,
  );
  const nearest = pairs
    .map((p) => ({ p, d: Math.hypot(x - p.x, y - p.y) }))
    .sort((a, b) => a.d - b.d)[0];
  // The film is already playing in the top mini-strip (just opened it):
  // clicking again re-plays it — refuse to steer the model that way.
  if (onTitle && miniPlayingTitle && sharesBigram(onTitle.title, miniPlayingTitle)) {
    return {
      note: `\n（⚠️ 「${onTitle.title}」（评分 ${onTitle.score}）已在顶部小窗播放中——就是刚点开的那部，任务播放已开始。不要再点它/点它的卡片（会重新播放一遍）：按规则 ocr 确认播放器控件（选集/倍速/进度条/时间码）出现后 done 汇报）`,
      setSortVerify: false,
    };
  }
  if (onTitle && opts.lastOcrChannelHome && !opts.lastOcrDetail && !opts.lastOcrPlayer) {
    // Channel-home hero cards AUTO-ROTATE: the coordinates in `pairs` came
    // from the last ocr, but by click time the carousel has moved on — the
    // click lands on the NEXT card and plays it unverified (19:47 session:
    // clicking 吴樾包贝尔 9.0 @(362,493) actually played 飞驰人生 9.7).
    return {
      blocked:
        `⛔ 当前是频道首页（热播榜大卡，自动轮播）：「${onTitle.title}」（评分 ${onTitle.score}）的坐标来自上次 ocr，轮播后点击会落在另一张卡上并直接播放未复核的片（19:47 会话：点「吴樾包贝尔 9.0」实际播了《飞驰人生》）。` +
        "大卡评分仅作参考。正确路径：向下滚动进入列表页（出现「最热/高分好评」筛选栏）或点顶部「高分好评」排序，在列表页按配对坐标点片名，进详情页复核评分与题材后再点播放。",
      note: "",
      setSortVerify: false,
    };
  }
  if (onTitle) {
    return {
      note: `\n（将打开「${onTitle.title}」（评分 ${onTitle.score}）：进详情页后先 ocr 复核评分达标再点播放）`,
      setSortVerify: false,
    };
  }
  if (nearest && nearest.d < 180 && !opts.lastOcrDetail && y > 280) {
    // List page, click missed every paired title: the nearby poster would
    // open a wrong or sub-9 film. Refuse to fire.
    return {
      blocked: `⛔ ${verb} (${x}, ${y}) 被守卫拦截：它没落在任何评分候选的片名上（最近候选「${nearest.p.title}」评分 ${nearest.p.score} @(${nearest.p.x}, ${nearest.p.y})）。腾讯视频点卡片会直接开始播放，评分徽标/海报边缘/演员行会打开错误的片。先 ocr 刷新列表，确认目标片的片名与评分都在配对清单里，再点它的片名坐标；要切排序/筛选请点顶部标签（y≤280）。`,
      note: "",
      setSortVerify: false,
    };
  }
  if (nearest && nearest.d < 180) {
    return {
      note: `\n⚠️ ${verb}位置 (${x}, ${y}) 不在配对清单的任何片名上——评分徽标/海报边缘会错开到旁边影片。最近候选：「${nearest.p.title}」评分 ${nearest.p.score} 分，片名坐标 (${nearest.p.x}, ${nearest.p.y})。建议改点片名坐标。`,
      setSortVerify: false,
    };
  }
  return base;
}

/** Pair each high-confidence rating with the title text of the same
 * poster (nearest plausible Chinese text), so the model clicks the
 * TITLE's coordinates — clicking near the rating badge lands on the
 * neighbouring poster (the 8.7-film-instead-of-9.1 bug).
 *
 * Returns candidates only; the caller owns the module state (lastListPairs
 * / seenTitles). verifiedScores (title → score confirmed on a detail page)
 * OVERRIDE the badge value: a detail page is the only trustworthy rating
 * source, so a verified score wins even when the badge OCR disagrees. */
export function buildPairs(
  words: OcrScreenWord[],
  opts: { seenTitles: string[]; detailPage: boolean; verifiedScores?: Map<string, string> },
): PairCandidate[] {
  const cx = (w: OcrScreenWord) => w.x + w.w / 2;
  const seen = opts.seenTitles;
  const out: PairCandidate[] = [];
  for (const r of words) {
    const rScore = ratingText(r.text);
    if (!rScore || r.confidence < MIN_CONFIDENCE) continue;
    const title = words
      .filter(
        (t) =>
          t !== r &&
          ratingText(t.text) === null &&
          t.confidence >= MIN_CONFIDENCE &&
          t.text.length >= 2 &&
          TITLE_CHARS.test(t.text) &&
          !NAV_RE.test(t.text) &&
          !/月\d+日|定档|上映|巨制|打爆/.test(t.text) &&
          // Popularity badges (三在追破200万 / 预约破200万 / 实时热度超3万 /
          // 讨论破100万) are heat counters, not film titles — clicking one
          // does nothing and the model burns steps re-clicking it
          // (17:57 session: 「三在追破200万」 was paired with a 9.7 and the
          // click at its coords got no response).
          !/在追破|预约破|实时热度|热度超|讨论破|播放量|弹幕/.test(t.text) &&
          // Actor/genre rows read as "雷佳音 张国立 警匪打黑" —
          // space-separated multi-word lines are cast + genre, not a film
          // title (14:05 session: it was paired with a 9.4 rating that
          // belonged to the neighbouring film).
          !/\s/.test(t.text) &&
          // Episode/series labels (第二部/第3集) are episode chips, not
          // titles (14:05 session: 「第二部」 scored 9.4).
          !/^第[一二三四五六七八九十百\d]+[部集话期]/.test(t.text) &&
          // List pages have two card layouts, distinguished by where the
          // rating badge sits relative to the title:
          //  A) rating directly below the title (dx < 100, dy > 0) —
          //     columns ~200px apart, so a far dx at dy>0 is a NEIGHBOUR
          //     card's badge (16:51 session: 红海行动 '9.8' was an
          //     adjacent-card rating, the film is ~8.3);
          //  B) 高分-sorted lists: badge at the card top-right, title
          //     below it (dy < 0, dx up to ~300 — 17:06 session).
          // A rating ABOVE a title within card width is the same card;
          // a rating BELOW a title only pairs within the tight column.
          // Detail pages pair differently (title above rating, dx≈109).
          (opts.detailPage ||
            (Math.abs(t.y - r.y) < PAIR_CARD_DY &&
              (r.y - t.y < 0
                ? Math.abs(cx(t) - cx(r)) < PAIR_CARD_DX
                : Math.abs(cx(t) - cx(r)) < PAIR_COL_DX))),
      )
      .map((t) => ({
        t,
        d: Math.abs(cx(t) - cx(r)) * 0.6 + Math.abs(t.y - r.y),
      }))
      .sort((a, b) => a.d - b.d)[0];
    if (title && title.d < (opts.detailPage ? PAIR_MAX_D_DETAIL : PAIR_MAX_D_LIST)) {
      const t = title.t.text.trim();
      // The user already watched this film (mini-player resume, 你正在追
      // history): it must not be offered as the pick.
      if (seen.some((s) => sharesBigram(t, s))) continue;
      const verified = opts.verifiedScores?.get(t);
      out.push({
        title: t,
        score: verified ?? rScore,
        x: Math.round(title.t.x + title.t.w / 2),
        y: Math.round(title.t.y + title.t.h / 2),
        verified: verified !== undefined,
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
