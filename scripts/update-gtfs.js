/**
 * 松江市交通局オープンデータページから最新のGTFS-JPデータを取得し、
 * アプリケーション用の事前パース済みデータ (gtfs_data.js) を生成するスクリプト。
 *
 * 使い方:
 *   node scripts/update-gtfs.js               # Webから最新ZIPを自動検出・ダウンロードして更新
 *   node scripts/update-gtfs.js <展開済フォルダ> # 指定したローカル展開済みGTFSフォルダから生成
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const OPENDATA_PAGE_URL = 'https://matsue-bus.jp/opendata';
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_JS_PATH = path.join(ROOT_DIR, 'gtfs_data.js');
const INDEX_HTML_PATH = path.join(ROOT_DIR, 'index.html');

/**
 * 指定されたURLからバイナリまたはテキストを取得する
 * @param {string} url 取得先URL
 * @returns {Promise<Buffer>} レスポンスバッファ
 */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        resolve(fetchBuffer(redirectUrl));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTPエラー: ${res.statusCode} (${url})`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 松江市交通局オープンデータページから最新のGTFS ZIPファイルのURLとラベルを抽出する
 * @returns {Promise<{ zipUrl: string, label: string }>}
 */
async function findLatestGtfsZipUrl() {
  const html = (await fetchBuffer(OPENDATA_PAGE_URL)).toString('utf8');
  const regex = /<a[^>]+href=["'](https?:\/\/matsue-bus\.jp\/wp-content\/uploads\/[^"']+\.zip)["'][^>]*>([^<]+)<\/a>/i;
  const match = html.match(regex);
  if (!match) {
    throw new Error('オープンデータページからGTFS ZIPのリンクを検出できませんでした。');
  }
  return {
    zipUrl: match[1].trim(),
    label: match[2].trim()
  };
}

/**
 * シンプルなCSVパーサー（BOM除去・行分割・ヘッダーマッピング）
 * @param {string} text CSV文字列
 * @returns {Array<Object<string, string>>} パース結果配列
 */
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (cols[i] || '').trim();
    });
    return obj;
  });
}

/**
 * HH:MM:SS 形式の時刻文字列を0時からの経過秒数に変換する
 * @param {string} timeStr 時刻文字列
 * @returns {number} 経過秒数
 */
function parseTimeToSecs(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

/**
 * 展開済みGTFSディレクトリからアプリケーション用のオブジェクトを構築する
 * @param {string} dir GTFSテキストファイル群が格納されたディレクトリパス
 * @returns {object} window.GTFS_DATA 用のオブジェクト
 */
function buildGTFSData(dir) {
  const data = {
    feed_info: {},
    agency: {},
    stops: [],
    routes: {},
    trips: {},
    calendar: {},
    calendar_dates: {},
    fares: {},
    stop_times: []
  };

  // feed_info.txt の読み込み
  if (fs.existsSync(path.join(dir, 'feed_info.txt'))) {
    const feeds = parseCSV(fs.readFileSync(path.join(dir, 'feed_info.txt'), 'utf8'));
    if (feeds.length > 0) {
      data.feed_info = {
        start_date: feeds[0].feed_start_date || '',
        end_date: feeds[0].feed_end_date || '',
        version: feeds[0].feed_version || ''
      };
    }
  }

  // agency.txt の読み込み
  parseCSV(fs.readFileSync(path.join(dir, 'agency.txt'), 'utf8')).forEach(a => {
    if (a.agency_id) data.agency[a.agency_id] = a.agency_name;
  });

  // translations.txt からバス停のよみがなを抽出
  const kanaByFieldVal = {};
  const kanaByRecId = {};
  if (fs.existsSync(path.join(dir, 'translations.txt'))) {
    parseCSV(fs.readFileSync(path.join(dir, 'translations.txt'), 'utf8')).forEach(t => {
      if (t.table_name === 'stops' && t.field_name === 'stop_name' && t.language === 'ja-Hrkt') {
        if (t.field_value) kanaByFieldVal[t.field_value] = t.translation;
        if (t.record_id) kanaByRecId[t.record_id] = t.translation;
      }
    });
  }

  // stops.txt の読み込み
  parseCSV(fs.readFileSync(path.join(dir, 'stops.txt'), 'utf8')).forEach(s => {
    if (!s.stop_id) return;
    if (s.location_type && s.location_type !== '0') return;
    data.stops.push({
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: s.stop_lat,
      stop_lon: s.stop_lon,
      stop_kana: kanaByRecId[s.stop_id] || kanaByFieldVal[s.stop_name] || ''
    });
  });

  // routes.txt の読み込み（公式バスロケURLも含める）
  parseCSV(fs.readFileSync(path.join(dir, 'routes.txt'), 'utf8')).forEach(r => {
    if (!r.route_id) return;
    const routeEntry = {
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      agency_id: r.agency_id
    };
    if (r.route_url) {
      routeEntry.route_url = r.route_url;
    }
    data.routes[r.route_id] = routeEntry;
  });

  // trips.txt の読み込み
  parseCSV(fs.readFileSync(path.join(dir, 'trips.txt'), 'utf8')).forEach(t => {
    if (!t.trip_id) return;
    data.trips[t.trip_id] = {
      route_id: t.route_id,
      service_id: t.service_id,
      trip_headsign: t.trip_headsign
    };
  });

  // calendar.txt の読み込み
  parseCSV(fs.readFileSync(path.join(dir, 'calendar.txt'), 'utf8')).forEach(c => {
    if (!c.service_id) return;
    data.calendar[c.service_id] = {
      monday: c.monday,
      tuesday: c.tuesday,
      wednesday: c.wednesday,
      thursday: c.thursday,
      friday: c.friday,
      saturday: c.saturday,
      sunday: c.sunday,
      start_date: c.start_date,
      end_date: c.end_date
    };
  });

  // calendar_dates.txt の読み込み
  if (fs.existsSync(path.join(dir, 'calendar_dates.txt'))) {
    parseCSV(fs.readFileSync(path.join(dir, 'calendar_dates.txt'), 'utf8')).forEach(cd => {
      if (!cd.service_id || !cd.date) return;
      if (!data.calendar_dates[cd.service_id]) data.calendar_dates[cd.service_id] = {};
      data.calendar_dates[cd.service_id][cd.date] = cd.exception_type;
    });
  }

  // fare_attributes.txt と fare_rules.txt から停留所間運賃マップを構築
  if (fs.existsSync(path.join(dir, 'fare_attributes.txt')) && fs.existsSync(path.join(dir, 'fare_rules.txt'))) {
    const farePriceById = {};
    parseCSV(fs.readFileSync(path.join(dir, 'fare_attributes.txt'), 'utf8')).forEach(fa => {
      if (fa.fare_id && fa.price) {
        farePriceById[fa.fare_id] = parseInt(fa.price, 10);
      }
    });
    parseCSV(fs.readFileSync(path.join(dir, 'fare_rules.txt'), 'utf8')).forEach(fr => {
      const price = farePriceById[fr.fare_id];
      if (!price || !fr.origin_id || !fr.destination_id) return;
      const originBase = fr.origin_id.split('_')[0];
      const destBase = fr.destination_id.split('_')[0];
      data.fares[`${originBase}>${destBase}`] = price;
    });
  }

  // stop_times.txt の読み込み
  parseCSV(fs.readFileSync(path.join(dir, 'stop_times.txt'), 'utf8')).forEach(st => {
    if (!st.trip_id) return;
    data.stop_times.push({
      trip_id: st.trip_id,
      arrival_time: st.arrival_time,
      departure_time: st.departure_time,
      stop_id: st.stop_id,
      stop_sequence: st.stop_sequence,
      departure_secs: parseTimeToSecs(st.departure_time)
    });
  });

  return data;
}

/**
 * ZIPファイルを一時ディレクトリに展開する（OS標準コマンドを使用）
 * @param {string} zipPath ZIPファイルのパス
 * @param {string} destDir 展開先ディレクトリ
 */
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
    ]);
  } else {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  }
}

/**
 * YYYYMMDD 文字列から「YYYY年M月D日」表記に変換する
 * @param {string} ymd 8桁の日付文字列
 * @returns {string} 日本語日付文字列
 */
function formatJapaneseDate(ymd) {
  if (!ymd || ymd.length !== 8) return '';
  const y = parseInt(ymd.substring(0, 4), 10);
  const m = parseInt(ymd.substring(4, 6), 10);
  const d = parseInt(ymd.substring(6, 8), 10);
  return `${y}年${m}月${d}日`;
}

/**
 * メイン実行処理
 */
async function main() {
  const argPath = process.argv[2];
  let tempDir = null;
  let targetDir = null;

  try {
    if (argPath && fs.existsSync(argPath) && fs.statSync(argPath).isDirectory()) {
      console.log(`ローカルディレクトリからGTFSを読み込みます: ${argPath}`);
      targetDir = argPath;
    } else {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matsue-gtfs-'));
      const zipPath = path.join(tempDir, 'gtfs.zip');
      const extractDir = path.join(tempDir, 'extracted');

      const { zipUrl, label } = await findLatestGtfsZipUrl();
      console.log(`最新GTFSデータを検出しました: ${label} (${zipUrl})`);
      const buf = await fetchBuffer(zipUrl);
      fs.writeFileSync(zipPath, buf);
      extractZip(zipPath, extractDir);
      targetDir = extractDir;
    }

    const gtfsData = buildGTFSData(targetDir);
    const jsContent = `// 松江・出雲バスナビ - 事前パース済みGTFSデータ\nwindow.GTFS_DATA = ${JSON.stringify(gtfsData)};\n`;
    fs.writeFileSync(OUTPUT_JS_PATH, jsContent, 'utf8');

    console.log(`gtfs_data.js を出力しました (${(Buffer.byteLength(jsContent) / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  有効期間: ${gtfsData.feed_info.start_date} 〜 ${gtfsData.feed_info.end_date}`);
    console.log(`  停留所標柱数: ${gtfsData.stops.length}`);
    console.log(`  路線数: ${Object.keys(gtfsData.routes).length}`);
    console.log(`  便数: ${Object.keys(gtfsData.trips).length}`);
    console.log(`  運賃ペア数: ${Object.keys(gtfsData.fares).length}`);
    console.log(`  通過時刻数: ${gtfsData.stop_times.length}`);

    // index.html のダイヤ改正日表記およびキャッシュバスターを自動更新
    if (gtfsData.feed_info.start_date && fs.existsSync(INDEX_HTML_PATH)) {
      const jpDate = formatJapaneseDate(gtfsData.feed_info.start_date);
      let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
      html = html.replace(/（\d{4}年\d{1,2}月\d{1,2}日改正ダイヤに対応）/g, `（${jpDate}改正ダイヤに対応）`);
      html = html.replace(/gtfs_data\.js(\?v=[^"']*)?/g, `gtfs_data.js?v=${gtfsData.feed_info.start_date}`);
      fs.writeFileSync(INDEX_HTML_PATH, html, 'utf8');
      console.log(`index.html のダイヤ表記を「${jpDate}改正ダイヤに対応」に更新しました。`);
    }
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch(err => {
  console.error('GTFS更新エラー:', err);
  process.exit(1);
});
