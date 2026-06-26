/**
 * 松江・出雲バスナビ - メインアプリケーション (完全ローカルGTFSパース版)
 * 松江市交通局・一畑バスの公式GTFS-JPオープンデータ (gtfs.zip) をブラウザ内で直接解析し、
 * 時刻表検索および直通経路検索を高速・オフラインで提供します。
 */

(() => {
  'use strict';

  // ===== 定数とストレージキー =====
  const STORAGE_KEY_THEME = 'matsue-local-bus-theme';
  const DEBOUNCE_MS = 200;

  // ===== GTFSデータ格納エリア =====
  const gtfsData = {
    agency: {},       // { agency_id: agency_name }
    stops: [],        // [{ stop_id, stop_name, stop_lat, stop_lon }]
    routes: {},       // { route_id: { route_short_name, route_long_name, agency_id } }
    trips: {},        // { trip_id: { route_id, service_id, trip_headsign } }
    calendar: {},     // { service_id: { monday...sunday, start_date, end_date } }
    calendar_dates: {}, // { service_id: { YYYYMMDD: exception_type } }
    stop_times: []    // [{ trip_id, arrival_time, departure_time, stop_id, stop_sequence, departure_secs }]
  };

  // 検索・解析を高速化するためのインデックス
  let stopIndex = [];           // オートコンプリート検索用 [{ name, kana, ids, lat, lon }]
  let stopTimesByStopId = {};   // { stop_id: [stop_time_record] }
  let stopTimesByTripId = {};   // { trip_id: [stop_time_record] } (stop_sequence順にソート済み)
  let stopNameById = {};        // { stop_id: stop_name } (逆引きマップ)

  // ===== 各要素取得 =====
  const $ = selector => document.querySelector(selector);
  const $$ = selector => document.querySelectorAll(selector);

  // ===== ユーティリティ関数 =====

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
  function getDisplayRouteName(trip, route) {
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
    
    // 系統番号が31番の場合の特別補正（一畑バスのデータ構造バグ対応）
    if (shortName === '31' && route.agency_id === '7280001000972') {
      const tripStopTimes = stopTimesByTripId[trip.trip_id] || [];
      if (tripStopTimes.length > 0) {
        const startStopId = tripStopTimes[0].stop_id;
        const startStopName = stopNameById[startStopId] || '';
        const lastStopId = tripStopTimes[tripStopTimes.length - 1].stop_id;
        const lastStopName = stopNameById[lastStopId] || '';
        
        if (startStopName.includes('八雲') || lastStopName.includes('八雲')) {
          routeTitle = '八雲';
        } else if (startStopName.includes('玉造') || lastStopName.includes('玉造')) {
          routeTitle = '玉造';
          shortName = ''; // 玉造線には系統番号がないため、[31]を表示させず「玉造」のみとする
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

    const renderDropdown = (items) => {
      if (items.length === 0) {
        dropdown.innerHTML = '';
        dropdown.classList.remove('visible');
        return;
      }

      dropdown.innerHTML = items.map(item => `
        <div class="autocomplete-item" role="option" data-name="${escapeHtml(item.name)}">
          <span class="autocomplete-item-icon">🚌</span>
          <div class="autocomplete-item-info">
            <div class="autocomplete-item-name">${escapeHtml(item.name)}</div>
            ${item.kana ? `<div class="autocomplete-item-sub">${escapeHtml(item.kana)}</div>` : ''}
          </div>
        </div>
      `).join('');
      dropdown.classList.add('visible');
    };

    const performSearch = () => {
      const val = input.value.trim().toLowerCase();
      if (!val) {
        renderDropdown([]);
        if (clearBtn) clearBtn.classList.remove('visible');
        return;
      }

      if (clearBtn) clearBtn.classList.add('visible');

      const hiraganaVal = toHiragana(val);
      const results = stopIndex.filter(stop => 
        stop.name.toLowerCase().includes(val) || 
        (stop.kana && stop.kana.includes(hiraganaVal))
      ).slice(0, 15);

      renderDropdown(results);
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
        onSelect(selectedStop);
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

    // 逆引き用の停留所名マップの構築
    stopNameById = {};
    gtfsData.stops.forEach(s => {
      stopNameById[s.stop_id] = s.stop_name;
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
   * 指定した日付で有効な service_id のセットを取得
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

    return activeServices;
  }

  // ===== 時刻表タブのロジック =====

  /**
   * バス停の全標柱の今後の発車時刻を取得
   */
  function getDeparturesForStopGroup(stopGroup, dateStr, timeStr) {
    const activeServices = getActiveServicesForDate(dateStr);
    const departures = [];

    let targetSecs = 0;
    if (timeStr) {
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
        const routeName = getDisplayRouteName(trip, route);
        const agencyName = route ? (gtfsData.agency[route.agency_id] || '路線バス') : '路線バス';

        departures.push({
          departure_secs: st.departure_secs,
          departure_time: st.departure_time,
          trip_headsign: trip.trip_headsign || '循環・その他',
          routeName: routeName,
          agencyName: agencyName,
          trip_id: st.trip_id
        });
      });
    });

    departures.sort((a, b) => a.departure_secs - b.departure_secs);
    return departures;
  }

  function handleStopSelected(stopGroup) {
    const container = $('#departures-container');

    const dateStr = todayYYYYMMDD();
    const deps = getDeparturesForStopGroup(stopGroup, dateStr, null);

    if (deps.length === 0) {
      container.innerHTML = `
        <div class="glass-card fade-in">
          <div class="departures-header">
            <div>
              <div class="departures-station-name">${escapeHtml(stopGroup.name)}</div>
              <div class="departures-date">本日これからの運行予定はありません</div>
            </div>
          </div>
          <div class="empty-state">
            <div class="empty-state-icon">🚌</div>
            <div class="empty-state-text">本日の発車予定はありません</div>
          </div>
        </div>`;
      return;
    }

    const depsHtml = deps.slice(0, 40).map((dep, i) => {
      const remaining = formatRemaining(dep.departure_secs);
      const isIchibata = dep.agencyName.includes('一畑');
      const badgeColor = isIchibata ? 'var(--ichibata-subtle)' : 'var(--shiei-subtle)';
      const badgeTextColor = isIchibata ? 'var(--ichibata)' : 'var(--shiei)';
      const companyLogo = isIchibata ? '🔴一畑' : '🔵市営';

      const idsAttr = JSON.stringify(stopGroup.ids);

      return `
        <div class="departure-card fade-in stagger-${Math.min(i + 1, 5)}" data-trip-id="${escapeHtml(dep.trip_id)}" data-current-ids='${idsAttr}'>
          <div class="departure-card-main">
            <div class="departure-time">
              ${dep.departure_time.substring(0, 5)}
              ${remaining ? `<div class="departure-time-remaining">${remaining}</div>` : ''}
            </div>
            <div class="route-color-bar" style="background:${isIchibata ? 'var(--ichibata)' : 'var(--shiei)'}"></div>
            <div class="departure-info">
              <div class="departure-route">
                ${escapeHtml(dep.routeName)}
              </div>
              <div class="departure-headsign">
                <span class="departure-mode-badge" style="background:${badgeColor}; color:${badgeTextColor}; font-size:11px; padding:2px 6px; border-radius:4px;">
                  ${companyLogo}
                </span>
                <span>→ ${escapeHtml(dep.trip_headsign)}</span>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="glass-card fade-in">
        <div class="departures-header">
          <div>
            <div class="departures-station-name">${escapeHtml(stopGroup.name)}</div>
            <div class="departures-date">本日これからの発車予定 (最大40件・タップで途中駅表示)</div>
          </div>
        </div>
        <div class="departures-list">
          ${depsHtml}
        </div>
      </div>`;
  }

  // ===== 経路検索タブのロジック =====

  /**
   * 直通バスの経路を検索
   */
  function searchDirectRoutes(fromGroup, toGroup, dateStr, timeStr, searchType) {
    const activeServices = getActiveServicesForDate(dateStr);
    const routesFound = [];

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
          const routeName = getDisplayRouteName(trip, route);
          const agencyName = route ? (gtfsData.agency[route.agency_id] || '路線バス') : '路線バス';
          const durationSecs = stTo.departure_secs - stFrom.departure_secs;

          routesFound.push({
            trip_id: tripId,
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
          <div class="loading-text">直通便を探索中...</div>
        </div>
      </div>`;

    const dateVal = $('#route-date').value.replace(/-/g, '') || todayYYYYMMDD();
    const timeVal = $('#route-time').value || null;
    const typeVal = $('#route-type').value || 'departure';

    setTimeout(() => {
      const routes = searchDirectRoutes(fromGroup, toGroup, dateVal, timeVal, typeVal);
      renderRouteResults(resultsContainer, routes, fromGroup, toGroup);
    }, 100);
  }

  function renderRouteResults(container, routes, fromGroup, toGroup) {
    if (routes.length === 0) {
      container.innerHTML = `
        <div class="glass-card fade-in">
          <div class="empty-state">
            <div class="empty-state-icon">🗺️</div>
            <div class="empty-state-text">本日、直通するバス便はありません。</div>
            <p style="color:var(--text-secondary); font-size:13px; margin: 8px 24px; text-align:center;">
              乗り継ぎが必要な可能性があります。外部の乗り換え案内サービスをご利用ください。
            </p>
            <div style="display:flex; gap:10px; margin-top:16px;">
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
        <div class="departure-card fade-in stagger-${i + 1}" data-trip-id="${escapeHtml(r.trip_id)}" data-current-ids='${idsAttr}'>
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
              </div>
              <div class="departure-headsign" style="margin-top:2px;">
                <span>→ ${escapeHtml(r.trip_headsign)}行</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); margin-top:2px; display:flex; justify-content:space-between; width:100%;">
                <span>${isIchibata ? '🔴一畑バス' : '🔵松江市営バス'}</span>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="section-label">検索結果 (直通バス便のみ・最大${maxResults}件・タップで途中駅表示)</div>
      ${routesHtml}
      <div style="text-align:center; margin-top:16px;">
        <span style="font-size:12px; color:var(--text-muted);">乗り継ぎ経路を検索したい場合は：</span>
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
        overlay.classList.add('fade-out');
      }, 100);

    } catch (err) {
      console.error(err);
      progress.innerHTML = `<span style="color:var(--rose); font-weight:700;">ロード中にエラーが発生しました: ${escapeHtml(err.message)}</span>`;
    }
  }

  function initTabsAndInputs() {
    const timetableAC = initAutocomplete({
      input: $('#stop-search-input'),
      dropdown: $('#stop-search-results'),
      clearBtn: $('#stop-search-clear'),
      onSelect: handleStopSelected
    });


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

  // ===== メイン初期化 & イベントリスニング =====
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();

    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });

    // 時刻表カードタップ時の途中停留所タイムライン表示
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.departure-card');
      if (!card) return;

      // リンクがタップされた場合はトグルしない
      if (e.target.closest('a')) {
        return;
      }

      const details = card.querySelector('.trip-details');
      if (details) {
        details.remove();
        card.classList.remove('expanded');
        return;
      }

      const tripId = card.dataset.tripId;
      if (!tripId) return;

      let currentIds = [];
      try {
        currentIds = JSON.parse(card.dataset.currentIds || '[]');
      } catch {}

      const detailsDiv = document.createElement('div');
      detailsDiv.className = 'trip-details fade-in';

      const stopTimes = stopTimesByTripId[tripId] || [];

      const timelineHtml = stopTimes.map(st => {
        const name = stopNameById[st.stop_id] || '不明';
        const time = st.departure_time.substring(0, 5);
        const isCurrent = currentIds.includes(st.stop_id);

        return `
          <div class="timeline-stop ${isCurrent ? 'current' : ''}">
            <div class="timeline-time">${time}</div>
            <div class="timeline-node"></div>
            <div class="timeline-name">${escapeHtml(name)}</div>
          </div>`;
      }).join('');

      detailsDiv.innerHTML = `
        <div class="timeline-container">
          <div class="timeline-line"></div>
          ${timelineHtml}
        </div>`;

      card.appendChild(detailsDiv);
      card.classList.add('expanded');
    });

    loadGTFS();
  });

})();
