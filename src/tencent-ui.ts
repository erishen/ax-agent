// TencentUiState — the Tencent-Video decision state machine.
//
// chat.ts grew to 2451 lines with ~20 module-level flags (lastListPairs /
// lastOcrDetail / miniPlayingTitle / seenTitles / pendingSortVerify /
// recentScrolls / qualityStreak…) shared across the ocr / click_at /
// double_click_at / scroll / element_at / open_app cases and the runSteps
// blind-click guard. This class bundles that state and the decisions built
// on it, so:
//   - every flag's lifecycle is explicit (resetForOpenApp, processOcr),
//   - the ocr hint assembly (11 hints) is testable in isolation,
//   - chat.ts's runTool switch becomes a thin caller.
//
// Behaviour is byte-identical to the old inline code; the regression tests
// (tencent/guard) plus the new tencent-ui tests are the safety net.
import type { OcrScreenWord } from "./types.ts";
import {
  MAX_PAIR_HINTS,
  MIN_CONFIDENCE,
  MINI_STRIP_Y,
  NAV_RE,
  ratingText,
  buildClickGuard,
  buildPairs,
  detectPage,
  parseMiniTitle,
  sharesBigram,
  type PairCandidate,
} from "./tencent.ts";

const SEEN_KEY = "axAgent.seenTitles.v1";

/** Tools that observe the UI (reset the "no-observation run"). */
const OBSERVE_TOOLS = new Set(["ocr", "wait_for", "read_screen", "element_at", "screen_info"]);

type RecentMove =
  | { kind: "observe" | "scroll" | "other" }
  | { kind: "click"; x: number; y: number };

export interface OcrReport {
  /** The formatted OCR dump (sorted, truncated, confidence-annotated). */
  joined: string;
  /** Everything appended after the dump: pairs block + the 11 hints. */
  hints: string;
}

export class TencentUiState {
  /** Recent scrolls, for the bounce detector (same spot scrolled up then
   * down is a no-op that burns steps). */
  recentScrolls: { x: number; y: number; sign: number }[] = [];

  /** Recent executed tools, for the blind-click guard. Observation tools
   * (ocr/wait_for/…) and scrolls reset the "no-observation run": a
   * legitimate click → observe → click cadence never trips it, while
   * click → click → click with zero verification does (self-drawn UIs
   * show nothing unless read). */
  recentMoves: RecentMove[] = [];

  /** Consecutive element_at -25208 failures (self-drawn app). After two
   * strikes the app is confirmed to have no accessibility API — keep
   * telling the model to stop calling element_at/read_screen instead of
   * burning steps. Reset on open_app so switching to a real AX app
   * clears the flag. */
  elementAtFails = 0;

  /** Title↔rating pairs from the most recent OCR on a list/channel page,
   * with the title's center coordinates. Filled by processOcr, consumed
   * by clickGuard: clicking the rating badge or poster edge lands on the
   * neighbouring film (the 8.7-instead-of-9.1 bug), so a click that
   * misses every paired title gets a corrective hint before it fires. */
  lastListPairs: PairCandidate[] = [];

  /** List-page OCRs in a row without a high-confidence rating digit. The
   * model tends to keep scrolling a 「最热/最新」-sorted list looking for
   * rating badges that the sort simply does not show; after two scrolls
   * the listHint escalates from "scroll more" to "switch to 高分好评 or
   * open a detail". */
  scrollsSinceRating = 0;

  /** Whether the most recent OCR was a list/channel page (has a back
   * marker, no rating digits). Gates the sort-tab click hint so the home
   * page top area does not get flagged as a filter bar. */
  lastOcrList = false;
  /** Whether the most recent ocr saw a detail page (简介/选集/播放列表).
   * List-page clicks near a rating candidate are intercepted (a Tencent
   * card click PLAYS the film directly, and clicking near the badge
   * opens the neighbouring poster — 14:05 session: opened sub-9 坚如磐石);
   * detail-page clicks (选集/立即播放) must stay free. */
  lastOcrDetail = false;
  /** Whether the most recent ocr showed a playing player (播放中/time
   * codes). Home-page clicks near nothing rated are soft-flagged, but
   * player-page clicks (pause/controls) must stay free. */
  lastOcrPlayer = false;

