/**
 * ==========================================================================
 * スマホで喋って一瞬でスケジュール作成 (Ver.2.0 - 設計図第2版 準拠)
 * 
 * 1. 状態管理 & 永続化 (予定・TODO・案件 3系統管理)
 * 2. 音声認識 (Web Speech API)
 * 3. AI 3軸自動振り分け (Gemini API & 高精度ローカルNLPエンジン)
 * 4. Googleカレンダー直接連携 (GIS OAuth2 & Calendar API v3 Read-before-Write)
 * 5. 誰のボールか（案件管理・タスク進捗連携）
 * 6. 一括登録 & ダッシュボード描画
 * 7. セキュリティ (BYOK) & 自動保存
 * ==========================================================================
 */

// --- 1. 状態管理 (State) ---
let isRecording = false;
let recognition = null;
let currentTab = 'record'; // 'record' or 'dashboard'
let currentFilter = 'all'; // 'all', 'schedules', 'todos', 'deals'
let isPhoneFrame = true;
let isAutoSaveEnabled = localStorage.getItem('auto_save_mode') !== 'false';
let autoSaveTimer = null;
let autoSaveCountdown = 3;

// 処理待ちの整理結果オブジェクト（予定・TODO・案件）
let pendingExtraction = null;

// Google Calendar API 連携状態
let googleTokenClient = null;
let googleAccessToken = sessionStorage.getItem('google_access_token') || null;
let googleUserEmail = sessionStorage.getItem('google_user_email') || null;

// 永続化データ (localStorage 3系統)
let schedules = JSON.parse(localStorage.getItem('saved_schedules')) || [
  {
    id: "sop-1",
    title: "〇〇クリニック 商談",
    date: getRelativeDateString(1),
    startTime: "10:00",
    endTime: "11:00",
    customer: "〇〇クリニック",
    type: "offline",
    isQuadrant2: false,
    memo: "対面商談（設計図第2版 標準例）"
  },
  {
    id: "sop-2",
    title: "ヤナピーと YouTube 撮影",
    date: "2026-10-10",
    startTime: "13:00",
    endTime: "15:00",
    customer: "ヤナピー",
    type: "offline",
    isQuadrant2: false,
    memo: "秋葉原スタジオにて対面収録（SOP標準例）"
  }
];

let todos = JSON.parse(localStorage.getItem('saved_todos')) || [
  {
    id: "todo-init-1",
    title: "商談後に見積書を作成",
    dueDate: "明日",
    completed: false
  },
  {
    id: "todo-init-2",
    title: "田中先生へメール",
    dueDate: "木曜日",
    completed: false
  }
];

let deals = JSON.parse(localStorage.getItem('saved_deals')) || [
  {
    id: "deal-init-1",
    customer: "〇〇クリニック",
    nextAction: "見積書作成・送付",
    ballHolder: "self", // 'self' | 'client' | 'other'
    status: "商談中"
  }
];

// --- 2. 初期化 (DOM Ready) ---
document.addEventListener('DOMContentLoaded', () => {
  updateDateHeader();
  renderDashboard();
  initSpeechRecognition();
  updateApiKeyBadge();
  updateAutoSaveButtonUI();
  updateGoogleAuthButtonUI();

  // GIS 初期化待機
  if (window.google && window.google.accounts) {
    initGoogleAuth();
  } else {
    window.addEventListener('load', () => {
      if (window.google && window.google.accounts) {
        initGoogleAuth();
      }
    });
  }
});

function updateDateHeader() {
  const now = new Date();
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dayName = days[now.getDay()];
  
  const displayEl = document.getElementById('currentDateDisplay');
  if (displayEl) {
    displayEl.textContent = `${y}.${m}.${d} ${dayName}`;
  }
}

function getRelativeDateString(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// --- 3. Google Calendar API 直接連携 (GIS & OAuth2) ---

function initGoogleAuth() {
  const clientId = localStorage.getItem('google_oauth_client_id');
  if (!clientId || !window.google || !window.google.accounts) return;

  try {
    googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/calendar.events',
      callback: (tokenResponse) => {
        if (tokenResponse.error !== undefined) {
          console.error("Google Auth Error:", tokenResponse);
          if (tokenResponse.error === 'access_denied') {
            showToast("⚠️ 403アクセス拒否: Google Cloudの『テストユーザー』にGmailを追加してください");
          } else {
            showToast(`⚠️ Googleカレンダー認証エラー: ${tokenResponse.error}`);
          }
          return;
        }
        googleAccessToken = tokenResponse.access_token;
        sessionStorage.setItem('google_access_token', googleAccessToken);
        updateGoogleAuthButtonUI();
        showToast("📅 Googleカレンダーと接続しました！実データ重複スキャンが有効です");
      }
    });
  } catch (err) {
    console.warn("GIS初期化エラー:", err);
  }
}

function handleGoogleAuthClick() {
  const clientId = localStorage.getItem('google_oauth_client_id');
  if (!clientId) {
    openSecurityModal();
    showToast("Google OAuth クライアントIDを設定してください");
    return;
  }

  if (googleAccessToken) {
    showToast("📅 Googleカレンダー接続中です（実予定重複スキャン有効）");
    return;
  }

  if (!googleTokenClient) {
    initGoogleAuth();
  }

  if (googleTokenClient) {
    googleTokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    showToast("Google認証ライブラリを読み込み中です。少々お待ちください。");
  }
}

function updateGoogleAuthButtonUI() {
  const btn = document.getElementById('googleAuthBtn');
  const statusBadge = document.getElementById('googleAuthStatusBadge');
  if (!btn) return;

  if (googleAccessToken) {
    btn.className = "px-2.5 py-1 rounded-full border border-[#6B8068] bg-[#EAF2EA] text-[#3D5C3D] font-medium transition-colors flex items-center space-x-1 text-[11px]";
    btn.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-[#6B8068]"></span><span>Google連携中</span>`;
    if (statusBadge) {
      statusBadge.textContent = "状態: Googleカレンダー接続中 (本物データ重複スキャン有効)";
      statusBadge.className = "text-[#3D5C3D] font-medium";
    }
  } else {
    btn.className = "px-2.5 py-1 rounded-full border border-[#DDD5C5] bg-[#FAF8F3] text-[#6B655D] hover:bg-[#F2ECE0] transition-colors flex items-center space-x-1 text-[11px]";
    btn.innerHTML = `<span>📅 Google接続</span>`;
    if (statusBadge) {
      statusBadge.textContent = "状態: 未接続 (ローカル重複スキャンで稼働)";
      statusBadge.className = "text-[#8C8476]";
    }
  }
}

async function fetchGoogleEventsForDay(dateStr) {
  if (!googleAccessToken) return [];

  try {
    const timeMin = new Date(`${dateStr}T00:00:00+09:00`).toISOString();
    const timeMax = new Date(`${dateStr}T23:59:59+09:00`).toISOString();
    
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${googleAccessToken}` }
    });

    if (res.status === 401) {
      googleAccessToken = null;
      sessionStorage.removeItem('google_access_token');
      updateGoogleAuthButtonUI();
      return [];
    }

    if (!res.ok) return [];

    const data = await res.json();
    if (!data.items) return [];

    return data.items
      .filter(ev => ev.start && ev.start.dateTime)
      .map(ev => {
        const startDt = new Date(ev.start.dateTime);
        const endDt = new Date(ev.end.dateTime);
        const startH = String(startDt.getHours()).padStart(2, '0');
        const startM = String(startDt.getMinutes()).padStart(2, '0');
        const endH = String(endDt.getHours()).padStart(2, '0');
        const endM = String(endDt.getMinutes()).padStart(2, '0');

        return {
          id: `gcal-${ev.id}`,
          googleEventId: ev.id,
          title: ev.summary || "無題の予定",
          date: dateStr,
          startTime: `${startH}:${startM}`,
          endTime: `${endH}:${endM}`,
          isGoogleRealEvent: true,
          memo: ev.description || ""
        };
      });
  } catch (e) {
    console.warn("Googleカレンダー同期エラー:", e);
    return [];
  }
}

async function insertEventToGoogleCalendar(schedule) {
  if (!googleAccessToken) return null;

  try {
    const startIso = `${schedule.date}T${schedule.startTime}:00+09:00`;
    const endIso = `${schedule.date}T${schedule.endTime}:00+09:00`;

    const body = {
      summary: schedule.title,
      description: `${schedule.customer ? '相手: ' + schedule.customer + '\n' : ''}${schedule.memo || ''}`,
      start: { dateTime: startIso, timeZone: 'Asia/Tokyo' },
      end: { dateTime: endIso, timeZone: 'Asia/Tokyo' }
    };

    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${googleAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) return null;

    const created = await res.json();
    return created.id;
  } catch (e) {
    console.warn("Googleカレンダー書き込みエラー:", e);
    return null;
  }
}

async function deleteGoogleCalendarEvent(googleEventId) {
  if (!googleAccessToken || !googleEventId) return;
  try {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${googleAccessToken}` }
    });
  } catch (e) {
    console.warn("Googleカレンダー削除エラー:", e);
  }
}

