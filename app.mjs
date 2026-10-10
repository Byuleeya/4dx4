const CFG = {
  telegramToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  telegramChatId: (process.env.TELEGRAM_CHAT_ID || "").trim(),

  relayUrl: (
    process.env.RELAY_URL ||
    "https://mcp.aka.page/api/cgv/timetable"
  ).trim(),

  theaterCode: (process.env.THEATER_CODE || "0013").trim(),
  theaterName: (process.env.THEATER_NAME || "용산아이파크몰").trim(),
  targetDate: (process.env.TARGET_DATE || "20261011").trim(),
  targetTime: (process.env.TARGET_TIME || "1520")
    .replace(":", "")
    .trim(),

  movieKeyword: (process.env.MOVIE_KEYWORD || "엔드게임").trim(),
  formatKeyword: (process.env.FORMAT_KEYWORD || "4DX").trim(),

  pollMinSeconds: Math.max(Number(process.env.POLL_MIN_SECONDS || "5"), 5),
  pollMaxSeconds: Math.max(Number(process.env.POLL_MAX_SECONDS || "7"), 5),

  cacheBust:
    String(process.env.CACHE_BUST || "true").trim().toLowerCase() !== "false",
  requestTimeoutMs: Math.max(
    Number(process.env.REQUEST_TIMEOUT_MS || "8000"),
    3000
  ),
  errorCooldownSeconds: Math.max(
    Number(process.env.ERROR_ALERT_COOLDOWN_SECONDS || "600"),
    60
  ),
};

if (!CFG.telegramToken || !CFG.telegramChatId) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 없습니다. Railway Variables에 입력하세요."
  );
}

let baseline = null;
let lastErrorText = "";
let lastErrorAlertAt = 0;
let stopping = false;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextPollDelayMs() {
  const min = Math.min(CFG.pollMinSeconds, CFG.pollMaxSeconds);
  const max = Math.max(CFG.pollMinSeconds, CFG.pollMaxSeconds);

  // Uniform random delay between min and max, including decimal seconds.
  return (min + Math.random() * (max - min)) * 1000;
}

function norm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s:·\-_[\]().]/g, "")
    .toUpperCase();
}

function kstNowText() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function targetStartPassed() {
  const iso =
    `${CFG.targetDate.slice(0, 4)}-${CFG.targetDate.slice(4, 6)}-${CFG.targetDate.slice(6, 8)}` +
    `T${CFG.targetTime.slice(0, 2)}:${CFG.targetTime.slice(2, 4)}:00+09:00`;

  return Date.now() >= new Date(iso).getTime();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CFG.requestTimeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function telegram(text, { silent = false } = {}) {
  const url =
    `https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: CFG.telegramChatId,
      text,
      disable_notification: silent,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram HTTP ${response.status}: ${body.slice(0, 250)}`
    );
  }
}

async function maybeAlertError(text) {
  log("ERROR:", text);

  const now = Date.now();
  if (
    text === lastErrorText &&
    now - lastErrorAlertAt < CFG.errorCooldownSeconds * 1000
  ) {
    return;
  }

  lastErrorText = text;
  lastErrorAlertAt = now;

  try {
    await telegram(
      "⚠️ [엔드게임 용산 4DX 잔여석봇]\n" +
      "시간표 relay 조회 오류가 발생했습니다.\n" +
      `${text.slice(0, 900)}\n\n` +
      "자동으로 계속 재시도합니다."
    );
  } catch (error) {
    log("Telegram error alert failed:", error.message);
  }
}

function* walkObjects(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkObjects(item);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  yield value;

  for (const child of Object.values(value)) {
    yield* walkObjects(child);
  }
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(row, key) &&
      row[key] !== null &&
      row[key] !== ""
    ) {
      return row[key];
    }
  }
  return null;
}

const MOVIE_KEYS = [
  "movNm",
  "movieName",
  "movieNm",
  "title",
  "movTitle",
  "movie_title",
];

const TIME_KEYS = [
  "scnsrtTm",
  "startTime",
  "start_time",
  "playStartTime",
  "screeningStartTime",
  "showTime",
  "time",
];

const HALL_KEYS = [
  "scnsNm",
  "scnsEnm",
  "screenName",
  "screenNm",
  "roomName",
  "auditoriumName",
  "hallName",
  "screen",
  "hall",
];

const FORMAT_KEYS = [
  "tcscnsGradNm",
  "format",
  "formatName",
  "screenType",
  "screenTypeName",
  "specialType",
  "specialTypeName",
  "cinemaType",
  "spltDivNm",
  "theaterType",
  "roomType",
  "scnTypeNm",
];

const REMAINING_KEYS = [
  "frSeatCnt",
  "remainingSeats",
  "availableSeats",
  "remainSeatCnt",
  "freeSeats",
];

const TOTAL_KEYS = [
  "stcnt",
  "totalSeats",
  "seatCount",
  "totalSeatCnt",
];