  /** Set when a click lands in the top filter/sort band of a rating-less
   * list: sort switches can be slow or fail silently, and the model tends
   * to scroll or click again right after tapping 高分好评 without verifying
   * (13:35 session). The next non-ocr action gets a reminder to verify
   * with an ocr first; the flag is consumed by the reminder and cleared
   * by any ocr. */
  pendingSortVerify = false;

  /** Titles the user has already watched — observed from the top
   * mini-player (the app auto-resumes a previously closed video, e.g.
   * 「播放中 扒特务」= 抓特务) and from the 你正在追 history page.
   * Recommending a film the user has finished defeats the task, so paired
   * candidates that overlap a seen title are suppressed. Kept across
   * open_app: watched films stay watched. */
  seenTitles: string[] = loadSeenTitles();

  /** Quality-note gating: loading/animation frames flash low-confidence
   * words on EVERY OCR, so the note would spam itself. Only after TWO
   * consecutive low-quality reads, and at most once per 3 OCRs. */
  qualityStreak = 0;
  ocrSinceQualityNote = 0;

  /** Film the model itself just opened and the mini-player is now playing
   * (matched against the rating candidates in the same OCR). Clicking a
   * Tencent card starts playback directly, so a second click on the same
   * title re-plays it (13:55 session: 捕风追影 played twice). Updated by
   * every ocr; non-empty means "do not click this film again". */
  miniPlayingTitle = "";

  lastOcrChannelHome = false;

  /** Left-side nav items (首页/你正在追/电视剧/电影/…) with their OCR
   * coordinates, refilled by every processOcr. Clicking a nav item is the
   * correct way into a channel — the click guard must let it through even
   * on home pages (14:23 session: on a secondary-screen window the nav
   * sits at x≈1750, far past the guard's x≥300 card-zone threshold, so a
   * correct 电影 click was blocked as a "card-area" click). */
  lastNavItems: { title: string; x: number; y: number }[] = [];

  /** Detail-page verified ratings (title → score): the only trustworthy
   * rating source. Overrides unreliable list badges when pairing (16:51
   * session: badges paired as 9.0/9.8/9.1 while the films are ~8.3). */
  detailVerifiedScores = new Map<string, string>();

  /** open_app resets the per-app decision state (a new target app has no
   * stale page flags). seenTitles intentionally survives — watched films
   * stay watched. */
  resetForOpenApp(): void {
    this.elementAtFails = 0; // new target app → re-arm element_at probes
    this.lastListPairs = []; // stale rating pairs from the previous app
    this.scrollsSinceRating = 0;
    this.lastOcrList = false;
    this.lastOcrDetail = false;
    this.lastOcrPlayer = false;
    this.pendingSortVerify = false;
    this.miniPlayingTitle = "";
    this.lastOcrChannelHome = false;
    this.detailVerifiedScores = new Map<string, string>();
  }

  /** One-shot reminder consumed by the next non-ocr action (scroll/click/
   * key): "you just tapped a sort tab, verify it took effect before acting
   * again". Returns "" when nothing is pending. */
  sortVerifyReminder(): string {
    if (!this.pendingSortVerify) return "";
    this.pendingSortVerify = false;
    return "\n（⚠️ 你刚点击了排序/筛选标签但还没用 ocr 验证切换是否生效——先 ocr 看顶部排序字样（最热/高分好评）与列表内容是否已变化再继续，不要盲目点击/滚动）";
  }