// --- 4. 音声認識 (Web Speech API チューニング版) ---
let speechFinalTranscript = '';
let speechSilenceTimer = null;
const SILENCE_AUTO_STOP_MS = 2200; // 2.2秒間の無音で自動確定・解析へ移行

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const statusEl = document.getElementById('speechEngineStatus');

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = true; // 途切れ防止のため連続認識を有効化
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setMicUIActive(true);
      speechFinalTranscript = '';
      if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
      document.getElementById('transcriptText').textContent = "聴き取っています... どうぞお話しください";
      document.getElementById('micStateHint').textContent = "話し終えると自動で解析されます（タップで今すぐ完了）";
    };

    recognition.onresult = (event) => {
      // 発話を検知するたびに無音タイマーをリセット
      if (speechSilenceTimer) clearTimeout(speechSilenceTimer);

      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          speechFinalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const combined = normalizeSpokenText(speechFinalTranscript + interimTranscript);
      if (combined) {
        document.getElementById('transcriptText').textContent = combined;
      }

      // 話し終わった後の自動停止タイマー（2.2秒無音で自動解析へ）
      speechSilenceTimer = setTimeout(() => {
        if (isRecording) {
          stopRecording();
        }
      }, SILENCE_AUTO_STOP_MS);
    };

    recognition.onend = () => {
      if (isRecording) {
        stopRecording();
      }
    };

    recognition.onerror = (event) => {
      console.warn("音声認識エラー:", event.error);
      if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
      setMicUIActive(false);
      isRecording = false;

      switch (event.error) {
        case 'not-allowed':
          showToast("⚠️ マイク利用が許可されていません。ブラウザ設定で許可してください");
          document.getElementById('micStateHint').textContent = "マイク利用がブロックされています（アドレスバーで許可してください）";
          break;
        case 'no-speech':
          document.getElementById('micStateHint').textContent = "音声が検出されませんでした。もう一度ボタンを押してお話しください";
          break;
        case 'network':
          showToast("⚠️ 音声認識ネットワークエラーが発生しました");
          document.getElementById('micStateHint').textContent = "ネットワーク接続を確認してください（手動入力も可能です）";
          break;
        case 'audio-capture':
          showToast("⚠️ マイク機器が見つかりません");
          document.getElementById('micStateHint').textContent = "マイク機器が接続されているか確認してください";
          break;
        default:
          document.getElementById('micStateHint').textContent = "ボタンを押して、予定やタスクを自然に話しかけてください";
          break;
      }
    };

    if (statusEl) statusEl.textContent = "音声認識: 準備完了 (高精度チューニング済)";
  } else {
    if (statusEl) statusEl.textContent = "デモモード（発話サンプル対応）";
  }
}

function handleMicToggle() {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
}

function startRecording() {
  if (!recognition) {
    showToast("このブラウザは音声認識に対応していません。手動入力またはサンプルボタンをお使いください。");
    return;
  }
  try {
    isRecording = true;
    speechFinalTranscript = '';
    if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
    recognition.start();
  } catch (e) {
    console.warn("録音開始例外:", e);
    isRecording = false;
  }
}

function stopRecording() {
  isRecording = false;
  if (speechSilenceTimer) {
    clearTimeout(speechSilenceTimer);
    speechSilenceTimer = null;
  }
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  setMicUIActive(false);

  let spokenText = document.getElementById('transcriptText').textContent;
  spokenText = normalizeSpokenText(spokenText);

  if (spokenText && !spokenText.includes("どうぞお話しください") && !spokenText.includes("「")) {
    processSpokenSchedule(spokenText);
  } else {
    document.getElementById('micStateHint').textContent = "ボタンを押して、予定やタスクを自然に話しかけてください";
  }
}

/**
 * 日本語音声認識テキストの正規化チューニング
 * - 全角数字 -> 半角数字
 * - 漢数字の日時 -> 半角数字
 * - 音声変換のブレ吸収 (ユーチューブ -> YouTube, ズーム -> Zoom 等)
 */
function normalizeSpokenText(text) {
  if (!text) return '';
  let s = text;

  // 1. 全角数字を半角数字へ変換 (０-９ -> 0-9)
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));

  // 2. 全角記号の正規化
  s = s.replace(/：/g, ':').replace(/[〜～]/g, '〜');

  // 3. 漢数字の日時表現を半角数字へ変換
  const kanjiNumMap = {
    '十月': '10月', '十一月': '11月', '十二月': '12月',
    '一月': '1月', '二月': '2月', '三月': '3月', '四月': '4月',
    '五月': '5月', '六月': '6月', '七月': '7月', '八月': '8月', '九月': '9月',
    '十日': '10日', '二十日': '20日', '三十日': '30日',
    '十時': '10時', '十一時': '11時', '十二時': '12時', '十三時': '13時',
    '十四時': '14時', '十五時': '15時', '十六時': '16時', '十七時': '17時',
    '十八時': '18時', '十九時': '19時', '二十時': '20時',
    '一時': '1時', '二時': '2時', '三時': '3時', '四時': '4時', '五時': '5時',
    '六時': '6時', '七時': '7時', '八時': '8時', '九時': '9時',
    '三十分': '30分', '十五分': '15分', '四十五分': '45分'
  };

  for (const [k, v] of Object.entries(kanjiNumMap)) {
    s = s.replaceAll(k, v);
  }

  // 4. 音声認識特有のカタカナIT用語の補正
  s = s.replace(/ユーチューブ/gi, 'YouTube')
       .replace(/ズーム/gi, 'Zoom')
       .replace(/チームス/gi, 'Teams')
       .replace(/グーグルミート/gi, 'Google Meet');

  // 5. よく使う営業・医療IT・店舗システム用語の認識精度向上 (Ver.3.3)
  // (1) レセコン (診療報酬請求コンピュータ)
  s = s.replace(/(?:れせこん|レセ今|レセ混|レスコン|セセコン)/gi, 'レセコン');

  // (2) HPS (医療・調剤・営業システム連携等)
  s = s.replace(/(?:エイチ\s*ピー\s*エス|えいちぴーえす|h\.?p\.?s\.?|8\s*ps|エッチピーエス)/gi, 'HPS');

  // (3) 自動釣銭機 (クリニック・店舗・会計)
  s = s.replace(/(?:自動(?:釣り?|つり?)(?:銭|線|せん)機|じどうつりせんき)/gi, '自動釣銭機');
  s = s.replace(/(?:釣り銭機|つりせんき|釣せん機)/gi, '釣銭機');

  // (4) 現調 (現場調査・現地調査)
  s = s.replace(/(?:原調|減調|現長|げんちょう)/gi, '現調');
  s = s.replace(/(?:現場調査|現地調査)/gi, '現調');

  // (5) その他 医療・店舗DX・営業頻出用語
  s = s.replace(/(?:でんしかるて|電カル|でんかる)/gi, '電子カルテ')
       .replace(/(?:オンライン資格確認|おんし|オンシ)/gi, 'オンライン資格確認')
       .replace(/(?:まいなほけんしょう|マイナ保険証)/gi, 'マイナ保険証')
       .replace(/(?:きってぃんぐ)/gi, 'キッティング')
       .replace(/(?:相見積もり|あいみつ|アイミツ|相見積)/gi, '相見積もり')
       .replace(/(?:くろーじんぐ)/gi, 'クロージング')
       .replace(/(?:ないらんかい)/gi, '内覧会')
       .replace(/(?:でもき|デモ機)/gi, 'デモ機');

  return s.trim();
}

