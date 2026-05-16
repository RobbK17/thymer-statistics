/**
 * Stats Dashboard — hybrid load, localStorage cache, event deltas. v1.0.5
 */

const STATS_CACHE_STORAGE_VERSION = 1;

class Plugin extends AppPlugin {

  onLoad() {
    this._statsCache = null;
    this._enrichGeneration = 0;
    this._activeDashboard = null;
    this._uiThrottleTimer = null;
    this._persistTimer = null;
    this._rescanTimers = new Map();
    this._eventHandlerIds = [];

    this.ui.registerCustomPanelType('workspace-stats', (panel) => {
      this.renderStatsPanel(panel);
    });

    this.ui.addCommandPaletteCommand({
      label: 'Show Stats Dashboard',
      icon: 'chart-bar',
      onSelected: async () => {
        await this._openPanel();
      },
    });

    this.ui.addSidebarItem({
      label: 'Stats Dashboard',
      icon: 'chart-bar',
      tooltip: 'View workspace statistics',
      onClick: async () => {
        await this._openPanel();
      },
    });

    this._bindWorkspaceEvents();
    this._injectStyles();
  }

  _bindWorkspaceEvents() {
    const on = (name, fn) => {
      this._eventHandlerIds.push(this.events.on(name, fn));
    };

    on('reload', () => {
      this._clearPersistedCache();
      this._statsCache = null;
      if (this._activeDashboard) {
        this.renderStatsPanel(this._activeDashboard.panel);
      }
    });

    on('record.created', (ev) => this._handleRecordCreated(ev));

    on('collection.created', () => this._handleCollectionStructureChange());
    on('collection.updated', () => this._handleCollectionStructureChange());
    on('global-plugin.created', () => this._handleCollectionStructureChange());
    on('global-plugin.updated', () => this._handleCollectionStructureChange());

    const schedule = (ev) => {
      const guid = ev.recordGuid ?? ev.getRecord?.()?.guid;
      if (guid) this._scheduleRecordRescan(guid);
    };

    on('record.updated', schedule);
    on('record.moved', schedule);
    on('lineitem.created', schedule);
    on('lineitem.updated', schedule);
    on('lineitem.deleted', schedule);
    on('lineitem.moved', schedule);
    on('lineitem.undeleted', schedule);
  }

  // ─── Panel ──────────────────────────────────────────────────────────────

  async _openPanel() {
    const panels = this.ui.getPanels();
    const rightmost = panels.length > 0 ? panels[panels.length - 1] : null;
    const panel = await this.ui.createPanel({ afterPanel: rightmost });
    if (panel) {
      panel.navigateToCustomType('workspace-stats');
      panel.setTitle('Stats');
    }
  }

  async renderStatsPanel(panel, forceRefresh = false) {
    this._cancelEnrich();
    const generation = ++this._enrichGeneration;
    const opts = this._getScanOptions();

    const el = panel.getElement();
    el.innerHTML = `
      <div class="ws-loading" style="padding:40px;text-align:center">
        <div class="ws-spinner"></div>
        <p class="ws-loading-msg" style="margin-top:18px;opacity:0.5;font-size:13px">Loading workspace metadata…</p>
      </div>`;

    let cache = null;

    if (forceRefresh && opts.persistCache) {
      this._clearPersistedCache();
    } else if (opts.persistCache) {
      const blob = this._loadPersistedCache();
      if (blob && this._isPersistedValid(blob)) {
        const msg = el.querySelector('.ws-loading-msg');
        if (msg) msg.textContent = 'Restoring cached stats…';
        cache = this._deserializeCache(blob);
        cache = await this._scanMetadata(generation, cache);
        if (generation !== this._enrichGeneration) return;
      }
    }

    if (!cache) {
      cache = await this._scanMetadata(generation);
      if (generation !== this._enrichGeneration) return;
    }

    this._statsCache = cache;

    const userName = cache.users.length > 0
      ? cache.users[0].getDisplayName() || cache.users[0].getEmail()
      : 'Workspace';

    panel.setTitle(`${userName}'s Stats`);

    const uiState = { activeKey: null, detailBuilt: new Set() };
    this._activeDashboard = { panel, el, generation, uiState };

    el.innerHTML = this._buildShellHTML(cache, userName);
    this._bindEvents(el, panel, uiState);
    this._updateCardUI(el, cache);
    this._updateProgressUI(el, cache);

    this._runBackgroundEnrich(cache, generation, el, panel, uiState);

    if (cache.phase === 'ready' && cache.enrichQueue.length === 0) {
      this._persistCacheNow(cache);
    }
  }

  _cancelEnrich() {
    this._enrichGeneration++;
    if (this._uiThrottleTimer) {
      clearTimeout(this._uiThrottleTimer);
      this._uiThrottleTimer = null;
    }
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
  }

  // ─── Config ─────────────────────────────────────────────────────────────

  _getScanOptions() {
    const cfg = this.getConfiguration();
    const custom = cfg.custom || {};
    return {
      excludeJournalEmpty: custom.emptyRecordsExcludeJournal !== false,
      largeWorkspaceThreshold: custom.largeWorkspaceThreshold ?? 3000,
      enrichBatchSize: custom.enrichBatchSize ?? 40,
      uiUpdateIntervalMs: custom.uiUpdateIntervalMs ?? 250,
      scanMode: custom.scanMode || 'auto',
      persistCache: custom.persistCache !== false,
      cacheTtlMs: custom.cacheTtlMs ?? 7 * 24 * 60 * 60 * 1000,
      cacheSaveDebounceMs: custom.cacheSaveDebounceMs ?? 1000,
      expandLineItemReferences: custom.expandLineItemReferences === true,
    };
  }

  _useBackgroundEnrich(totalRecords, opts) {
    if (opts.scanMode === 'full') return false;
    if (opts.scanMode === 'fast') return true;
    return totalRecords >= opts.largeWorkspaceThreshold;
  }

  // ─── Persistence (localStorage) ───────────────────────────────────────────

  _storageKey() {
    return `thymer-stats:v${STATS_CACHE_STORAGE_VERSION}:${this.getWorkspaceGuid()}`;
  }

  _prefsStorageKey() {
    return `thymer-stats-prefs:v${STATS_CACHE_STORAGE_VERSION}:${this.getWorkspaceGuid()}`;
  }

