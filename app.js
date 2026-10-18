/**
 * 松江・出雲バスナビ - メインアプリケーション (完全ローカルGTFSパース版)
 * 松江市交通局・一畑バスの公式GTFS-JPオープンデータ (gtfs.zip) をブラウザ内で直接解析し、
 * 時刻表検索および直通経路検索を高速・オフラインで提供します。
 */

(() => {
  'use strict';

  console.log('松江・出雲バスナビ v20261018 (GTFS 2026/10/01改正版) Loaded');

  // ===== 定数とストレージキー =====
  const STORAGE_KEY_THEME = 'matsue-local-bus-theme';
  const STORAGE_KEY_HISTORY = 'matsue-bus-history';
  const STORAGE_KEY_FAV_STOPS = 'matsue-bus-fav-stops';
  const STORAGE_KEY_FAV_ROUTES = 'matsue-bus-fav-routes';
  const DEBOUNCE_MS = 200;

  // ===== 状態管理 (localStorage) =====
  const SearchHistoryManager = {
    get() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]'); }
      catch { return []; }
    },
    add(stopName) {
      if (!stopName) return;
      let history = this.get();
      history = history.filter(name => name !== stopName);
      history.unshift(stopName);
      if (history.length > 10) history = history.slice(0, 10);
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
    }
  };

  const FavoritesManager = {
    getStops() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY_FAV_STOPS) || '[]'); }
      catch { return []; }
    },
    toggleStop(stopName) {
      if (!stopName) return false;
      let favs = this.getStops();
      const isFav = favs.includes(stopName);
      if (isFav) {
        favs = favs.filter(name => name !== stopName);
      } else {
        favs.push(stopName);
      }
      localStorage.setItem(STORAGE_KEY_FAV_STOPS, JSON.stringify(favs));
      return !isFav;
    },
    isFavStop(stopName) {
      return this.getStops().includes(stopName);
    },

    getRoutes() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY_FAV_ROUTES) || '[]'); }
      catch { return []; }
    },
    toggleRoute(fromName, toName) {
      if (!fromName || !toName) return false;
      let favs = this.getRoutes();
      const idx = favs.findIndex(r => r.from === fromName && r.to === toName);
      if (idx !== -1) {
        favs.splice(idx, 1);
        localStorage.setItem(STORAGE_KEY_FAV_ROUTES, JSON.stringify(favs));
        return false;
      } else {
        favs.push({ from: fromName, to: toName });
        localStorage.setItem(STORAGE_KEY_FAV_ROUTES, JSON.stringify(favs));
        return true;
      }
    },
    isFavRoute(fromName, toName) {
      return this.getRoutes().some(r => r.from === fromName && r.to === toName);
    }
  };

  // ===== GTFSデータ格納エリア =====
  const gtfsData = {
    feed_info: {},    // { start_date, end_date, version }
    agency: {},       // { agency_id: agency_name }
    stops: [],        // [{ stop_id, stop_name, stop_lat, stop_lon, stop_kana }]
    routes: {},       // { route_id: { route_short_name, route_long_name, agency_id, route_url } }
    trips: {},        // { trip_id: { route_id, service_id, trip_headsign } }
    calendar: {},     // { service_id: { monday...sunday, start_date, end_date } }
    calendar_dates: {}, // { service_id: { YYYYMMDD: exception_type } }
    fares: {},        // { "originBase>destBase": price }
    stop_times: []    // [{ trip_id, arrival_time, departure_time, stop_id, stop_sequence, departure_secs }]
  };

  // 主要乗り継ぎ拠点リスト（直通便が無い/少ない場合の1回乗換探索用）
  const MAJOR_TRANSFER_HUBS = [
    '松江駅',
    '県民会館前',
    '大橋南詰',
    '松江しんじ湖温泉駅',
    'ＪＲ出雲市駅',
    '玉造温泉入口'
  ];

  // 検索・解析を高速化するためのインデックス
  let stopIndex = [];           // オートコンプリート検索用 [{ name, kana, ids, lat, lon }]
  let stopTimesByStopId = {};   // { stop_id: [stop_time_record] }
  let stopTimesByTripId = {};   // { trip_id: [stop_time_record] } (stop_sequence順にソート済み)
  let stopNameById = {};        // { stop_id: stop_name } (逆引きマップ)
  let timetableAutocomplete = null; // 時刻表検索オートコンプリート参照
  let stopLatLngById = {};          // { stop_id: { lat, lon } } (緯度経度逆引き)
  let currentTimetableStopGroup = null; // 時刻表タブで現在選択中のバス停グループ
  let timetableMode = 'now';        // 時刻表表示モード ('now' | 'all')
  let toastTimer = null;            // トースト通知タイマー

  // ===== 各要素取得 =====
  const $ = selector => document.querySelector(selector);
  const $$ = selector => document.querySelectorAll(selector);

  // ===== ユーティリティ関数 =====

  /**
   * 2地点間の距離 (メートル) をハバーシン公式で計算する
   */
  function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球の半径 (m)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * 秒数を HH:MM 形式の時刻文字列に変換
   */
  function formatTime(secs) {
    if (secs == null || isNaN(secs)) return '--:--';
    let totalMinutes = Math.floor(secs / 60);
    let hours = Math.floor(totalMinutes / 60);
    let minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  /**
   * 現在時刻から発車までの残り時間表示
   */
  function formatRemaining(departureSecs) {
    const diff = departureSecs - currentTimeSecs();
    if (diff < 0 || diff > 7200) return null;
    if (diff < 60) return 'まもなく';
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `あと${mins}分`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `あと${h}時間${m}分`;
  }

  /**
   * 本日の0:00からの経過秒数
   */
  function currentTimeSecs() {
    const now = new Date();
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  }

  /**
   * HTML特殊文字のエスケープ
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * 指定した日付 (YYYYMMDD) の曜日名（小文字英語）を取得
   */
  function getDayName(dateStr) {
    const y = parseInt(dateStr.substring(0, 4), 10);
    const m = parseInt(dateStr.substring(4, 6), 10) - 1;
    const d = parseInt(dateStr.substring(6, 8), 10);
    const dateObj = new Date(y, m, d);
    const dayOfWeek = dateObj.getDay();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[dayOfWeek];
  }

  /**
   * 今日の日付を YYYYMMDD 形式で取得
   */
  function todayYYYYMMDD() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * 今日の日付を YYYY-MM-DD 形式で取得
   */
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * 現在時刻を HH:MM 形式で取得
   */
  function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * ひらがなをカタカナに変換する
   */
  function toHiragana(str) {
    return str.replace(/[\u30a1-\u30f6]/g, match => {
      const chr = match.charCodeAt(0) - 0x60;
      return String.fromCharCode(chr);
    });
  }

  /**
   * GTFSの路線名データを簡潔・綺麗に整形する
   */
  /**
   * GTFSの路線名データを簡潔・綺麗に整形する
   * @param {object} trip - trips辞書の値（trip_idフィールドは含まない）
   * @param {object} route - routes辞書の値
   * @param {string} tripId - trips辞書のキー（= GTFS上のtrip_id）
   */
  function getDisplayRouteName(trip, route, tripId) {
    if (!route) return '路線バス';
    let shortName = route.route_short_name || '';
    const longName = route.route_long_name || '';
    
    let routeTitle = '';
    const match = longName.match(/【(.*?)】/);
    if (match && match[1]) {
      routeTitle = match[1];
    } else {
      routeTitle = longName;
    }
    
    // 一畑バスの特別補正（GTFSデータの不整合対応）
    // route_long_nameが「【玉造】」になっているが実際には八雲線の便も含む
    if (route.agency_id === '7280001000972') {
      if (longName.includes('【玉造】')) {
        // trip_idを使って停車順序を取得（tripオブジェクト自体にはtripIdが含まれない）
        const tripStopTimes = stopTimesByTripId[tripId] || [];
        if (tripStopTimes.length > 0) {
          const startStopName = stopNameById[tripStopTimes[0].stop_id] || '';
          const lastStopName = stopNameById[tripStopTimes[tripStopTimes.length - 1].stop_id] || '';
          
          if (startStopName.includes('八雲') || lastStopName.includes('八雲')) {
            // 八雲発着は系統番号31を表示
            routeTitle = '八雲';
            shortName = '31';
          } else {
            // 玉造線には系統番号が存在しない（公式ルール）
            routeTitle = '玉造';
            shortName = '';
          }
        }
        // stop_timesが空の場合はフォールバックとして系統番号を消す
        // （安全側に倒し、玉造として表示）
        if ((stopTimesByTripId[tripId] || []).length === 0) {
          shortName = '';
          routeTitle = '玉造';
        }
      }
    }
    
    return shortName ? `[${shortName}] ${routeTitle}` : routeTitle;
  }

  // ===== オートコンプリートの実装 =====
  function initAutocomplete(opts) {
    const { input, dropdown, clearBtn, onSelect } = opts;
    if (!input || !dropdown) return null; // DOMが取得できない場合の安全ガード
    let query = '';

    const renderDropdown = (items, isHistory = false) => {
      if (items.length === 0) {
        dropdown.innerHTML = '';
        dropdown.classList.remove('visible');
        return;
      }

      dropdown.innerHTML = items.map(item => `
        <div class="autocomplete-item" role="option" data-name="${escapeHtml(item.name)}">
          <span class="autocomplete-item-icon">${isHistory ? '🕒' : '🚌'}</span>
          <div class="autocomplete-item-info">
            <div class="autocomplete-item-name">${escapeHtml(item.name)}</div>
            ${item.kana && !isHistory ? `<div class="autocomplete-item-sub">${escapeHtml(item.kana)}</div>` : ''}
            ${isHistory ? `<div class="autocomplete-item-sub" style="color:var(--text-muted); font-size:10px;">検索履歴</div>` : ''}
          </div>
        </div>
      `).join('');
      dropdown.classList.add('visible');
    };

    const performSearch = () => {
      const val = input.value.trim().toLowerCase();
      if (!val) {
        if (clearBtn) clearBtn.classList.remove('visible');
        const historyNames = SearchHistoryManager.get();
        if (historyNames.length > 0) {
          // 履歴名からダミーのitemオブジェクトを作成
          const historyItems = historyNames.map(name => ({ name: name }));
          renderDropdown(historyItems, true);
        } else {
          renderDropdown([]);
        }
        return;
      }

      if (clearBtn) clearBtn.classList.add('visible');

      const hiraganaVal = toHiragana(val);
      const results = stopIndex.filter(stop => 
        stop.name.toLowerCase().includes(val) || 
        (stop.kana && stop.kana.includes(hiraganaVal))
      ).slice(0, 15);

      renderDropdown(results, false);
    };

    const handleInput = debounce(performSearch, DEBOUNCE_MS);

    input.addEventListener('input', handleInput);
    input.addEventListener('focus', performSearch);

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        renderDropdown([]);
        clearBtn.classList.remove('visible');
        input.focus();
      });
    }

    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.autocomplete-item');
      if (!item) return;
      const stopName = item.dataset.name;
      const selectedStop = stopIndex.find(s => s.name === stopName);
      if (selectedStop) {
        input.value = selectedStop.name;
        renderDropdown([]);
        SearchHistoryManager.add(selectedStop.name);
        onSelect(selectedStop);
      } else {
        // 履歴クリック時のフォールバック処理
        input.value = stopName;
        renderDropdown([]);
        SearchHistoryManager.add(stopName);
        // 仮のstopオブジェクトを渡す（検索ロジック側で名前で解決させるため）
        onSelect({ name: stopName, ids: [] });
      }
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('visible');
      }
    });

    return {
      setQuery(text) {
        input.value = text;
        const selectedStop = stopIndex.find(s => s.name === text);
        if (selectedStop) {
          SearchHistoryManager.add(selectedStop.name);
          onSelect(selectedStop);
        } else {
          performSearch();
        }
      }
    };
  }

  // ===== GTFS解析・インデックス構築 =====

  /**
   * 解析後のCSV配列からインデックスとグループを構築
   */
  function buildIndex() {
    // 0. 停留所名のクレンジングと表記統一（空のカッコや表記ゆれを防ぐ）
    const repNames = {};
    gtfsData.stops.forEach(s => {
      const rawName = s.stop_name || '';
      const baseName = rawName.replace(/\(.*?\)$/, '').replace(/（.*?）$/, '').trim();
      if (!baseName) return;

      const currentRep = repNames[baseName];
      const hasValidKanaInParen = /\(.+?\)$/.test(rawName) || /（.+?）$/.test(rawName);

      if (!currentRep) {
        repNames[baseName] = rawName;
      } else {
        const isCurrentValid = /\(.+?\)$/.test(currentRep) || /（.+?）$/.test(currentRep);
        if (hasValidKanaInParen && !isCurrentValid) {
          repNames[baseName] = rawName;
        } else if (rawName.length > currentRep.length && !rawName.includes('()') && !rawName.includes('（）')) {
          repNames[baseName] = rawName;
        }
      }
    });

    gtfsData.stops.forEach(s => {
      const rawName = s.stop_name || '';
      const baseName = rawName.replace(/\(.*?\)$/, '').replace(/（.*?）$/, '').trim();
      if (repNames[baseName]) {
        s.stop_name = repNames[baseName];
      }
    });

    // 1. stops のグループ化
    const stopsByName = {};
    gtfsData.stops.forEach(s => {
      const name = s.stop_name;
      if (!stopsByName[name]) {
        stopsByName[name] = {
          name: name,
          ids: [],
          lat: 0,
          lon: 0,
          count: 0
        };
      }
      stopsByName[name].ids.push(s.stop_id);
      stopsByName[name].lat += parseFloat(s.stop_lat);
      stopsByName[name].lon += parseFloat(s.stop_lon);
      stopsByName[name].count++;
    });

    stopIndex = Object.values(stopsByName).map(g => {
      const name = g.name;
      const originalStop = gtfsData.stops.find(s => s.stop_name === name);
      const kana = originalStop ? originalStop.stop_kana : '';
      return {
        name: name,
        kana: kana,
        ids: g.ids,
        lat: g.lat / g.count,
        lon: g.lon / g.count
      };
    });

    stopIndex.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    // 逆引き用の停留所名マップおよび緯度経度マップの構築
    stopNameById = {};
    stopLatLngById = {};
    gtfsData.stops.forEach(s => {
      stopNameById[s.stop_id] = s.stop_name;
      stopLatLngById[s.stop_id] = { lat: parseFloat(s.stop_lat), lon: parseFloat(s.stop_lon) };
    });

    // 2. stop_times を stop_id ごと、および trip_id ごとにグループ化
    stopTimesByStopId = {};
    stopTimesByTripId = {};

    gtfsData.stop_times.forEach(st => {
      if (!stopTimesByStopId[st.stop_id]) {
        stopTimesByStopId[st.stop_id] = [];
      }
      stopTimesByStopId[st.stop_id].push(st);

      if (!stopTimesByTripId[st.trip_id]) {
        stopTimesByTripId[st.trip_id] = [];
      }
      stopTimesByTripId[st.trip_id].push(st);
    });

    Object.keys(stopTimesByTripId).forEach(tripId => {
      stopTimesByTripId[tripId].sort((a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10));
    });

    console.log('BuildIndex complete. Unique stops in index:', stopIndex.length);
  }

  /**
   * 2つの標柱ID間の片道運賃（円）を取得する
   */
  function getFare(fromStopId, toStopId) {
    if (!fromStopId || !toStopId || !gtfsData.fares) return null;
    const fromBase = String(fromStopId).split('_')[0];
    const toBase = String(toStopId).split('_')[0];
    return gtfsData.fares[`${fromBase}>${toBase}`] || null;
  }

  /**
   * stop_id から標柱番号（のりば番号）ラベルを取得する
   */
  function getPoleLabel(stopId) {
    if (!stopId) return '';
    const parts = String(stopId).split('_');
    if (parts.length < 2 || !parts[1] || parts[1] === '0') return '';
    return `${parts[1]}番のりば`;
  }

  /**
   * stop_id から公式バスロケーションシステム（接近情報）のURLを生成する
   */
  function getStopBusLocUrl(stopId) {
    if (!stopId) return 'https://mi.bus-navigation.jp/';
    const [base, pole] = String(stopId).split('_');
    if (!base || !pole) return 'https://mi.bus-navigation.jp/';
    return `https://mi.bus-navigation.jp/wgsys/wgp/search.htm??stopcd=${base.padStart(6, '0')}&?poleNumber=${pole}`;
  }

  /**
   * YYYYMMDD 文字列を見やすい「YYYY/MM/DD」形式に整形する
   */
  function formatDateSlash(dateStr) {
    if (!dateStr || dateStr.length !== 8) return dateStr || '';
    return `${dateStr.substring(0, 4)}/${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}`;
  }

  /**
   * トースト通知を表示する
   */
  function showToast(message) {
    const toast = $('#toast-notification');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2600);
  }

  /**
   * 現在の検索状態をURLクエリパラメータに反映する（ディープリンク対応）
   */
  function syncUrlState(params) {
    try {
      const url = new URL(window.location.href);
      url.search = '';
      Object.entries(params).forEach(([k, v]) => {
        if (v != null && v !== '') {
          url.searchParams.set(k, v);
        }
      });
      window.history.replaceState(null, '', url.toString());
    } catch {
      // file:// プロトコル等で replaceState が制限される環境では無視
    }
  }

  /**
   * 現在のURLをクリップボードにコピー（またはWeb Share APIで共有）する
   */
  async function copyShareUrl() {
    const shareUrl = window.location.href;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        showToast('🔗 検索結果のURLをコピーしました');
        return;
      }
    } catch {
      // フォールバックへ進む
    }
    const tempInput = document.createElement('input');
    tempInput.value = shareUrl;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    showToast('🔗 検索結果のURLをコピーしました');
  }

  /**
   * GTFS有効期間外フォールバック時の警告バナー表示を更新する
   */
  function updateFeedNoticeBanner(dateStr, isFallback) {
    const banner = $('#feed-notice-banner');
    if (!banner) return;
    if (!isFallback) {
      banner.innerHTML = '';
      return;
    }
    const startStr = formatDateSlash(gtfsData.feed_info && gtfsData.feed_info.start_date);
    const endStr = formatDateSlash(gtfsData.feed_info && gtfsData.feed_info.end_date);
    const rangeNote = (startStr && endStr) ? `（収録期間: ${startStr}〜${endStr}）` : '';
    banner.innerHTML = `
      <div class="feed-warning-banner fade-in">
        <span>⚠️</span>
        <div>
          指定日（${escapeHtml(formatDateSlash(dateStr))}）はGTFSデータの有効期間外${escapeHtml(rangeNote)}のため、曜日ダイヤに基づく推定時刻を表示しています。
        </div>
      </div>`;
  }

  /**
   * 指定した日付で有効な service_id のセットを取得
   * 有効期間外の日付が指定された場合は曜日判定にフォールバックし、警告バナーを表示する
   */
  function getActiveServicesForDate(dateStr) {
    const activeServices = new Set();
    const dayKey = getDayName(dateStr);

    Object.entries(gtfsData.calendar).forEach(([serviceId, cal]) => {
      if (dateStr >= cal.start_date && dateStr <= cal.end_date) {
        if (cal[dayKey] === '1') {
          activeServices.add(serviceId);
        }
      }
    });

    Object.entries(gtfsData.calendar_dates).forEach(([serviceId, dates]) => {
      if (dates[dateStr]) {
        const exceptionType = dates[dateStr];
        if (exceptionType === '1') {
          activeServices.add(serviceId);
        } else if (exceptionType === '2') {
          activeServices.delete(serviceId);
        }
      }
    });

    // 有効期間外のため該当サービスが0件だった場合、曜日のみでフォールバック適用
    if (activeServices.size === 0) {
      Object.entries(gtfsData.calendar).forEach(([serviceId, cal]) => {
        if (cal[dayKey] === '1') {
          activeServices.add(serviceId);
        }
      });
      updateFeedNoticeBanner(dateStr, true);
    } else {
      updateFeedNoticeBanner(dateStr, false);
    }

    return activeServices;
  }

  /**
   * バス停の全標柱の今後の発車時刻を取得
   * 各発車便に headsign（行先）・のりば番号・バスロケURL情報を付与して返す
   */
  function getDeparturesForStopGroup(stopGroup, dateStr, timeStr) {
    const activeServices = getActiveServicesForDate(dateStr);
    const departures = [];
    const showPole = stopGroup.ids.length > 1;

    let targetSecs = 0;
    if (timeStr != null) {
      const parts = timeStr.split(':').map(Number);
      targetSecs = parts[0] * 3600 + parts[1] * 60;
    } else {
      targetSecs = currentTimeSecs();
    }

    stopGroup.ids.forEach(stopId => {
      const records = stopTimesByStopId[stopId] || [];
      records.forEach(st => {
        const trip = gtfsData.trips[st.trip_id];
        if (!trip) return;

        if (!activeServices.has(trip.service_id)) return;
        if (st.departure_secs < targetSecs) return;

        const route = gtfsData.routes[trip.route_id];
        const routeName = getDisplayRouteName(trip, route, st.trip_id);
        const agencyName = route ? (gtfsData.agency[route.agency_id] || '路線バス') : '路線バス';

        const allStopTimes = stopTimesByTripId[st.trip_id] || [];
        const totalStops = allStopTimes.length;
        const rawLastName = totalStops > 0
          ? (stopNameById[allStopTimes[allStopTimes.length - 1].stop_id] || '')
          : '';
        const lastStopName = rawLastName.replace(/\(.*?\)$/, '').trim();

        departures.push({
          departure_secs: st.departure_secs,
          departure_time: st.departure_time,
          trip_headsign: trip.trip_headsign || '循環・その他',
          routeName: routeName,
          agencyName: agencyName,
          trip_id: st.trip_id,
          stop_id: st.stop_id,
          poleLabel: showPole ? getPoleLabel(st.stop_id) : '',
          busLocUrl: (route && route.route_url) ? route.route_url : getStopBusLocUrl(st.stop_id),
          destStopName: lastStopName
        });
      });
    });

    departures.sort((a, b) => a.departure_secs - b.departure_secs);
    return departures;
  }

  /**
   * コンパクト発車行（dep-row）のHTMLを生成する
   * @param {object} dep - getDeparturesForStopGroupの1件
   * @param {string} idsAttr - JSON.stringify(stopGroup.ids)
   * @param {boolean} isToday - 本日表示かどうか（残り時間表示の判定用）
   */
  function buildDepRowHtml(dep, idsAttr, isToday = true) {
    const remaining = isToday ? formatRemaining(dep.departure_secs) : null;
    const isIchibata = dep.agencyName.includes('一畑');
    const barColor = isIchibata ? 'var(--ichibata)' : 'var(--shiei)';
    const badgeBg  = isIchibata ? 'var(--ichibata-subtle)' : 'var(--shiei-subtle)';
    const badgeCol = isIchibata ? 'var(--ichibata)' : 'var(--shiei)';
    const companyLabel = isIchibata ? '一畑' : '市営';

    return `
      <div class="dep-row" data-trip-id="${escapeHtml(dep.trip_id)}" data-origin-stop-id="${escapeHtml(dep.stop_id)}" data-current-ids='${idsAttr}'>
        <div class="dep-row-time">
          ${dep.departure_time.substring(0, 5)}
          ${remaining ? `<div class="dep-row-soon">${remaining}</div>` : ''}
        </div>
        <div class="dep-row-bar" style="background:${barColor}"></div>
        <div class="dep-row-info">
          <div class="dep-row-route" style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
            <span>${escapeHtml(dep.routeName)}</span>
            ${dep.poleLabel ? `<span class="pole-badge">${escapeHtml(dep.poleLabel)}</span>` : ''}
          </div>
          <div class="dep-row-headsign">→ ${escapeHtml(dep.trip_headsign)}</div>
        </div>
        <a href="${escapeHtml(dep.busLocUrl)}" target="_blank" rel="noopener" class="busloc-link" title="公式バスロケーションでリアルタイム接近情報を確認">📡接近</a>
        <span class="dep-row-badge" style="background:${badgeBg}; color:${badgeCol}">${companyLabel}</span>
      </div>`;
  }

  /**
   * 時刻表タブ: バス停選択時に方向別のアコーディオンを描画する
   */
  function handleStopSelected(stopGroup) {
    if (!stopGroup) return;
    currentTimetableStopGroup = stopGroup;

    const container = $('#departures-container');
    const ttDateInput = $('#timetable-date');
    const selectedDateStr = (ttDateInput && ttDateInput.value)
      ? ttDateInput.value.replace(/-/g, '')
      : todayYYYYMMDD();
    const isToday = selectedDateStr === todayYYYYMMDD();

    // 「始発から全便」モード、または今日以外の日付が選択されている場合は 00:00 から全便取得
    const timeFilter = (timetableMode === 'all' || !isToday) ? '00:00' : null;
    const deps = getDeparturesForStopGroup(stopGroup, selectedDateStr, timeFilter);

    // URL状態を同期
    syncUrlState({
      tab: 'timetable',
      stop: stopGroup.name,
      date: selectedDateStr !== todayYYYYMMDD() ? selectedDateStr : '',
      mode: timetableMode !== 'now' ? timetableMode : ''
    });

    const isFav = FavoritesManager.isFavStop(stopGroup.name);
    const favIcon = isFav ? '★' : '☆';
    const favClass = isFav ? 'fav-active' : '';
    const subTitleLabel = (timetableMode === 'all' || !isToday)
      ? `${formatDateSlash(selectedDateStr)} 始発からの全便（方向をタップで展開）`
      : '本日これからの発車（方向をタップで全便展開）';

    if (deps.length === 0) {
      container.innerHTML = `
        <div class="glass-card fade-in">
          <div class="departures-header" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div class="departures-station-name">${escapeHtml(stopGroup.name)}</div>
              <div class="departures-date">${escapeHtml(formatDateSlash(selectedDateStr))} の運行予定はありません</div>
            </div>
            <div class="header-actions-row">
              <button type="button" class="share-url-btn" title="この時刻表のURLをコピー">🔗 共有</button>
              <button class="fav-toggle-btn ${favClass}" data-stop-name="${escapeHtml(stopGroup.name)}" aria-label="お気に入り登録">${favIcon}</button>
            </div>
          </div>
          <div class="empty-state">
            <div class="empty-state-icon">🚌</div>
            <div class="empty-state-text">該当する発車予定はありません</div>
            ${isToday && timetableMode === 'now' ? `<p style="font-size:12px; color:var(--text-secondary); margin-top:8px;">上部の「🌅 始発から全便」をタップすると本日の全時刻表を確認できます。</p>` : ''}
          </div>
        </div>`;
      setupFavStopButton(container.querySelector('.fav-toggle-btn'));
      const shareBtn = container.querySelector('.share-url-btn');
      if (shareBtn) shareBtn.addEventListener('click', copyShareUrl);
      return;
    }

    // 行先（終着停留所）別にグループ化
    const groups = new Map();
    deps.forEach(dep => {
      const key = dep.destStopName || dep.trip_headsign;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(dep);
    });

    // 各グループの最初の便の departure_secs で昇順ソート
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      const aFirst = a[1][0].departure_secs;
      const bFirst = b[1][0].departure_secs;
      return aFirst - bFirst;
    });

    const idsAttr = JSON.stringify(stopGroup.ids);

    let groupsHtml = '';
    sortedGroups.forEach(([destName, arr]) => {
      const nextDep = arr[0];
      const remaining = isToday ? formatRemaining(nextDep.departure_secs) : null;
      const isIchibata = nextDep.agencyName.includes('一畑');
      const companyLabel = isIchibata ? '一畑' : '市営';
      const badgeBg = isIchibata ? 'var(--ichibata-subtle)' : 'var(--shiei-subtle)';
      const badgeCol = isIchibata ? 'var(--ichibata)' : 'var(--shiei)';

      const depRowsHtml = arr.map(dep => buildDepRowHtml(dep, idsAttr, isToday)).join('');

      groupsHtml += `
        <div class="dir-group">
          <div class="dir-header">
            <div class="dir-header-summary">
              <div class="dir-dest">→ ${escapeHtml(destName)}</div>
              <div class="dir-next-info">
                <span class="dir-next-time">${nextDep.departure_time.substring(0, 5)}</span>
                <span class="dir-next-route">${escapeHtml(nextDep.routeName)}</span>
                ${nextDep.poleLabel ? `<span class="pole-badge">${escapeHtml(nextDep.poleLabel)}</span>` : ''}
                ${remaining ? `<span class="dir-next-remaining">${remaining}</span>` : ''}
                <span class="dir-next-company" style="background:${badgeBg}; color:${badgeCol}">${companyLabel}</span>
              </div>
            </div>
            <div class="dir-arrow-area">
              <span class="dir-count-badge">${arr.length}本</span>
              <span class="dir-arrow">▼</span>
            </div>
          </div>
          <div class="dir-body" style="display: none;">
            <div class="dep-list">
              ${depRowsHtml}
            </div>
          </div>
        </div>`;
    });

    container.innerHTML = `
      <div class="glass-card fade-in">
        <div class="departures-header" style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div class="departures-station-name">${escapeHtml(stopGroup.name)}</div>
            <div class="departures-date">${escapeHtml(subTitleLabel)}</div>
          </div>
          <div class="header-actions-row">
            <button type="button" class="share-url-btn" title="この時刻表のURLをコピー">🔗 共有</button>
            <button class="fav-toggle-btn ${favClass}" data-stop-name="${escapeHtml(stopGroup.name)}" aria-label="お気に入り登録">${favIcon}</button>
          </div>
        </div>
        <div class="dir-groups-container">
          ${groupsHtml}
        </div>
      </div>`;

    setupFavStopButton(container.querySelector('.fav-toggle-btn'));
    const shareBtn = container.querySelector('.share-url-btn');
    if (shareBtn) shareBtn.addEventListener('click', copyShareUrl);
  }

  function setupFavStopButton(btn) {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const stopName = btn.dataset.stopName;
      const isNowFav = FavoritesManager.toggleStop(stopName);
      btn.textContent = isNowFav ? '★' : '☆';
      btn.classList.toggle('fav-active', isNowFav);
      renderFavStops();
    });
  }

  // ===== 経路検索タブのロジック =====

  /**
   * 直通バスの経路を検索（運賃・のりば番号・バスロケURL付き）
   */
  function searchDirectRoutes(fromGroup, toGroup, dateStr, timeStr, searchType) {
    const activeServices = getActiveServicesForDate(dateStr);
    const routesFound = [];
    const showPole = fromGroup.ids.length > 1;

    let targetSecs = 0;
    if (searchType === 'first') {
      targetSecs = 0;
    } else if (searchType === 'last') {
      targetSecs = 24 * 3600 - 1;
    } else if (timeStr) {
      const parts = timeStr.split(':').map(Number);
      targetSecs = parts[0] * 3600 + parts[1] * 60;
    } else {
      targetSecs = currentTimeSecs();
    }

    const checkedTrips = new Set();

    fromGroup.ids.forEach(fromId => {
      const fromRecords = stopTimesByStopId[fromId] || [];
      fromRecords.forEach(stFrom => {
        const tripId = stFrom.trip_id;
        if (checkedTrips.has(tripId)) return;
        checkedTrips.add(tripId);

        const trip = gtfsData.trips[tripId];
        if (!trip) return;

        if (!activeServices.has(trip.service_id)) return;

        if (searchType === 'departure' && stFrom.departure_secs < targetSecs) return;
        if (searchType === 'arrival' && stFrom.departure_secs > targetSecs) return;

        const tripStopTimes = stopTimesByTripId[tripId] || [];
        const fromSeq = parseInt(stFrom.stop_sequence, 10);

        const stTo = tripStopTimes.find(st => toGroup.ids.includes(st.stop_id) && parseInt(st.stop_sequence, 10) > fromSeq);

        if (stTo) {
          if (searchType === 'arrival' && stTo.departure_secs > targetSecs) return;

          const route = gtfsData.routes[trip.route_id];
          const routeName = getDisplayRouteName(trip, route, tripId);
          const agencyName = route ? (gtfsData.agency[route.agency_id] || '路線バス') : '路線バス';
          const durationSecs = stTo.departure_secs - stFrom.departure_secs;
          const fare = getFare(stFrom.stop_id, stTo.stop_id);

          routesFound.push({
            trip_id: tripId,
            from_stop_id: stFrom.stop_id,
            to_stop_id: stTo.stop_id,
            poleLabel: showPole ? getPoleLabel(stFrom.stop_id) : '',
            fare: fare,
            busLocUrl: (route && route.route_url) ? route.route_url : getStopBusLocUrl(stFrom.stop_id),
            routeName: routeName,
            agencyName: agencyName,
            trip_headsign: trip.trip_headsign || '不明',
            departure_time: stFrom.departure_time,
            departure_secs: stFrom.departure_secs,
            arrival_time: stTo.arrival_time,
            arrival_secs: stTo.departure_secs,
            durationSecs: durationSecs
          });
        }
      });
    });

    if (searchType === 'last') {
      routesFound.sort((a, b) => b.departure_secs - a.departure_secs);
    } else if (searchType === 'arrival') {
      routesFound.sort((a, b) => b.arrival_secs - a.arrival_secs);
    } else {
      routesFound.sort((a, b) => a.departure_secs - b.departure_secs);
    }

    return routesFound;
  }

  /**
   * 主要拠点（松江駅・県民会館前など）での1回乗り継ぎ経路を探索する
   */
  function searchTransferRoutes(fromGroup, toGroup, dateStr, timeStr, searchType) {
    const MIN_TRANSFER_SECS = 5 * 60;  // 最低乗換時間 5分
    const MAX_TRANSFER_SECS = 45 * 60; // 最大待ち時間 45分
    const candidatesByFirstTrip = new Map();

    MAJOR_TRANSFER_HUBS.forEach(hubName => {
      if (hubName === fromGroup.name || hubName === toGroup.name) return;
      const hubGroup = stopIndex.find(s => s.name === hubName);
      if (!hubGroup) return;

      // 第1区間: 出発地 -> ハブ停留所
      const leg1Type = (searchType === 'arrival') ? 'first' : searchType;
      const leg1Routes = searchDirectRoutes(fromGroup, hubGroup, dateStr, timeStr, leg1Type);
      if (leg1Routes.length === 0) return;

      // 第2区間: ハブ停留所 -> 目的地（全便取得して接続判定）
      const leg2All = searchDirectRoutes(hubGroup, toGroup, dateStr, '00:00', 'first');
      if (leg2All.length === 0) return;

      leg1Routes.slice(0, 15).forEach(l1 => {
        const minDep2 = l1.arrival_secs + MIN_TRANSFER_SECS;
        const maxDep2 = l1.arrival_secs + MAX_TRANSFER_SECS;

        const matchingLeg2 = leg2All.find(l2 => {
          if (l2.trip_id === l1.trip_id) return false;
          if (l2.departure_secs < minDep2 || l2.departure_secs > maxDep2) return false;
          if (searchType === 'arrival' && timeStr) {
            const parts = timeStr.split(':').map(Number);
            const limitSecs = parts[0] * 3600 + parts[1] * 60;
            if (l2.arrival_secs > limitSecs) return false;
          }
          return true;
        });

        if (matchingLeg2) {
          const waitMins = Math.round((matchingLeg2.departure_secs - l1.arrival_secs) / 60);
          const totalDurationSecs = matchingLeg2.arrival_secs - l1.departure_secs;
          const totalFare = (l1.fare != null && matchingLeg2.fare != null) ? (l1.fare + matchingLeg2.fare) : null;

          const existing = candidatesByFirstTrip.get(l1.trip_id);
          if (!existing || matchingLeg2.arrival_secs < existing.arrival_secs) {
            candidatesByFirstTrip.set(l1.trip_id, {
              hubName: hubName,
              hubGroup: hubGroup,
              leg1: l1,
              leg2: matchingLeg2,
              waitMins: waitMins,
              departure_secs: l1.departure_secs,
              arrival_secs: matchingLeg2.arrival_secs,
              totalDurationSecs: totalDurationSecs,
              totalFare: totalFare
            });
          }
        }
      });
    });

    const results = Array.from(candidatesByFirstTrip.values());
    if (searchType === 'last') {
      results.sort((a, b) => b.departure_secs - a.departure_secs);
    } else if (searchType === 'arrival') {
      results.sort((a, b) => b.arrival_secs - a.arrival_secs);
    } else {
      results.sort((a, b) => a.arrival_secs - b.arrival_secs);
    }
    return results.slice(0, 3);
  }

  function handleRouteSearch() {
    const fromInput = $('#route-from-input').value.trim();
    const toInput = $('#route-to-input').value.trim();
    const resultsContainer = $('#route-results-container');

    if (!fromInput || !toInput) {
      alert('出発地と目的地を入力してください。');
      return;
    }

    const fromGroup = stopIndex.find(s => s.name === fromInput);
    const toGroup = stopIndex.find(s => s.name === toInput);

    if (!fromGroup) {
      alert(`出発地「${fromInput}」が見つかりません。`);
      return;
    }
    if (!toGroup) {
      alert(`目的地「${toInput}」が見つかりません。`);
      return;
    }

    resultsContainer.innerHTML = `
      <div class="glass-card">
        <div class="loading-container">
          <div class="spinner"></div>
          <div class="loading-text">直通便・乗り継ぎ便を探索中...</div>
        </div>
      </div>`;

    const dateVal = $('#route-date').value.replace(/-/g, '') || todayYYYYMMDD();
    const timeVal = $('#route-time').value || null;
    const typeVal = $('#route-type').value || 'departure';

    // URLクエリパラメータを同期
    syncUrlState({
      tab: 'route',
      from: fromGroup.name,
      to: toGroup.name,
      date: dateVal !== todayYYYYMMDD() ? dateVal : '',
      time: timeVal || '',
      type: typeVal !== 'departure' ? typeVal : ''
    });

    setTimeout(() => {
      const directRoutes = searchDirectRoutes(fromGroup, toGroup, dateVal, timeVal, typeVal);
      // 直通便が2本以下の場合は主要拠点での1回乗り継ぎルートも探索
      const transferRoutes = directRoutes.length <= 2
        ? searchTransferRoutes(fromGroup, toGroup, dateVal, timeVal, typeVal)
        : [];
      renderRouteResults(resultsContainer, directRoutes, transferRoutes, fromGroup, toGroup);
    }, 80);
  }

  /**
   * 1回乗り継ぎカードのHTMLを生成する
   */
  function buildTransferCardsHtml(transferRoutes, fromGroup, toGroup) {
    if (!transferRoutes || transferRoutes.length === 0) return '';
    const cards = transferRoutes.map(tr => {
      const totalMins = Math.round(tr.totalDurationSecs / 60);
      const isIchibata1 = tr.leg1.agencyName.includes('一畑');
      const isIchibata2 = tr.leg2.agencyName.includes('一畑');
      const currentIds = [...fromGroup.ids, ...tr.hubGroup.ids, ...toGroup.ids];
      const idsAttr = JSON.stringify(currentIds);

      return `
        <div class="transfer-card fade-in" data-trip-id="${escapeHtml(tr.leg1.trip_id)}" data-leg2-trip-id="${escapeHtml(tr.leg2.trip_id)}" data-origin-stop-id="${escapeHtml(tr.leg1.from_stop_id)}" data-current-ids='${idsAttr}'>
          <div class="transfer-header">
            <div class="transfer-times">
              ${tr.leg1.departure_time.substring(0, 5)} <span style="color:var(--text-muted); font-size:14px;">→</span> ${tr.leg2.arrival_time.substring(0, 5)}
            </div>
            <div class="transfer-badges">
              <span style="font-size:11px; background:var(--accent-subtle); color:var(--accent); padding:2px 7px; border-radius:4px; font-weight:600;">
                乗換1回・計${totalMins}分
              </span>
              ${tr.totalFare != null ? `<span class="fare-badge">合算 ¥${tr.totalFare}</span>` : ''}
            </div>
          </div>
          <div class="transfer-leg-row">
            <span class="transfer-leg-time">${tr.leg1.departure_time.substring(0, 5)}〜${tr.leg1.arrival_time.substring(0, 5)}</span>
            <span style="color:${isIchibata1 ? 'var(--ichibata)' : 'var(--shiei)'}; font-weight:700;">●</span>
            <span style="font-weight:600; color:var(--text-primary);">${escapeHtml(tr.leg1.routeName)}</span>
            ${tr.leg1.fare != null ? `<span style="color:var(--text-muted); font-size:11px;">(¥${tr.leg1.fare})</span>` : ''}
          </div>
          <div class="transfer-wait-row">
            🔄 <strong>${escapeHtml(tr.hubName)}</strong> で乗り継ぎ（待ち ${tr.waitMins}分）
          </div>
          <div class="transfer-leg-row">
            <span class="transfer-leg-time">${tr.leg2.departure_time.substring(0, 5)}〜${tr.leg2.arrival_time.substring(0, 5)}</span>
            <span style="color:${isIchibata2 ? 'var(--ichibata)' : 'var(--shiei)'}; font-weight:700;">●</span>
            <span style="font-weight:600; color:var(--text-primary);">${escapeHtml(tr.leg2.routeName)}</span>
            ${tr.leg2.fare != null ? `<span style="color:var(--text-muted); font-size:11px;">(¥${tr.leg2.fare})</span>` : ''}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="section-label" style="margin-top:20px; margin-bottom:6px;">🔄 主要バス停での1回乗り継ぎ候補（タップで停車駅表示）</div>
      ${cards}`;
  }

  function renderRouteResults(container, routes, transferRoutes, fromGroup, toGroup) {
    const isFavRoute = FavoritesManager.isFavRoute(fromGroup.name, toGroup.name);
    const favIcon = isFavRoute ? '★' : '☆';
    const favClass = isFavRoute ? 'fav-active' : '';

    if (routes.length === 0 && (!transferRoutes || transferRoutes.length === 0)) {
      container.innerHTML = `
        <div class="glass-card fade-in">
          <div class="empty-state">
            <div class="empty-state-icon">🗺️</div>
            <div class="empty-state-text">指定条件で直通・主要拠点乗り継ぎできるバス便はありません。</div>
            <p style="color:var(--text-secondary); font-size:13px; margin: 8px 24px; text-align:center;">
              徒歩を含むルートや他社線との乗り継ぎは外部サービスをご利用ください。
            </p>
            <div style="display:flex; justify-content:center; gap:10px; margin-top:16px;">
              <a href="https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(fromGroup.name + ' バス停')}&destination=${encodeURIComponent(toGroup.name + ' バス停')}&travelmode=transit" 
                 target="_blank" rel="noopener" class="quick-stop-btn" style="text-decoration:none;">
                Google マップで検索
              </a>
              <a href="https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(fromGroup.name)}&to=${encodeURIComponent(toGroup.name)}" 
                 target="_blank" rel="noopener" class="quick-stop-btn" style="text-decoration:none;">
                Yahoo! 路線情報
              </a>
            </div>
          </div>
        </div>`;
      return;
    }

    const maxResults = 5;
    const routesHtml = routes.slice(0, maxResults).map((r, i) => {
      const isIchibata = r.agencyName.includes('一畑');
      const durationMins = Math.round(r.durationSecs / 60);

      const currentIds = [...fromGroup.ids, ...toGroup.ids];
      const idsAttr = JSON.stringify(currentIds);

      return `
        <div class="departure-card fade-in stagger-${i + 1}" data-trip-id="${escapeHtml(r.trip_id)}" data-origin-stop-id="${escapeHtml(r.from_stop_id)}" data-current-ids='${idsAttr}'>
          <div class="departure-card-main">
            <div style="display:flex; flex-direction:column; width:64px; justify-content:center; align-items:flex-start;">
              <span class="departure-time" style="font-size:22px; font-weight:700;">
                ${r.departure_time.substring(0, 5)}
              </span>
              <span class="departure-time" style="font-size:16px; font-weight:700; color:var(--text-secondary); margin-top:-2px;">
                ${r.arrival_time.substring(0, 5)}
              </span>
            </div>
            <div class="route-color-bar" style="background:${isIchibata ? 'var(--ichibata)' : 'var(--shiei)'}; height:42px;"></div>
            <div class="departure-info" style="flex:1; min-width:0; padding-left:2px;">
              <div class="departure-route" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span>${escapeHtml(r.routeName)}</span>
                <span style="font-size:11px; background:var(--accent-subtle); color:var(--accent); padding:1px 6px; border-radius:4px; font-weight:normal;">
                  直通 ${durationMins}分
                </span>
                ${r.fare != null ? `<span class="fare-badge">¥${r.fare}</span>` : ''}
                ${r.poleLabel ? `<span class="pole-badge">${escapeHtml(r.poleLabel)}</span>` : ''}
              </div>
              <div class="departure-headsign" style="margin-top:2px;">
                <span>→ ${escapeHtml(r.trip_headsign)}行</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); margin-top:4px; display:flex; align-items:center; justify-content:space-between; width:100%;">
                <span>${isIchibata ? '🔴一畑バス' : '🔵松江市営バス'}</span>
                <a href="${escapeHtml(r.busLocUrl)}" target="_blank" rel="noopener" class="busloc-link">📡 接近情報</a>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    const transferHtml = buildTransferCardsHtml(transferRoutes, fromGroup, toGroup);

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; margin-bottom:8px;">
        <div class="section-label" style="margin-bottom:0;">
          ${routes.length > 0 ? `直通検索結果 (最大${maxResults}件・タップで途中駅表示)` : '直通便なし（乗り継ぎ候補を表示中）'}
        </div>
        <div class="header-actions-row">
          <button type="button" class="share-url-btn" title="この検索結果のURLをコピー">🔗 共有</button>
          <button class="fav-toggle-route-btn ${favClass}" data-from="${escapeHtml(fromGroup.name)}" data-to="${escapeHtml(toGroup.name)}" aria-label="経路をお気に入り登録">
            ${favIcon} 経路を保存
          </button>
        </div>
      </div>
      ${routesHtml}
      ${transferHtml}
      <div style="text-align:center; margin-top:16px;">
        <span style="font-size:12px; color:var(--text-muted);">その他の乗り継ぎ経路を検索したい場合は：</span>
        <div style="display:flex; justify-content:center; gap:10px; margin-top:8px;">
          <a href="https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(fromGroup.name + ' バス停')}&destination=${encodeURIComponent(toGroup.name + ' バス停')}&travelmode=transit" 
             target="_blank" rel="noopener" class="quick-stop-btn" style="text-decoration:none; font-size:12px;">
            🗺️ Google マップ
          </a>
          <a href="https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(fromGroup.name)}&to=${encodeURIComponent(toGroup.name)}" 
             target="_blank" rel="noopener" class="quick-stop-btn" style="text-decoration:none; font-size:12px;">
            🔍 Yahoo! 路線情報
          </a>
        </div>
      </div>`;

    const favBtn = container.querySelector('.fav-toggle-route-btn');
    if (favBtn) {
      favBtn.addEventListener('click', () => {
        const fromName = favBtn.dataset.from;
        const toName = favBtn.dataset.to;
        const isNowFav = FavoritesManager.toggleRoute(fromName, toName);
        favBtn.innerHTML = `${isNowFav ? '★' : '☆'} 経路を保存`;
        favBtn.classList.toggle('fav-active', isNowFav);
        renderFavRoutes();
      });
    }

    const shareBtn = container.querySelector('.share-url-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', copyShareUrl);
    }
  }

  // ===== お気に入り一覧の描画 =====
  function renderFavStops() {
    const container = $('#fav-stops-container');
    if (!container) return;
    const favs = FavoritesManager.getStops();
    if (favs.length === 0) {
      container.innerHTML = '';
      return;
    }

    const btnsHtml = favs.map(name => `
      <button class="fav-item-btn" data-name="${escapeHtml(name)}">
        <span style="color:var(--accent);">★</span> ${escapeHtml(name)}
      </button>
    `).join('');

    container.innerHTML = `
      <div class="section-label" style="margin-top:16px;">⭐ お気に入りバス停</div>
      <div class="fav-list-container">
        ${btnsHtml}
      </div>
    `;

    container.querySelectorAll('.fav-item-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (timetableAutocomplete) {
          timetableAutocomplete.setQuery(btn.dataset.name);
        }
      });
    });
  }

  function renderFavRoutes() {
    const container = $('#fav-routes-container');
    if (!container) return;
    const favs = FavoritesManager.getRoutes();
    if (favs.length === 0) {
      container.innerHTML = '';
      return;
    }

    const btnsHtml = favs.map(r => `
      <button class="fav-item-btn fav-route-btn" data-from="${escapeHtml(r.from)}" data-to="${escapeHtml(r.to)}">
        <span style="color:var(--accent);">★</span> ${escapeHtml(r.from)} <span style="color:var(--text-muted);">→</span> ${escapeHtml(r.to)}
      </button>
    `).join('');

    container.innerHTML = `
      <div class="section-label" style="margin-top:16px;">⭐ お気に入り経路</div>
      <div class="fav-list-container">
        ${btnsHtml}
      </div>
    `;

    container.querySelectorAll('.fav-route-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fromInput = $('#route-from-input');
        const toInput = $('#route-to-input');
        if (fromInput && toInput) {
          fromInput.value = btn.dataset.from;
          toInput.value = btn.dataset.to;
          $('#route-search-btn').click();
        }
      });
    });
  }

  // ===== タブ切り替え制御 =====
  function switchTab(tabId) {
    $$('.tab-btn').forEach(btn => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    $$('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `${tabId}-tab`);
    });
  }

  // ===== テーマ切り替え制御 =====
  function initTheme() {
    const toggleBtn = $('#theme-toggle');
    const savedTheme = localStorage.getItem(STORAGE_KEY_THEME) || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    toggleBtn.textContent = savedTheme === 'dark' ? '🌙' : '☀️';

    toggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(STORAGE_KEY_THEME, next);
      toggleBtn.textContent = next === 'dark' ? '🌙' : '☀️';
    });
  }

  // ===== 補助関数 (デバウンス) =====
  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /**
   * 途中停留所タイムラインHTMLを生成する（運賃・時刻表ジャンプ・目的地セットボタン付き）
   */
  function buildTimelineHtml(stopTimes, currentIds, originStopId) {
    let passedOrigin = false;
    return stopTimes.map(st => {
      const name = stopNameById[st.stop_id] || '不明';
      const isCurrent = currentIds.includes(st.stop_id);
      if (originStopId && st.stop_id === originStopId) {
        passedOrigin = true;
      }
      const stepFare = (passedOrigin && originStopId && st.stop_id !== originStopId)
        ? getFare(originStopId, st.stop_id)
        : null;

      return `
        <div class="timeline-stop ${isCurrent ? 'current' : ''}">
          <div class="timeline-stop-main">
            <div class="timeline-time">${st.departure_time.substring(0, 5)}</div>
            <div class="timeline-node"></div>
            <div class="timeline-name">
              ${escapeHtml(name)}
              ${stepFare != null ? `<span class="fare-badge" style="margin-left:6px; font-weight:600;">¥${stepFare}</span>` : ''}
            </div>
          </div>
          <div class="timeline-actions">
            <button type="button" class="timeline-action-btn" data-tl-action="timetable" data-stop-name="${escapeHtml(name)}" title="${escapeHtml(name)}の時刻表を見る">🕐時刻表</button>
            <button type="button" class="timeline-action-btn" data-tl-action="route-to" data-stop-name="${escapeHtml(name)}" title="${escapeHtml(name)}を目的地にして経路検索">🏁ここへ</button>
          </div>
        </div>`;
    }).join('');
  }

  /**
   * URLクエリパラメータから初期検索状態を復元する
   */
  function restoreStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const stop = params.get('stop');
    const from = params.get('from');
    const to = params.get('to');
    const date = params.get('date');
    const time = params.get('time');
    const type = params.get('type');
    const mode = params.get('mode');

    if (tab === 'timetable' || (stop && !from)) {
      switchTab('timetable');
      if (date && date.length === 8 && $('#timetable-date')) {
        $('#timetable-date').value = `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
      }
      if (mode === 'all') {
        timetableMode = 'all';
        $$('.tt-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.ttMode === 'all'));
      }
      if (stop && timetableAutocomplete) {
        timetableAutocomplete.setQuery(stop);
      }
    } else if (from && to) {
      switchTab('route');
      $('#route-from-input').value = from;
      $('#route-to-input').value = to;
      if (date && date.length === 8) {
        $('#route-date').value = `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
      }
      if (time) $('#route-time').value = time;
      if (type) $('#route-type').value = type;
      handleRouteSearch();
    }
  }

  // ===== 初期起動フロー (事前パース済みデータロード) =====
  function loadGTFS() {
    const overlay = $('#loading-overlay');
    const progress = $('#loading-progress');

    try {
      progress.textContent = 'データを展開中...';
      
      if (!window.GTFS_DATA) {
        throw new Error('GTFSデータファイル(gtfs_data.js)が見つからないか、正しく読み込まれていません。');
      }

      Object.assign(gtfsData, window.GTFS_DATA);

      progress.textContent = '検索用インデックスを構築中...';
      setTimeout(() => {
        buildIndex();
        initTabsAndInputs();
        restoreStateFromUrl();
        overlay.classList.add('fade-out');
      }, 100);

    } catch (err) {
      console.error(err);
      progress.innerHTML = `<span style="color:var(--rose); font-weight:700;">ロード中にエラーが発生しました: ${escapeHtml(err.message)}</span>`;
    }
  }

  function initTabsAndInputs() {
    timetableAutocomplete = initAutocomplete({
      input: $('#stop-search-input'),
      dropdown: $('#stop-search-results'),
      clearBtn: $('#stop-search-clear'),
      onSelect: handleStopSelected
    });

    // 時刻表タブの日付初期化とモード切替イベント
    const ttDateInput = $('#timetable-date');
    if (ttDateInput) {
      ttDateInput.value = todayISO();
      ttDateInput.addEventListener('change', () => {
        if (currentTimetableStopGroup) {
          handleStopSelected(currentTimetableStopGroup);
        }
      });
    }

    const btnTtToday = $('#btn-timetable-today');
    if (btnTtToday && ttDateInput) {
      btnTtToday.addEventListener('click', () => {
        ttDateInput.value = todayISO();
        if (currentTimetableStopGroup) {
          handleStopSelected(currentTimetableStopGroup);
        }
      });
    }

    $$('.tt-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        timetableMode = btn.dataset.ttMode || 'now';
        $$('.tt-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
        if (currentTimetableStopGroup) {
          handleStopSelected(currentTimetableStopGroup);
        }
      });
    });

    // クイックアクセス: 松江駅
    const btnMatsue = $('#btn-matsue-station');
    if (btnMatsue) {
      btnMatsue.addEventListener('click', () => {
        const matsueStop = stopIndex.find(s => s.name === '松江駅');
        if (matsueStop) {
          timetableAutocomplete.setQuery(matsueStop.name);
        }
      });
    }

    // クイックアクセス: 現在地から探す
    const btnNearby = $('#btn-nearby-stops');
    const departuresContainer = $('#departures-container');
    if (btnNearby) {
      btnNearby.addEventListener('click', () => {
        if (!navigator.geolocation) {
          showNearbyError('お使いのブラウザは位置情報サービスに対応していません。');
          return;
        }

        departuresContainer.innerHTML = `
          <div class="glass-card fade-in">
            <div class="nearby-loading">
              <div class="nearby-loading-spinner"></div>
              <div class="loading-text" style="font-size:14px; color:var(--text-secondary);">現在地を取得しています...</div>
            </div>
          </div>`;

        navigator.geolocation.getCurrentPosition(
          (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            const scored = stopIndex
              .filter(s => s.lat != null && s.lon != null)
              .map(s => {
                const dist = getDistance(lat, lon, s.lat, s.lon);
                return { stopGroup: s, distance: dist };
              });

            scored.sort((a, b) => a.distance - b.distance);
            const nearby = scored.slice(0, 5);

            if (nearby.length === 0) {
              showNearbyError('近くにバス停が見つかりませんでした。');
              return;
            }

            const rowsHtml = nearby.map(item => {
              const distStr = item.distance < 1000
                ? `${Math.round(item.distance)}m`
                : `${(item.distance / 1000).toFixed(1)}km`;

              return `
                <div class="nearby-stop-row" data-stop-name="${escapeHtml(item.stopGroup.name)}">
                  <div class="nearby-stop-name">🚌 ${escapeHtml(item.stopGroup.name)}</div>
                  <div class="nearby-stop-dist">${distStr}</div>
                </div>`;
            }).join('');

            departuresContainer.innerHTML = `
              <div class="glass-card fade-in">
                <div class="departures-header">
                  <div>
                    <div class="departures-station-name">📍 現在地周辺のバス停</div>
                    <div class="departures-date">タップすると時刻表を表示します</div>
                  </div>
                </div>
                <div class="nearby-stops-list">
                  ${rowsHtml}
                </div>
              </div>`;
          },
          (error) => {
            console.error(error);
            let errMsg = '位置情報の取得に失敗しました。';
            if (error.code === 1) {
              errMsg = '位置情報の利用が許可されていません。ブラウザの設定を確認してください。';
            } else if (error.code === 2) {
              errMsg = '位置情報を特定できませんでした。';
            } else if (error.code === 3) {
              errMsg = '位置情報の取得がタイムアウトしました。';
            }
            showNearbyError(errMsg);
          },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
      });
    }

    function showNearbyError(message) {
      departuresContainer.innerHTML = `
        <div class="glass-card fade-in">
          <div class="nearby-error">
            <span class="nearby-error-icon">⚠️</span>
            <div class="nearby-error-text">${escapeHtml(message)}</div>
          </div>
        </div>`;
    }

    const routeFromAC = initAutocomplete({
      input: $('#route-from-input'),
      dropdown: $('#route-from-results'),
      onSelect: () => {}
    });

    const routeToAC = initAutocomplete({
      input: $('#route-to-input'),
      dropdown: $('#route-to-results'),
      onSelect: () => {}
    });

    // 経路検索クイックボタン: 出発地・目的地「松江駅」
    const btnRouteFromMatsue = $('#btn-route-from-matsue');
    if (btnRouteFromMatsue) {
      btnRouteFromMatsue.addEventListener('click', () => {
        const matsueStop = stopIndex.find(s => s.name === '松江駅');
        if (matsueStop && routeFromAC) {
          routeFromAC.setQuery(matsueStop.name);
        }
      });
    }

    const btnRouteToMatsue = $('#btn-route-to-matsue');
    if (btnRouteToMatsue) {
      btnRouteToMatsue.addEventListener('click', () => {
        const matsueStop = stopIndex.find(s => s.name === '松江駅');
        if (matsueStop && routeToAC) {
          routeToAC.setQuery(matsueStop.name);
        }
      });
    }

    // 経路検索クイックボタン: 出発地・目的地「現在地近く」
    const handleRouteNearby = (acInstance, inputElement) => {
      if (!navigator.geolocation) {
        alert('お使いのブラウザは位置情報サービスに対応していません。');
        return;
      }

      const originalPlaceholder = inputElement.placeholder;
      inputElement.placeholder = '現在地を取得中...';
      inputElement.value = '';

      navigator.geolocation.getCurrentPosition(
        (position) => {
          inputElement.placeholder = originalPlaceholder;
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;

          let nearest = null;
          let minDist = Infinity;
          stopIndex.forEach(s => {
            if (s.lat != null && s.lon != null) {
              const dist = getDistance(lat, lon, s.lat, s.lon);
              if (dist < minDist) {
                minDist = dist;
                nearest = s;
              }
            }
          });

          if (nearest && acInstance) {
            acInstance.setQuery(nearest.name);
          } else {
            alert('近くにバス停が見つかりませんでした。');
          }
        },
        (error) => {
          console.error(error);
          inputElement.placeholder = originalPlaceholder;
          alert('位置情報の取得に失敗しました。GPSまたはブラウザの設定を確認してください。');
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    };

    const btnRouteFromNearby = $('#btn-route-from-nearby');
    if (btnRouteFromNearby) {
      btnRouteFromNearby.addEventListener('click', () => {
        handleRouteNearby(routeFromAC, $('#route-from-input'));
      });
    }

    const btnRouteToNearby = $('#btn-route-to-nearby');
    if (btnRouteToNearby) {
      btnRouteToNearby.addEventListener('click', () => {
        handleRouteNearby(routeToAC, $('#route-to-input'));
      });
    }

    $('#route-swap-btn').addEventListener('click', () => {
      const fromVal = $('#route-from-input').value;
      const toVal = $('#route-to-input').value;
      $('#route-from-input').value = toVal;
      $('#route-to-input').value = fromVal;
    });

    $('#route-search-btn').addEventListener('click', handleRouteSearch);

    $('#route-date').value = todayISO();
    $('#route-time').value = nowHHMM();
  }

  /**
   * PWA用 Service Worker の登録
   */
  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.protocol === 'http:')) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('ServiceWorker registration skipped:', err);
      });
    }
  }

  // ===== メイン初期化 & イベントリスニング =====
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    registerServiceWorker();

    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });

    // 時刻表・経路検索の行/カードタップ時の途中停留所タイムライン表示・操作
    document.addEventListener('click', (e) => {
      // タイムライン内のアクションボタン（🕐時刻表 / 🏁ここへ）の処理
      const tlActionBtn = e.target.closest('.timeline-action-btn');
      if (tlActionBtn) {
        e.stopPropagation();
        const action = tlActionBtn.dataset.tlAction;
        const stopName = tlActionBtn.dataset.stopName;
        if (!stopName) return;

        if (action === 'timetable') {
          switchTab('timetable');
          if (timetableAutocomplete) {
            timetableAutocomplete.setQuery(stopName);
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (action === 'route-to') {
          switchTab('route');
          const fromInput = $('#route-from-input');
          const toInput = $('#route-to-input');
          if (fromInput && !fromInput.value.trim() && currentTimetableStopGroup) {
            fromInput.value = currentTimetableStopGroup.name;
          }
          if (toInput) {
            toInput.value = stopName;
          }
          if (fromInput && fromInput.value.trim() && toInput && toInput.value.trim()) {
            handleRouteSearch();
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      // リンクがタップされた場合はトグルしない
      if (e.target.closest('a')) return;
      // チップクリックも無視
      if (e.target.closest('.dir-chip')) return;

      // 現在地検索結果の行がタップされた時の処理
      const nearbyRow = e.target.closest('.nearby-stop-row');
      if (nearbyRow) {
        const stopName = nearbyRow.dataset.stopName;
        if (stopName && timetableAutocomplete) {
          timetableAutocomplete.setQuery(stopName);
        }
        return;
      }

      // 方面アコーディオン（dir-header）の処理
      const dirHeader = e.target.closest('.dir-header');
      if (dirHeader) {
        const group = dirHeader.closest('.dir-group');
        if (group) {
          const body = group.querySelector('.dir-body');
          if (body) {
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            group.classList.toggle('expanded', isHidden);
          }
        }
        return;
      }

      // dep-row（時刻表タブの行スタイル）の処理
      const row = e.target.closest('.dep-row');
      if (row) {
        const existingDetails = row.nextElementSibling;
        if (existingDetails && existingDetails.classList.contains('dep-row-details')) {
          existingDetails.remove();
          row.classList.remove('expanded');
          return;
        }

        const tripId = row.dataset.tripId;
        if (!tripId) return;
        const originStopId = row.dataset.originStopId || '';
        let currentIds = [];
        try { currentIds = JSON.parse(row.dataset.currentIds || '[]'); } catch {}

        const stopTimes = stopTimesByTripId[tripId] || [];
        const timelineHtml = buildTimelineHtml(stopTimes, currentIds, originStopId);

        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'dep-row-details fade-in';
        detailsDiv.innerHTML = `
          <div class="timeline-container">
            <div class="timeline-line"></div>
            ${timelineHtml}
          </div>`;

        row.classList.add('expanded');
        row.insertAdjacentElement('afterend', detailsDiv);
        return;
      }

      // departure-card / transfer-card（経路検索タブのカードスタイル）の処理
      const card = e.target.closest('.departure-card, .transfer-card');
      if (!card) return;

      const details = card.querySelector('.trip-details');
      if (details) {
        details.remove();
        card.classList.remove('expanded');
        return;
      }

      const tripId = card.dataset.tripId;
      if (!tripId) return;
      const leg2TripId = card.dataset.leg2TripId || '';
      const originStopId = card.dataset.originStopId || '';
      let currentIds = [];
      try { currentIds = JSON.parse(card.dataset.currentIds || '[]'); } catch {}

      const detailsDiv = document.createElement('div');
      detailsDiv.className = 'trip-details fade-in';

      const stopTimes1 = stopTimesByTripId[tripId] || [];
      const timelineHtml1 = buildTimelineHtml(stopTimes1, currentIds, originStopId);

      let leg2SectionHtml = '';
      if (leg2TripId) {
        const stopTimes2 = stopTimesByTripId[leg2TripId] || [];
        const timelineHtml2 = buildTimelineHtml(stopTimes2, currentIds, '');
        leg2SectionHtml = `
          <div style="font-size:11px; font-weight:700; color:var(--amber); margin: 12px 0 8px 8px;">🔄 乗り継ぎ後の停車駅</div>
          <div class="timeline-container">
            <div class="timeline-line"></div>
            ${timelineHtml2}
          </div>`;
      }

      detailsDiv.innerHTML = `
        <div class="timeline-container">
          <div class="timeline-line"></div>
          ${timelineHtml1}
        </div>
        ${leg2SectionHtml}`;

      card.appendChild(detailsDiv);
      card.classList.add('expanded');
    });

    renderFavStops();
    renderFavRoutes();
    loadGTFS();
  });

})();