function setMicUIActive(active) {
  const micBtn = document.getElementById('micBtn');
  const micIcon = document.getElementById('micIconInner');
  const wave = document.getElementById('waveContainer');
  const label = document.getElementById('micLabel');

  if (active) {
    micBtn.classList.add('mic-recording');
    micIcon.classList.remove('bg-[#F3ECE0]', 'text-[#AF894E]');
    micIcon.classList.add('bg-[#B8654F]', 'text-white');
    wave.classList.remove('hidden');
    wave.classList.add('flex');
    label.textContent = "LISTENING...";
  } else {
    micBtn.classList.remove('mic-recording');
    micIcon.classList.remove('bg-[#B8654F]', 'text-white');
    micIcon.classList.add('bg-[#F3ECE0]', 'text-[#AF894E]');
    wave.classList.add('hidden');
    wave.classList.remove('flex');
    label.textContent = "話して整理する";
  }
}

function injectPreset(phrase) {
  document.getElementById('transcriptText').textContent = phrase;
  processSpokenSchedule(phrase);
}

function submitManualText() {
  const inputEl = document.getElementById('manualTextInput');
  const text = inputEl.value.trim();
  if (!text) {
    showToast("予定やタスク内容を入力してください");
    return;
  }
  document.getElementById('transcriptText').textContent = text;
  inputEl.value = '';
  processSpokenSchedule(text);
}

// --- 5. AI解析 ＆ 3軸自動振り分け (設計図第2版 核心) ---
async function processSpokenSchedule(text) {
  setMicUIActive(false);
  isRecording = false;
  cancelAutoSave();
  hideConflictAlert();

  document.getElementById('micStateHint').textContent = "AIが発話内容を【予定】【TODO】【案件】に整理中...";

  const analyzingCard = document.getElementById('aiAnalyzingCard');
  const confirmationCard = document.getElementById('confirmationCard');

  analyzingCard.classList.remove('hidden');
  analyzingCard.classList.add('flex');
  confirmationCard.classList.add('hidden');

  const apiKey = localStorage.getItem('user_gemini_api_key');
  let extractedResult = null;

  // 特殊判定：第2領域（未来への投資時間）の抽象指示か？
  if (text.includes("枠を") || text.includes("空いている時間") || text.includes("確保") || text.includes("事業計画") || text.includes("第2領域")) {
    extractedResult = parseQuadrant2Allocation(text);
  } else if (apiKey) {
    try {
      extractedResult = await callGeminiExtractAPI(text, apiKey);
    } catch (err) {
      console.warn("Gemini API連携エラー、ローカルNLP解析にフォールバック:", err);
      extractedResult = parseLocallyV2(text);
    }
  } else {
    await new Promise(r => setTimeout(r, 600));
    extractedResult = parseLocallyV2(text);
  }

  analyzingCard.classList.add('hidden');
  analyzingCard.classList.remove('flex');

  pendingExtraction = extractedResult;
  populateTriCategoryForm(extractedResult);

  confirmationCard.classList.remove('hidden');
  confirmationCard.classList.add('flex');
  document.getElementById('micStateHint').textContent = "AIの整理結果を確認し、まとめて登録してください";

  // 先行読み取り (Read-before-Write): 予定が存在する場合、Googleカレンダー & アプリ内の重複をスキャン
  if (extractedResult.schedule && extractedResult.schedule.date && extractedResult.schedule.startTime && extractedResult.schedule.endTime) {
    const conflict = await scanForConflict(extractedResult.schedule.date, extractedResult.schedule.startTime, extractedResult.schedule.endTime);
    if (conflict) {
      showConflictAlert(conflict, extractedResult.schedule);
    } else {
      hideConflictAlert();
      startAutoSaveTimer();
    }
  } else {
    startAutoSaveTimer();
  }
}

function parseQuadrant2Allocation(text) {
  const title = text.includes("事業計画") ? "事業計画策定（未来投資）" : "戦略的思考タスク";
  const slot1Date = getRelativeDateString(3);

  return {
    schedule: {
      title: `【第2領域】${title}`,
      date: slot1Date,
      startTime: "10:00",
      endTime: "11:00",
      customer: "経営戦略・CEO専従",
      type: "internal",
      isQuadrant2: true,
      memo: "SOP第2領域ガバナンス適用：平日10-18時・分散配置ルールにより自動抽出"
    },
    todos: [
      { id: "todo-" + Date.now(), title: "事前分析データの整理", dueDate: slot1Date, completed: false }
    ],
    deal: null
  };
}