  /** When true, `getLineItems(true)` includes reference/transclusion targets (heavier, higher totals). */
  _getExpandLineItemReferences() {
    try {
      const raw = localStorage.getItem(this._prefsStorageKey());
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.expandLineItemReferences === 'boolean') {
          return p.expandLineItemReferences;
        }
      }
    } catch (_) { /* ignore */ }
    return this._getScanOptions().expandLineItemReferences;
  }

  _setExpandLineItemReferences(value, panel) {
    try {
      localStorage.setItem(
        this._prefsStorageKey(),
        JSON.stringify({ expandLineItemReferences: !!value }),
      );
    } catch (_) { /* ignore */ }
    this.renderStatsPanel(panel, true);
  }

  _loadPersistedCache() {
    try {
      const raw = localStorage.getItem(this._storageKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  _clearPersistedCache() {
    try {
      localStorage.removeItem(this._storageKey());
    } catch (_) { /* ignore */ }
  }

  _isPersistedValid(blob) {
    if (!blob || blob.version !== STATS_CACHE_STORAGE_VERSION) return false;
    if (blob.workspaceGuid !== this.getWorkspaceGuid()) return false;
    const opts = this._getScanOptions();
    if (opts.cacheTtlMs > 0 && blob.builtAt) {
      if (Date.now() - blob.builtAt > opts.cacheTtlMs) return false;
    }
    if (blob.expandLineItemReferences !== this._getExpandLineItemReferences()) return false;
    return true;
  }

  _serializeCache(cache) {
    const records = {};
    for (const [guid, entry] of cache.byRecord) {
      records[guid] = {
        guid: entry.guid,
        name: entry.name,
        colGuid: entry.colGuid,
        colName: entry.colName,
        colIcon: entry.colIcon,
        isJournal: entry.isJournal,
        lineItemCount: entry.lineItemCount,
        taskCount: entry.taskCount,
        isEmpty: entry.isEmpty,
        scanned: entry.scanned,
        snapshot: entry.snapshot,
      };
    }

    const collections = cache.collections.map((c) => ({
      guid: c.guid,
      name: c.name,
      isJournal: c.isJournal,
      recordCount: c.recordCount,
      lineItemCount: c.lineItemCount,
      taskCount: c.taskCount,
      newThisWeek: c.newThisWeek,
      editThisWeek: c.editThisWeek,
      lastActivity: c.lastActivity ? c.lastActivity.getTime() : null,
      icon: c.config?.icon || 'file-text',
    }));

    return {
      version: STATS_CACHE_STORAGE_VERSION,
      workspaceGuid: this.getWorkspaceGuid(),
      expandLineItemReferences: this._getExpandLineItemReferences(),
      builtAt: Date.now(),
      phase: cache.phase,
      progress: { done: cache.progress.done, total: cache.progress.total },
      totals: { ...cache.totals },
      lineItemTypes: { ...cache.lineItemTypes },
      taskStatuses: { ...cache.taskStatuses },
      propertyTypes: { ...cache.propertyTypes },
      viewTypes: { ...cache.viewTypes },
      collections,
      records,
      largestRecords: cache.largestRecords.map((r) => ({ ...r })),
      emptySamples: cache.emptySamples.map((r) => ({ ...r })),
      recentRecords: cache.recentRecords.map((r) => ({
        guid: r.guid,
        name: r.name,
        colName: r.colName,
        colIcon: r.colIcon,
        date: r.date instanceof Date ? r.date.getTime() : r.date,
      })),
    };
  }

  _deserializeCache(blob) {
    const cache = this._createEmptyCache();
    cache.phase = blob.phase === 'ready' ? 'ready' : 'enriching';
    cache.progress = blob.progress || { done: 0, total: 0 };
    cache.totals = { ...blob.totals };
    cache.lineItemTypes = { ...blob.lineItemTypes };
    cache.taskStatuses = { ...blob.taskStatuses };
    cache.propertyTypes = { ...blob.propertyTypes };
    cache.viewTypes = { ...blob.viewTypes };
    cache.largestRecords = (blob.largestRecords || []).map((r) => ({ ...r }));
    cache.emptySamples = (blob.emptySamples || []).map((r) => ({ ...r }));
    cache.recentRecords = (blob.recentRecords || []).map((r) => ({
      guid: r.guid,
      name: r.name,
      colName: r.colName,
      colIcon: r.colIcon,
      date: new Date(r.date),
    }));

    cache.collections = (blob.collections || []).map((c) => ({
      guid: c.guid,
      name: c.name,
      isJournal: c.isJournal,
      recordCount: c.recordCount,
      lineItemCount: c.lineItemCount,
      taskCount: c.taskCount,
      newThisWeek: c.newThisWeek,
      editThisWeek: c.editThisWeek,
      lastActivity: c.lastActivity != null ? new Date(c.lastActivity) : null,
      config: { icon: c.icon || 'file-text', fields: [], views: [] },
    }));

    cache.colByGuid = new Map(cache.collections.map((c) => [c.guid, c]));

    for (const [guid, rec] of Object.entries(blob.records || {})) {
      cache.byRecord.set(guid, {
        guid: rec.guid,
        name: rec.name,
        colGuid: rec.colGuid,
        colName: rec.colName,
        colIcon: rec.colIcon,
        isJournal: rec.isJournal,
        record: null,
        lineItemCount: rec.lineItemCount,
        taskCount: rec.taskCount,
        scanned: !!rec.scanned,
        isEmpty: !!rec.isEmpty,
        snapshot: rec.snapshot || null,
      });
    }

    return cache;
  }

  _schedulePersist(cache) {
    const opts = this._getScanOptions();
    if (!opts.persistCache || !cache) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistCacheNow(cache);
    }, opts.cacheSaveDebounceMs);
  }

  _persistCacheNow(cache) {
    const opts = this._getScanOptions();
    if (!opts.persistCache || !cache) return;
    if (cache.phase !== 'ready' && cache.phase !== 'enriching') return;
    try {
      const blob = this._serializeCache(cache);
      localStorage.setItem(this._storageKey(), JSON.stringify(blob));
    } catch (e) {
      if (e?.name === 'QuotaExceededError') this._clearPersistedCache();
    }
  }

  _ensureStatsCacheLoaded() {
    if (this._statsCache) return this._statsCache;
    const opts = this._getScanOptions();
    if (!opts.persistCache) return null;
    const blob = this._loadPersistedCache();
    if (!blob || !this._isPersistedValid(blob)) return null;
    this._statsCache = this._deserializeCache(blob);
    return this._statsCache;
  }

  _removeRecordFromCache(cache, guid) {
    const entry = cache.byRecord.get(guid);
    if (!entry) return;
    const colData = cache.colByGuid.get(entry.colGuid);
    if (entry.snapshot) this._subtractSnapshot(cache, entry, colData);
    this._removeEmptySample(cache, guid, entry);
    cache.byRecord.delete(guid);
  }

  // ─── Cache ────────────────────────────────────────────────────────────────

  _createEmptyCache() {
    return {
      phase: 'metadata',
      progress: { done: 0, total: 0 },
      totals: {
        records: 0,
        lineItems: 0,
        tasks: 0,
        properties: 0,
        views: 0,
        newThisWeek: 0,
        emptyCount: 0,
      },
      lineItemTypes: {},
      taskStatuses: {},
      propertyTypes: {},
      viewTypes: {},
      collections: [],
      colByGuid: new Map(),
      byRecord: new Map(),
      enrichQueue: [],
      largestRecords: [],
      emptySamples: [],
      recentRecords: [],
      users: [],
      globalPlugins: [],
      detailDirty: new Set(),
    };
  }

  _cacheToStats(cache) {
    return {
      phase: cache.phase,
      progress: cache.progress,
      collections: cache.collections,
      totalRecords: cache.totals.records,
      totalLineItems: cache.totals.lineItems,
      totalTasks: cache.totals.tasks,
      totalProperties: cache.totals.properties,
      totalViews: cache.totals.views,
      newThisWeek: cache.totals.newThisWeek,
      lineItemTypes: cache.lineItemTypes,
      taskStatuses: cache.taskStatuses,
      propertyTypes: cache.propertyTypes,
      viewTypes: cache.viewTypes,
      largestRecords: cache.largestRecords,
      emptyRecords: cache.emptySamples,
      emptyCount: cache.totals.emptyCount,
      recentRecords: cache.recentRecords,
      users: cache.users,
      globalPlugins: cache.globalPlugins,
    };
  }

  async _scanMetadata(generation, existingCache = null) {
    const reconcile = !!existingCache;
    const cache = reconcile ? existingCache : this._createEmptyCache();
    const opts = this._getScanOptions();
    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    cache.enrichQueue = [];
    cache.totals.newThisWeek = 0;
    cache.recentRecords = [];
    cache.propertyTypes = {};
    cache.viewTypes = {};
    cache.totals.properties = 0;
    cache.totals.views = 0;
    cache.totals.records = 0;

    cache.users = this.data.getActiveUsers();
    cache.globalPlugins = await this.data.getAllGlobalPlugins();
    if (generation !== this._enrichGeneration) return cache;

    const collections = await this.data.getAllCollections();
    if (generation !== this._enrichGeneration) return cache;

    const liveGuids = new Set();
    const nextCollections = [];

    for (const col of collections) {
      const colCfg = col.getConfiguration();
      const colGuid = col.getGuid();
      let colData = cache.colByGuid.get(colGuid);

      if (colData) {
        colData.name = col.getName();
        colData.isJournal = col.isJournalPlugin();
        colData.config = colCfg;
        colData.recordCount = 0;
        colData.newThisWeek = 0;
        colData.editThisWeek = 0;
        colData.lastActivity = null;
        if (!reconcile) {
          colData.lineItemCount = 0;
          colData.taskCount = 0;
        }
      } else {
        colData = {
          guid: colGuid,
          name: col.getName(),
          isJournal: col.isJournalPlugin(),
          recordCount: 0,
          lineItemCount: 0,
          taskCount: 0,
          newThisWeek: 0,
          editThisWeek: 0,
          lastActivity: null,
          config: colCfg,
        };
      }

      if (colCfg.fields) {
        for (const f of colCfg.fields) {
          if (f.active) {
            cache.propertyTypes[f.type] = (cache.propertyTypes[f.type] || 0) + 1;
            cache.totals.properties++;
          }
        }
      }
      if (colCfg.views) {
        for (const v of colCfg.views) {
          if (v.shown) {
            cache.viewTypes[v.type] = (cache.viewTypes[v.type] || 0) + 1;
            cache.totals.views++;
          }
        }
      }

      const records = await col.getAllRecords();
      colData.recordCount = records.length;
      cache.totals.records += records.length;

      const colIcon = colCfg.icon || 'file-text';
      const isJournal = col.isJournalPlugin();

      for (const record of records) {
        const guid = record.guid;
        liveGuids.add(guid);
        const createdAt = record.getCreatedAt();
        const updatedAt = record.getUpdatedAt();
        const lastTouch = updatedAt ?? createdAt;

        if (createdAt && createdAt >= weekAgo) {
          colData.newThisWeek++;
          cache.totals.newThisWeek++;
        }
        if (updatedAt && updatedAt >= weekAgo) {
          colData.editThisWeek++;
        }
        if (lastTouch) {
          if (!colData.lastActivity || lastTouch > colData.lastActivity) {
            colData.lastActivity = lastTouch;
          }
          this._pushRecent(cache, {
            guid,
            name: record.getName() || '(untitled)',
            colName: colData.name,
            colIcon,
            date: lastTouch,
          });
        }

        let entry = cache.byRecord.get(guid);
        if (entry) {
          entry.record = record;
          entry.name = record.getName() || '(untitled)';
          entry.colGuid = colGuid;
          entry.colName = colData.name;
          entry.colIcon = colIcon;
          entry.isJournal = isJournal;
          if (!entry.scanned) cache.enrichQueue.push(entry);
        } else {
          entry = {
            guid,
            name: record.getName() || '(untitled)',
            colGuid,
            colName: colData.name,
            colIcon,
            isJournal,
            record,
            lineItemCount: null,
            taskCount: 0,
            scanned: false,
            isEmpty: false,
            snapshot: null,
          };
          cache.byRecord.set(guid, entry);
          cache.enrichQueue.push(entry);
        }
      }

      if (reconcile) {
        colData.lineItemCount = 0;
        colData.taskCount = 0;
        for (const entry of cache.byRecord.values()) {
          if (entry.colGuid === colGuid && entry.scanned && entry.snapshot) {
            colData.lineItemCount += entry.snapshot.count;
            colData.taskCount += entry.snapshot.taskCount;
          }
        }
      }

      nextCollections.push(colData);
      cache.colByGuid.set(colData.guid, colData);
    }

    if (reconcile) {
      for (const guid of [...cache.byRecord.keys()]) {
        if (!liveGuids.has(guid)) this._removeRecordFromCache(cache, guid);
      }
    }

    cache.collections = nextCollections;

    const scanned = cache.byRecord.size - cache.enrichQueue.length;
    cache.progress.total = cache.byRecord.size;
    cache.progress.done = Math.max(0, scanned);

    if (cache.enrichQueue.length === 0) {
      cache.phase = 'ready';
    } else if (!reconcile || cache.phase !== 'ready') {
      cache.phase = 'enriching';
    }

    return cache;
  }

  _pushRecent(cache, entry) {
    const list = cache.recentRecords;
    list.push(entry);
    list.sort((a, b) => b.date - a.date);
    if (list.length > 5) list.length = 5;
  }

  // ─── Background enrich ────────────────────────────────────────────────────

  async _runBackgroundEnrich(cache, generation, el, panel, uiState) {
    const opts = this._getScanOptions();
    if (cache.progress.total === 0) {
      cache.phase = 'ready';
      this._scheduleUiUpdate(el, cache, uiState, true);
      this._schedulePersist(cache);
      return;
    }

    if (!this._useBackgroundEnrich(cache.totals.records, opts)) {
      await this._enrichAllSync(cache, generation);
      if (generation !== this._enrichGeneration) return;
      cache.phase = 'ready';
      this._scheduleUiUpdate(el, cache, uiState, true);
      this._schedulePersist(cache);
      return;
    }

    if (cache.enrichQueue.length === 0) {
      cache.phase = 'ready';
      this._scheduleUiUpdate(el, cache, uiState, true);
      this._schedulePersist(cache);
      return;
    }

    cache.phase = 'enriching';
    const batchSize = opts.enrichBatchSize;

    while (cache.enrichQueue.length > 0 && generation === this._enrichGeneration) {
      const batch = cache.enrichQueue.splice(0, batchSize);
      for (const entry of batch) {
        if (generation !== this._enrichGeneration) return;
        try {
          const lineItems = await entry.record.getLineItems(this._getExpandLineItemReferences());
          this._applyLineItemsToCache(cache, entry, lineItems);
        } catch (_) {
          entry.scanned = true;
          entry.lineItemCount = 0;
        }
      }
      cache.progress.done = cache.progress.total - cache.enrichQueue.length;
      this._scheduleUiUpdate(el, cache, uiState, false);
      await new Promise((r) => setTimeout(r, 0));
    }

    if (generation !== this._enrichGeneration) return;
    cache.phase = 'ready';
    this._scheduleUiUpdate(el, cache, uiState, true);
    this._schedulePersist(cache);
  }

  async _enrichAllSync(cache, generation) {
    const queue = cache.enrichQueue.splice(0);
    for (const entry of queue) {
      if (generation !== this._enrichGeneration) return;
      const lineItems = await entry.record.getLineItems(this._getExpandLineItemReferences());
      this._applyLineItemsToCache(cache, entry, lineItems);
    }
    cache.progress.done = cache.progress.total;
  }

  _applyLineItemsToCache(cache, entry, lineItems) {
    const opts = this._getScanOptions();
    const colData = cache.colByGuid.get(entry.colGuid);
    const count = lineItems.length;
    let taskCount = 0;
    const types = {};
    const statuses = {};

    for (const item of lineItems) {
      types[item.type] = (types[item.type] || 0) + 1;
      if (item.type === 'task') {
        const st = item.getTaskStatus();
        statuses[st] = (statuses[st] || 0) + 1;
        taskCount++;
      }
    }

    if (entry.snapshot) {
      this._subtractSnapshot(cache, entry, colData);
    }

    entry.lineItemCount = count;
    entry.taskCount = taskCount;
    entry.scanned = true;
    entry.snapshot = { count, taskCount, types, statuses };

    cache.totals.lineItems += count;
    cache.totals.tasks += taskCount;
    if (colData) {
      colData.lineItemCount += count;
      colData.taskCount += taskCount;
    }

    for (const [t, n] of Object.entries(types)) {
      cache.lineItemTypes[t] = (cache.lineItemTypes[t] || 0) + n;
    }
    for (const [st, n] of Object.entries(statuses)) {
      cache.taskStatuses[st] = (cache.taskStatuses[st] || 0) + n;
    }

    const recData = {
      guid: entry.guid,
      name: entry.name,
      lineItemCount: count,
      taskCount,
      collectionName: entry.colName,
    };

    if (count > 0) {
      this._pushLargest(cache, recData);
      this._removeEmptySample(cache, entry.guid, entry);
    } else if (!opts.excludeJournalEmpty || !entry.isJournal) {
      this._pushEmptySample(cache, recData, entry);
    }

    this._markDetailsDirty(cache, ['collections', 'records', 'lineitems', 'tasks']);
  }

  _subtractSnapshot(cache, entry, colData) {
    const s = entry.snapshot;
    cache.totals.lineItems -= s.count;
    cache.totals.tasks -= s.taskCount;
    if (colData) {
      colData.lineItemCount -= s.count;
      colData.taskCount -= s.taskCount;
    }
    for (const [t, n] of Object.entries(s.types)) {
      cache.lineItemTypes[t] = (cache.lineItemTypes[t] || 0) - n;
      if (cache.lineItemTypes[t] <= 0) delete cache.lineItemTypes[t];
    }
    for (const [st, n] of Object.entries(s.statuses)) {
      cache.taskStatuses[st] = (cache.taskStatuses[st] || 0) - n;
      if (cache.taskStatuses[st] <= 0) delete cache.taskStatuses[st];
    }
    this._removeFromLargest(cache, entry.guid);
  }

  _pushLargest(cache, rec) {
    const list = cache.largestRecords;
    const idx = list.findIndex((r) => r.guid === rec.guid);
    if (idx >= 0) list.splice(idx, 1);
    list.push(rec);
    list.sort((a, b) => b.lineItemCount - a.lineItemCount);
    if (list.length > 10) list.length = 10;
  }

  _removeFromLargest(cache, guid) {
    const idx = cache.largestRecords.findIndex((r) => r.guid === guid);
    if (idx >= 0) cache.largestRecords.splice(idx, 1);
  }

  _pushEmptySample(cache, rec, entry) {
    if (entry.isEmpty) return;
    entry.isEmpty = true;
    cache.totals.emptyCount++;
    if (cache.emptySamples.length < 10 && !cache.emptySamples.some((r) => r.guid === rec.guid)) {
      cache.emptySamples.push(rec);
    }
  }

  _removeEmptySample(cache, guid, entry) {
    const e = entry || cache.byRecord.get(guid);
    if (!e?.isEmpty) return;
    e.isEmpty = false;
    cache.totals.emptyCount = Math.max(0, cache.totals.emptyCount - 1);
    const idx = cache.emptySamples.findIndex((r) => r.guid === guid);
    if (idx >= 0) cache.emptySamples.splice(idx, 1);
  }

  _markDetailsDirty(cache, keys) {
    for (const k of keys) cache.detailDirty.add(k);
  }

  // ─── Event rescan (single record) ─────────────────────────────────────────

  _scheduleRecordRescan(guid) {
    if (!this._statsCache || this._statsCache.phase === 'metadata') return;
    if (this._rescanTimers.has(guid)) clearTimeout(this._rescanTimers.get(guid));
    this._rescanTimers.set(
      guid,
      setTimeout(() => {
        this._rescanTimers.delete(guid);
        this._rescanRecord(guid);
      }, 400),
    );
  }

  async _resolveRecordHandle(entry) {
    if (entry.record) return entry.record;
    const collections = await this.data.getAllCollections();
    const col = collections.find((c) => c.getGuid() === entry.colGuid);
    if (!col) return null;
    const records = await col.getAllRecords();
    const rec = records.find((r) => r.guid === entry.guid);
    if (rec) entry.record = rec;
    return rec;
  }

  async _rescanRecord(guid) {
    const cache = this._statsCache || this._ensureStatsCacheLoaded();
    const dash = this._activeDashboard;
    if (!cache) return;

    const entry = cache.byRecord.get(guid);
    if (!entry) return;

    const record = await this._resolveRecordHandle(entry);
    if (!record) return;

    try {
      const lineItems = await record.getLineItems(this._getExpandLineItemReferences());
      this._applyLineItemsToCache(cache, entry, lineItems);
      cache.detailDirty.add('records');
      cache.detailDirty.add('lineitems');
      cache.detailDirty.add('tasks');
      cache.detailDirty.add('collections');
      if (dash) {
        this._scheduleUiUpdate(dash.el, cache, dash.uiState, true);
      }
      this._schedulePersist(cache);
    } catch (_) { /* ignore */ }
  }

  async _handleRecordCreated(ev) {
    const record = ev.getRecord?.();
    const guid = ev.recordGuid ?? record?.guid;
    if (!guid || !record) return;

    let cache = this._statsCache || this._ensureStatsCacheLoaded();
    if (!cache) return;

    if (cache.byRecord.has(guid)) {
      this._scheduleRecordRescan(guid);
      return;
    }

    const col = ev.getCollection?.();
    const colGuid = ev.collectionGuid ?? col?.getGuid?.();
    if (!colGuid) return;

    let colData = cache.colByGuid.get(colGuid);
    if (!colData) {
      await this._handleCollectionStructureChange();
      return;
    }

    const colCfg = col?.getConfiguration?.() || colData.config;
    const colIcon = colCfg?.icon || 'file-text';
    const entry = {
      guid,
      name: record.getName() || '(untitled)',
      colGuid,
      colName: colData.name,
      colIcon,
      isJournal: colData.isJournal,
      record,
      lineItemCount: null,
      taskCount: 0,
      scanned: false,
      isEmpty: false,
      snapshot: null,
    };
    cache.byRecord.set(guid, entry);
    cache.enrichQueue.push(entry);
    cache.totals.records++;
    colData.recordCount++;
    cache.progress.total = cache.byRecord.size;

    const dash = this._activeDashboard;
    if (dash && cache.phase !== 'metadata') {
      this._scheduleRecordRescan(guid);
    } else {
      this._schedulePersist(cache);
    }
  }

  async _handleCollectionStructureChange() {
    let cache = this._statsCache || this._ensureStatsCacheLoaded();
    if (!cache) return;

    const generation = this._enrichGeneration;
    cache = await this._scanMetadata(generation, cache);
    this._statsCache = cache;
    this._schedulePersist(cache);

    const dash = this._activeDashboard;
    if (!dash) return;

    this._updateCardUI(dash.el, cache);
    this._updateProgressUI(dash.el, cache);
    if (cache.enrichQueue.length > 0) {
      this._runBackgroundEnrich(cache, generation, dash.el, dash.panel, dash.uiState);
    }
  }

  // ─── UI updates ───────────────────────────────────────────────────────────

  _scheduleUiUpdate(el, cache, uiState, immediate) {
    const opts = this._getScanOptions();
    if (this._uiThrottleTimer) clearTimeout(this._uiThrottleTimer);

    const run = () => {
      this._uiThrottleTimer = null;
      this._updateCardUI(el, cache);
      this._updateProgressUI(el, cache);
      this._maybeRefreshOpenDetail(el, cache, uiState);
      if (cache.phase === 'ready' || cache.phase === 'enriching') {
        this._schedulePersist(cache);
      }
    };

    if (immediate) {
      run();
    } else {
      this._uiThrottleTimer = setTimeout(run, opts.uiUpdateIntervalMs);
    }
  }

  _updateCardUI(el, cache) {
    const s = this._cacheToStats(cache);
    const enriching = cache.phase === 'enriching';
    const doneTasks = s.taskStatuses.done || 0;
    const taskPct = s.totalTasks > 0 ? Math.round((doneTasks / s.totalTasks) * 100) : 0;

    const set = (key, value, sub) => {
      const card = el.querySelector(`.ws-card[data-section="${key}"]`);
      if (!card) return;
      const valEl = card.querySelector('.ws-card-value');
      const subEl = card.querySelector('.ws-card-sub');
      if (valEl) valEl.textContent = value;
      if (subEl) subEl.textContent = sub || '';
      else if (sub && !subEl) {
        const div = document.createElement('div');
        div.className = 'ws-card-sub';
        div.textContent = sub;
        card.appendChild(div);
      }
    };

    set('collections', String(s.collections.length), null);
    set('records', s.totalRecords.toLocaleString(), null);
    set(
      'lineitems',
      enriching && cache.progress.done < cache.progress.total
        ? s.totalLineItems.toLocaleString() + '+'
        : s.totalLineItems.toLocaleString(),
      enriching ? 'scanning…' : null,
    );
    set(
      'tasks',
      enriching && cache.progress.done < cache.progress.total
        ? s.totalTasks.toLocaleString() + '+'
        : s.totalTasks.toLocaleString(),
      enriching ? 'scanning…' : `${taskPct}% done`,
    );
    set('newthisweek', s.newThisWeek.toLocaleString(), 'records created');
    set('users', String(s.users.length), null);
    set('globalplugins', String(s.globalPlugins.length), null);
    set('properties', s.totalProperties.toLocaleString(), null);
    set('views', s.totalViews.toLocaleString(), null);
  }

  _updateProgressUI(el, cache) {
    const bar = el.querySelector('.ws-progress');
    if (!bar) return;

    if (cache.phase === 'ready') {
      bar.style.display = 'none';
      return;
    }

    if (cache.phase === 'metadata' || cache.progress.total === 0) {
      bar.style.display = 'none';
      return;
    }

    const pct = Math.round((cache.progress.done / cache.progress.total) * 100);
    bar.style.display = 'block';
    const fill = bar.querySelector('.ws-progress-fill');
    const label = bar.querySelector('.ws-progress-label');
    if (fill) fill.style.width = `${pct}%`;
    if (label) {
      label.textContent = `Scanning content… ${cache.progress.done.toLocaleString()} / ${cache.progress.total.toLocaleString()} records (${pct}%)`;
    }
  }

  _maybeRefreshOpenDetail(el, cache, uiState) {
    if (!uiState.activeKey) return;
    const key = uiState.activeKey;
    const stale = cache.detailDirty.has(key) || !uiState.detailBuilt.has(key);
    if (!stale) return;
    cache.detailDirty.delete(key);
    uiState.detailBuilt.delete(key);
    this._renderDetailSection(el, key, cache, uiState);
  }

  // ─── HTML shell ───────────────────────────────────────────────────────────

  _buildShellHTML(cache, userName) {
    const s = this._cacheToStats(cache);
    const expandRefs = this._getExpandLineItemReferences();
    return `
<div class="ws-root">
  <div class="ws-header">
    <h1>📊 ${this.ui.htmlEscape(userName)}'s Stats</h1>
    <div class="ws-header-actions">
      <label class="ws-expand-refs-label" title="When checked, line item counts include content pulled in via references and transclusions (slower, higher counts).">
        <input type="checkbox" data-action="toggle-expand-refs" ${expandRefs ? 'checked' : ''} />
        <span>Include refs &amp; transclusions</span>
      </label>
      <button class="ws-refresh-btn" data-action="refresh">🔄 Refresh</button>
    </div>
  </div>
  <div class="ws-progress" style="display:none">
    <div class="ws-progress-label">Scanning content…</div>
    <div class="ws-progress-track"><div class="ws-progress-fill"></div></div>
  </div>
  <div class="ws-cards">
    ${this._card('collections', '📁', 'Collections', s.collections.length, null)}
    ${this._card('records', '📄', 'Records', s.totalRecords.toLocaleString(), null)}
    ${this._card('lineitems', '📝', 'Line Items', '…', null)}
    ${this._card('tasks', '✓', 'Tasks', '…', '…')}
    ${this._card('newthisweek', '🔥', 'New This Week', s.newThisWeek.toLocaleString(), 'records created')}
    ${this._card('users', '👥', 'Users', s.users.length, null)}
    ${this._card('globalplugins', '🔌', 'Global Plugins', s.globalPlugins.length, null)}
    ${this._card('properties', '🏷️', 'Properties', s.totalProperties.toLocaleString(), null)}
    ${this._card('views', '👁️', 'Views', s.totalViews.toLocaleString(), null)}
  </div>
  <div class="ws-detail-panel"></div>
  <div class="ws-bottom">
    ${this._buildBottomHTML(s)}
  </div>
</div>`;
  }

  _card(key, emoji, label, value, sub) {
    return `
    <div class="ws-card" data-section="${key}">
      <div class="ws-card-emoji">${emoji}</div>
      <div class="ws-card-value">${value}</div>
      <div class="ws-card-label">${label}</div>
      ${sub != null ? `<div class="ws-card-sub">${sub}</div>` : ''}
    </div>`;
  }

  _buildBottomHTML(s) {
    return `
    <div class="ws-bottom-card ws-bottom-card--fixed" style="height:auto">
      <div class="ws-bottom-title ws-collapsible-title" data-toggle="activity">
        🕐 Recent Activity
        <span class="ws-chevron" data-chevron="activity">▶</span>
      </div>
      <div class="ws-activity-scroll" data-body="activity" style="display:none">
        ${s.recentRecords.length === 0
          ? '<div class="ws-empty">No recent activity found.</div>'
          : s.recentRecords.map((r) => `
            <div class="ws-activity-row" data-record-guid="${r.guid}">
              <div class="ws-activity-icon">
                <span class="ti ti-${this.ui.htmlEscape(r.colIcon)}"></span>
              </div>
              <div class="ws-activity-body">
                <div class="ws-activity-name">${this.ui.htmlEscape(r.name)}</div>
                <div class="ws-activity-meta">${this.ui.htmlEscape(r.colName)}</div>
              </div>
              <div class="ws-activity-time">${this._fmtRel(r.date)}</div>
            </div>`).join('')}
      </div>
    </div>
    <div class="ws-bottom-card">
      <div class="ws-bottom-title ws-collapsible-title" data-toggle="dist">
        📊 Record Distribution
        <span class="ws-chevron" data-chevron="dist">▶</span>
      </div>
      <div class="ws-dist-bars" data-body="dist" style="display:none">
        ${this._buildDistributionHTML(s)}
      </div>
    </div>`;
  }

  _buildDistributionHTML(s) {
    if (s.collections.length === 0) {
      return '<div class="ws-empty">No collections found.</div>';
    }
    const sorted = [...s.collections].sort((a, b) => b.recordCount - a.recordCount);
    const max = Math.max(...sorted.map((c) => c.recordCount), 1);
    return sorted.map((c) => `
      <div class="ws-bar-row" data-collection-guid="${c.guid}">
        <div class="ws-bar-label">
          <span class="ti ti-${this.ui.htmlEscape(c.config.icon || 'file-text')}"></span>
          ${this.ui.htmlEscape(c.name)}
        </div>
        <div class="ws-bar-track">
          <div class="ws-bar-fill" style="width:${Math.max(2, (c.recordCount / max) * 100)}%"></div>
        </div>
        <div class="ws-bar-count">${c.recordCount}</div>
      </div>`).join('');
  }

  // ─── Lazy detail sections ─────────────────────────────────────────────────

  _renderDetailSection(el, key, cache, uiState) {
    const panel = el.querySelector('.ws-detail-panel');
    if (!panel) return;

    let host = panel.querySelector(`.ws-detail-section[data-section="${key}"]`);
    if (!host) {
      host = document.createElement('div');
      host.className = 'ws-detail-section';
      host.dataset.section = key;
      panel.appendChild(host);
    }

    const s = this._cacheToStats(cache);
    const needsEnrich = ['records', 'lineitems', 'tasks'].includes(key);
    const enriching = cache.phase === 'enriching' && cache.progress.done < cache.progress.total;

    if (needsEnrich && enriching && !uiState.detailBuilt.has(key)) {
      host.style.display = 'block';
      host.innerHTML = `
        <div class="ws-detail">
          <p class="ws-empty" style="opacity:0.7">Loading content stats… ${cache.progress.done.toLocaleString()} / ${cache.progress.total.toLocaleString()} records</p>
          <div class="ws-spinner" style="margin:16px auto"></div>
        </div>`;
      return;
    }

    const builders = {
      collections: () => this._detailCollections(s, cache),
      records: () => this._detailRecords(s, cache),
      lineitems: () => this._detailLineItems(s),
      tasks: () => this._detailTasks(s),
      users: () => this._detailUsers(s),
      globalplugins: () => this._detailGlobalPlugins(s),
      properties: () => this._detailProperties(s),
      views: () => this._detailViews(s),
      newthisweek: () => this._detailNewThisWeek(s),
    };

    host.style.display = 'block';
    host.innerHTML = builders[key] ? builders[key]() : '<div class="ws-empty">Unknown section</div>';
    uiState.detailBuilt.add(key);
    cache.detailDirty.delete(key);

    const dash = this._activeDashboard;
    if (dash) this._bindNavigation(el, dash.panel);
  }

  _detailCollections(s, cache) {
    const partial = cache.phase === 'enriching';
    return `<div class="ws-detail">
      <h2>📁 Collections${partial ? ' <span class="ws-partial-hint">(content counts updating)</span>' : ''}</h2>
      <div class="ws-list">
        ${s.collections.map((c) => `
          <div class="ws-list-item" data-collection-guid="${c.guid}">
            <div class="ws-list-name">
              ${this.ui.htmlEscape(c.name)}
              ${c.isJournal ? '<span class="ws-badge">Journal</span>' : ''}
            </div>
            <div class="ws-list-meta">
              <span>${c.recordCount} records</span>
              <span>${partial && c.lineItemCount === 0 ? '…' : c.lineItemCount} items</span>
              <span>${partial && c.taskCount === 0 ? '…' : c.taskCount} tasks</span>
              <span>${c.config.fields ? c.config.fields.filter((f) => f.active).length : 0} properties</span>
              <span>${c.config.views ? c.config.views.filter((v) => v.shown).length : 0} views</span>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  _detailRecords(s, cache) {
    const enriching = cache.phase === 'enriching';
    return `<div class="ws-detail">
      <h2>📄 Largest Records</h2>
      ${enriching && s.largestRecords.length === 0
        ? '<div class="ws-empty">Still scanning…</div>'
        : `<div class="ws-list">
            ${s.largestRecords.map((r) => `
              <div class="ws-list-item" data-record-guid="${r.guid}">
                <div class="ws-list-name">${this.ui.htmlEscape(r.name)}</div>
                <div class="ws-list-meta">
                  <span>${this.ui.htmlEscape(r.collectionName)}</span>
                  <span>${r.lineItemCount} items</span>
                  ${r.taskCount > 0 ? `<span>${r.taskCount} tasks</span>` : ''}
                </div>
              </div>`).join('')}
          </div>`}
      ${s.emptyCount > 0 || s.emptyRecords.length > 0 ? `
        <h2 style="margin-top:24px">📭 Empty Records${s.emptyCount > 10 ? ` (showing 10 of ${s.emptyCount.toLocaleString()})` : ''}</h2>
        <div class="ws-list">
          ${s.emptyRecords.map((r) => `
            <div class="ws-list-item" data-record-guid="${r.guid}">
              <div class="ws-list-name">${this.ui.htmlEscape(r.name)}</div>
              <div class="ws-list-meta">
                <span>${this.ui.htmlEscape(r.collectionName)}</span>
              </div>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
  }

  _detailLineItems(s) {
    const entries = Object.entries(s.lineItemTypes).sort((a, b) => b[1] - a[1]);
    return `<div class="ws-detail">
      <h2>📝 Content Types</h2>
      ${entries.length === 0
        ? '<div class="ws-empty">No content found yet.</div>'
        : `<div class="ws-grid">
            ${entries.map(([t, n]) => `
              <div class="ws-grid-item">
                <div class="ws-grid-label">${this._fmtLineItemType(t)}</div>
                <div class="ws-grid-value">${n.toLocaleString()}</div>
              </div>`).join('')}
          </div>`}
    </div>`;
  }

  _detailTasks(s) {
    const entries = Object.entries(s.taskStatuses).sort((a, b) => b[1] - a[1]);
    return `<div class="ws-detail">
      <h2>✓ Task Statuses</h2>
      ${entries.length === 0
        ? '<div class="ws-empty">No tasks found yet.</div>'
        : `<div class="ws-grid">
            ${entries.map(([st, n]) => `
              <div class="ws-grid-item">
                <div class="ws-grid-label">${this._fmtTaskStatus(st)}</div>
                <div class="ws-grid-value">${n.toLocaleString()}</div>
              </div>`).join('')}
          </div>`}
    </div>`;
  }

  _detailUsers(s) {
    return `<div class="ws-detail">
      <h2>👥 Users</h2>
      <div class="ws-list">
        ${s.users.map((u) => `
          <div class="ws-list-item">
            <div class="ws-list-name">
              ${this.ui.htmlEscape(u.getDisplayName() || u.getEmail() || '')}
              ${u.isAdmin() ? '<span class="ws-badge ws-badge--admin">Admin</span>' : ''}
              ${u.isOwner() ? '<span class="ws-badge ws-badge--owner">Owner</span>' : ''}
            </div>
            <div class="ws-list-meta">
              <span>${this.ui.htmlEscape(u.getEmail() || '')}</span>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  _detailGlobalPlugins(s) {
    return `<div class="ws-detail">
      <h2>🔌 Global Plugins</h2>
      ${s.globalPlugins.length === 0
        ? '<div class="ws-empty">No global plugins found.</div>'
        : `<div class="ws-list">
            ${s.globalPlugins.map((p) => `
              <div class="ws-list-item">
                <div class="ws-list-name">${this.ui.htmlEscape(p.getName())}</div>
              </div>`).join('')}
          </div>`}
    </div>`;
  }

  _detailProperties(s) {
    const entries = Object.entries(s.propertyTypes).sort((a, b) => b[1] - a[1]);
    return `<div class="ws-detail">
      <h2>🏷️ Property Types</h2>
      ${entries.length === 0
        ? '<div class="ws-empty">No properties found.</div>'
        : `<div class="ws-grid">
            ${entries.map(([t, n]) => `
              <div class="ws-grid-item">
                <div class="ws-grid-label">${this._fmtPropertyType(t)}</div>
                <div class="ws-grid-value">${n.toLocaleString()}</div>
              </div>`).join('')}
          </div>`}
    </div>`;
  }

  _detailViews(s) {
    const entries = Object.entries(s.viewTypes).sort((a, b) => b[1] - a[1]);
    return `<div class="ws-detail">
      <h2>👁️ View Types</h2>
      ${entries.length === 0
        ? '<div class="ws-empty">No views found.</div>'
        : `<div class="ws-grid">
            ${entries.map(([t, n]) => `
              <div class="ws-grid-item">
                <div class="ws-grid-label">${this._fmtViewType(t)}</div>
                <div class="ws-grid-value">${n.toLocaleString()}</div>
              </div>`).join('')}
          </div>`}
    </div>`;
  }

  _detailNewThisWeek(s) {
    const sorted = s.collections.slice().sort((a, b) => b.newThisWeek - a.newThisWeek);
    return `<div class="ws-detail">
      <h2>🔥 Activity by Collection — This Week</h2>
      <table class="ws-table">
        <thead>
          <tr>
            <th>Collection</th>
            <th class="ws-tr">Records</th>
            <th class="ws-tr">New / wk</th>
            <th class="ws-tr">Edits / wk</th>
            <th class="ws-tr">Last Activity</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((c) => `
            <tr data-collection-guid="${c.guid}">
              <td class="ws-col-cell">
                <span class="ti ti-${this.ui.htmlEscape(c.config.icon || 'file-text')}"></span>
                <span class="ws-col-title">${this.ui.htmlEscape(c.name)}</span>
              </td>
              <td class="ws-tr ws-num">${c.recordCount}</td>
              <td class="ws-tr ws-num ${c.newThisWeek ? 'ws-green' : 'ws-muted'}">
                ${c.newThisWeek ? '+' + c.newThisWeek : '—'}
              </td>
              <td class="ws-tr ws-num ${c.editThisWeek ? 'ws-accent' : 'ws-muted'}">
                ${c.editThisWeek || '—'}
              </td>
              <td class="ws-tr ws-num ws-muted">
                ${c.lastActivity ? this._fmtRel(c.lastActivity) : '—'}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  _bindEvents(el, panel, uiState) {
    el.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
      this.renderStatsPanel(panel, true);
    });

    el.querySelector('[data-action="toggle-expand-refs"]')?.addEventListener('change', (e) => {
      this._setExpandLineItemReferences(e.target.checked, panel);
    });

    el.querySelectorAll('.ws-card').forEach((card) => {
      card.addEventListener('click', () => {
        const key = card.dataset.section;
        const allSections = el.querySelectorAll('.ws-detail-section');
        const allCards = el.querySelectorAll('.ws-card');

        if (uiState.activeKey === key) {
          allSections.forEach((s) => { s.style.display = 'none'; });
          allCards.forEach((c) => c.classList.remove('ws-card--active'));
          uiState.activeKey = null;
        } else {
          allSections.forEach((s) => { s.style.display = 'none'; });
          allCards.forEach((c) => c.classList.remove('ws-card--active'));
          card.classList.add('ws-card--active');
          uiState.activeKey = key;
          if (this._statsCache) {
            this._renderDetailSection(el, key, this._statsCache, uiState);
          }
        }
      });
    });

    el.querySelectorAll('.ws-collapsible-title').forEach((title) => {
      title.addEventListener('click', () => {
        const key = title.dataset.toggle;
        const body = el.querySelector(`[data-body="${key}"]`);
        const chevron = el.querySelector(`[data-chevron="${key}"]`);
        const card = title.closest('.ws-bottom-card');
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'flex';
        chevron.textContent = isOpen ? '▶' : '▼';
        if (key === 'activity') {
          card.style.height = isOpen ? 'auto' : '300px';
        }
      });
    });

    this._bindNavigation(el, panel);
  }

  _bindNavigation(el, panel) {
    el.querySelectorAll('[data-collection-guid]').forEach((node) => {
      if (node.dataset.navBound) return;
      node.dataset.navBound = '1';
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.navigateTo({
          type: 'overview',
          rootId: node.dataset.collectionGuid,
          subId: null,
          workspaceGuid: this.getWorkspaceGuid(),
        });
      });
    });

    el.querySelectorAll('[data-record-guid]').forEach((node) => {
      if (node.dataset.navBound) return;
      node.dataset.navBound = '1';
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => {
        panel.navigateTo({
          type: 'edit_panel',
          rootId: node.dataset.recordGuid,
          subId: null,
          workspaceGuid: this.getWorkspaceGuid(),
        });
      });
    });
  }

  // ─── Formatters ───────────────────────────────────────────────────────────

  _fmtRel(date) {
    if (!date) return '';
    const diff = Date.now() - date;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return `${d}d ago`;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  _fmtLineItemType(type) {
    const m = {
      task: '✓ Task', text: '📝 Text', heading: '📌 Heading',
      ulist: '• List', olist: '1. Ordered', quote: '❝ Quote',
      block: '▢ Block', image: '🖼️ Image', file: '📎 File',
      table: '⊞ Table', br: '↵ Line Break', empty: '∅ Empty',
    };
    return m[type] || type;
  }

  _fmtTaskStatus(status) {
    const m = {
      done: '✓ Done', none: '◯ None', started: '▶ Started',
      waiting: '⏸ Waiting', important: '! Important', starred: '★ Starred',
      billable: '$ Billable', discuss: '💬 Discuss', alert: '⚠ Alert',
    };
    return m[status] || status;
  }

  _fmtPropertyType(type) {
    const m = {
      text: 'Text', number: 'Number', choice: 'Choice / Select',
      datetime: 'Date/Time', user: 'User', record: 'Record Reference',
      file: 'File', image: 'Image', url: 'URL',
      hashtag: 'Hashtag', dynamic: 'Formula / Dynamic',
    };
    return m[type] || type;
  }

  _fmtViewType(type) {
    const m = {
      table: 'Table', board: 'Board / Kanban',
      gallery: 'Gallery', calendar: 'Calendar', custom: 'Custom',
    };
    return m[type] || type;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────

  _injectStyles() {
    if (this._stylesInjected) return;
    this._stylesInjected = true;
    this.ui.injectCSS(`
      .ws-root {
        padding: 24px;
        max-width: 1200px;
        margin: 0 auto;
        font-size: 13px;
        color: var(--color-text);
        box-sizing: border-box;
      }
      .ws-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .ws-header h1 { margin: 0; font-size: 22px; font-weight: 700; }
      .ws-header-actions {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .ws-expand-refs-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        color: inherit;
        opacity: 0.9;
      }
      .ws-expand-refs-label input { cursor: pointer; margin: 0; }
      .ws-refresh-btn {
        padding: 6px 14px;
        background: var(--color-bg-2, rgba(0,0,0,0.05));
        color: inherit;
        border: 1px solid var(--color-border, rgba(0,0,0,0.12));
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
      }
      .ws-refresh-btn:hover { background: var(--color-bg-3, rgba(0,0,0,0.09)); }
      .ws-progress { margin-bottom: 16px; }
      .ws-progress-label {
        font-size: 11px;
        color: #6b7280;
        margin-bottom: 6px;
        font-weight: 500;
      }
      .ws-progress-track {
        height: 4px;
        background: var(--color-bg-3, rgba(0,0,0,0.08));
        border-radius: 2px;
        overflow: hidden;
      }
      .ws-progress-fill {
        height: 100%;
        width: 0;
        background: var(--color-accent, #2563eb);
        transition: width 0.2s ease;
      }
      .ws-partial-hint {
        font-size: 11px;
        font-weight: 500;
        color: #6b7280;
        text-transform: none;
        letter-spacing: 0;
      }
      .ws-cards {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        width: 100%;
      }
      .ws-card {
        background: var(--color-bg-2, #fff);
        border: 1.5px solid var(--color-border, rgba(0,0,0,0.1));
        border-radius: 10px;
        padding: 14px 10px;
        text-align: center;
        cursor: pointer;
        user-select: none;
        transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
      }
      .ws-card:hover {
        border-color: var(--color-accent, #2563eb);
        box-shadow: 0 0 0 3px rgba(37,99,235,0.08);
      }
      .ws-card--active {
        border-color: var(--color-accent, #2563eb);
        background: rgba(37,99,235,0.72);
        box-shadow: 0 0 0 3px rgba(37,99,235,0.13);
      }
      .ws-card--active .ws-card-value,
      .ws-card--active .ws-card-label,
      .ws-card--active .ws-card-sub { color: #fff; opacity: 1; }
      .ws-card-emoji { font-size: 18px; margin-bottom: 5px; }
      .ws-card-value {
        font-size: 24px; font-weight: 700; line-height: 1.15;
        margin-bottom: 3px; color: #0a2342;
      }
      .ws-card-label {
        font-size: 10px; text-transform: uppercase;
        letter-spacing: 0.4px; font-weight: 600;
        color: #0a2342; opacity: 0.75;
      }
      .ws-card-sub {
        font-size: 10px; margin-top: 3px;
        color: #0a2342; opacity: 0.5;
      }
      .ws-detail-panel { min-height: 0; }
      .ws-detail-section { margin: 8px 0 16px; }
      .ws-detail {
        background: #fff;
        border: 1.5px solid #2563eb;
        border-radius: 10px;
        padding: 20px 24px;
        animation: ws-detail-in 0.14s ease;
      }
      @keyframes ws-detail-in {
        from { opacity: 0; transform: translateY(-5px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .ws-detail h2 {
        margin: 0 0 16px;
        font-size: 14px;
        font-weight: 700;
        color: #0a2342;
      }
      .ws-list { display: flex; flex-direction: column; gap: 7px; }
      .ws-list-item {
        padding: 11px 14px;
        background: #f0f4ff;
        border: 1px solid #c7d7f8;
        border-radius: 7px;
      }
      .ws-list-item:hover { background: #dde8ff; }
      .ws-list-name {
        font-weight: 700; color: #0a2342; margin-bottom: 4px;
        display: flex; align-items: center; gap: 6px;
      }
      .ws-list-meta {
        display: flex; gap: 14px; font-size: 12px;
        color: #374151; font-weight: 500; flex-wrap: wrap;
      }
      .ws-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(185px, 1fr));
        gap: 10px;
      }
      .ws-grid-item {
        padding: 10px 14px;
        background: #f0f4ff;
        border: 1px solid #c7d7f8;
        border-radius: 7px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .ws-grid-label { font-size: 13px; color: #374151; font-weight: 600; }
      .ws-grid-value { font-size: 18px; font-weight: 700; color: #0a2342; }
      .ws-badge {
        display: inline-block;
        padding: 1px 7px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        border-radius: 3px;
        background: var(--color-bg-3, #e0e0e0);
      }
      .ws-badge--admin { background: #fef08a; color: #713f12; }
      .ws-badge--owner { background: #fecaca; color: #7f1d1d; }
      .ws-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .ws-table th {
        text-align: left; font-size: 11px; font-weight: 700;
        text-transform: uppercase; color: #374151;
        padding: 0 10px 10px 0;
        border-bottom: 1px solid #c7d7f8;
      }
      .ws-table td {
        padding: 9px 10px 9px 0;
        border-bottom: 1px solid #e5edff;
        color: #0a2342;
      }
      .ws-table tr:last-child td { border-bottom: none; }
      .ws-table tr:hover td { background: #f0f4ff; }
      .ws-tr { text-align: right; }
      .ws-num { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
      .ws-col-cell { display: flex; align-items: center; gap: 8px; }
      .ws-col-title { font-weight: 600; }
      .ws-green { color: #15803d; }
      .ws-accent { color: #2563eb; }
      .ws-muted { color: #6b7280; }
      .ws-bottom {
        display: flex;
        flex-direction: column;
        gap: 14px;
        margin-top: 96px;
      }
      .ws-bottom-card {
        background: var(--color-bg-2, #fff);
        border: 1px solid var(--color-border, rgba(0,0,0,0.1));
        border-radius: 10px;
        padding: 18px 20px;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .ws-bottom-card--fixed { height: 300px; }
      .ws-bottom-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #0a2342;
        margin-bottom: 12px;
      }
      .ws-collapsible-title {
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        user-select: none;
        margin-bottom: 0;
      }
      .ws-chevron { font-size: 9px; color: #0a2342; }
      .ws-activity-scroll {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-top: 10px;
      }
      .ws-activity-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 4px;
        border-radius: 6px;
      }
      .ws-activity-row:hover { background: var(--color-bg-3, rgba(0,0,0,0.04)); }
      .ws-activity-icon {
        width: 26px; height: 26px;
        border-radius: 5px;
        background: #dbeafe;
        display: flex; align-items: center; justify-content: center;
        font-size: 13px; color: #1d4ed8;
      }
      .ws-activity-body { flex: 1; min-width: 0; }
      .ws-activity-name {
        font-weight: 700; font-size: 12.5px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ws-activity-meta { font-size: 11px; color: #374151; margin-top: 1px; }
      .ws-activity-time { font-size: 11px; color: #374151; white-space: nowrap; }
      .ws-dist-bars {
        display: flex;
        flex-direction: column;
        gap: 9px;
        margin-top: 10px;
      }
      .ws-bar-row { display: flex; align-items: center; gap: 9px; }
      .ws-bar-label {
        width: 120px; flex-shrink: 0;
        display: flex; align-items: center; gap: 5px;
        font-size: 12px; font-weight: 700;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ws-bar-track {
        flex: 1; height: 7px;
        background: var(--color-bg-3, rgba(0,0,0,0.07));
        border-radius: 3px; overflow: hidden;
      }
      .ws-bar-fill {
        height: 100%;
        background: var(--color-accent, #2563eb);
        opacity: 0.55;
      }
      .ws-bar-count {
        width: 30px; text-align: right;
        font-size: 12px; font-weight: 700;
      }
      .ws-empty { font-size: 12px; opacity: 0.4; padding: 10px 0; text-align: center; }
      .ws-spinner {
        border: 3px solid rgba(0,0,0,0.08);
        border-top: 3px solid var(--color-accent, #2563eb);
        border-radius: 50%;
        width: 36px; height: 36px;
        animation: ws-spin 0.8s linear infinite;
        margin: 0 auto;
      }
      @keyframes ws-spin { to { transform: rotate(360deg); } }
    `);
  }
}
