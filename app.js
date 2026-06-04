/* YOMIASA v0.1
 * 好きなnoteクリエイターの記事を、年月でたどる小さな道具。
 * Vanilla JS / ビルド不要 / 状態は localStorage に保存。
 *
 * 画面構成（SPA・ハッシュルーティング）:
 *   #list  … クリエイター一覧画面（進捗付き縦リスト）
 *   #read  … 記事一覧画面（選択中の1人を漁る）
 */
(function () {
  'use strict';

  // note.com API は CORS を許可していないため、CORS 対応の中継プロキシ経由で取得する。
  // ?id= でクリエイタープロフィール、?path= で任意の note API パスを中継できる。
  var PROXY_URL = 'https://falling-mouse-736b.hasyamo.workers.dev/';
  var STORAGE_KEY = 'yomiasa:v0';
  // 取得ページ上限。通常は isLastPage / 空ページで終端するので実質無制限。
  // この値は API が isLastPage を返さない等の不具合時に無限ループを防ぐ保険。
  // 1ページ6件なので 9999 = 約6万件まで対応。
  var PAGE_LIMIT = 9999;

  // アプリのバージョン。updates.json のキーと一致させること。
  var APP_VERSION = '0.1.2';
  var VERSION_KEY = 'yomiasa:lastSeenVersion';

  // 読了状態の出所。manual=手動トグル / bulk_initial=初期既読セットアップでの一括既読。
  // 状態は常に上書き可能なので優先順位は持たない（最後の操作が勝つ）。
  var SOURCE = { MANUAL: 'manual', BULK_INITIAL: 'bulk_initial' };

  // ---------------------------------------------------------------------------
  // localStorage 読み書き（関数化）
  // ---------------------------------------------------------------------------

  function defaultState() {
    return {
      creators: [],
      selectedCreatorId: '',
      articlesByCreator: {},
      readArticles: {},
      uiState: {
        keyword: '',
        year: 'all',
        month: 'all',
        showUnreadOnly: false,
        sortOrder: 'desc',
      },
    };
  }

  // 旧フォーマットを現行の {status, source, readAt} へ移行する。
  //   v0.1: readArticles[key] === true
  //   v0.2: readArticles[key] === {read, source}
  // いずれも「読了」とみなせるものだけ残す（未読は記録しない）。
  function migrateReadArticles(read) {
    var out = {};
    if (!read) return out;
    Object.keys(read).forEach(function (k) {
      var v = read[k];
      var isRead;
      var source = SOURCE.MANUAL;
      if (v === true) {
        isRead = true;
      } else if (v && typeof v === 'object') {
        // 現行構造（status）／旧構造（read）の両対応
        if ('status' in v) {
          isRead = v.status === 'read';
          source = v.source === SOURCE.BULK_INITIAL ? SOURCE.BULK_INITIAL : SOURCE.MANUAL;
        } else {
          isRead = !!v.read;
        }
      } else {
        isRead = false;
      }
      if (isRead) {
        out[k] = { status: 'read', source: source, readAt: v && v.readAt ? v.readAt : null };
      }
    });
    return out;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var base = defaultState();
      return {
        creators: Array.isArray(parsed.creators) ? parsed.creators : base.creators,
        selectedCreatorId: parsed.selectedCreatorId || base.selectedCreatorId,
        articlesByCreator: parsed.articlesByCreator || base.articlesByCreator,
        readArticles: migrateReadArticles(parsed.readArticles),
        uiState: Object.assign({}, base.uiState, parsed.uiState || {}),
      };
    } catch (e) {
      return defaultState();
    }
  }

  // 保存できなかった場合は true 以外（メッセージ）を返す。
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return 'localStorage に保存できませんでした。\n空き容量を確認してください。';
    }
  }

  // 現在の状態を JSON テキストにする（エクスポート用）。
  function exportData() {
    return JSON.stringify(
      {
        app: 'yomiasa',
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        state: state,
      },
      null,
      2
    );
  }

  // JSON テキストから状態を復元して上書き保存する（インポート用）。
  // 失敗時は例外を投げる。成功時は新しい state を返す。
  function importData(jsonText) {
    var parsed = JSON.parse(jsonText);
    // エクスポート形式（{app,version,state}）と、生の state 直貼りの両対応
    var incoming = parsed && parsed.state ? parsed.state : parsed;
    if (!incoming || typeof incoming !== 'object') {
      throw new Error('形式が正しくありません');
    }
    var base = defaultState();
    var next = {
      creators: Array.isArray(incoming.creators) ? incoming.creators : base.creators,
      selectedCreatorId: incoming.selectedCreatorId || base.selectedCreatorId,
      articlesByCreator:
        incoming.articlesByCreator && typeof incoming.articlesByCreator === 'object'
          ? incoming.articlesByCreator
          : base.articlesByCreator,
      readArticles: migrateReadArticles(incoming.readArticles),
      uiState: Object.assign({}, base.uiState, incoming.uiState || {}),
    };
    state = next;
    var saved = saveState();
    if (saved !== true) throw new Error(saved);
    return state;
  }

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------

  var state = loadState();
  var isFetching = false;
  var editingCreatorId = null;

  // 一覧表示時に取得する各クリエイターの最新totalCount（揮発・保存しない）。
  // バッジ = latestTotalCount[id] - creator.seenTotalCount。
  var latestTotalCount = {};

  // 追加モーダルのプレビュー用。取得に成功すると {id, displayName, iconUrl} が入る。
  var pendingProfile = null;
  var addPreviewToken = 0; // 入力連打時の取得結果の競合を防ぐ
  var addDebounceTimer = null;

  // ---------------------------------------------------------------------------
  // クリエイターID 抽出
  // ---------------------------------------------------------------------------

  function extractCreatorId(input) {
    if (!input) return null;
    var value = String(input).trim();
    if (!value) return null;

    var urlMatch = value.match(/note\.com\/([^\/\?#\s]+)/i);
    if (urlMatch) {
      value = urlMatch[1];
    } else if (/^https?:\/\//i.test(value)) {
      return null;
    }

    value = value.replace(/^@/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    if (value === 'api') return null;
    return value;
  }

  // ---------------------------------------------------------------------------
  // API（取得処理と描画処理は分離する）
  // ---------------------------------------------------------------------------

  function fetchCreatorProfile(creatorId) {
    var url = PROXY_URL + '?id=' + encodeURIComponent(creatorId);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object') return null;
        return {
          displayName: data.nickname || creatorId,
          iconUrl: data.profileImageUrl || null,
        };
      })
      .catch(function () {
        return null;
      });
  }

  // 1ページの取得件数。per 未指定だとデフォルト6件になり、ページ番号上限(約100)に
  // 早く到達して ~600件で打ち切られる。per=18（note web の「もっと見る」と同値・
  // per の許容上限は20）にすることで多記事クリエイターも全件取得できる。
  var PER_PAGE = 18;

  function buildContentsUrl(creatorId, page) {
    var notePath =
      '/api/v2/creators/' +
      encodeURIComponent(creatorId) +
      '/contents?kind=note&page=' +
      page +
      '&per=' +
      PER_PAGE +
      '&disabled_pinned=false&with_notes=false';
    return PROXY_URL + '?path=' + encodeURIComponent(notePath);
  }

  function normalizeArticle(item, creatorId) {
    return {
      id: 'n' + item.id,
      title: item.name || '(無題)',
      url: 'https://note.com/' + creatorId + '/n/' + item.key,
      publishedAt: item.publishAt || item.publish_at || '',
      likeCount: typeof item.likeCount === 'number' ? item.likeCount : 0,
      commentCount: typeof item.commentCount === 'number' ? item.commentCount : 0,
      thumbnailUrl: item.eyecatch || '',
    };
  }

  // 記事を取得する。差分取得対応。
  //   opts.knownIds : 既に持っている記事IDの Set。新しい順に取得し、
  //                   既知IDに当たった時点で停止する（＝新着分だけ取れる）。
  //   opts.knownTotal : 前回の totalCount。page1 の totalCount がこれと同じなら
  //                     新着なしと判断し、page1 すら全部見ずに即終了する。
  //   onProgress(count) : 取得済み件数を都度通知（任意）。
  // 戻り値: { articles: 新しい順の取得分, totalCount, reachedKnown: 既知に到達して止めたか }
  function fetchArticles(creatorId, onProgress, opts) {
    opts = opts || {};
    var knownIds = opts.knownIds || null;
    var knownTotal = typeof opts.knownTotal === 'number' ? opts.knownTotal : null;

    var collected = [];
    var page = 1;
    var totalCount = null;
    var reachedKnown = false;

    function next() {
      return fetch(buildContentsUrl(creatorId, page))
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status);
          return res.json();
        })
        .then(function (json) {
          var data = json && json.data;
          if (!data || typeof data !== 'object' || !Array.isArray(data.contents)) {
            if (page === 1) throw new Error('no contents');
            return finish();
          }

          if (page === 1) {
            totalCount = typeof data.totalCount === 'number' ? data.totalCount : null;
            // 総数が前回と変わっていなければ新着なし → 取得を打ち切る
            if (knownTotal !== null && totalCount !== null && totalCount === knownTotal) {
              return finish();
            }
          }

          for (var i = 0; i < data.contents.length; i++) {
            var art = normalizeArticle(data.contents[i], creatorId);
            // 既知IDに到達したら、そこから先は持っているので停止
            if (knownIds && knownIds.has(art.id)) {
              reachedKnown = true;
              return finish();
            }
            collected.push(art);
          }

          if (typeof onProgress === 'function') onProgress(collected.length);
          if (data.isLastPage || data.contents.length === 0 || page >= PAGE_LIMIT) {
            return finish();
          }
          page += 1;
          return next();
        });
    }

    function finish() {
      return { articles: collected, totalCount: totalCount, reachedKnown: reachedKnown };
    }

    return next();
  }

  // 記事総数(totalCount)だけを軽量に取得する（page1の1リクエスト）。
  // 一覧画面で全クリエイターの新着判定に使う。失敗時は null。
  function fetchTotalCount(creatorId) {
    return fetch(buildContentsUrl(creatorId, 1))
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object') return null;
        return typeof data.totalCount === 'number' ? data.totalCount : null;
      })
      .catch(function () {
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // 読了状態
  //   readArticles[key] が存在し status==='read' なら読了。未読はキーを持たない。
  //   状態は常に上書き可能（最後の操作が勝つ）。
  // ---------------------------------------------------------------------------

  function readKey(creatorId, articleId) {
    return creatorId + ':' + articleId;
  }

  function isRead(creatorId, articleId) {
    var entry = state.readArticles[readKey(creatorId, articleId)];
    return !!(entry && entry.status === 'read');
  }

  // 読了/未読をセットする。read=false ならエントリを削除（未読）。
  function setRead(creatorId, articleId, read, source) {
    var key = readKey(creatorId, articleId);
    if (read) {
      state.readArticles[key] = {
        status: 'read',
        source: source || SOURCE.MANUAL,
        readAt: new Date().toISOString(),
      };
    } else {
      delete state.readArticles[key];
    }
  }

  // ---------------------------------------------------------------------------
  // 日付ユーティリティ
  // ---------------------------------------------------------------------------

  function parseDate(publishedAt) {
    if (!publishedAt) return null;
    var d = new Date(publishedAt);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function yearOf(a) {
    var d = parseDate(a.publishedAt);
    return d ? d.getFullYear() : null;
  }

  function monthOf(a) {
    var d = parseDate(a.publishedAt);
    return d ? d.getMonth() + 1 : null;
  }

  function formatDateDot(a) {
    var d = parseDate(a.publishedAt);
    if (!d) return '';
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '.' + m + '.' + day;
  }

  function formatFetched(iso) {
    var d = parseDate(iso);
    if (!d) return '未取得';
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '.' + m + '.' + day;
  }

  // ---------------------------------------------------------------------------
  // 集計
  // ---------------------------------------------------------------------------

  function articlesOf(creatorId) {
    return state.articlesByCreator[creatorId] || [];
  }

  function statsOf(creatorId) {
    var arts = articlesOf(creatorId);
    var read = 0;
    arts.forEach(function (a) {
      if (isRead(creatorId, a.id)) read += 1;
    });
    return { total: arts.length, read: read, unread: arts.length - read };
  }

  // 既読率（0-100の整数）。記事0件なら0。
  function readPercent(stats) {
    if (!stats.total) return 0;
    return Math.round((stats.read / stats.total) * 100);
  }

  // 新着件数 = 最新totalCount − 取得時totalCount(seenTotalCount)。
  // 最新が未取得（latestが無い）なら0扱い。差が負なら0。
  function newCountOf(creator) {
    var latest = latestTotalCount[creator.id];
    if (typeof latest !== 'number') return 0;
    var seen = typeof creator.seenTotalCount === 'number' ? creator.seenTotalCount : latest;
    return Math.max(0, latest - seen);
  }

  // 進捗バー要素を生成する（水平バー＋パーセント）。
  function progressBarEl(stats) {
    var pct = readPercent(stats);
    var wrap = document.createElement('div');
    wrap.className = 'progress';

    var track = document.createElement('div');
    track.className = 'progress-track';
    var fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = pct + '%';
    track.appendChild(fill);

    var label = document.createElement('span');
    label.className = 'progress-pct';
    label.textContent = pct + '%';

    wrap.setAttribute('role', 'progressbar');
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    wrap.setAttribute('aria-valuenow', String(pct));
    wrap.setAttribute('aria-label', '読了率 ' + pct + 'パーセント');

    wrap.appendChild(track);
    wrap.appendChild(label);
    return wrap;
  }

  function getCreator(id) {
    return (
      state.creators.filter(function (c) {
        return c.id === id;
      })[0] || null
    );
  }

  function getSelectedCreator() {
    return getCreator(state.selectedCreatorId);
  }

  // ---------------------------------------------------------------------------
  // フィルタ / グルーピング
  // ---------------------------------------------------------------------------

  function applyFilters(articles, creatorId) {
    var ui = state.uiState;
    var keyword = (ui.keyword || '').trim().toLowerCase();
    return articles.filter(function (a) {
      if (keyword && a.title.toLowerCase().indexOf(keyword) === -1) return false;
      if (ui.year !== 'all' && String(yearOf(a)) !== String(ui.year)) return false;
      if (ui.month !== 'all' && String(monthOf(a)) !== String(ui.month)) return false;
      if (ui.showUnreadOnly && isRead(creatorId, a.id)) return false;
      return true;
    });
  }

  function groupByYearMonth(articles) {
    var desc = state.uiState.sortOrder !== 'asc';
    var sorted = articles.slice().sort(function (a, b) {
      var ta = (parseDate(a.publishedAt) || new Date(0)).getTime();
      var tb = (parseDate(b.publishedAt) || new Date(0)).getTime();
      return desc ? tb - ta : ta - tb;
    });

    var years = [];
    var yearMap = {};
    sorted.forEach(function (a) {
      var y = yearOf(a);
      var m = monthOf(a);
      var yKey = y === null ? '不明' : y;
      var mKey = m === null ? '不明' : m;
      if (!yearMap[yKey]) {
        yearMap[yKey] = { year: yKey, months: [], monthMap: {} };
        years.push(yearMap[yKey]);
      }
      var yg = yearMap[yKey];
      if (!yg.monthMap[mKey]) {
        yg.monthMap[mKey] = { month: mKey, articles: [] };
        yg.months.push(yg.monthMap[mKey]);
      }
      yg.monthMap[mKey].articles.push(a);
    });
    return years;
  }

  // ---------------------------------------------------------------------------
  // DOM 参照
  // ---------------------------------------------------------------------------

  var els = {
    viewList: document.getElementById('view-list'),
    viewRead: document.getElementById('view-read'),
    emptyState: document.getElementById('empty-state'),
    emptyAddBtn: document.getElementById('empty-add-btn'),
    listBody: document.getElementById('list-body'),
    addBtn: document.getElementById('add-btn'),
    creatorList: document.getElementById('creator-list'),
    fab: document.getElementById('fab'),

    backBtn: document.getElementById('back-btn'),
    readName: document.getElementById('read-name'),
    readId: document.getElementById('read-id'),
    readStats: document.getElementById('read-stats'),
    readProgress: document.getElementById('read-progress'),
    fetchBtn: document.getElementById('fetch-btn'),
    fetchDot: document.getElementById('fetch-dot'),
    keyword: document.getElementById('keyword'),
    yearFilter: document.getElementById('year-filter'),
    monthFilter: document.getElementById('month-filter'),
    unreadOnly: document.getElementById('unread-only'),
    statusMsg: document.getElementById('status-msg'),
    articles: document.getElementById('articles'),

    addModal: document.getElementById('add-modal'),
    addInput: document.getElementById('add-input'),
    addPreview: document.getElementById('add-preview'),
    addNameWrap: document.getElementById('add-name-wrap'),
    addName: document.getElementById('add-name'),
    addError: document.getElementById('add-error'),
    addCancel: document.getElementById('add-cancel'),
    addConfirm: document.getElementById('add-confirm'),

    editModal: document.getElementById('edit-modal'),
    editName: document.getElementById('edit-name'),
    editError: document.getElementById('edit-error'),
    editCancel: document.getElementById('edit-cancel'),
    editSave: document.getElementById('edit-save'),

    setupModal: document.getElementById('setup-modal'),
    setupStepAsk: document.getElementById('setup-step-ask'),
    setupStepBulk: document.getElementById('setup-step-bulk'),
    setupLead: document.getElementById('setup-lead'),
    setupAllUnread: document.getElementById('setup-all-unread'),
    setupBulk: document.getElementById('setup-bulk'),
    setupLater: document.getElementById('setup-later'),
    setupMonthList: document.getElementById('setup-month-list'),
    setupBulkBack: document.getElementById('setup-bulk-back'),
    setupBulkApply: document.getElementById('setup-bulk-apply'),

    readbackModal: document.getElementById('readback-modal'),
    readbackArticle: document.getElementById('readback-article'),
    readbackYes: document.getElementById('readback-yes'),
    readbackNo: document.getElementById('readback-no'),

    headerVersion: document.getElementById('header-version'),
    updateModal: document.getElementById('update-modal'),
    updateVersion: document.getElementById('update-version'),
    updateBody: document.getElementById('update-body'),
    updateClose: document.getElementById('update-close'),

    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    settingsExport: document.getElementById('settings-export'),
    settingsImport: document.getElementById('settings-import'),
    settingsClose: document.getElementById('settings-close'),

    exportModal: document.getElementById('export-modal'),
    exportText: document.getElementById('export-text'),
    exportCopy: document.getElementById('export-copy'),
    exportClose: document.getElementById('export-close'),

    importModal: document.getElementById('import-modal'),
    importText: document.getElementById('import-text'),
    importError: document.getElementById('import-error'),
    importPaste: document.getElementById('import-paste'),
    importConfirm: document.getElementById('import-confirm'),
    importCancel: document.getElementById('import-cancel'),
  };

  // 初期既読セットアップの対象クリエイターID
  var setupCreatorId = null;

  // ---------------------------------------------------------------------------
  // ルーティング
  // ---------------------------------------------------------------------------

  function currentRoute() {
    return location.hash === '#read' ? 'read' : 'list';
  }

  function goTo(route) {
    if (currentRoute() === route) {
      renderRoute();
    } else {
      location.hash = route === 'read' ? '#read' : '#list';
      // hashchange イベントで renderRoute が走る
    }
  }

  function renderRoute() {
    var route = currentRoute();
    // 選択中クリエイターが無ければ read には入れない
    if (route === 'read' && !getSelectedCreator()) {
      location.hash = '#list';
      return;
    }
    var onRead = route === 'read';
    els.viewList.classList.toggle('hidden', onRead);
    els.viewRead.classList.toggle('hidden', !onRead);
    els.fab.classList.toggle('hidden', onRead || state.creators.length === 0);
    if (onRead) {
      renderReadView();
    } else {
      renderListView();
    }
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // 描画: クリエイター一覧画面
  // ---------------------------------------------------------------------------

  function renderListView() {
    var has = state.creators.length > 0;
    els.emptyState.classList.toggle('hidden', has);
    els.listBody.classList.toggle('hidden', !has);
    if (!has) return;
    renderCreatorCards();
    // 各クリエイターの最新totalCountを取得して新着バッジを更新する
    refreshLatestCounts();
  }

  // 一覧の全クリエイターの最新totalCountをAPIで取得し、新着バッジを更新する。
  // page1の1リクエスト/人。取得済みのものから順次カードに反映する。
  var refreshCountsToken = 0;
  function refreshLatestCounts() {
    var token = ++refreshCountsToken;
    state.creators.forEach(function (c) {
      // 記事未取得（seenTotalCount無し）のクリエイターは新着判定対象外
      if (typeof c.seenTotalCount !== 'number') return;
      fetchTotalCount(c.id).then(function (total) {
        if (token !== refreshCountsToken) return; // 一覧を離れた等で古い結果は破棄
        if (typeof total !== 'number') return;
        if (latestTotalCount[c.id] === total) return; // 変化なし
        latestTotalCount[c.id] = total;
        // 該当カードだけ作り直して差し替え（全再描画は避ける）
        if (currentRoute() === 'list') renderCreatorCards();
      });
    });
  }

  function renderCreatorCards() {
    els.creatorList.innerHTML = '';
    state.creators.forEach(function (c) {
      els.creatorList.appendChild(creatorCardEl(c));
    });
  }

  function creatorCardEl(c) {
    var stats = statsOf(c.id);

    var card = document.createElement('div');
    card.className =
      'creator-card' + (c.id === state.selectedCreatorId ? ' is-selected' : '');

    // top: avatar + name/id + menu
    var top = document.createElement('div');
    top.className = 'creator-card-top';

    var avatar = document.createElement('div');
    avatar.className = 'creator-card-avatar';
    if (c.iconUrl) {
      var img = document.createElement('img');
      img.src = c.iconUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        avatar.removeChild(img);
        avatar.textContent = (c.displayName || c.id).charAt(0);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (c.displayName || c.id).charAt(0);
    }
    top.appendChild(avatar);

    var head = document.createElement('div');
    head.className = 'creator-card-head';
    var name = document.createElement('div');
    name.className = 'creator-card-name';
    name.textContent = c.displayName || c.id;
    var idEl = document.createElement('div');
    idEl.className = 'creator-card-id';
    idEl.textContent = '@' + c.id;
    head.appendChild(name);
    head.appendChild(idEl);
    top.appendChild(head);

    var menu = document.createElement('div');
    menu.className = 'creator-card-menu';
    var editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.type = 'button';
    editBtn.textContent = '編集';
    editBtn.setAttribute('aria-label', '表示名を編集');
    editBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openEditModal(c.id);
    });
    var delBtn = document.createElement('button');
    delBtn.className = 'icon-btn is-danger';
    delBtn.type = 'button';
    delBtn.textContent = '削除';
    delBtn.setAttribute('aria-label', '削除');
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteCreator(c.id);
    });
    menu.appendChild(editBtn);
    menu.appendChild(delBtn);
    top.appendChild(menu);

    card.appendChild(top);

    // stats（左にテキスト、右端に新着バッジ）
    var statsEl = document.createElement('div');
    statsEl.className = 'creator-card-stats';
    var statsText = document.createElement('span');
    statsText.className = 'creator-card-stats-text';
    statsText.textContent =
      '記事 ' + stats.total + '件 / 読了 ' + stats.read + '件 / 未読 ' + stats.unread + '件';
    statsEl.appendChild(statsText);
    // 新着バッジ = 最新totalCount − 取得時totalCount
    var nc = newCountOf(c);
    if (nc > 0) {
      var badge = document.createElement('span');
      badge.className = 'badge-new';
      badge.textContent = '新着 ' + nc;
      statsEl.appendChild(badge);
    }
    card.appendChild(statsEl);

    // 進捗バー（記事取得済みのときだけ）
    if (stats.total > 0) {
      card.appendChild(progressBarEl(stats));
    }

    var fetched = document.createElement('div');
    fetched.className = 'creator-card-fetched';
    fetched.textContent = '最終取得: ' + formatFetched(c.lastFetchedAt);
    card.appendChild(fetched);

    // 初期既読の状態（記事取得済みで未セットアップのときだけ「未設定」を出す）
    if (stats.total > 0 && !c.initialSetupDone) {
      var setupRow = document.createElement('div');
      setupRow.className = 'creator-card-setup';
      setupRow.textContent = '初期既読: 未設定';
      card.appendChild(setupRow);
    }

    // action
    var action = document.createElement('div');
    action.className = 'creator-card-action';

    // 記事取得済み・未セットアップなら「既読を設定する」を併設
    if (stats.total > 0 && !c.initialSetupDone) {
      var setupBtn = document.createElement('button');
      setupBtn.className = 'btn';
      setupBtn.type = 'button';
      setupBtn.textContent = '既読を設定する';
      setupBtn.addEventListener('click', function () {
        // セットアップは選択中クリエイター前提なので合わせておく
        state.selectedCreatorId = c.id;
        saveState();
        openSetupModal(c.id);
      });
      action.appendChild(setupBtn);
    }

    var go = document.createElement('button');
    go.className = 'btn btn-primary';
    go.type = 'button';
    go.textContent = '読みに行く';
    go.addEventListener('click', function () {
      selectCreator(c.id);
    });
    action.appendChild(go);
    card.appendChild(action);

    return card;
  }

  function selectCreator(id) {
    if (state.selectedCreatorId !== id) {
      state.selectedCreatorId = id;
      // 別クリエイターに切り替えたら年月フィルタはリセット
      state.uiState.year = 'all';
      state.uiState.month = 'all';
      saveState();
    }
    // 遷移しただけではバッジを消さない（記事一覧で取得して件数を取り込むまで残す）
    clearStatus();
    goTo('read');
  }

  // ---------------------------------------------------------------------------
  // 描画: 記事一覧画面
  // ---------------------------------------------------------------------------

  function renderReadView() {
    var c = getSelectedCreator();
    if (!c) return;
    var stats = statsOf(c.id);

    els.readName.textContent = c.displayName || c.id;
    els.readId.textContent = '@' + c.id;
    renderReadHeaderStats(stats);

    els.keyword.value = state.uiState.keyword || '';
    els.unreadOnly.checked = !!state.uiState.showUnreadOnly;

    renderFilterOptions();
    renderArticles();

    // 最新totalCountを取得して新着バッジ/ドットを更新（記事取得済みのときのみ）
    if (typeof c.seenTotalCount === 'number') {
      var cid = c.id;
      fetchTotalCount(cid).then(function (total) {
        if (typeof total !== 'number') return;
        if (latestTotalCount[cid] === total) return;
        latestTotalCount[cid] = total;
        // まだ同じクリエイターの記事一覧を見ているなら再描画
        if (currentRoute() === 'read' && state.selectedCreatorId === cid) {
          renderReadHeaderStats(statsOf(cid));
        }
      });
    }
  }

  function renderFilterOptions() {
    var arts = articlesOf(state.selectedCreatorId);

    var years = [];
    var seenY = {};
    arts.forEach(function (a) {
      var y = yearOf(a);
      if (y !== null && !seenY[y]) {
        seenY[y] = true;
        years.push(y);
      }
    });
    years.sort(function (a, b) {
      return b - a;
    });
    fillSelect(
      els.yearFilter,
      [{ value: 'all', label: 'すべて' }].concat(
        years.map(function (y) {
          return { value: String(y), label: y + '年' };
        })
      ),
      state.uiState.year
    );

    var monthsSet = {};
    arts.forEach(function (a) {
      if (state.uiState.year !== 'all' && String(yearOf(a)) !== String(state.uiState.year)) {
        return;
      }
      var m = monthOf(a);
      if (m !== null) monthsSet[m] = true;
    });
    var months = Object.keys(monthsSet)
      .map(Number)
      .sort(function (a, b) {
        return b - a;
      });
    fillSelect(
      els.monthFilter,
      [{ value: 'all', label: 'すべて' }].concat(
        months.map(function (m) {
          return { value: String(m), label: m + '月' };
        })
      ),
      state.uiState.month
    );
  }

  function fillSelect(selectEl, options, selectedValue) {
    selectEl.innerHTML = '';
    var hasSelected = false;
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === String(selectedValue)) {
        o.selected = true;
        hasSelected = true;
      }
      selectEl.appendChild(o);
    });
    if (!hasSelected) selectEl.value = 'all';
  }

  function renderArticles() {
    var c = getSelectedCreator();
    els.articles.innerHTML = '';
    if (!c) return;

    var all = articlesOf(c.id);
    if (all.length === 0) {
      els.articles.appendChild(
        emptyArticlesEl('まだ記事を取得していません。\n「記事一覧を取得 / 更新」を押してください。')
      );
      return;
    }

    var filtered = applyFilters(all, c.id);
    if (filtered.length === 0) {
      els.articles.appendChild(emptyArticlesEl('条件に合う記事がありません。'));
      return;
    }

    groupByYearMonth(filtered).forEach(function (yg) {
      var yearSection = document.createElement('div');
      yearSection.className = 'year-group';

      var yh = document.createElement('div');
      yh.className = 'year-heading';
      yh.textContent = yg.year === '不明' ? '日付不明' : yg.year + '年';
      yearSection.appendChild(yh);

      yg.months.forEach(function (mg) {
        var monthSection = document.createElement('div');
        monthSection.className = 'month-group';
        var mh = document.createElement('div');
        mh.className = 'month-heading';
        mh.textContent = mg.month === '不明' ? '月不明' : mg.month + '月';
        monthSection.appendChild(mh);
        mg.articles.forEach(function (a) {
          monthSection.appendChild(articleEl(a, c.id));
        });
        yearSection.appendChild(monthSection);
      });

      els.articles.appendChild(yearSection);
    });
  }

  // 通常の記事一覧ではチェックボックスは出さない。
  // 既読は見た目（グレーアウト＋「読了」ラベル）で区別するのみ。
  // 既読状態の設定は「初期既読セットアップ」で行う。
  function articleEl(article, creatorId) {
    var read = isRead(creatorId, article.id);

    var wrap = document.createElement('div');
    wrap.className = 'article' + (read ? ' is-read' : '');

    // サムネイル（eyecatch があるときだけ。タップで記事を開ける）
    if (article.thumbnailUrl) {
      var thumbLink = document.createElement('a');
      thumbLink.className = 'article-thumb';
      thumbLink.href = article.url;
      thumbLink.target = '_blank';
      thumbLink.rel = 'noopener';
      thumbLink.tabIndex = -1; // タイトルリンクと重複するのでフォーカス対象から外す
      thumbLink.setAttribute('aria-hidden', 'true');
      var img = document.createElement('img');
      img.src = article.thumbnailUrl;
      img.alt = '';
      img.loading = 'lazy';
      // 画像が読めなければサムネ枠ごと消す
      img.addEventListener('error', function () {
        if (thumbLink.parentNode) thumbLink.parentNode.removeChild(thumbLink);
      });
      thumbLink.appendChild(img);
      wrap.appendChild(thumbLink);
    }

    // サムネのリンクにも「読みに行った」記録を仕込む
    if (article.thumbnailUrl) {
      var thumbA = wrap.querySelector('.article-thumb');
      if (thumbA) {
        thumbA.addEventListener('click', function () {
          rememberPendingArticle(creatorId, article);
        });
      }
    }

    var body = document.createElement('div');
    body.className = 'article-body';

    var link = document.createElement('a');
    link.className = 'article-title';
    link.href = article.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = article.title;
    // 記事を開いたら「読みに行った」記録を残す（戻ってきたら確認モーダル）
    link.addEventListener('click', function () {
      rememberPendingArticle(creatorId, article);
    });
    body.appendChild(link);

    var meta = document.createElement('div');
    meta.className = 'article-meta';
    var date = document.createElement('span');
    date.className = 'article-date';
    date.textContent = formatDateDot(article);
    meta.appendChild(date);

    // 既読トグルチップ（タップで未読⇄既読、手動操作）
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'article-chip' + (read ? ' is-read' : '');
    chip.textContent = read ? '読了 ✓' : '読んだにする';
    chip.addEventListener('click', function () {
      var nowRead = !isRead(creatorId, article.id);
      setRead(creatorId, article.id, nowRead, SOURCE.MANUAL);
      saveState();
      // 未読のみ表示中に既読化したら、その行は消えるので作り直す
      if (state.uiState.showUnreadOnly && nowRead) {
        renderArticles();
      } else {
        wrap.classList.toggle('is-read', nowRead);
        chip.classList.toggle('is-read', nowRead);
        chip.textContent = nowRead ? '読了 ✓' : '読んだにする';
      }
      updateReadStatsHeader();
    });
    meta.appendChild(chip);

    body.appendChild(meta);

    wrap.appendChild(body);
    return wrap;
  }

  // 記事を再描画せずヘッダーの集計だけ更新（チップ操作の軽量反映）
  function updateReadStatsHeader() {
    var c = getSelectedCreator();
    if (!c) return;
    renderReadHeaderStats(statsOf(c.id));
  }

  // ヘッダーの「記事/読了/未読」テキストと進捗バーを更新する。
  function renderReadHeaderStats(stats) {
    els.readStats.innerHTML = '';
    var statsText = document.createElement('span');
    statsText.textContent =
      '記事 ' + stats.total + '件 / 読了 ' + stats.read + '件 / 未読 ' + stats.unread + '件';
    els.readStats.appendChild(statsText);

    // 新着バッジ（クリエイター一覧カードと同じ見た目）＋ 取得ボタン右上のドット
    var c = getSelectedCreator();
    var nc = c ? newCountOf(c) : 0;
    if (nc > 0) {
      var badge = document.createElement('span');
      badge.className = 'badge-new';
      badge.textContent = '新着 ' + nc;
      els.readStats.appendChild(badge);
    }
    els.fetchDot.classList.toggle('hidden', nc <= 0);

    els.readProgress.innerHTML = '';
    if (stats.total > 0) {
      els.readProgress.appendChild(progressBarEl(stats));
    }
  }

  function emptyArticlesEl(text) {
    var p = document.createElement('p');
    p.className = 'empty-articles';
    p.textContent = text;
    return p;
  }

  // ---------------------------------------------------------------------------
  // ステータス表示
  // ---------------------------------------------------------------------------

  // type: 'loading' | 'error' | 'info'
  function setStatus(text, type) {
    els.statusMsg.innerHTML = '';
    els.statusMsg.classList.toggle('is-error', type === 'error');
    els.statusMsg.classList.toggle('is-loading', type === 'loading');
    if (type === 'loading') {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      els.statusMsg.appendChild(spinner);
    }
    els.statusMsg.appendChild(document.createTextNode(text));
    els.statusMsg.classList.remove('hidden');
  }

  function clearStatus() {
    els.statusMsg.classList.add('hidden');
    els.statusMsg.classList.remove('is-loading', 'is-error');
    els.statusMsg.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // 追加モーダル
  // ---------------------------------------------------------------------------

  function openAddModal() {
    els.addInput.value = '';
    els.addName.value = '';
    resetAddPreview();
    hideError(els.addError);
    els.addModal.classList.remove('hidden');
    els.addInput.focus();
  }

  function closeAddModal() {
    els.addModal.classList.add('hidden');
    if (addDebounceTimer) {
      clearTimeout(addDebounceTimer);
      addDebounceTimer = null;
    }
  }

  // プレビュー欄と追加ボタンを初期状態（取得前）に戻す。
  function resetAddPreview() {
    pendingProfile = null;
    addPreviewToken += 1; // 進行中の取得結果を無効化
    els.addPreview.classList.add('hidden');
    els.addPreview.innerHTML = '';
    els.addNameWrap.classList.add('hidden');
    els.addConfirm.disabled = true;
  }

  function showAddLoading() {
    pendingProfile = null;
    els.addConfirm.disabled = true;
    els.addNameWrap.classList.add('hidden');
    els.addPreview.classList.remove('hidden');
    els.addPreview.innerHTML = '<span class="add-preview-loading">読み込み中…</span>';
  }

  function showAddProfilePreview(profile) {
    els.addPreview.classList.remove('hidden');
    els.addPreview.innerHTML = '';

    var avatar = document.createElement('div');
    avatar.className = 'add-preview-avatar';
    if (profile.iconUrl) {
      var img = document.createElement('img');
      img.src = profile.iconUrl;
      img.alt = '';
      img.addEventListener('error', function () {
        avatar.removeChild(img);
        avatar.textContent = (profile.displayName || profile.id).charAt(0);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (profile.displayName || profile.id).charAt(0);
    }

    var info = document.createElement('div');
    var nameEl = document.createElement('div');
    nameEl.className = 'add-preview-name';
    nameEl.textContent = profile.displayName;
    var idEl = document.createElement('div');
    idEl.className = 'add-preview-id';
    idEl.textContent = '@' + profile.id;
    info.appendChild(nameEl);
    info.appendChild(idEl);

    els.addPreview.appendChild(avatar);
    els.addPreview.appendChild(info);

    // 表示名は取得した nickname を初期値に入れて編集可能にする
    els.addNameWrap.classList.remove('hidden');
    els.addName.value = profile.displayName;
    els.addConfirm.disabled = false;
  }

  // 入力に応じてプロフィールを取得し、プレビューを更新する。
  function handleAddInput() {
    var raw = els.addInput.value.trim();
    hideError(els.addError);

    if (!raw) {
      resetAddPreview();
      return;
    }

    var id = extractCreatorId(raw);
    if (!id) {
      resetAddPreview();
      showError(els.addError, 'noteのURLまたはIDを確認してください。');
      return;
    }

    // 既に登録済みなら取得せずに知らせる
    if (getCreator(id)) {
      resetAddPreview();
      showError(els.addError, 'このクリエイターは既に登録されています。');
      return;
    }

    showAddLoading();
    var token = ++addPreviewToken;

    fetchCreatorProfile(id)
      .then(function (profile) {
        if (token !== addPreviewToken) return; // 古い結果は破棄
        if (!profile) {
          // プロフィールが取れない = 存在しないクリエイター
          els.addPreview.classList.add('hidden');
          els.addPreview.innerHTML = '';
          els.addNameWrap.classList.add('hidden');
          els.addConfirm.disabled = true;
          pendingProfile = null;
          showError(els.addError, 'クリエイターが見つかりませんでした。');
          return;
        }
        pendingProfile = {
          id: id,
          displayName: profile.displayName || id,
          iconUrl: profile.iconUrl || null,
        };
        showAddProfilePreview(pendingProfile);
      })
      .catch(function () {
        if (token !== addPreviewToken) return;
        els.addPreview.classList.add('hidden');
        els.addNameWrap.classList.add('hidden');
        els.addConfirm.disabled = true;
        pendingProfile = null;
        showError(els.addError, 'クリエイターが見つかりませんでした。');
      });
  }

  // 確定。プレビューでプロフィール取得に成功している場合のみ登録できる。
  function confirmAdd() {
    if (!pendingProfile) return; // ボタンは disabled のはずだが念のため
    var id = pendingProfile.id;

    if (getCreator(id)) {
      showError(els.addError, 'このクリエイターは既に登録されています。');
      return;
    }

    var name = els.addName.value.trim() || pendingProfile.displayName || id;

    var creator = {
      id: id,
      displayName: name,
      iconUrl: pendingProfile.iconUrl,
      url: 'https://note.com/' + id,
      addedAt: new Date().toISOString(),
      lastFetchedAt: null,
      initialSetupDone: false,
    };
    state.creators.push(creator);
    state.selectedCreatorId = id;
    if (!state.articlesByCreator[id]) state.articlesByCreator[id] = [];

    var saved = saveState();
    if (saved !== true) {
      state.creators.pop(); // 失敗したら巻き戻す
      showError(els.addError, saved);
      return;
    }

    closeAddModal();
    clearStatus();
    goTo('read');
  }

  // ---------------------------------------------------------------------------
  // 編集モーダル
  // ---------------------------------------------------------------------------

  function openEditModal(id) {
    var c = getCreator(id);
    if (!c) return;
    editingCreatorId = id;
    els.editName.value = c.displayName || c.id;
    hideError(els.editError);
    els.editModal.classList.remove('hidden');
    els.editName.focus();
    els.editName.select();
  }

  function closeEditModal() {
    els.editModal.classList.add('hidden');
    editingCreatorId = null;
  }

  function saveEdit() {
    var c = getCreator(editingCreatorId);
    if (!c) {
      closeEditModal();
      return;
    }
    var name = els.editName.value.trim();
    if (!name) {
      showError(els.editError, '表示名を入力してください。');
      return;
    }
    c.displayName = name;
    saveState();
    closeEditModal();
    renderRoute();
  }

  // ---------------------------------------------------------------------------
  // 初期既読セットアップ
  //   初回取得後（またはカードの「既読を設定する」）に表示する。
  //   クリエイターごとに initialSetupDone を立てて、初回は1回だけ自動表示。
  // ---------------------------------------------------------------------------

  function openSetupModal(creatorId) {
    var c = getCreator(creatorId);
    if (!c) return;
    setupCreatorId = creatorId;
    var stats = statsOf(creatorId);
    els.setupLead.textContent =
      (c.displayName || c.id) + 'さんの記事を ' + stats.total + '件 取得しました。';
    // 常にステップ1から
    els.setupStepBulk.classList.add('hidden');
    els.setupStepAsk.classList.remove('hidden');
    els.setupModal.classList.remove('hidden');
  }

  function closeSetupModal() {
    els.setupModal.classList.add('hidden');
    setupCreatorId = null;
  }

  // セットアップ完了を記録して閉じ、記事一覧へ進む。
  function finishSetup() {
    var c = getCreator(setupCreatorId);
    if (c) {
      c.initialSetupDone = true;
      saveState();
    }
    var id = setupCreatorId;
    closeSetupModal();
    if (id && state.selectedCreatorId === id) {
      renderReadView();
    } else {
      renderRoute();
    }
  }

  // 「すべて未読から始める」: 何も既読化せず完了。
  function setupAllUnread() {
    finishSetup();
  }

  // 「あとで」: 完了フラグは立てない（カードから再度開けるように）。
  function setupLater() {
    var id = setupCreatorId;
    closeSetupModal();
    if (id && state.selectedCreatorId === id) {
      renderReadView();
    } else {
      renderRoute();
    }
  }

  // 「既読をまとめて設定する」: 年月チェックリストを表示。
  function setupShowBulk() {
    buildSetupMonthList();
    els.setupStepAsk.classList.add('hidden');
    els.setupStepBulk.classList.remove('hidden');
  }

  function setupBackToAsk() {
    els.setupStepBulk.classList.add('hidden');
    els.setupStepAsk.classList.remove('hidden');
  }

  // 年→月の件数つきチェックリストを組み立てる（新しい年月順）。
  function buildSetupMonthList() {
    els.setupMonthList.innerHTML = '';
    var arts = articlesOf(setupCreatorId);

    // 年→月→件数 を集計
    var years = [];
    var yearMap = {};
    arts.forEach(function (a) {
      var y = yearOf(a);
      var m = monthOf(a);
      if (y === null || m === null) return;
      if (!yearMap[y]) {
        yearMap[y] = { year: y, months: {}, monthOrder: [] };
        years.push(yearMap[y]);
      }
      if (!yearMap[y].months[m]) {
        yearMap[y].months[m] = 0;
        yearMap[y].monthOrder.push(m);
      }
      yearMap[y].months[m] += 1;
    });

    years.sort(function (a, b) {
      return b.year - a.year;
    });

    years.forEach(function (yg) {
      var block = document.createElement('div');
      block.className = 'setup-year-block';
      var label = document.createElement('div');
      label.className = 'setup-year-label';
      label.textContent = yg.year + '年';
      block.appendChild(label);

      yg.monthOrder
        .sort(function (a, b) {
          return b - a;
        })
        .forEach(function (m) {
          var row = document.createElement('label');
          row.className = 'setup-month-row';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.year = String(yg.year);
          cb.dataset.month = String(m);
          var name = document.createElement('span');
          name.className = 'setup-month-name';
          name.textContent = m + '月';
          var count = document.createElement('span');
          count.className = 'setup-month-count';
          count.textContent = yg.months[m] + '件';
          row.appendChild(cb);
          row.appendChild(name);
          row.appendChild(count);
          block.appendChild(row);
        });

      els.setupMonthList.appendChild(block);
    });
  }

  // 選択された年月の記事を一括既読（source: bulk_initial）にして完了。
  function setupApplyBulk() {
    var checks = els.setupMonthList.querySelectorAll('input[type="checkbox"]:checked');
    var selected = {};
    checks.forEach(function (cb) {
      selected[cb.dataset.year + '-' + cb.dataset.month] = true;
    });

    var arts = articlesOf(setupCreatorId);
    arts.forEach(function (a) {
      var y = yearOf(a);
      var m = monthOf(a);
      if (y === null || m === null) return;
      if (selected[y + '-' + m]) {
        setRead(setupCreatorId, a.id, true, SOURCE.BULK_INITIAL);
      }
    });

    finishSetup();
  }

  // ---------------------------------------------------------------------------
  // 記事を開いて戻ったときの読了確認
  //   記事リンクを押したら pending を sessionStorage に記録（別タブ遷移でも残る）。
  //   タブに戻る（visibilitychange/focus）と確認モーダルを出す。
  // ---------------------------------------------------------------------------

  var PENDING_KEY = 'yomiasa:pendingArticle';

  function rememberPendingArticle(creatorId, article) {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ creatorId: creatorId, articleId: article.id, title: article.title })
      );
    } catch (e) {
      /* sessionStorage 不可なら確認は出ないだけ */
    }
  }

  function takePendingArticle() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(PENDING_KEY);
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  var pendingReadback = null;

  // 戻ってきたら、未処理の pending があれば確認モーダルを開く。
  function handleReturn() {
    if (!els.readbackModal.classList.contains('hidden')) return; // 既に表示中
    var pending = takePendingArticle();
    if (!pending) return;
    // 記事がまだ存在し、既読でない場合のみ聞く（既読済みなら聞く必要なし）
    if (!getCreator(pending.creatorId)) return;
    if (isRead(pending.creatorId, pending.articleId)) return;
    pendingReadback = pending;
    els.readbackArticle.textContent = pending.title;
    els.readbackModal.classList.remove('hidden');
  }

  function closeReadbackModal() {
    els.readbackModal.classList.add('hidden');
    pendingReadback = null;
  }

  function confirmReadbackYes() {
    if (pendingReadback) {
      setRead(pendingReadback.creatorId, pendingReadback.articleId, true, SOURCE.MANUAL);
      saveState();
    }
    closeReadbackModal();
    // 表示中の画面を更新
    if (currentRoute() === 'read') {
      renderArticles();
      updateReadStatsHeader();
    } else {
      renderListView();
    }
  }

  function confirmReadbackNo() {
    closeReadbackModal();
  }

  function deleteCreator(id) {
    var c = getCreator(id);
    if (!c) return;
    var ok = window.confirm(
      '「' + (c.displayName || c.id) + '」を削除しますか?\n取得した記事と読了状態も消えます。'
    );
    if (!ok) return;

    state.creators = state.creators.filter(function (x) {
      return x.id !== id;
    });
    delete state.articlesByCreator[id];
    // この creator の読了状態も掃除
    Object.keys(state.readArticles).forEach(function (k) {
      if (k.indexOf(id + ':') === 0) delete state.readArticles[k];
    });
    if (state.selectedCreatorId === id) {
      state.selectedCreatorId = state.creators[0] ? state.creators[0].id : '';
    }
    saveState();
    goTo('list');
  }

  // ---------------------------------------------------------------------------
  // 記事取得アクション
  // ---------------------------------------------------------------------------

  function doFetch() {
    if (isFetching) return;
    var c = getSelectedCreator();
    if (!c) return;

    var existing = articlesOf(c.id);
    var isFirstFetch = !c.lastFetchedAt || existing.length === 0;

    isFetching = true;
    els.fetchBtn.disabled = true;
    els.fetchBtn.classList.add('is-loading');
    setStatus(isFirstFetch ? '記事一覧を取得しています…' : '新着を確認しています…', 'loading');

    function onProgress(count) {
      setStatus(count + '件を取得中…', 'loading');
    }

    // 差分取得: 既知IDと前回totalCountを渡す（初回は素の全件取得）
    var opts = isFirstFetch
      ? {}
      : {
          knownIds: new Set(
            existing.map(function (a) {
              return a.id;
            })
          ),
          knownTotal: typeof c.knownTotalCount === 'number' ? c.knownTotalCount : null,
        };

    fetchArticles(c.id, onProgress, opts)
      .then(function (result) {
        var fresh = result.articles || [];

        if (isFirstFetch) {
          if (fresh.length === 0) {
            setStatus('記事が見つかりませんでした。', 'error');
            return;
          }
          state.articlesByCreator[c.id] = fresh;
        } else {
          // 新着分を既存の先頭にマージ（fresh は新しい順）。重複は除外。
          if (fresh.length > 0) {
            var have = new Set(
              existing.map(function (a) {
                return a.id;
              })
            );
            var add = fresh.filter(function (a) {
              return !have.has(a.id);
            });
            state.articlesByCreator[c.id] = add.concat(existing);
          }
        }

        // 取得＝件数を取り込んだので seen を最新に合わせる → バッジは消える
        if (typeof result.totalCount === 'number') {
          c.knownTotalCount = result.totalCount;
          c.seenTotalCount = result.totalCount;
          latestTotalCount[c.id] = result.totalCount;
        }
        c.lastFetchedAt = new Date().toISOString();

        var saved = saveState();
        if (saved !== true) {
          setStatus(saved, 'error');
          return;
        }

        // 結果メッセージ
        if (!isFirstFetch) {
          var addedNow = state.articlesByCreator[c.id].length - existing.length;
          if (addedNow > 0) {
            setStatus('新着 ' + addedNow + '件を取得しました。', 'info');
          } else {
            setStatus('新着はありませんでした。', 'info');
          }
        } else {
          clearStatus();
        }

        renderReadView();
        if (isFirstFetch && !c.initialSetupDone) {
          openSetupModal(c.id);
        }
      })
      .catch(function () {
        setStatus(
          '記事一覧を取得できませんでした。\nnote IDを確認して、もう一度試してください。',
          'error'
        );
      })
      .then(function () {
        isFetching = false;
        els.fetchBtn.disabled = false;
        els.fetchBtn.classList.remove('is-loading');
      });
  }

  // ---------------------------------------------------------------------------
  // モーダル汎用
  // ---------------------------------------------------------------------------

  function showError(el, text) {
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function hideError(el) {
    el.textContent = '';
    el.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // イベント配線
  // ---------------------------------------------------------------------------

  function wireEvents() {
    window.addEventListener('hashchange', renderRoute);

    els.emptyAddBtn.addEventListener('click', openAddModal);
    els.addBtn.addEventListener('click', openAddModal);
    els.fab.addEventListener('click', openAddModal);

    els.backBtn.addEventListener('click', function () {
      goTo('list');
    });
    els.fetchBtn.addEventListener('click', doFetch);

    // 追加モーダル
    els.addCancel.addEventListener('click', closeAddModal);
    els.addConfirm.addEventListener('click', confirmAdd);
    els.addModal.addEventListener('click', function (e) {
      if (e.target === els.addModal) closeAddModal();
    });
    // 入力中にプロフィールを取得（連打は 350ms デバウンス）
    els.addInput.addEventListener('input', function () {
      if (addDebounceTimer) clearTimeout(addDebounceTimer);
      addDebounceTimer = setTimeout(handleAddInput, 350);
    });
    // Enter での即時取得・確定
    els.addInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (addDebounceTimer) {
        clearTimeout(addDebounceTimer);
        addDebounceTimer = null;
      }
      if (pendingProfile) {
        confirmAdd();
      } else {
        handleAddInput();
      }
    });
    els.addName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && pendingProfile) confirmAdd();
    });

    // 編集モーダル
    els.editCancel.addEventListener('click', closeEditModal);
    els.editSave.addEventListener('click', saveEdit);
    els.editModal.addEventListener('click', function (e) {
      if (e.target === els.editModal) closeEditModal();
    });
    els.editName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveEdit();
    });

    // 初期既読セットアップ
    els.setupAllUnread.addEventListener('click', setupAllUnread);
    els.setupBulk.addEventListener('click', setupShowBulk);
    els.setupLater.addEventListener('click', setupLater);
    els.setupBulkBack.addEventListener('click', setupBackToAsk);
    els.setupBulkApply.addEventListener('click', setupApplyBulk);
    // セットアップはオーバーレイ外クリックでは閉じない（誤操作で初期化を飛ばさない）

    // 読了確認モーダル（記事から戻ったとき）
    els.readbackYes.addEventListener('click', confirmReadbackYes);
    els.readbackNo.addEventListener('click', confirmReadbackNo);

    // 設定 / エクスポート / インポート
    els.settingsBtn.addEventListener('click', openSettingsModal);
    els.settingsClose.addEventListener('click', closeSettingsModal);
    els.settingsModal.addEventListener('click', function (e) {
      if (e.target === els.settingsModal) closeSettingsModal();
    });
    els.settingsExport.addEventListener('click', openExportModal);
    els.settingsImport.addEventListener('click', openImportModal);

    els.exportCopy.addEventListener('click', copyExport);
    els.exportClose.addEventListener('click', closeExportModal);
    els.exportModal.addEventListener('click', function (e) {
      if (e.target === els.exportModal) closeExportModal();
    });

    els.importPaste.addEventListener('click', pasteFromClipboard);
    els.importConfirm.addEventListener('click', confirmImport);
    els.importCancel.addEventListener('click', closeImportModal);
    els.importModal.addEventListener('click', function (e) {
      if (e.target === els.importModal) closeImportModal();
    });

    // 記事を読んで戻ってきたことの検知
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') handleReturn();
    });
    window.addEventListener('focus', handleReturn);

    // フィルタ
    els.keyword.addEventListener('input', function () {
      state.uiState.keyword = els.keyword.value;
      saveState();
      renderArticles();
    });
    els.yearFilter.addEventListener('change', function () {
      state.uiState.year = els.yearFilter.value;
      state.uiState.month = 'all';
      saveState();
      renderFilterOptions();
      renderArticles();
    });
    els.monthFilter.addEventListener('change', function () {
      state.uiState.month = els.monthFilter.value;
      saveState();
      renderArticles();
    });
    els.unreadOnly.addEventListener('change', function () {
      state.uiState.showUnreadOnly = els.unreadOnly.checked;
      saveState();
      renderArticles();
    });

    // Esc でモーダルを閉じる
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!els.addModal.classList.contains('hidden')) closeAddModal();
        if (!els.editModal.classList.contains('hidden')) closeEditModal();
        if (!els.readbackModal.classList.contains('hidden')) closeReadbackModal();
        if (!els.updateModal.classList.contains('hidden')) closeUpdateModal();
        if (!els.settingsModal.classList.contains('hidden')) closeSettingsModal();
        if (!els.exportModal.classList.contains('hidden')) closeExportModal();
        if (!els.importModal.classList.contains('hidden')) closeImportModal();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // アップデートお知らせ
  //   updates.json から現バージョンの更新内容を取得し、未読なら1回だけ表示する。
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function checkVersionUpdate() {
    if (els.headerVersion) els.headerVersion.textContent = 'v' + APP_VERSION;

    var lastSeen = null;
    try {
      lastSeen = localStorage.getItem(VERSION_KEY);
    } catch (e) {
      /* noop */
    }
    if (lastSeen === APP_VERSION) return;

    // updates.json を取得（キャッシュ回避のため t= を付ける）
    fetch('updates.json?t=' + new Date().getTime())
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        var items = data ? data[APP_VERSION] : null;
        if (!items || items.length === 0) {
          // お知らせが無ければ静かに既読化
          rememberSeenVersion();
          return;
        }
        els.updateVersion.textContent = 'v' + APP_VERSION;
        els.updateBody.innerHTML = items
          .map(function (t) {
            return '<li>' + escapeHtml(t) + '</li>';
          })
          .join('');
        els.updateModal.classList.remove('hidden');
      })
      .catch(function () {
        /* 取得失敗時はモーダルを出さない（既読化もしない＝次回再試行） */
      });
  }

  function rememberSeenVersion() {
    try {
      localStorage.setItem(VERSION_KEY, APP_VERSION);
    } catch (e) {
      /* noop */
    }
  }

  function closeUpdateModal() {
    rememberSeenVersion();
    els.updateModal.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // 設定 / エクスポート / インポート
  // ---------------------------------------------------------------------------

  function openSettingsModal() {
    els.settingsModal.classList.remove('hidden');
  }
  function closeSettingsModal() {
    els.settingsModal.classList.add('hidden');
  }

  function openExportModal() {
    closeSettingsModal();
    els.exportText.value = exportData();
    els.exportCopy.textContent = 'コピー';
    els.exportModal.classList.remove('hidden');
    // 選択しておくと手動コピーもしやすい
    setTimeout(function () {
      els.exportText.focus();
      els.exportText.select();
    }, 50);
  }
  function closeExportModal() {
    els.exportModal.classList.add('hidden');
  }

  function copyExport() {
    var text = els.exportText.value;
    var done = function () {
      els.exportCopy.textContent = 'コピーしました';
      setTimeout(function () {
        els.exportCopy.textContent = 'コピー';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(els.exportText);
        done();
      });
    } else {
      legacyCopy(els.exportText);
      done();
    }
  }

  function legacyCopy(textarea) {
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* noop */
    }
  }

  function openImportModal() {
    closeSettingsModal();
    els.importText.value = '';
    hideError(els.importError);
    els.importModal.classList.remove('hidden');
    setTimeout(function () {
      els.importText.focus();
    }, 50);
  }
  function closeImportModal() {
    els.importModal.classList.add('hidden');
  }

  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showError(els.importError, 'この環境では自動貼り付けに対応していません。\n手動で貼り付けてください。');
      els.importText.focus();
      return;
    }
    navigator.clipboard.readText().then(
      function (text) {
        els.importText.value = text;
        hideError(els.importError);
      },
      function () {
        showError(els.importError, 'クリップボードを読み取れませんでした。\n手動で貼り付けてください。');
        els.importText.focus();
      }
    );
  }

  // 貼り付けで混入しがちな不可視文字を正規化する。
  //   BOM除去 / ゼロ幅スペース除去 / ノーブレークスペース等を通常スペースへ
  function normalizePasted(raw) {
    return raw
      .replace(/^﻿/, '')
      .replace(/[​-‍]/g, '')
      .replace(/[   ]/g, ' ')
      .trim();
  }

  function confirmImport() {
    var raw = els.importText.value;
    if (!raw || !raw.trim()) {
      showError(els.importError, 'テキストを貼り付けてください。');
      return;
    }
    var ok = window.confirm('現在のデータを、貼り付けた内容で上書きします。よろしいですか?');
    if (!ok) return;

    try {
      importData(normalizePasted(raw));
    } catch (e) {
      showError(
        els.importError,
        '読み込みに失敗しました。\nエクスポートしたテキストか確認してください。'
      );
      return;
    }
    closeImportModal();
    // 選択中クリエイターの整合性を取り直して全再描画
    if (state.selectedCreatorId && !getCreator(state.selectedCreatorId)) {
      state.selectedCreatorId = '';
      saveState();
    }
    clearStatus();
    goTo('list');
    renderRoute();
  }

  // ---------------------------------------------------------------------------
  // Service Worker（PWA）
  // ---------------------------------------------------------------------------

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // 相対パスで登録（GitHub Pages の /yomiasa/ サブパスでも動く）
    navigator.serviceWorker.register('sw.js').catch(function () {
      /* 登録失敗は致命的でないので無視 */
    });
  }

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------

  function init() {
    // 選択中クリエイターの整合性
    if (state.selectedCreatorId && !getCreator(state.selectedCreatorId)) {
      state.selectedCreatorId = '';
    }
    wireEvents();
    els.updateClose.addEventListener('click', closeUpdateModal);
    // 直接 #read で来ても選択が無ければ list に落とす（renderRoute 内で処理）
    renderRoute();
    checkVersionUpdate();
    registerServiceWorker();
  }

  init();
})();