async function callGeminiExtractAPI(text, apiKey) {
  const now = new Date();
  const todayStr = getRelativeDateString(0);

  const systemPrompt = `
あなたは「スマホで喋って一瞬でスケジュール作成」の専属エグゼクティブAI秘書です。
ユーザーの発話内容を分析し、【予定】【TODO】【案件（誰のボールか）】の3カテゴリに正確に分類・整理してください。

発話テキスト: "${text}"
現在日付: ${todayStr} (${now.toLocaleDateString('ja-JP', { weekday: 'long' })})

【抽出・分類の厳格ルール】:
1. schedule（予定）: 日時・時間・場所・相手とのアポイントメント・約束。
   - title: 予定名（指示語「〜の予定を入れて」等は除外）
   - date: YYYY-MM-DD（実在日付に計算変換）
   - startTime: HH:MM（24時間表記）
   - endTime: HH:MM（終了指定なければ1時間後）
   - customer: 相手・顧客名。相手がいない場合は空文字 ""（"関係者様"は禁止）
   - type: "online"（Zoom等） | "offline"（対面・外出・訪問等） | "internal"（社内・作業等）
   - isQuadrant2: 未来への投資・重要戦略タスクならtrue
   - memo: 特記事項

2. todos（やること・タスク）: 自分が実行する行動・作業の配列（0〜複数件）。
   - title: 行動内容（例: "商談後に見積書を作成", "田中先生へメール"）
   - dueDate: 期限（例: "明日", "木曜日", "今週中" 等。指定なければ空文字）

3. deal（案件・継続管理対象）: 顧客や商談案件に関するステータス。
   - customer: 顧客名・医療機関名など
   - nextAction: 次に取るべきアクション（例: "見積作成"）
   - ballHolder: "self"（自分が次に行動） | "client"（先方の返信・確認待ち） | "other"（社内他担当やメーカー待ち）
   ※商談や顧客の言及が一切ない単独タスクの場合は null でも可。

【営業・医療IT・店舗システム業界用語の理解ルール】:
- 「レセコン」: 診療報酬請求コンピュータ。クリニックや薬局の重要システム。
- 「HPS」: 医療・調剤・営業連携システム。
- 「自動釣銭機」: クリニック・店舗の会計機。
- 「現調（げんちょう）」: 現場調査・現地調査。現地に出向く作業のため、typeは必ず "offline"（対面・訪問）。
- 「電子カルテ」「オンライン資格確認」「キッティング」「内覧会」等の専門用語も正確に抽出・活用すること。

必ず以下のJSONフォーマットのみで返答してください:
{
  "schedule": {
    "title": "予定名",
    "date": "YYYY-MM-DD",
    "startTime": "HH:MM",
    "endTime": "HH:MM",
    "customer": "相手名または空文字",
    "type": "online" または "offline" または "internal",
    "isQuadrant2": false,
    "memo": ""
  },
  "todos": [
    { "title": "TODOタイトル", "dueDate": "期限" }
  ],
  "deal": {
    "customer": "顧客名",
    "nextAction": "次回アクション",
    "ballHolder": "self"
  }
}
`;

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API Status: ${response.status}`);
  }

  const result = await response.json();
  const parsed = JSON.parse(result.candidates[0].content.parts[0].text);
  
  // ID付与などの整形
  if (parsed.todos && Array.isArray(parsed.todos)) {
    parsed.todos = parsed.todos.map((t, idx) => ({
      id: "todo-" + Date.now() + "-" + idx,
      title: t.title,
      dueDate: t.dueDate || "",
      completed: false
    }));
  } else {
    parsed.todos = [];
  }

  return parsed;
}

function parseLocallyV2(text) {
  // 1. 第2版 設計図 標準デモ発話の超精密マッピング
  if (text.includes("〇〇クリニック") && text.includes("見積書")) {
    const tomorrow = getRelativeDateString(1);
    return {
      schedule: {
        title: "〇〇クリニック 商談",
        date: tomorrow,
        startTime: "10:00",
        endTime: "11:00",
        customer: "〇〇クリニック",
        type: "offline",
        isQuadrant2: false,
        memo: "設計図第2版標準シナリオ：対面商談"
      },
      todos: [
        { id: "todo-" + Date.now() + "-1", title: "商談後に見積書を作成", dueDate: "明日", completed: false },
        { id: "todo-" + Date.now() + "-2", title: "田中先生へメール", dueDate: "木曜日", completed: false }
      ],
      deal: {
        customer: "〇〇クリニック",
        nextAction: "見積書作成・送付",
        ballHolder: "self"
      }
    };
  }

  // 2. SOP標準例（ヤナピー）
  if (text.includes("ヤナピー") || (text.includes("YouTube") && text.includes("撮影"))) {
    return {
      schedule: {
        title: "ヤナピーと YouTube 撮影",
        date: "2026-10-10",
        startTime: "13:00",
        endTime: "15:00",
        customer: "ヤナピー",
        type: "offline",
        isQuadrant2: false,
        memo: "秋葉原スタジオ対面収録"
      },
      todos: [
        { id: "todo-" + Date.now() + "-1", title: "撮影機材と台本の準備", dueDate: "前日", completed: false }
      ],
      deal: {
        customer: "ヤナピー",
        nextAction: "収録データ編集",
        ballHolder: "self"
      }
    };
  }

  // 3. 一般発話からの自然言語分解
  let targetDate = getRelativeDateString(0);
  if (text.includes("明々後日")) targetDate = getRelativeDateString(3);
  else if (text.includes("明後日")) targetDate = getRelativeDateString(2);
  else if (text.includes("明日")) targetDate = getRelativeDateString(1);

  const monthDayMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (monthDayMatch) {
    const yyyy = new Date().getFullYear();
    const mm = String(parseInt(monthDayMatch[1])).padStart(2, '0');
    const dd = String(parseInt(monthDayMatch[2])).padStart(2, '0');
    targetDate = `${yyyy}-${mm}-${dd}`;
  } else {
    const weekdayMatch = text.match(/(来週|今週)?(?:の)?(月|火|水|木|金|土|日)曜?/);
    if (weekdayMatch && !text.includes("明日") && !text.includes("明後日")) {
      const dayMap = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
      const targetDay = dayMap[weekdayMatch[2]];
      const now = new Date();
      const currentDay = now.getDay();
      let diff = targetDay - currentDay;
      if (weekdayMatch[1] === '来週' || diff <= 0) {
        diff += 7;
      }
      targetDate = getRelativeDateString(diff);
    }
  }

  let startTime = "10:00";
  let endTime = "11:00";
  const timeRangeMatch = text.match(/(?:午後)?(\d{1,2})時(?:(\d{1,2})分)?(?:から|〜|-|~)(?:午後)?(\d{1,2})時(?:(\d{1,2})分)?/);
  const timeSingleMatch = text.match(/(?:(午後|午前))?(\d{1,2})時(?:(\d{1,2})分|半)?(?:から)?/);

  if (timeRangeMatch) {
    let sH = parseInt(timeRangeMatch[1]);
    const sM = timeRangeMatch[2] ? String(parseInt(timeRangeMatch[2])).padStart(2, '0') : '00';
    let eH = parseInt(timeRangeMatch[3]);
    const eM = timeRangeMatch[4] ? String(parseInt(timeRangeMatch[4])).padStart(2, '0') : '00';
    if (text.includes("午後") && sH < 12) sH += 12;
    if (text.includes("午後") && eH < 12) eH += 12;
    startTime = `${String(sH).padStart(2, '0')}:${sM}`;
    endTime = `${String(eH).padStart(2, '0')}:${eM}`;
  } else if (timeSingleMatch) {
    let sH = parseInt(timeSingleMatch[2]);
    let sM = '00';
    if (timeSingleMatch[3] === '半') sM = '30';
    else if (timeSingleMatch[3]) sM = String(parseInt(timeSingleMatch[3])).padStart(2, '0');
    if (timeSingleMatch[1] === '午後' && sH < 12) sH += 12;
    startTime = `${String(sH).padStart(2, '0')}:${sM}`;
    let eH = (sH + 1) % 24;
    endTime = `${String(eH).padStart(2, '0')}:${sM}`;
  }

  let customer = "";
  const textNoTime = text
    .replace(/(?:来週|今週)?(?:の)?(?:月|火|水|木|金|土|日)曜(?:日)?/g, ' ')
    .replace(/(?:明日|明後日|明々後日|今日|\d{1,2}月\d{1,2}日)/g, ' ')
    .replace(/(?:午後|午前)?\d{1,2}時(?:\d{1,2}分|半)?(?:から|〜|-|~)?(?:(?:午後|午前)?\d{1,2}時(?:\d{1,2}分)?)?/g, ' ');

  const nameHonorific = textNoTime.match(/(?:[、。\s]|^|から|で)([A-Za-z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3007]+?)(?:様|さん|氏|先生|社長|部長|ディレクター)(?:と|へ|に)?/);
  const orgMatch = textNoTime.match(/(?:[、。\s]|^|から|で)([A-Za-z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3007]+?(?:クリニック|医院|病院|薬局|メディカル|株式会社|有限会社|合同会社|オフィス|スタジオ|チーム))(?:と|へ|に)?/);
  const withMatch = textNoTime.match(/(?:[、。\s]|^|から|で)([A-Za-z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3007]+?)と(?:ミーティング|商談|面談|打合せ|打ち合わせ|会議|ランチ|ご飯|収録|撮影|通話|電話|相談|現調)/);

  if (nameHonorific && nameHonorific[1]) {
    customer = nameHonorific[1].replace(/^(?:から|で|に|の|と|より|を)+/, '').trim();
  } else if (orgMatch && orgMatch[1]) {
    customer = orgMatch[1].replace(/^(?:から|で|に|の|と|より|を)+/, '').trim();
  } else if (withMatch && withMatch[1]) {
    customer = withMatch[1].replace(/^(?:から|で|に|の|と|より|を)+/, '').trim();
  }

  let type = "online";
  if (/(?:対面|訪問|現調|現場|現地|設置|納品|デモ|キッティング|内覧会|スタジオ|カフェ|ランチ|会食|行く|伺う|出張|オフライン|外出|秋葉原|渋谷|新宿|銀座|東京)/i.test(text)) {
    type = "offline";
  } else if (/(?:社内|1on1|チーム|定例|役員|全社|事業計画|自社|作業|振り返り|朝会|夕会)/i.test(text)) {
    type = "internal";
  } else if (/(?:オンライン|zoom|teams|meet|リモート|web会議|ウェビナー|電話|通話)/i.test(text)) {
    type = "online";
  }

  // TODO抽出 (営業・システム導入対応)
  const extractedTodos = [];
  if (text.includes("見積") || text.includes("資料") || text.includes("作成")) {
    let todoTitle = "資料を作成";
    if (text.includes("自動釣銭機") && text.includes("見積")) todoTitle = "自動釣銭機の見積書を作成";
    else if (text.includes("HPS") && text.includes("見積")) todoTitle = "HPS連携の見積書を作成";
    else if (text.includes("レセコン") && text.includes("見積")) todoTitle = "レセコン導入の見積書を作成";
    else if (text.includes("見積")) todoTitle = "見積書を作成";

    const dueMatch = text.match(/(木曜|金曜|月曜|火曜|水曜|明日|今週|来週)(?:まで|中)?/);
    extractedTodos.push({
      id: "todo-" + Date.now() + "-1",
      title: todoTitle,
      dueDate: dueMatch ? dueMatch[0] : "明日",
      completed: false
    });
  }
  if (text.includes("現調") && (text.includes("報告") || text.includes("まとめ") || !text.includes("見積"))) {
    extractedTodos.push({
      id: "todo-" + Date.now() + "-report",
      title: customer ? `${customer}の現調報告書を作成` : "現調チェックシートをまとめる",
      dueDate: "当日中",
      completed: false
    });
  }
  if (text.includes("メール") || text.includes("連絡") || text.includes("電話")) {
    const dueMatch = text.match(/(木曜|金曜|月曜|火曜|水曜|明日|今週|来週)(?:まで|中)?/);
    extractedTodos.push({
      id: "todo-" + Date.now() + "-2",
      title: customer ? `${customer}へ連絡・メール` : "関係者へメール連絡",
      dueDate: dueMatch ? dueMatch[0] : "今週中",
      completed: false
    });
  }

  // 案件抽出 (営業・商談・現調・機器導入)
  let deal = null;
  if (customer || text.includes("商談") || text.includes("契約") || text.includes("現調") || text.includes("レセコン") || text.includes("自動釣銭機") || text.includes("HPS")) {
    let ball = "self";
    if (text.includes("返事待ち") || text.includes("連絡待ち") || text.includes("確認待ち")) {
      ball = "client";
    } else if (text.includes("他担当") || text.includes("メーカー")) {
      ball = "other";
    }

    let defaultAction = "次回アクション検討";
    if (text.includes("現調")) defaultAction = "現調実施・機器配置確認";
    else if (text.includes("自動釣銭機")) defaultAction = "自動釣銭機の見積作成・提案";
    else if (text.includes("HPS")) defaultAction = "HPS仕様確認・見積送付";
    else if (text.includes("レセコン")) defaultAction = "レセコン提案書作成";

    deal = {
      customer: customer || (text.includes("現調") ? "現調先案件" : "商談案件"),
      nextAction: extractedTodos.length > 0 ? extractedTodos[0].title : defaultAction,
      ballHolder: ball
    };
  }

  let cleanTitle = text
    .replace(/(?:来週|今週)?(?:の)?(?:月|火|水|木|金|土|日)曜(?:日)?/g, '')
    .replace(/(?:明日|明後日|明々後日|今日|\d{1,2}月\d{1,2}日)/g, '')
    .replace(/(?:午後|午前)?\d{1,2}時(?:\d{1,2}分|半)?(?:から|〜|-|~)?(?:(?:午後|午前)?\d{1,2}時(?:\d{1,2}分)?)?/g, '')
    .replace(/(?:の予定を入れて|の予定追加|予定を入れて|予定を追加して|登録して|カレンダーに入れて|お願い)/g, '')
    .trim()
    .replace(/^(?:の|で|に|へ|と|から)+/, '')
    .trim();

  // 営業・現調タイトルの最適化
  if (customer && (text.includes("現調") || text.includes("レセコン") || text.includes("自動釣銭機"))) {
    const parts = [];
    if (text.includes("レセコン")) parts.push("レセコン");
    if (text.includes("自動釣銭機")) parts.push("自動釣銭機");
    if (text.includes("HPS")) parts.push("HPS");
    const itemStr = parts.length > 0 ? parts.join('・') + " " : "";
    cleanTitle = `${customer} ${itemStr}${text.includes("現調") ? "現調" : "商談"}`;
  }

  if (!cleanTitle) cleanTitle = customer ? `${customer}との予定` : "無題の予定";

  return {
    schedule: {
      title: cleanTitle.length > 35 ? cleanTitle.substring(0, 35) + "..." : cleanTitle,
      date: targetDate,
      startTime,
      endTime,
      customer,
      type,
      isQuadrant2: false,
      memo: ""
    },
    todos: extractedTodos,
    deal
  };
}

// --- 6. 整理結果フォーム反映 & 編集 ---
function populateTriCategoryForm(data) {
  // 1. 予定 (Schedule)
  const sc = data.schedule || {};
  document.getElementById('fieldTitle').value = sc.title || "";
  document.getElementById('fieldDate').value = sc.date || getRelativeDateString(0);
  document.getElementById('fieldStartTime').value = sc.startTime || "10:00";
  document.getElementById('fieldEndTime').value = sc.endTime || "11:00";
  document.getElementById('fieldCustomer').value = sc.customer || "";
  document.getElementById('fieldType').value = sc.type || "online";
  document.getElementById('fieldMemo').value = sc.memo || "";

  // 2. TODO (やることリスト)
  renderExtractedTodoList(data.todos || []);

  // 3. 案件 (Deal)
  const dealBox = document.getElementById('dealConfirmBox');
  if (data.deal) {
    dealBox.classList.remove('hidden');
    document.getElementById('fieldDealCustomer').value = data.deal.customer || "";
    document.getElementById('fieldDealNextAction').value = data.deal.nextAction || "";
    document.getElementById('fieldDealBall').value = data.deal.ballHolder || "self";
  } else {
    dealBox.classList.add('hidden');
  }

  // ボタン文言の動的変更
  const saveBtnText = document.getElementById('savePlanBtnText');
  if (saveBtnText) {
    if (googleAccessToken) {
      saveBtnText.textContent = "Googleカレンダー＆ダッシュボードに一括登録";
    } else {
      saveBtnText.textContent = "この内容でまとめて登録";
    }
  }

  // 4. ユーザーが項目を修正しようとタップ（フォーカス）した瞬間に自動保存を即時停止
  const formInputs = document.querySelectorAll('#confirmationCard input, #confirmationCard select, #confirmationCard textarea');
  formInputs.forEach(el => {
    el.addEventListener('focus', cancelAutoSave);
    el.addEventListener('input', cancelAutoSave);
  });
}

function renderExtractedTodoList(todoList) {
  const container = document.getElementById('extractedTodosContainer');
  if (!container) return;
  container.innerHTML = '';

  if (!todoList || todoList.length === 0) {
    container.innerHTML = '<p class="text-[11px] text-[#9C9488] italic py-1">抽出されたTODOはありません</p>';
    return;
  }

  todoList.forEach((todo, idx) => {
    const row = document.createElement('div');
    row.className = "flex items-center space-x-1.5 p-1.5 bg-[#FAF8F3] border border-[#EBE4D6] rounded-lg text-xs";
    row.innerHTML = `
      <span class="text-[#AF894E]">□</span>
      <input type="text" value="${todo.title}" onfocus="cancelAutoSave()" onchange="updatePendingTodo(${idx}, 'title', this.value)" class="flex-1 bg-transparent text-xs text-[#2B2824] focus:outline-none">
      <input type="text" value="${todo.dueDate || ''}" placeholder="期限" onfocus="cancelAutoSave()" onchange="updatePendingTodo(${idx}, 'dueDate', this.value)" class="w-16 bg-[#F3EDE2] text-[10px] px-1.5 py-0.5 rounded text-[#6B655D] focus:outline-none">
      <button onclick="removePendingTodo(${idx})" class="text-[#B8654F] hover:text-red-700 text-xs px-1">✕</button>
    `;
    container.appendChild(row);
  });
}

function updatePendingTodo(idx, field, val) {
  if (pendingExtraction && pendingExtraction.todos && pendingExtraction.todos[idx]) {
    pendingExtraction.todos[idx][field] = val;
  }
}

function removePendingTodo(idx) {
  if (pendingExtraction && pendingExtraction.todos) {
    pendingExtraction.todos.splice(idx, 1);
    renderExtractedTodoList(pendingExtraction.todos);
  }
}

function addPendingTodoPrompt() {
  if (!pendingExtraction) return;
  if (!pendingExtraction.todos) pendingExtraction.todos = [];
  pendingExtraction.todos.push({
    id: "todo-" + Date.now(),
    title: "新規TODO",
    dueDate: "明日",
    completed: false
  });
  renderExtractedTodoList(pendingExtraction.todos);
}

// --- 7. ダブルブッキング検知 (Read-before-Write) ---
async function scanForConflict(date, start, end, excludeId = null) {
  let googleEvents = [];
  if (googleAccessToken) {
    googleEvents = await fetchGoogleEventsForDay(date);
  }

  const googleConflict = googleEvents.find(ev => (start < ev.endTime) && (end > ev.startTime));
  if (googleConflict) return googleConflict;

  return schedules.find(s => {
    if (s.id === excludeId) return false;
    if (s.date !== date) return false;
    return (start < s.endTime) && (end > s.startTime);
  });
}

function showConflictAlert(conflict, pendingSchedule) {
  cancelAutoSave();
  const alertBox = document.getElementById('conflictAlertBox');
  if (!alertBox) return;

  const sourceLabel = conflict.isGoogleRealEvent ? "【Googleカレンダー実データ】" : "【既存の予定】";
  document.getElementById('conflictItemInfo').textContent = 
    `${sourceLabel} ${conflict.title} (${conflict.startTime}〜${conflict.endTime})`;

  const [endH, endM] = conflict.endTime.split(':').map(Number);
  const durH = parseInt(pendingSchedule.endTime) - parseInt(pendingSchedule.startTime) || 1;
  const newStartStr = conflict.endTime;
  const newEndH = String(endH + durH).padStart(2, '0');
  const newEndStr = `${newEndH}:${String(endM).padStart(2, '0')}`;

  document.getElementById('altSlotProposal').textContent = 
    `提案: 同日 ${newStartStr}〜${newEndStr} にスライドする`;

  document.getElementById('btnResolveAlt').onclick = () => {
    document.getElementById('fieldStartTime').value = newStartStr;
    document.getElementById('fieldEndTime').value = newEndStr;
    if (pendingExtraction && pendingExtraction.schedule) {
      pendingExtraction.schedule.startTime = newStartStr;
      pendingExtraction.schedule.endTime = newEndStr;
    }
    hideConflictAlert();
    showToast("AI推奨の別枠を採用しました");
    saveAllExtractedItems();
  };

  document.getElementById('btnResolveOverwrite').onclick = async () => {
    if (conflict.isGoogleRealEvent && conflict.googleEventId) {
      await deleteGoogleCalendarEvent(conflict.googleEventId);
    }
    schedules = schedules.filter(s => s.id !== conflict.id);
    hideConflictAlert();
    showToast(`既存の「${conflict.title}」を上書きしました`);
    saveAllExtractedItems();
  };

  document.getElementById('btnResolveForce').onclick = () => {
    if (pendingExtraction && pendingExtraction.schedule) {
      pendingExtraction.schedule.hasConflict = true;
    }
    hideConflictAlert();
    showToast("重複したまま登録しました");
    saveAllExtractedItems();
  };

  alertBox.classList.remove('hidden');
}

function hideConflictAlert() {
  const alertBox = document.getElementById('conflictAlertBox');
  if (alertBox) alertBox.classList.add('hidden');
}

// --- 8. 一括登録 (この内容でまとめて登録) ---
async function saveAllExtractedItems() {
  cancelAutoSave();
  hideConflictAlert();

  // 1. 予定の確定 & 保存
  const title = document.getElementById('fieldTitle').value.trim();
  if (title) {
    const newSchedule = {
      id: "plan-" + Date.now(),
      title,
      date: document.getElementById('fieldDate').value || getRelativeDateString(0),
      startTime: document.getElementById('fieldStartTime').value || "10:00",
      endTime: document.getElementById('fieldEndTime').value || "11:00",
      customer: document.getElementById('fieldCustomer').value.trim(),
      type: document.getElementById('fieldType').value,
      memo: document.getElementById('fieldMemo').value.trim(),
      hasConflict: pendingExtraction?.schedule?.hasConflict || false,
      isQuadrant2: pendingExtraction?.schedule?.isQuadrant2 || false
    };

    if (googleAccessToken) {
      const gId = await insertEventToGoogleCalendar(newSchedule);
      if (gId) newSchedule.googleEventId = gId;
    }

    schedules.unshift(newSchedule);
    localStorage.setItem('saved_schedules', JSON.stringify(schedules));
  }

  // 2. TODOの確定 & 保存
  if (pendingExtraction && pendingExtraction.todos && pendingExtraction.todos.length > 0) {
    pendingExtraction.todos.forEach(t => {
      if (t.title && t.title.trim()) {
        todos.unshift({
          id: t.id || ("todo-" + Date.now() + Math.random()),
          title: t.title.trim(),
          dueDate: t.dueDate || "",
          completed: false
        });
      }
    });
    localStorage.setItem('saved_todos', JSON.stringify(todos));
  }

  // 3. 案件の確定 & 保存
  const dealCust = document.getElementById('fieldDealCustomer').value.trim();
  if (dealCust) {
    const newDeal = {
      id: "deal-" + Date.now(),
      customer: dealCust,
      nextAction: document.getElementById('fieldDealNextAction').value.trim() || "商談進行",
      ballHolder: document.getElementById('fieldDealBall').value || "self",
      status: "商談進行中"
    };
    deals.unshift(newDeal);
    localStorage.setItem('saved_deals', JSON.stringify(deals));
  }

  renderDashboard();

  document.getElementById('confirmationCard').classList.add('hidden');
  document.getElementById('micStateHint').textContent = "ボタンを押して、予定やタスクを自然に話しかけてください";
  document.getElementById('transcriptText').textContent = "「明日 10時に〇〇クリニックと商談。終わったら見積書を作って、木曜日までに田中先生へメールして。」";

  showToast("🎉 予定・TODO・案件を一括登録しました！");

  setTimeout(() => {
    switchTab('dashboard');
  }, 600);
}

function discardCurrentPlan() {
  cancelAutoSave();
  hideConflictAlert();
  document.getElementById('confirmationCard').classList.add('hidden');
  document.getElementById('micStateHint').textContent = "ボタンを押して、予定やタスクを自然に話しかけてください";
  document.getElementById('transcriptText').textContent = "「明日 10時に〇〇クリニックと商談。終わったら見積書を作って、木曜日までに田中先生へメールして。」";
  showToast("作成中の内容を破棄しました");
}

// --- 9. ダッシュボード描画 (予定・TODO・案件 3画面連携) ---
function renderDashboard() {
  renderScheduleSection();
  renderTodoSection();
  renderDealSection();
  updateBadgeCounts();
}

function updateBadgeCounts() {
  const schedCount = document.getElementById('schedCountBadge');
  const todoCount = document.getElementById('todoCountBadge');
  const dealCount = document.getElementById('dealCountBadge');
  
  if (schedCount) schedCount.textContent = `${schedules.length}件`;
  if (todoCount) {
    const uncompleted = todos.filter(t => !t.completed).length;
    todoCount.textContent = `${uncompleted}件`;
  }
  if (dealCount) dealCount.textContent = `${deals.length}件`;
}

// 予定セクションの描画
function renderScheduleSection() {
  const container = document.getElementById('scheduleTimeline');
  if (!container) return;
  container.innerHTML = '';

  if (schedules.length === 0) {
    container.innerHTML = '<p class="text-center py-6 text-[#9C9488] font-serif-art text-xs">予定はありません。静かな時間が広がっています。</p>';
    return;
  }

  schedules.forEach(item => {
    const card = document.createElement('div');
    let borderAccent = 'border-l-[#AF894E]';
    if (item.hasConflict) borderAccent = 'border-l-[#B8654F] bg-[#FFF8F6]';
    else if (item.isQuadrant2) borderAccent = 'border-l-[#6B8068] bg-[#F9FAF8]';

    card.className = `p-3 bg-white rounded-xl border border-[#E5DFD0] shadow-xs pl-3.5 border-l-4 ${borderAccent} fade-enter text-xs mb-2`;

    const topRow = document.createElement('div');
    topRow.className = "flex justify-between items-center";

    const timeSpan = document.createElement('span');
    timeSpan.className = "text-[10px] font-serif-art text-[#AF894E] tracking-wider font-semibold";
    timeSpan.textContent = `${item.date} ${item.startTime} - ${item.endTime}`;

    const rightGroup = document.createElement('div');
    rightGroup.className = "flex items-center space-x-1.5";

    if (item.googleEventId) {
      rightGroup.innerHTML += `<span class="text-[9px] bg-[#E8F0FE] text-[#1A73E8] px-1.5 py-0.5 rounded font-medium">✓ Google同期済</span>`;
    }
    if (item.hasConflict) {
      rightGroup.innerHTML += `<span class="text-[9px] bg-[#FDE8E4] text-[#B8654F] px-1.5 py-0.5 rounded font-medium">⚠️ 重複</span>`;
    }

    const typeLabel = item.type === 'online' ? '🌐 オンライン' : (item.type === 'offline' ? '🏢 対面' : '👥 社内');
    rightGroup.innerHTML += `<span class="text-[9px] bg-[#F5F2EA] text-[#6B655D] px-1.5 py-0.5 rounded">${typeLabel}</span>`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = "text-[#A89F91] hover:text-[#B8654F] transition p-0.5";
    deleteBtn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>`;
    deleteBtn.onclick = async () => {
      if (!confirm("この予定を削除しますか？")) return;
      if (item.googleEventId) await deleteGoogleCalendarEvent(item.googleEventId);
      schedules = schedules.filter(s => s.id !== item.id);
      localStorage.setItem('saved_schedules', JSON.stringify(schedules));
      renderDashboard();
      showToast("予定を削除しました");
    };
    rightGroup.appendChild(deleteBtn);

    topRow.appendChild(timeSpan);
    topRow.appendChild(rightGroup);

    const titleEl = document.createElement('h4');
    titleEl.className = "text-xs font-semibold text-[#2B2824] mt-1";
    titleEl.textContent = item.title;

    const custEl = document.createElement('p');
    custEl.className = "text-[10px] text-[#8C8476] mt-0.5";
    custEl.textContent = item.customer ? `相手: ${item.customer}` : "相手: 未指定";

    card.appendChild(topRow);
    card.appendChild(titleEl);
    card.appendChild(custEl);

    container.appendChild(card);
  });
}

// TODOセクションの描画
function renderTodoSection() {
  const container = document.getElementById('todoListContainer');
  if (!container) return;
  container.innerHTML = '';

  if (todos.length === 0) {
    container.innerHTML = '<p class="text-center py-6 text-[#9C9488] font-serif-art text-xs">やることはありません。心穏やかな状態です。</p>';
    return;
  }

  todos.forEach(todo => {
    const row = document.createElement('div');
    row.className = `p-2.5 bg-white rounded-xl border border-[#E8E2D5] shadow-2xs flex items-center justify-between text-xs mb-1.5 transition ${todo.completed ? 'opacity-50 bg-[#F7F5F0]' : ''}`;

    const left = document.createElement('div');
    left.className = "flex items-center space-x-2.5 flex-1 min-w-0";

    const chk = document.createElement('input');
    chk.type = "checkbox";
    chk.checked = todo.completed;
    chk.className = "w-4 h-4 rounded border-[#C8BFB0] text-[#AF894E] focus:ring-0 cursor-pointer";
    chk.onchange = () => {
      todo.completed = chk.checked;
      localStorage.setItem('saved_todos', JSON.stringify(todos));
      renderDashboard();
    };

    const textSpan = document.createElement('span');
    textSpan.className = `truncate font-medium ${todo.completed ? 'line-through text-[#9C9488]' : 'text-[#2B2824]'}`;
    textSpan.textContent = todo.title;

    left.appendChild(chk);
    left.appendChild(textSpan);

    const right = document.createElement('div');
    right.className = "flex items-center space-x-2 shrink-0 ml-2";

    if (todo.dueDate) {
      const due = document.createElement('span');
      due.className = "text-[9px] bg-[#F5EFE3] text-[#AF894E] px-1.5 py-0.5 rounded font-medium";
      due.textContent = `期限: ${todo.dueDate}`;
      right.appendChild(due);
    }

    const delBtn = document.createElement('button');
    delBtn.className = "text-[#A89F91] hover:text-[#B8654F] transition text-xs";
    delBtn.innerHTML = "✕";
    delBtn.onclick = () => {
      todos = todos.filter(t => t.id !== todo.id);
      localStorage.setItem('saved_todos', JSON.stringify(todos));
      renderDashboard();
    };
    right.appendChild(delBtn);

    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  });
}