  /** Persist across sessions: the user's watched films stay watched even
   * after the app restarts (TaUI webview keeps localStorage). */
  rememberSeen(title: string): void {
    if (!this.seenTitles.includes(title)) {
      this.seenTitles.push(title);
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(this.seenTitles));
      } catch {
        /* storage full / unavailable — in-memory is still fine */
      }
    }
  }

  /** The whole Tencent-Video OCR decision: classify the page, update the
   * flags, pair ratings→titles, assemble the 11 hints, and mutate state
   * (seen titles, verified scores, mini-playing title, quality gating,
   * scrollsSinceRating). Pure in the sense that `words` fully determines
   * the output + state delta — testable with session word-lists. */
  processOcr(words: OcrScreenWord[]): OcrReport {
    // An ocr is exactly the verification a sort-tab click needs; any
    // pending "verify the sort" reminder is satisfied here.
    this.pendingSortVerify = false;
    const joined = words
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, 60)
      .map(
        (w) =>
          `「${w.text}」${w.w > 0 ? ` (${Math.round(w.w)}×${Math.round(w.h)})` : ""} @(${Math.round(w.x)}, ${Math.round(w.y)})` +
          (w.confidence < 0.5 ? ` 置信${(w.confidence * 100).toFixed(0)}%` : ""),
      )
      .join("\n");
    const rating = words.find(
      (w) => ratingText(w.text) !== null && w.confidence >= MIN_CONFIDENCE,
    );
    // Page classification lives in src/tencent.ts (pure, regression-
    // tested) — see detectPage for the per-session rule provenance.
    const flags = detectPage(joined);
    const { watchedPage, detailPage, channelHome, homeLike, playing, listPage } = flags;
    this.lastOcrDetail = detailPage;
    this.lastOcrPlayer = playing;
    this.lastOcrChannelHome = channelHome;
    this.lastOcrList = listPage;
    // Refill left-nav coordinates (nav words share a tight x cluster at
    // the window's left edge). The top bar (片库/腾讯视频) and VIP badge
    // are not channel entries; everything else in the column is.
    const navWords = words
      .filter(
        (w) =>
          w.confidence >= 0.3 &&
          NAV_RE.test(w.text) &&
          !/^(片库|腾讯视频|VIP会员|VIP)$/.test(w.text) &&
          w.y > 140 &&
          w.y < 760,
      )
      .sort((a, b) => a.x - b.x);
    let navCluster: OcrScreenWord[] = [];
    let best: OcrScreenWord[] = [];
    for (const w of navWords) {
      if (!navCluster.length || w.x - navCluster[navCluster.length - 1].x <= 90) {
        navCluster.push(w);
      } else {
        if (navCluster.length > best.length) best = navCluster;
        navCluster = [w];
      }
    }
    if (navCluster.length > best.length) best = navCluster;
    this.lastNavItems = best.map((w) => ({
      title: w.text,
      x: Math.round(w.x + w.w / 2),
      y: Math.round(w.y + w.h / 2),
    }));
    let pairs: string[] = [];
    // A detail page is the one trustworthy rating source: capture the
    // verified (title → score) so list badges can be overridden when
    // the model returns to the list (16:51: badges lied).
    if (detailPage && rating) {
      const dt = words.find((w) => /简介[＞>〉]/.test(w.text));
      if (dt) {
        const name = parseMiniTitle(dt.text.replace(/[^，。\s]*简介[＞>〉].*$/, ""));
        if (name.length >= 2) {
          this.detailVerifiedScores.set(name, rating.text.replace("分", ""));
        }
      }
    }
    // Channel-home hero cards (热播榜大卡) rotate and PLAY on click —
    // pairing them would invite a click that plays an unverified film
    // (14:23 session: 庇护之地 9.7 hero card clicked → played whatever
    // card was under the cursor). Hero scores stay visible in hints as
    // references only; pairs come from list pages and details.
    this.lastListPairs =
      rating && !watchedPage && !homeLike && !channelHome
        ? buildPairs(words, { seenTitles: this.seenTitles, detailPage, verifiedScores: this.detailVerifiedScores })
        : [];
    for (const p of this.lastListPairs) {
      pairs.push(
        `「${p.title}」评分 ${p.score} 分${p.verified ? "（详情页已复核）" : ""} → 点片名坐标 (${p.x}, ${p.y})`,
      );
    }
    pairs = [...new Set(pairs)].slice(0, MAX_PAIR_HINTS);
    // Tell the model why a rated card may be missing from the pairs —
    // it is a watched film, not an OCR miss.
    const seenOnScreen = this.seenTitles.filter((s) =>
      words.some((w) => w.text.length >= 2 && sharesBigram(w.text, s)),
    );
    const seenHint = seenOnScreen.length
      ? `\n（已从候选配对中排除你看过的片：${[...new Set(seenOnScreen)].join("、")}——它们不会作为推荐候选；列表里它们的评分/海报可以忽略）`
      : "";
    // Playback evidence must be scoped. 「播放中」appears in two very
    // different places:
    //  1) a player page — real task evidence → done;
    //  2) the top banner strip on the home/channel page. Closing the
    //     「继续播放」toast makes Tencent Video auto-resume one of the
    //     previously closed videos, so the banner shows 「播放中 第N集」
    //     even though the model clicked nothing. Treating that as task
    //     evidence would finish on the wrong video.
    const playerEvidence = /简介|评分|播放第|选集|倍速|杜比|语言|\d{1,2}:\d{2}/.test(joined);
    // Try to name the banner: the title word on the same row, within a
    // moderate distance right/left of the 播放中 marker.
    const pw = playing ? words.find((w) => /播放中|正在播放|播放[片日F！]|放中/.test(w.text)) : undefined;
    let playingTitle = "";
    if (pw) {
      const near = words
        .filter(
          (w) =>
            w !== pw &&
            Math.abs(w.y - pw.y) <= 24 &&
            Math.abs(w.x + w.w / 2 - (pw.x + pw.w / 2)) <= 420 &&
            w.text.length >= 2 &&
            !/播放中|正在播放|第\d+[集话]|^\d+$/.test(w.text),
        )
        .sort(
          (a, b) =>
            Math.abs(a.x + a.w / 2 - (pw.x + pw.w / 2)) -
            Math.abs(b.x + b.w / 2 - (pw.x + pw.w / 2)),
        )[0];
      if (near) playingTitle = `「${near.text}」`;
    }
    // Quality hint: many low-confidence / garbled words usually mean the
    // page is mid-transition (loading, animation, overlay) — telling the
    // model to re-scan after a beat instead of trusting the noise.
    // Gated: two CONSECUTIVE low-quality reads, then at most once per 3
    // OCRs — a loading frame alone would otherwise spam every read.
    const lowConf = words.filter((w) => w.confidence < MIN_CONFIDENCE).length;
    const lowConfRatio = words.length > 3 && (lowConf / words.length > 0.5 || lowConf >= 10);
    this.ocrSinceQualityNote += 1;
    let qualityNote = "";
    if (lowConfRatio) {
      this.qualityStreak += 1;
      if (this.qualityStreak >= 2 && this.ocrSinceQualityNote >= 3) {
        qualityNote = "\n⚠️ 识别质量差（大量低置信/乱码词）：页面可能在加载、有动画或遮罩层。建议 wait_for 1-2s 后再 ocr，或滚动到稳定画面；若连续多次乱码，检查窗口是否被遮挡/未最大化（move_window maximize）或目标应用是否在前台。";
        this.ocrSinceQualityNote = 0;
      }
    } else {
      this.qualityStreak = 0;
    }
    // Detail-page play guidance: self-drawn players (Tencent Video etc.)
    // render the play control as an unlabeled image button the OCR can't
    // name — tell the model where to look / how to fall back to keyboard.
    // 「立即播放」is NOT a detail marker: the resume toast on the home
    // page shows it too, which would mis-fire this hint. Gate the
    // coordinate on detail-like content; OCR renders detail ratings as
    // 「9.0分」, not the literal 「评分」.
    const detailLike = /简介|评分|播放第|第\d+集|\d\.\d分/.test(joined);
    const playBtn = detailLike ? words.find((w) => /立即播放/.test(w.text)) : undefined;
    const inDetail = !playing && detailLike;
    const playHint = playBtn
      ? `\n（详情页「立即播放」按钮在 (${Math.round(playBtn.x + playBtn.w / 2)}, ${Math.round(playBtn.y + playBtn.h / 2)})：评分达标就点它开始播放，随后 ocr 确认播放器控件（选集/倍速/进度条/时间码）出现再 done）`
      : inDetail
        ? "\n（详情页播放按钮多为无文字的绿色大按钮，位于片名/简介行的下方或右侧；OCR 识别不到按钮文字时，可先按空格键尝试播放，或对按钮区域再 ocr 一次）"
        : "";
    // Resume-dialog hint: Tencent Video opens a "继续播放之前关闭的 N 个视频"
    // toast over the home page. Clicking home cards underneath (stale
    // resume items) either starts playing something the user had closed or
    // does nothing — close the toast first at the OCR coordinates.
    const resume = /继续播放之前关闭的\s*\d+\s*个视频/.test(joined);
    const dialogHint = resume
      ? "\n（检测到「继续播放」弹窗：先点击 OCR 中「关闭」或「立即播放」的坐标处理掉它，再操作首页其他内容——直接点首页卡片可能误播你之前关闭的视频。注意：点「关闭」后顶部若出现「播放中」小窗，那是应用自动恢复播放之前关闭的视频，不是你的点击所致，与任务无关可忽略或按空格暂停）"
      : "";
    // 「你正在追」history page guard: clicking a card resume-plays it
    // (no detail page, no rating re-check) and its scores are for films
    // the user already watched — not the high-score candidate pool.
    const watchedHint = watchedPage
      ? "\n（检测到「你正在追/历史观看」页（观看至N%/已看完标签）：这些是你追过的剧，评分不代表高分新片池，点击卡片会【直接续播】而不会打开详情页。任务要挑高分电影：回到「电影」频道列表页并切「高分好评」排序（或点开候选片详情页复核），不要在本页点卡片播放）"
      : "";
    // Detail-page rating guard: a detail page carries 简介/选集/播放列表
    // markers that never appear on list/home pages. If its rating is
    // below the 9.0 bar, say so loudly — the agent otherwise keeps
    // fiddling with a film it must not play (13:22 session: opened the
    // wrong 8.1 detail after a stale-coordinate click and never noticed).
    const ratingNum = rating ? parseFloat(rating.text) : NaN;
    const ratingGuard =
      detailPage && rating && !Number.isNaN(ratingNum) && ratingNum < 9
        ? `\n（当前详情页评分 ${rating.text.replace("分", "")} 分 < 9，【不达标】：不要点播放/立即播放。按 esc 返回列表（返回后 ocr 确认回到列表），重新挑选评分 ≥9 的候选片；本页的推荐/选集/播放列表都是这个低分片的周边内容，不要继续操作）`
        : "";
    // A detail page for a film the user already watched (mini-player
    // resume / 你正在追): even at 9+, it is not a valid recommendation.
    const seenOnDetail = detailPage
      ? this.seenTitles.find((s) => words.some((w) => w.text.length >= 2 && sharesBigram(w.text, s)))
      : undefined;
    const seenDetailHint = seenOnDetail
      ? `\n（⚠️ 当前详情页这部片（${seenOnDetail}）是你之前看过的：不要把它作为任务推荐片。即使评分 ≥9 也不要点播放——按 esc 返回列表，换一部没看过的片）`
      : "";
    // Channel home / list hero cards also show rating + 立即播放, but
    // they are NOT a detail page and the hero card auto-rotates — the
    // button belongs to whichever card is shown at click time (13:28
    // session: clicked 出入平安 9.3's button, the card rotated and a
    // different film opened). Warn neutrally when a rated 立即播放 has
    // no detail-page markers around it.
    const heroCard =
      playBtn !== undefined && !detailPage && /\d\.\d分/.test(joined);
    const heroHint = heroCard
      ? "\n（注意：带评分的「立即播放」旁没有详情页特征（简介/选集/播放列表）——当前是频道首页/列表大卡片而非详情页。首页大卡片会自动轮播，点「立即播放」前先确认当前展示卡片的片名与评分确实对应，评分达标再点，否则可能打开轮播到的别的片）"
      : "";
    // Channel home (热播榜大卡): the hero cards rotate and PLAY on click
    // (14:23 session: 庇护之地 9.7 hero was clicked and played whatever
    // card was under the cursor). Tell the model to scroll into the list
    // page instead of clicking the heroes.
    const channelHomeHint = channelHome
      ? "\n（当前是频道首页（热播榜大卡）：大卡评分仅作参考，大卡会自动轮播且点卡直接播放——不要点大卡。向下滚动进入列表页（出现「最热/高分好评」筛选栏）再按评分配对选片，或点顶部「高分好评」排序）"
      : "";
    // 「播放中」position decides what it means. In the top strip
    // (y<140, Tencent's mini-player / resume banner) it is the app
    // auto-resuming a previously closed video — NOT evidence the task
    // film is playing, even when a rated detail page is on screen.
    // Only a 播放中 marker in the page body counts as playback proof.
    // The strip's state word OCRs as noise (播放片/播放F/播放日/放中),
    // so any 第N话/集 marker at y<140 flags the mini-player too, even
    // without a readable 「播放中」.
    const topEpi = words.find((w) => w.y < MINI_STRIP_Y && /第\d+[话集]/.test(w.text));
    // The strip's play glyph OCRs as II/I1/口 followed by the film title
    // with no readable state word at all (13:28 session: 「II •E让眼泪
    // 变珍王」= a resumed 心动的信号). Any such marker at y<140 is the
    // mini-player, even without 播放中 or 第N话.
    const topPlayer = words.find(
      (w) => w.y < MINI_STRIP_Y && /^(II|I1|口)[^，。]{2,}/.test(w.text),
    );
    const miniPlayer =
      topEpi !== undefined || topPlayer !== undefined || (pw !== undefined && pw.y < MINI_STRIP_Y);
    // The resumed mini-player is a film the user recently watched — keep
    // its title so the pairing / detail guards never offer it again
    // (13:47 session: 「II 口播放中 扒特务」= 抓特务, yet the model kept
    // trying to open it from the list).
    const miniWord = topPlayer ?? pw ?? topEpi;
    // The mini-player is either the app auto-resuming a previously
    // closed video (a film the user already watched) OR the task film
    // the model just opened — clicking a Tencent card directly starts
    // playback (13:55 session: tapping 捕风追影 played it, yet the
    // model thought nothing had started and clicked it again, playing
    // it a second time). Decide by matching the strip's title against
    // the current rating candidates: a match means the task film is
    // already playing (playback evidence, NOT a watched film); no
    // match means an auto-resumed old film (watched, exclude it).
    let miniSeenTitle = "";
    let miniPlaying = "";
    if (miniWord) {
      const raw = parseMiniTitle(miniWord.text);
      if (raw.length >= 2) {
        const isTaskFilm = this.lastListPairs.some((p) => sharesBigram(p.title, raw));
        if (isTaskFilm) {
          // The strip is playing a candidate the model just clicked:
          // that IS the task playback. Remember it so repeat clicks on
          // the same film are blocked.
          miniPlaying = raw;
          this.miniPlayingTitle = raw;
          this.rememberSeen(raw);
        } else {
          miniSeenTitle = raw;
          this.miniPlayingTitle = "";
          this.rememberSeen(raw);
        }
      } else {
        this.miniPlayingTitle = "";
      }
    }
    const miniHint = miniPlaying
      ? `\n（顶部小窗正在播放「${miniPlaying}」——这就是你刚点开的候选片，任务播放【已开始】：按规则确认播放器控件（选集/倍速/进度条/时间码）出现后 done 汇报，【不要再点击它】——重复点击卡片会把它重新播放一遍（13:55 会话把同一部片播放了两遍）。注意：它的评分来自列表徽标配对，【未经详情页复核】——如果用户指出分数不对（如实际只有 8.x），说明配对评分错了（评分徽标错配到相邻卡片），此片不达标：不要 done，按 esc 返回列表重新 ocr 挑片）`
      : `\n（顶部出现「播放中」小窗${playingTitle}：这是应用自动恢复之前视频的迷你播放器，【不是】本次任务播放成功的证据——即使屏幕上有评分/简介的详情页也一样。继续任务：详情页评分达标后点「立即播放」（ocr 有坐标），确认播放器控件（选集/倍速/进度条/时间码）出现才算完成${miniSeenTitle ? `。另外：小窗里这部（${miniSeenTitle}）是你之前看过的片，任务推荐应排除它——不要在列表里再找它/点它` : ""}）`;
    const playingHint = miniPlayer
      ? miniHint
      : playing
        ? playerEvidence
          ? `\n（检测到「播放中」标记：${playingTitle}视频已在播放页播放，按规则立即 done 汇报，不要再点击）`
          : `\n（检测到「播放中」标记${playingTitle}但缺少播放器证据：先确认是否真在播放（时间码/选集/倍速控件），若只是页面残留标记则继续任务）`
        : "";
    // List/channel page without any rating digits: the model tends to
    // re-click filter tabs (already selected) instead of scrolling to
    // read the per-card ratings. Guide it to scroll / open a detail.
    // Recognize the current sort from the channel header, e.g.
    // 「电影 •最热 •院线电影」/「电影•高分好评•全部电影」. The model
    // keeps scrolling a 最热 list hunting for badges the sort does not
    // show, unaware which sort it is on (13:35 session kept scrolling
    // while the header still said 最热 after tapping 高分好评).
    const sortLabel =
      joined.match(/电影\s*[•·]\s*(最热|最新|高分好评)/)?.[1] ??
      joined.match(/(最热|最新|高分好评)\s*[•·]\s*(院线电影|全部电影|电影)/)?.[1] ??
      null;
    // Track consecutive rating-less list OCRs so the hint can escalate
    // from "scroll another screen" to "switch sort / open a detail".
    if (rating) {
      this.scrollsSinceRating = 0;
    } else if (listPage) {
      this.scrollsSinceRating += 1;
    }
    const listHint = listPage
      ? sortLabel === "高分好评"
        ? "\n（当前已切到「高分好评」排序：卡片按评分排列，直接读本屏各卡片评分挑 ≥9 的候选；若本屏评分都 <9 再滚动换屏，不要再切回其他排序）"
        : sortLabel === "最热" || sortLabel === "最新"
          ? `\n（当前是「${sortLabel}」排序（如「电影•最热•院线电影」）：该排序下评分参差，部分卡片不显示评分徽标，继续滚动也读不到分。任务要求 ≥9 的高分片：点顶部「高分好评」标签切换（ocr 中有其坐标），或点开候选片详情页用详情页评分筛选；不要在同一列表里反复滚动）`
          : this.scrollsSinceRating >= 2
            ? `\n（已连续 ${this.scrollsSinceRating} 次列表页未见评分数字：当前多半是「最热/最新」排序，卡片不显示评分徽标，继续滚动也读不到分。改切「高分好评」排序（ocr 顶部筛选栏该标签坐标），或直接点开候选片详情页用详情页评分筛选；不要继续在同一列表里盲目滚动）`
            : "\n（当前在列表/频道页且本屏未见评分数字：评分通常显示在卡片下方（如 9.8）。滚动逐屏读取评分挑选高分片；评分不在本屏就再滚一屏，或点开卡片详情页复核。列表出现后不要再反复点击筛选标签，直接滚动读评分）"
      : "";
    // Home/navigation page with no list/detail/player markers. The model
    // tends to click whatever card catches its eye (你正在追 / hot-list
    // / recommendations), and Tencent cards PLAY directly on click —
    // that is how the 16:33 session opened 心动的信号9 before ever
    // entering the film channel, and how the 16:43 session (after the
    // window move reset Tencent to home) scrolled the rated home feed
    // hunting for 马腾你别走 9.7. Steer it to the 电影 channel instead.
    const homeHint = homeLike
      ? "\n（当前是首页/导航页——【不是电影频道列表】：即使本屏带评分卡（如 9.7 推荐位），首页卡片点卡会【直接播放】无关内容，评分也不代表频道候选池；窗口移动/最大化会让腾讯视频重置回首页。请点左侧导航「电影」重新进入频道列表（窗口可能在副屏——用最近 ocr 输出中「电影」项的实际坐标，别用主屏坐标），在频道页滚动读取各片评分挑 ≥9 候选，再点片名坐标进详情页复核——不要在首页点卡片/滚动找片）"
      : "";
    const hints =
      (pairs.length ? `\n\n【评分-片名配对】（点片名坐标打开详情，不会错位）：\n${pairs.join("\n")}` : "") +
      playingHint +
      playHint +
      dialogHint +
      watchedHint +
      ratingGuard +
      seenDetailHint +
      heroHint +
      channelHomeHint +
      listHint +
      homeHint +
      seenHint +
      qualityNote;
    return { joined, hints };
  }

  /** Click guard: arms pendingSortVerify on sort-tab clicks, hard-blocks
   * mis-aimed list clicks, and soft-hints everything in between. Pure
   * logic lives in buildClickGuard (regression-tested); this method just
   * wires the state through and arms the sort verify. */
  clickGuard(x: number, y: number, verb: string): { note: string; blocked?: string } {
    const guard = buildClickGuard({
      x,
      y,
      verb,
      pairs: this.lastListPairs,
      miniPlayingTitle: this.miniPlayingTitle,
      navItems: this.lastNavItems,
      lastOcrDetail: this.lastOcrDetail,
      lastOcrList: this.lastOcrList,
      lastOcrChannelHome: this.lastOcrChannelHome,
      lastOcrPlayer: this.lastOcrPlayer,
    });
    if (guard.setSortVerify) this.pendingSortVerify = true;
    return { note: guard.note, blocked: guard.blocked };
  }

  /** element_at failure streak: after two strikes tell the model the app
   * has no accessibility API. Returns the corrective hint or "". */
  elementAtNote(): string {
    this.elementAtFails += 1;
    return this.elementAtFails >= 2
      ? `（已连续失败 ${this.elementAtFails} 次：该应用确认不支持 element_at/read_screen，请不要再调用它们，只用 ocr 读屏 + click_at 操作推进）`
      : "";
  }

  /** Scroll bounce detector: returns true when the same spot was just
   * scrolled in the opposite direction (a no-op that burns steps). */
  scrollBounced(x: number, y: number, sign: number): boolean {
    const bounced = this.recentScrolls.some(
      (s) => Math.abs(s.x - x) < 4 && Math.abs(s.y - y) < 4 && s.sign === -sign,
    );
    this.recentScrolls.push({ x, y, sign });
    if (this.recentScrolls.length > 4) this.recentScrolls.shift();
    return bounced;
  }

  /** After a scroll every pair coordinate is stale — clear the pairs and
   * return the "you just left a qualifying candidate" reminder. */
  scrollAwayNote(): { qualifiedNote: string } {
    const qualified = this.lastListPairs
      .filter((p) => {
        const n = parseFloat(p.score.replace("分", ""));
        return !Number.isNaN(n) && n >= 9;
      })
      .slice(0, 2);
    // 滚动后屏幕内容已移动：任何来自上次 ocr 的评分-片名配对坐标都已
    // 失效。不清空的话 click_at 会用旧坐标提示「将打开 X」而实际点到
    // 滚动后的别的卡片（13:22 会话：滚动后未 ocr 即点狄仁杰坐标，
    // 结果打开的是 8.1 分的定海神针详情页）。
    this.lastListPairs = [];
    return {
      qualifiedNote: qualified.length
        ? `\n⚠️ 注意：滚动前本屏上次 ocr 已有达标候选——${qualified.map((p) => `「${p.title}」评分 ${p.score}（片名坐标 ${p.x},${p.y}）`).join("、")}。如果还没点它，滚动后坐标已失效：先滚回上一屏重新 ocr 定位再点，不要继续滚向更远；评分 <9 不达标才值得继续找。`
        : "",
    };
  }

  /** Blind-click guard for the runSteps loop: record the tool in the
   * recent-moves window and, for click tools, detect 3+ consecutive
   * clicks at the same spot with zero observation in between. Returns
   * {block, warn} — block means the click must not fire, warn appends a
   * note to the real result. */
  trackMove(toolName: string, x: number | null, y: number | null): { block?: string; warn?: string } {
    const isClickTool = toolName === "click_at" || toolName === "double_click_at";
    const cx = isClickTool && x !== null ? x : null;
    const cy = isClickTool && y !== null ? y : null;
    let block: string | undefined;
    let warn: string | undefined;
    if (isClickTool && cx !== null && cy !== null) {
      const run: { x: number; y: number }[] = [];
      for (let i = this.recentMoves.length - 1; i >= 0; i--) {
        const m = this.recentMoves[i];
        if (m.kind === "click") run.push({ x: m.x, y: m.y });
        else break;
      }
      run.push({ x: cx, y: cy });
      if (run.length >= 3) {
        const allNear = run.every((p) =>
          run.every((q) => Math.abs(p.x - q.x) <= 60 && Math.abs(p.y - q.y) <= 60),
        );
        if (allNear) {
          block =
            `您已在同一区域连续点击 ${run.length} 次（坐标相距 ≤60pt），且期间没有任何观察。\n` +
            "点击后页面毫无变化的原因排查（自绘 UI 不读屏就看不见）：\n" +
            "1. 目标已不在该坐标（窗口移动/最大化/滚动后布局变了）→ 先 ocr 找导航项当前位置；\n" +
            "2. 点击被弹窗/覆盖层挡住 → 先 ocr 找「关闭/取消」；\n" +
            "3. 页面切换有延迟 → 用 wait_for text=页面特征词（勿用导航栏恒在的词）等待。\n" +
            "请先 ocr 复核现状再决定下一步，不要继续盲点同一位置。";
        } else {
          warn =
            `⚠️ 您已连续点击 ${run.length} 次且中间没有任何 ocr/wait_for 验证（本次已执行）。` +
            "自绘 UI 中每步点击后都应观察：点完先 wait_for 页面特征词或 ocr 确认真的切换了；" +
            "页面无变化就换坐标/换方式，不要连续盲点。";
        }
      }
    }
    if (isClickTool && cx !== null && cy !== null) {
      this.recentMoves.push({ kind: "click", x: cx, y: cy });
    } else if (OBSERVE_TOOLS.has(toolName)) {
      this.recentMoves.push({ kind: "observe" });
    } else if (toolName === "scroll") {
      this.recentMoves.push({ kind: "scroll" });
    } else {
      this.recentMoves.push({ kind: "other" });
    }
    if (this.recentMoves.length > 8) this.recentMoves.shift();
    return { block, warn };
  }
}

/** Load watched-film titles from localStorage (missing/unparsable → []). */
function loadSeenTitles(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.length >= 2) : [];
  } catch {
    return [];
  }
}
