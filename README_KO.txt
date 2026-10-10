엔드게임 용산 4DX 잔여석 증가 감지봇 — Relay 버전
====================================================

왜 이 버전인가
--------------
Railway에서 CGV 자체를 직접 열었을 때:
- 일반 HTTP: 403
- Headless Chromium: CGV 첫 페이지부터 403

이 버전은 CGV를 Railway에서 직접 호출하지 않습니다.
공개 CGV timetable relay:
https://mcp.aka.page/api/cgv/timetable
에서 용산 10/11 시간표를 받아 15:20 엔드게임 4DX의
잔여석 숫자만 비교합니다.

로그인/좌석상세/홀딩/결제 기능은 없습니다.

알림 규칙
---------
3 -> 3 : 무시
3 -> 2 : 무시
2 -> 1 : 무시
1 -> 2 : 취소표 알림
2 -> 4 : 취소표 알림 (+2)

처음 시작했을 때 현재 잔여석은 기준값으로만 저장합니다.

GitHub에서 교체할 파일
----------------------
app.mjs
package.json
Dockerfile
railway.json
.env.example

Railway
-------
기존 새 Railway 서비스를 그대로 사용합니다.

Variables:
TELEGRAM_BOT_TOKEN=기존값
TELEGRAM_CHAT_ID=기존값

그 외 변수는 .env.example의 기본값 그대로 사용 가능.

필요 없는 것:
- Chromium
- Playwright
- Volume
- Public Networking
- CGV 로그인

정상 로그
---------
Starting relay-based Endgame Yongsan 4DX remaining watcher
Target: 20261011 1520 / 용산아이파크몰 / 엔드게임 / 4DX
Relay: https://mcp.aka.page/api/cgv/timetable
Baseline=...

정상 Telegram:
✅ [엔드게임 용산 4DX 잔여석봇] 감시 시작
현재 잔여석: N석

주의
----
Relay가 데이터를 캐시하면 알림 지연은 relay cache age만큼 생길 수 있습니다.
코드는 응답에 Age 헤더가 있으면 Telegram 시작 메시지와 로그에 표시합니다.


RELAY v2 수정사항
-----------------
일부 relay 응답은 다음처럼 영화/시간/잔여석은 주지만 상영관명이 비어 있을 수 있습니다.

어벤져스-엔드게임 앙코르 / 1520 / ? / 잔여=51

따라서 v2는:
1. 영화명 + 정확한 시작시간(15:20)을 먼저 매칭
2. 그 결과가 1개뿐이면 그 회차 사용
3. 같은 영화/같은 시간 회차가 여러 개일 때만 4DX 필드로 재확인
4. 여러 개인데 relay가 포맷을 전혀 주지 않으면 잘못된 회차 감시를 막기 위해 중단

현재 2026-10-11 용산 엔드게임 15:20은 공개 시간표상 4DX 회차입니다.


RELAY v3-jitter 수정사항
------------------------
고정 조회주기 대신 매 조회가 끝날 때마다 다음 대기시간을 새로 뽑습니다.

기본:
POLL_MIN_SECONDS=5
POLL_MAX_SECONDS=7

예:
5.23초 -> 6.81초 -> 5.47초 -> 6.05초 ...

분포는 5~7초 구간의 균등 랜덤입니다.
최소값은 코드상 5초보다 낮아지지 않습니다.

Railway Variables에 기존 POLL_SECONDS가 남아 있어도
v3-jitter에서는 사용하지 않습니다.
POLL_MIN_SECONDS / POLL_MAX_SECONDS만 사용합니다.


RELAY v4-cachebust 수정사항
---------------------------
기존 v3에서 cacheAge가 수십~100초까지 올라가는 현상을 확인하여,
매 relay 요청 URL에 다음처럼 고유한 값을 자동 추가합니다.

_cb=현재밀리초타임스탬프

예:
...?playDate=20261011&theaterCode=0013&_cb=1791675405123

목적:
- CDN/프록시가 이전 URL의 오래된 캐시 응답을 그대로 재사용하는 것을 피하도록 시도
- relay 자체 내부 캐시라면 효과가 없을 수 있음

기본:
CACHE_BUST=true

로그:
Cache bust: ON
cacheAge=...
cacheStatus=...

판단:
- cacheAge가 0~몇 초 수준으로 낮게 유지되면 효과가 있는 것
- cacheAge가 계속 수십 초 이상이면 relay 내부 캐시 가능성이 높음

기존 5~7초 랜덤 감시, 증가 시 Telegram 알림, 429 시 자동 대기 로직은 그대로 유지합니다.