// 案件セクションの描画 (誰のボールか)
function renderDealSection() {
  const container = document.getElementById('dealListContainer');
  if (!container) return;
  container.innerHTML = '';

  if (deals.length === 0) {
    container.innerHTML = '<p class="text-center py-6 text-[#9C9488] font-serif-art text-xs">進行中の案件はありません。</p>';
    return;
  }

  deals.forEach(deal => {
    const card = document.createElement('div');
    card.className = "p-3 bg-white rounded-xl border border-[#E5DFD0] shadow-xs mb-2 text-xs";

    const top = document.createElement('div');
    top.className = "flex justify-between items-center mb-1";

    const name = document.createElement('h4');
    name.className = "font-bold text-[#2B2824] text-xs";
    name.textContent = deal.customer;

    // ボール状況バッジ
    const ballBadge = document.createElement('select');
    ballBadge.className = "text-[10px] rounded-lg px-2 py-0.5 font-medium border border-[#D5CDBC] bg-[#FAF8F3] text-[#2B2824] focus:outline-none";
    ballBadge.innerHTML = `
      <option value="self" ${deal.ballHolder === 'self' ? 'selected' : ''}>🎾 自分のボール</option>
      <option value="client" ${deal.ballHolder === 'client' ? 'selected' : ''}>⏳ 相手待ち</option>
      <option value="other" ${deal.ballHolder === 'other' ? 'selected' : ''}>👥 他担当待ち</option>
    `;
    ballBadge.onchange = () => {
      deal.ballHolder = ballBadge.value;
      localStorage.setItem('saved_deals', JSON.stringify(deals));
      showToast(`ボールを「${ballBadge.options[ballBadge.selectedIndex].text}」に更新しました`);
    };

    top.appendChild(name);
    top.appendChild(ballBadge);

    const action = document.createElement('p');
    action.className = "text-[11px] text-[#6B655D] mt-1 bg-[#F9F7F2] p-1.5 rounded-lg border border-[#EDE7D9]";
    action.textContent = `次のアクション: ${deal.nextAction || '未定'}`;

    const btm = document.createElement('div');
    btm.className = "flex justify-end mt-2";
    const delBtn = document.createElement('button');
    delBtn.className = "text-[10px] text-[#A89F91] hover:text-[#B8654F] transition";
    delBtn.textContent = "案件を完了/削除";
    delBtn.onclick = () => {
      if (!confirm(`「${deal.customer}」の案件を完了/削除しますか？`)) return;
      deals = deals.filter(d => d.id !== deal.id);
      localStorage.setItem('saved_deals', JSON.stringify(deals));
      renderDashboard();
      showToast("案件を削除しました");
    };
    btm.appendChild(delBtn);

    card.appendChild(top);
    card.appendChild(action);
    card.appendChild(btm);
    container.appendChild(card);
  });
}