function hhmm(value) {
  const digits = String(value ?? "").replace(/\D/g, "");

  if (digits.length === 4) return digits;
  if (digits.length === 3) return `0${digits}`;

  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  if (match) {
    return `${match[1].padStart(2, "0")}${match[2]}`;
  }

  return "";
}

function candidateRows(payload) {
  const rows = [];

  for (const row of walkObjects(payload)) {
    const t = firstValue(row, TIME_KEYS);
    if (t === null) continue;

    const remaining = firstValue(row, REMAINING_KEYS);
    if (remaining === null) continue;

    rows.push(row);
  }

  return rows;
}

function findTargetRow(payload) {
  const movieNeedle = norm(CFG.movieKeyword);
  const formatNeedle = norm(CFG.formatKeyword);

  // First match the two fields that the relay reliably exposes:
  // movie name + exact start time.
  const movieTimeMatches = candidateRows(payload).filter((row) => {
    const movie = norm(firstValue(row, MOVIE_KEYS));
    const time = hhmm(firstValue(row, TIME_KEYS));

    return (
      movie.includes(movieNeedle) &&
      time === CFG.targetTime
    );
  });

  if (!movieTimeMatches.length) {
    return null;
  }

  // In the current relay payload the hall/format field may be absent.
  // If movie+time uniquely identifies one row, that is enough.
  if (movieTimeMatches.length === 1) {
    return movieTimeMatches[0];
  }

  // Only when there are duplicate rows at the exact same movie/time
  // do we use hall/format as a disambiguator.
  const formatMatches = movieTimeMatches.filter((row) => {
    const hall = norm(
      [
        firstValue(row, HALL_KEYS),
        ...FORMAT_KEYS
          .map((k) => row[k])
          .filter((x) => x !== undefined && x !== null),
      ].join(" ")
    );

    return hall.includes(formatNeedle);
  });

  if (formatMatches.length === 1) {
    return formatMatches[0];
  }

  if (formatMatches.length > 1) {
    return formatMatches[0];
  }

  // Ambiguous duplicate movie/time rows without format metadata:
  // fail closed rather than monitor the wrong showtime.
  throw new Error(
    `동일 영화 ${CFG.targetTime} 회차가 ${movieTimeMatches.length}개인데 ` +
    `relay에 상영관/포맷 정보가 없어 4DX 회차를 구분할 수 없습니다.`
  );
}

function parseRemaining(row) {
  const raw = firstValue(row, REMAINING_KEYS);
  const value = Number.parseInt(String(raw), 10);

  if (!Number.isFinite(value)) {
    throw new Error(
      `대상 회차 잔여석 숫자를 파싱하지 못했습니다. raw=${String(raw)}`
    );
  }

  return value;
}

function parseTotal(row) {
  const raw = firstValue(row, TOTAL_KEYS);
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : null;
}

function describeNearby(payload) {
  const rows = candidateRows(payload);

  const sameMovie = rows
    .filter((row) =>
      norm(firstValue(row, MOVIE_KEYS)).includes(
        norm(CFG.movieKeyword)
      )
    )
    .map((row) => {
      const movie =
        firstValue(row, MOVIE_KEYS) || "?";
      const time = hhmm(firstValue(row, TIME_KEYS)) || "?";
      const hall = firstValue(row, HALL_KEYS) || "?";
      const remain =
        firstValue(row, REMAINING_KEYS) ?? "?";
      const format = FORMAT_KEYS
        .map((k) => row[k])
        .filter((x) => x !== undefined && x !== null)
        .join(",");
      return `${movie}/${time}/${hall}${format ? `/${format}` : ""}/잔여=${remain}`;
    })
    .slice(0, 15);

  return sameMovie.join(" | ") || "없음";
}