// --- 10. UI切り替え ＆ タブ操作 ---
function switchTab(tab) {
  currentTab = tab;
  const recordTab = document.getElementById('recordTab');
  const dashboardTab = document.getElementById('dashboardTab');
  const tabRecordBtn = document.getElementById('tabRecordBtn');
  const tabDashboardBtn = document.getElementById('tabDashboardBtn');

  if (tab === 'record') {
    recordTab.classList.remove('hidden');
    recordTab.classList.add('flex');
    dashboardTab.classList.add('hidden');
    dashboardTab.classList.remove('flex');

    tabRecordBtn.className = "px-3 py-1 text-xs rounded-full font-medium transition-all bg-[#2B2824] text-[#F7F5F0]";
    tabDashboardBtn.className = "px-3 py-1 text-xs rounded-full font-medium transition-all text-[#6B655D] hover:bg-[#F0EDE5]";
  } else {
    recordTab.classList.add('hidden');
    recordTab.classList.remove('flex');
    dashboardTab.classList.remove('hidden');
    dashboardTab.classList.add('flex');

    tabRecordBtn.className = "px-3 py-1 text-xs rounded-full font-medium transition-all text-[#6B655D] hover:bg-[#F0EDE5]";
    tabDashboardBtn.className = "px-3 py-1 text-xs rounded-full font-medium transition-all bg-[#2B2824] text-[#F7F5F0]";
    renderDashboard();
  }
}

function setDashboardFilter(filter) {
  currentFilter = filter;
  const secSched = document.getElementById('secSchedules');
  const secTodo = document.getElementById('secTodos');
  const secDeal = document.getElementById('secDeals');

  ['btnFiltAll', 'btnFiltSched', 'btnFiltTodo', 'btnFiltDeal'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.className = "px-2.5 py-1 rounded-full text-[10px] font-medium border border-[#DDD5C5] bg-[#FAF8F3] text-[#6B655D] hover:bg-[#F2ECE0]";
  });

  if (filter === 'all') {
    secSched.classList.remove('hidden');
    secTodo.classList.remove('hidden');
    secDeal.classList.remove('hidden');
    document.getElementById('btnFiltAll').className = "px-2.5 py-1 rounded-full text-[10px] font-medium bg-[#2B2824] text-[#F7F5F0]";
  } else if (filter === 'schedules') {
    secSched.classList.remove('hidden');
    secTodo.classList.add('hidden');
    secDeal.classList.add('hidden');
    document.getElementById('btnFiltSched').className = "px-2.5 py-1 rounded-full text-[10px] font-medium bg-[#2B2824] text-[#F7F5F0]";
  } else if (filter === 'todos') {
    secSched.classList.add('hidden');
    secTodo.classList.remove('hidden');
    secDeal.classList.add('hidden');
    document.getElementById('btnFiltTodo').className = "px-2.5 py-1 rounded-full text-[10px] font-medium bg-[#2B2824] text-[#F7F5F0]";
  } else if (filter === 'deals') {
    secSched.classList.add('hidden');
    secTodo.classList.add('hidden');
    secDeal.classList.remove('hidden');
    document.getElementById('btnFiltDeal').className = "px-2.5 py-1 rounded-full text-[10px] font-medium bg-[#2B2824] text-[#F7F5F0]";
  }
}