async function fetchRelaySnapshot() {
  const params = new URLSearchParams({
    playDate: CFG.targetDate,
    theaterCode: CFG.theaterCode,
    limit: "500",
    timeoutMs: String(CFG.requestTimeoutMs),
  });

  // Try to avoid a stale CDN/proxy cache by making each request URL unique.
  // This does not bypass login/security; it only asks the public relay for
  // a fresh representation of the same timetable resource.
  if (CFG.cacheBust) {
    params.set("_cb", String(Date.now()));
  }

  const url = `${CFG.relayUrl}?${params.toString()}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `relay HTTP ${response.status}: ` +
      raw.replace(/\s+/g, " ").slice(0, 250)
    );
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(
      `relay JSON 파싱 실패: ${raw.slice(0, 250)}`
    );
  }

  if (
    payload &&
    typeof payload === "object" &&
    payload.success === false
  ) {
    throw new Error(
      `relay success=false: ` +
      String(payload.error || payload.message || "")
    );
  }

  const row = findTargetRow(payload);

  if (!row) {
    throw new Error(
      `대상 회차를 찾지 못했습니다. ` +
      `조건=2026-10-11 15:20 / 엔드게임 / 4DX. ` +
      `같은 영화 후보=${describeNearby(payload)}`
    );
  }

  const ageHeader = response.headers.get("age");
  const cacheAge =
    ageHeader && Number.isFinite(Number(ageHeader))
      ? Number(ageHeader)
      : null;

  const cacheStatus =
    response.headers.get("cf-cache-status") ||
    response.headers.get("x-cache") ||
    response.headers.get("x-vercel-cache") ||
    null;

  return {
    remaining: parseRemaining(row),
    total: parseTotal(row),
    movie:
      String(firstValue(row, MOVIE_KEYS) || "어벤져스: 엔드게임 앙코르"),
    hall:
      String(firstValue(row, HALL_KEYS) || "4DX관"),
    cacheAge,
    cacheStatus,
  };
}

async function main() {
  log("Starting relay-based Endgame Yongsan 4DX remaining watcher v4-cachebust");
  log(
    `Target: ${CFG.targetDate} ${CFG.targetTime} / ` +
    `${CFG.theaterName} / ${CFG.movieKeyword} / ${CFG.formatKeyword}`
  );
  log(`Poll interval: random ${CFG.pollMinSeconds}-${CFG.pollMaxSeconds}s`);
  log(`Relay: ${CFG.relayUrl}`);
  log(`Cache bust: ${CFG.cacheBust ? "ON" : "OFF"}`);

  while (!stopping) {
    if (targetStartPassed()) {
      try {
        await telegram(
          "⏹ [엔드게임 용산 4DX 잔여석봇]\n" +
          "2026-10-11 15:20 상영 시작 시간이 되어 감시를 종료합니다.",
          { silent: true }
        );
      } catch {}

      log("Target showtime reached; watcher stopped.");
      return;
    }

    try {
      const snapshot = await fetchRelaySnapshot();

      lastErrorText = "";

      if (baseline === null) {
        baseline = snapshot.remaining;

        const totalText =
          snapshot.total === null
            ? ""
            : ` / 총 ${snapshot.total}석`;

        const cacheText =
          snapshot.cacheAge === null
            ? ""
            : `\nrelay cache age: 약 ${snapshot.cacheAge}초`;

        log(
          `Baseline=${baseline}; movie=${snapshot.movie}; ` +
          `hall=${snapshot.hall}; cacheAge=${snapshot.cacheAge}; cacheStatus=${snapshot.cacheStatus ?? "-"}`
        );

        await telegram(
          "✅ [엔드게임 용산 4DX 잔여석봇] 감시 시작\n\n" +
          "🗓 2026-10-11 15:20\n" +
          `📍 CGV ${CFG.theaterName} / ${snapshot.hall}\n` +
          `🎬 ${snapshot.movie}\n` +
          `현재 잔여석: ${baseline}석${totalText}\n` +
          `조회주기: ${CFG.pollMinSeconds}~${CFG.pollMaxSeconds}초 랜덤` +
          cacheText +
          "\n\n잔여석이 증가할 때만 알림을 보냅니다.",
          { silent: true }
        );
      } else {
        const previous = baseline;
        const current = snapshot.remaining;

        if (current > previous) {
          log(`Cancellation detected: ${previous} -> ${current}`);

          await telegram(
            "🚨🚨 [취소표 발생 — 엔드게임 용산 4DX]\n\n" +
            "🗓 2026-10-11 15:20\n" +
            `잔여석 증가: ${previous}석 → ${current}석\n` +
            `증가분: +${current - previous}석\n` +
            `🕒 ${kstNowText()}\n\n` +
            "바로 CGV에서 확인하세요:\n" +
            "https://cgv.co.kr/cnm/movieBook/cinema"
          );
        }

        // 감소도 새 기준값으로 저장.
        // 예: 3 -> 2 무시, 이후 2 -> 3이면 취소표 알림.
        baseline = current;

        log(
          `Seat count: ${previous} -> ${current}; ` +
          `cacheAge=${snapshot.cacheAge ?? "-"}; cacheStatus=${snapshot.cacheStatus ?? "-"}`
        );
      }

      const delayMs = nextPollDelayMs();
      log(`Next check in ${(delayMs / 1000).toFixed(2)}s`);
      await sleep(delayMs);
    } catch (error) {
      const text = String(error?.message || error);

      // 마지막 정상 baseline은 절대 0으로 초기화하지 않는다.
      await maybeAlertError(text);

      if (text.includes("429")) {
        await sleep(60_000);
      } else {
        await sleep(20_000);
      }
    }
  }
}

process.on("SIGTERM", () => {
  stopping = true;
});

process.on("SIGINT", () => {
  stopping = true;
});

main().catch(async (error) => {
  log("FATAL:", error);

  try {
    await telegram(
      "🚨 [엔드게임 용산 4DX 잔여석봇] 치명적 오류\n" +
      String(error?.stack || error).slice(0, 1500)
    );
  } catch {}

  process.exit(1);
});