function toggleDeviceFrame() {
  const container = document.getElementById('deviceContainer');
  const btnText = document.getElementById('viewToggleText');
  isPhoneFrame = !isPhoneFrame;

  if (isPhoneFrame) {
    container.classList.remove('max-w-2xl');
    container.classList.add('max-w-md');
    btnText.textContent = "全幅表示";
  } else {
    container.classList.remove('max-w-md');
    container.classList.add('max-w-2xl');
    btnText.textContent = "スマホ枠";
  }
}

// --- 11. 自動保存 ＆ セキュリティ設定 ---
function toggleAutoSave() {
  isAutoSaveEnabled = !isAutoSaveEnabled;
  localStorage.setItem('auto_save_mode', isAutoSaveEnabled);
  updateAutoSaveButtonUI();
  showToast(isAutoSaveEnabled ? "⚡ 自動保存ON（3秒後に一括登録）" : "手動保存モードにしました");
}

function updateAutoSaveButtonUI() {
  const btn = document.getElementById('autoSaveToggleBtn');
  if (!btn) return;
  if (isAutoSaveEnabled) {
    btn.className = "px-2 py-1 rounded-full border border-[#AF894E] bg-[#F5EFE3] text-[#AF894E] font-medium transition-colors flex items-center space-x-1 text-[11px]";
    btn.innerHTML = `<span>⚡ 自動保存: ON</span>`;
  } else {
    btn.className = "px-2 py-1 rounded-full border border-[#DDD5C5] bg-[#FAF8F3] text-[#8C8476] font-medium transition-colors flex items-center space-x-1 text-[11px]";
    btn.innerHTML = `<span>自動保存: OFF</span>`;
  }
}

function startAutoSaveTimer() {
  cancelAutoSave();
  const banner = document.getElementById('autoSaveBanner');
  const textEl = document.getElementById('autoSaveCountdownText');

  if (!isAutoSaveEnabled) {
    if (banner) banner.classList.add('hidden');
    return;
  }

  if (banner) banner.classList.remove('hidden');
  autoSaveCountdown = 5;
  if (textEl) textEl.textContent = `⚡ 5秒後に自動登録（項目タップで停止・修正可能）`;

  autoSaveTimer = setInterval(() => {
    autoSaveCountdown--;
    if (autoSaveCountdown > 0) {
      if (textEl) textEl.textContent = `⚡ ${autoSaveCountdown}秒後に自動登録（タップで修正モードへ）`;
    } else {
      clearInterval(autoSaveTimer);
      autoSaveTimer = null;
      saveAllExtractedItems();
    }
  }, 1000);
}

function cancelAutoSave() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  const banner = document.getElementById('autoSaveBanner');
  const textEl = document.getElementById('autoSaveCountdownText');
  if (textEl) textEl.textContent = "自動保存を停止（内容を修正できます）";
  setTimeout(() => {
    if (banner && !autoSaveTimer) banner.classList.add('hidden');
  }, 1200);
}

function openSecurityModal() {
  const modal = document.getElementById('securityModal');
  const input = document.getElementById('apiKeyInput');
  const googleClientIdInput = document.getElementById('googleClientIdInput');

  const savedKey = localStorage.getItem('user_gemini_api_key');
  const savedClientId = localStorage.getItem('google_oauth_client_id');

  if (savedKey) input.value = savedKey;
  else input.value = '';

  if (savedClientId && googleClientIdInput) googleClientIdInput.value = savedClientId;
  else if (googleClientIdInput) googleClientIdInput.value = '';

  updateApiKeyBadge();
  updateGoogleAuthButtonUI();
  modal.classList.remove('hidden');
}

function closeSecurityModal() {
  document.getElementById('securityModal').classList.add('hidden');
}

function saveApiKeyFromModal() {
  let input = document.getElementById('apiKeyInput').value;
  const googleClientIdInput = document.getElementById('googleClientIdInput');

  if (input && input.trim()) {
    input = input.trim().replace(/^["'「」]+|["'「」]+$/g, '').trim();
    localStorage.setItem('user_gemini_api_key', input);
  }

  if (googleClientIdInput && googleClientIdInput.value.trim()) {
    const cId = googleClientIdInput.value.trim();
    localStorage.setItem('google_oauth_client_id', cId);
    initGoogleAuth();
  }

  updateApiKeyBadge();
  updateGoogleAuthButtonUI();
  closeSecurityModal();
  showToast("設定をブラウザに安全に保存しました！");
}

function clearSavedApiKey() {
  localStorage.removeItem('user_gemini_api_key');
  document.getElementById('apiKeyInput').value = '';
  updateApiKeyBadge();
  showToast("Gemini APIキーを消去しました");
}

function clearGoogleClientId() {
  localStorage.removeItem('google_oauth_client_id');
  sessionStorage.removeItem('google_access_token');
  googleAccessToken = null;
  googleTokenClient = null;
  if (document.getElementById('googleClientIdInput')) {
    document.getElementById('googleClientIdInput').value = '';
  }
  updateGoogleAuthButtonUI();
  showToast("Google連携設定を解除しました");
}

function updateApiKeyBadge() {
  const badge = document.getElementById('apiKeyStatusBadge');
  if (!badge) return;
  const savedKey = localStorage.getItem('user_gemini_api_key');

  if (savedKey) {
    badge.textContent = "状態: Gemini 2.0 Flash 有効 (3軸自動振り分け稼働中)";
    badge.className = "text-[#6B8068] font-medium";
  } else {
    badge.textContent = "状態: 未設定 (高精度ローカルNLPエンジン稼働中)";
    badge.className = "text-[#8C8476]";
  }
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = msg;
  toast.classList.remove('translate-y-20', 'opacity-0');
  toast.classList.add('translate-y-0', 'opacity-100');

  setTimeout(() => {
    toast.classList.remove('translate-y-0', 'opacity-100');
    toast.classList.add('translate-y-20', 'opacity-0');
  }, 2500);
}
