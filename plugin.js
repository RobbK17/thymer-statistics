/**
 * Workspace Statistics Plugin for Thymer
 *
 * Cards are clickable — each expands a detail section below the card row.
 * Only one detail section is open at a time; clicking the active card collapses it.
 *
 * Always-visible bottom section shows Recent Activity (scrollable) and
 * Record Distribution side-by-side at equal fixed height.
 *
 * New This Week card uses per-record creation/update dates (slightly slower load).
 * 
 * v1.0.3
 */

class Plugin extends AppPlugin {

  onLoad() {
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
  }

  // ─── Panel Management ───────────────────────────────────────────────────

  async _openPanel() {
    const panels = this.ui.getPanels();
    const rightmost = panels.length > 0 ? panels[panels.length - 1] : null;
    const panel = await this.ui.createPanel({ afterPanel: rightmost });
    if (panel) {
      panel.navigateToCustomType('workspace-stats');
      panel.setTitle('Stats');
    }
  }

  async renderStatsPanel(panel) {
    const el = panel.getElement();
    el.innerHTML = `
      <div style="padding:40px;text-align:center">
        <div class="ws-spinner"></div>
        <p style="margin-top:18px;opacity:0.5;font-size:13px">Analyzing workspace…</p>
      </div>`;

    this._injectStyles();

    const stats = await this._collectStatistics();

    const userName = stats.users.length > 0
      ? stats.users[0].getDisplayName() || stats.users[0].getEmail()
      : 'Workspace';

    panel.setTitle(`${userName}'s Stats`);
    el.innerHTML = this._buildHTML(stats, userName);
    this._bindEvents(el, panel);
  }

  // ─── Data Collection ────────────────────────────────────────────────────

  async _collectStatistics() {
    const now     = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const cfg = this.getConfiguration();
    const excludeJournalEmpty = cfg.custom?.emptyRecordsExcludeJournal !== false;

    const stats = {
      collections:     [],
      totalRecords:    0,
      totalLineItems:  0,
      totalTasks:      0,
      totalProperties: 0,
      totalViews:      0,
      newThisWeek:     0,
      lineItemTypes:   {},
      taskStatuses:    {},
      propertyTypes:   {},
      viewTypes:       {},
      largestRecords:  [],
      emptyRecords:    [],
      recentRecords:   [],
      users:           [],
      globalPlugins:   [],
    };

    const recentPool = [];
    const collections = await this.data.getAllCollections();

    for (const col of collections) {
      const colCfg = col.getConfiguration();
      const colData = {
        guid:         col.getGuid(),
        name:         col.getName(),
        isJournal:    col.isJournalPlugin(),
        recordCount:  0,
        lineItemCount: 0,
        taskCount:    0,
        newThisWeek:  0,
        editThisWeek: 0,
        lastActivity: null,
        config:       colCfg,
      };

      const records = await col.getAllRecords();
      colData.recordCount  = records.length;
      stats.totalRecords  += records.length;

      for (const record of records) {
        const createdAt = record.getCreatedAt();
        const updatedAt = record.getUpdatedAt();
        const lastTouch = updatedAt ?? createdAt;

        if (createdAt && createdAt >= weekAgo) {
          colData.newThisWeek++;
          stats.newThisWeek++;
        }
        if (updatedAt && updatedAt >= weekAgo) {
          colData.editThisWeek++;
        }
        if (lastTouch) {
          if (!colData.lastActivity || lastTouch > colData.lastActivity) {
            colData.lastActivity = lastTouch;
          }
          recentPool.push({
            record,
            colName: colData.name,
            colIcon: colCfg.icon || 'file-text',
            date:    lastTouch,
          });
        }

        const lineItems = await record.getLineItems();
        const recData = {
          guid:           record.guid,
          name:           record.getName(),
          lineItemCount:  lineItems.length,
          taskCount:      0,
          collectionName: colData.name,
        };

        colData.lineItemCount  += lineItems.length;
        stats.totalLineItems   += lineItems.length;

        for (const item of lineItems) {
          stats.lineItemTypes[item.type] = (stats.lineItemTypes[item.type] || 0) + 1;
          if (item.type === 'task') {
            const st = item.getTaskStatus();
            stats.taskStatuses[st] = (stats.taskStatuses[st] || 0) + 1;
            stats.totalTasks++;
            colData.taskCount++;
            recData.taskCount++;
          }
        }

        if (lineItems.length > 0) {
          stats.largestRecords.push(recData);
        } else if (!excludeJournalEmpty || !col.isJournalPlugin()) {
          stats.emptyRecords.push(recData);
        }
      }

      // Properties & views
      if (colCfg.fields) {
        for (const f of colCfg.fields) {
          if (f.active) {
            stats.propertyTypes[f.type] = (stats.propertyTypes[f.type] || 0) + 1;
            stats.totalProperties++;
          }
        }
      }
      if (colCfg.views) {
        for (const v of colCfg.views) {
          if (v.shown) {
            stats.viewTypes[v.type] = (stats.viewTypes[v.type] || 0) + 1;
            stats.totalViews++;
          }
        }
      }

      stats.collections.push(colData);
    }

    // Finalise derived lists
    stats.largestRecords.sort((a, b) => b.lineItemCount - a.lineItemCount);
    stats.largestRecords = stats.largestRecords.slice(0, 10);

    recentPool.sort((a, b) => b.date - a.date);
    stats.recentRecords = recentPool.slice(0, 5);

    stats.users         = this.data.getActiveUsers();
    stats.globalPlugins = await this.data.getAllGlobalPlugins();

    return stats;
  }

  // ─── HTML Builder ───────────────────────────────────────────────────────

  _buildHTML(s, userName) {
    const doneTasks = s.taskStatuses['done'] || 0;
    const taskPct   = s.totalTasks > 0 ? Math.round((doneTasks / s.totalTasks) * 100) : 0;

    // Pre-render all detail sections (hidden by default)
    const sections = {
      collections:   this._detailCollections(s),
      records:       this._detailRecords(s),
      lineitems:     this._detailLineItems(s),
      tasks:         this._detailTasks(s),
      users:         this._detailUsers(s),
      globalplugins: this._detailGlobalPlugins(s),
      properties:    this._detailProperties(s),
      views:         this._detailViews(s),
      newthisweek:   this._detailNewThisWeek(s),
    };

    const detailHTML = Object.entries(sections)
      .map(([k, html]) =>
        `<div class="ws-detail-section" data-section="${k}" style="display:none">${html}</div>`)
      .join('');

    return `
<div class="ws-root">

  <div class="ws-header">
    <h1>📊 ${this.ui.htmlEscape(userName)}'s Stats</h1>
    <button class="ws-refresh-btn" data-action="refresh">🔄 Refresh</button>
  </div>

  <!-- ── Cards ── -->
  <div class="ws-cards">
    ${this._card('collections',   '📁', 'Collections',    s.collections.length,              null)}
    ${this._card('records',       '📄', 'Records',        s.totalRecords.toLocaleString(),    null)}
    ${this._card('lineitems',     '📝', 'Line Items',     s.totalLineItems.toLocaleString(),  null)}
    ${this._card('tasks',         '✓',  'Tasks',          s.totalTasks.toLocaleString(),      `${taskPct}% done`)}
    ${this._card('newthisweek',   '🔥', 'New This Week',  s.newThisWeek.toLocaleString(),     'records created')}
    ${this._card('users',         '👥', 'Users',          s.users.length,                     null)}
    ${this._card('globalplugins', '🔌', 'Global Plugins', s.globalPlugins.length,             null)}
    ${this._card('properties',    '🏷️', 'Properties',    s.totalProperties.toLocaleString(), null)}
    ${this._card('views',         '👁️', 'Views',         s.totalViews.toLocaleString(),      null)}
  </div>

  <!-- ── Expandable detail (below cards) ── -->
  <div class="ws-detail-panel">
    ${detailHTML}
  </div>

  <!-- ── Always-visible bottom ── -->
  <div class="ws-bottom">

    <div class="ws-bottom-card ws-bottom-card--fixed" style="height:auto">
      <div class="ws-bottom-title ws-collapsible-title" data-toggle="activity">
        🕐 Recent Activity
        <span class="ws-chevron" data-chevron="activity">▶</span>
      </div>
      <div class="ws-activity-scroll" data-body="activity" style="display:none">
        ${s.recentRecords.length === 0
          ? '<div class="ws-empty">No recent activity found.</div>'
          : s.recentRecords.map(r => `
            <div class="ws-activity-row" data-record-guid="${r.record.guid}">
              <div class="ws-activity-icon">
                <span class="ti ti-${this.ui.htmlEscape(r.colIcon)}"></span>
              </div>
              <div class="ws-activity-body">
                <div class="ws-activity-name">${this.ui.htmlEscape(r.record.getName() || '(untitled)')}</div>
                <div class="ws-activity-meta">${this.ui.htmlEscape(r.colName)}</div>
              </div>
              <div class="ws-activity-time">${this._fmtRel(r.date)}</div>
            </div>`).join('')
        }
      </div>
    </div>

    <div class="ws-bottom-card">
      <div class="ws-bottom-title ws-collapsible-title" data-toggle="dist">
        📊 Record Distribution
        <span class="ws-chevron" data-chevron="dist">▶</span>
      </div>
      <div class="ws-dist-bars" data-body="dist" style="display:none">
        ${(() => {
          if (s.collections.length === 0) {
            return '<div class="ws-empty">No collections found.</div>';
          }
          const sorted = [...s.collections].sort((a, b) => b.recordCount - a.recordCount);
          const max = Math.max(...sorted.map(c => c.recordCount), 1);
          return sorted.map(c => `
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
        })()}
      </div>
    </div>

  </div>
</div>`;
  }

  _card(key, emoji, label, value, sub) {
    return `
    <div class="ws-card" data-section="${key}">
      <div class="ws-card-emoji">${emoji}</div>
      <div class="ws-card-value">${value}</div>
      <div class="ws-card-label">${label}</div>
      ${sub ? `<div class="ws-card-sub">${sub}</div>` : ''}
    </div>`;
  }

  // ─── Detail Sections ────────────────────────────────────────────────────

  _detailCollections(s) {
    return `<div class="ws-detail">
      <h2>📁 Collections</h2>
      <div class="ws-list">
        ${s.collections.map(c => `
          <div class="ws-list-item" data-collection-guid="${c.guid}">
            <div class="ws-list-name">
              ${this.ui.htmlEscape(c.name)}
              ${c.isJournal ? '<span class="ws-badge">Journal</span>' : ''}
            </div>
            <div class="ws-list-meta">
              <span>${c.recordCount} records</span>
              <span>${c.lineItemCount} items</span>
              <span>${c.taskCount} tasks</span>
              <span>${c.config.fields ? c.config.fields.filter(f => f.active).length : 0} properties</span>
              <span>${c.config.views ? c.config.views.filter(v => v.shown).length : 0} views</span>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  _detailRecords(s) {
    return `<div class="ws-detail">
      <h2>📄 Largest Records</h2>
      <div class="ws-list">
        ${s.largestRecords.map(r => `
          <div class="ws-list-item" data-record-guid="${r.guid}">
            <div class="ws-list-name">${this.ui.htmlEscape(r.name)}</div>
            <div class="ws-list-meta">
              <span>${this.ui.htmlEscape(r.collectionName)}</span>
              <span>${r.lineItemCount} items</span>
              ${r.taskCount > 0 ? `<span>${r.taskCount} tasks</span>` : ''}
            </div>
          </div>`).join('')}
      </div>
      ${s.emptyRecords.length > 0 ? `
        <h2 style="margin-top:24px">📭 Empty Records</h2>
        <div class="ws-list">
          ${s.emptyRecords.slice(0, 10).map(r => `
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
        ? '<div class="ws-empty">No content found.</div>'
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
        ? '<div class="ws-empty">No tasks found.</div>'
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
        ${s.users.map(u => `
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
            ${s.globalPlugins.map(p => `
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
          ${sorted.map(c => `
            <tr data-collection-guid="${c.guid}">
              <td class="ws-col-cell">
                <span class="ti ti-${this.ui.htmlEscape(c.config.icon || 'file-text')}"></span>
                <span class="ws-col-title">${this.ui.htmlEscape(c.name)}</span>
              </td>
              <td class="ws-tr ws-num">${c.recordCount}</td>
              <td class="ws-tr ws-num ${c.newThisWeek  ? 'ws-green'  : 'ws-muted'}">
                ${c.newThisWeek  ? '+' + c.newThisWeek  : '—'}
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

  // ─── Event Binding ───────────────────────────────────────────────────────

  _bindEvents(el, panel) {
    // Refresh
    el.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
      this.renderStatsPanel(panel);
    });

    // Card click → expand / collapse detail
    let activeKey = null;
    el.querySelectorAll('.ws-card').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.section;
        const allSections = el.querySelectorAll('.ws-detail-section');
        const allCards    = el.querySelectorAll('.ws-card');

        if (activeKey === key) {
          // Collapse
          allSections.forEach(s => { s.style.display = 'none'; });
          allCards.forEach(c => c.classList.remove('ws-card--active'));
          activeKey = null;
        } else {
          // Expand
          allSections.forEach(s => { s.style.display = 'none'; });
          allCards.forEach(c => c.classList.remove('ws-card--active'));
          const target = el.querySelector(`.ws-detail-section[data-section="${key}"]`);
          if (target) target.style.display = 'block';
          card.classList.add('ws-card--active');
          activeKey = key;
        }
      });
    });

    // Collapse toggles for bottom panels
    el.querySelectorAll('.ws-collapsible-title').forEach(title => {
      title.addEventListener('click', () => {
        const key     = title.dataset.toggle;
        const body    = el.querySelector(`[data-body="${key}"]`);
        const chevron = el.querySelector(`[data-chevron="${key}"]`);
        const card    = title.closest('.ws-bottom-card');
        const isOpen  = body.style.display !== 'none';
        body.style.display   = isOpen ? 'none' : (key === 'activity' ? 'flex' : 'flex');
        chevron.textContent  = isOpen ? '▶' : '▼';
        if (key === 'activity') {
          card.style.height = isOpen ? 'auto' : '300px';
        }
      });
    });
    el.querySelectorAll('[data-collection-guid]').forEach(node => {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.navigateTo({
          type:          'overview',
          rootId:        node.dataset.collectionGuid,
          subId:         null,
          workspaceGuid: this.getWorkspaceGuid(),
        });
      });
    });

    // Navigate to record
    el.querySelectorAll('[data-record-guid]').forEach(node => {
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => {
        panel.navigateTo({
          type:          'edit_panel',
          rootId:        node.dataset.recordGuid,
          subId:         null,
          workspaceGuid: this.getWorkspaceGuid(),
        });
      });
    });
  }

  // ─── Formatters ──────────────────────────────────────────────────────────

  _fmtRel(date) {
    if (!date) return '';
    const diff = Date.now() - date;
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7)  return `${d}d ago`;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  _fmtLineItemType(type) {
    const m = {
      task: '✓ Task',        text: '📝 Text',       heading: '📌 Heading',
      ulist: '• List',       olist: '1. Ordered',   quote: '❝ Quote',
      block: '▢ Block',      image: '🖼️ Image',    file: '📎 File',
      table: '⊞ Table',      br: '↵ Line Break',    empty: '∅ Empty',
    };
    return m[type] || type;
  }

  _fmtTaskStatus(status) {
    const m = {
      done: '✓ Done',     none: '◯ None',        started: '▶ Started',
      waiting: '⏸ Waiting', important: '! Important', starred: '★ Starred',
      billable: '$ Billable', discuss: '💬 Discuss',  alert: '⚠ Alert',
    };
    return m[status] || status;
  }

  _fmtPropertyType(type) {
    const m = {
      text: 'Text',         number: 'Number',      choice: 'Choice / Select',
      datetime: 'Date/Time', user: 'User',         record: 'Record Reference',
      file: 'File',          image: 'Image',        url: 'URL',
      hashtag: 'Hashtag',   dynamic: 'Formula / Dynamic',
    };
    return m[type] || type;
  }

  _fmtViewType(type) {
    const m = {
      table: 'Table',  board: 'Board / Kanban',
      gallery: 'Gallery', calendar: 'Calendar', custom: 'Custom',
    };
    return m[type] || type;
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

  _injectStyles() {
    this.ui.injectCSS(`
      /* ── Root ── */
      .ws-root {
        padding: 24px;
        max-width: 1200px;
        margin: 0 auto;
        font-size: 13px;
        color: var(--color-text);
        box-sizing: border-box;
      }

      /* ── Header ── */
      .ws-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }
      .ws-header h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
      }
      .ws-refresh-btn {
        padding: 6px 14px;
        background: var(--color-bg-2, rgba(0,0,0,0.05));
        color: inherit;
        border: 1px solid var(--color-border, rgba(0,0,0,0.12));
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: background 0.15s;
      }
      .ws-refresh-btn:hover { background: var(--color-bg-3, rgba(0,0,0,0.09)); }

      /* ── Cards grid ── */
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
      .ws-card--active .ws-card-sub {
        color: #ffffff;
        opacity: 1;
      }
      .ws-card-emoji  { font-size: 18px; margin-bottom: 5px; }
      .ws-card-value  { font-size: 24px; font-weight: 700; line-height: 1.15; margin-bottom: 3px; color: #0a2342; }
      .ws-card-label  { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; color: #0a2342; opacity: 0.75; }
      .ws-card-sub    { font-size: 10px; margin-top: 3px; color: #0a2342; opacity: 0.5; }

      /* ── Detail panel ── */
      .ws-detail-panel { min-height: 0; }
      .ws-detail-section { margin: 8px 0 16px; }
      .ws-detail {
        background: #ffffff;
        border: 1.5px solid #2563eb;
        border-radius: 10px;
        padding: 20px 24px;
        animation: ws-detail-in 0.14s ease;
      }
      @keyframes ws-detail-in {
        from { opacity: 0; transform: translateY(-5px); }
        to   { opacity: 1; transform: translateY(0);    }
      }
      .ws-detail h2 {
        margin: 0 0 16px;
        font-size: 14px;
        font-weight: 700;
        color: #0a2342;
      }

      /* ── Generic list (collections, records, users, plugins) ── */
      .ws-list { display: flex; flex-direction: column; gap: 7px; }
      .ws-list-item {
        padding: 11px 14px;
        background: #f0f4ff;
        border: 1px solid #c7d7f8;
        border-radius: 7px;
        transition: background 0.12s;
      }
      .ws-list-item:hover { background: #dde8ff; }
      .ws-list-name {
        font-weight: 700;
        color: #0a2342;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ws-list-meta {
        display: flex;
        gap: 14px;
        font-size: 12px;
        color: #374151;
        font-weight: 500;
        flex-wrap: wrap;
      }

      /* ── Breakdown grid ── */
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

      /* ── Badges ── */
      .ws-badge {
        display: inline-block;
        padding: 1px 7px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        border-radius: 3px;
        background: var(--color-bg-3, #e0e0e0);
      }
      .ws-badge--admin { background: #fef08a; color: #713f12; }
      .ws-badge--owner { background: #fecaca; color: #7f1d1d; }

      /* ── Activity table (New This Week) ── */
      .ws-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
      }
      .ws-table th {
        text-align: left;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: #374151;
        padding: 0 10px 10px 0;
        border-bottom: 1px solid #c7d7f8;
      }
      .ws-table td {
        padding: 9px 10px 9px 0;
        border-bottom: 1px solid #e5edff;
        vertical-align: middle;
        color: #0a2342;
      }
      .ws-table tr:last-child td { border-bottom: none; }
      .ws-table tr:hover td { background: #f0f4ff; }
      .ws-tr   { text-align: right; }
      .ws-num  { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; color: #0a2342; }
      .ws-col-cell {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ws-col-title { font-weight: 600; color: #0a2342; }
      .ws-green  { color: #15803d; }
      .ws-accent { color: #2563eb; }
      .ws-muted  { color: #6b7280; }

      /* ── Bottom section ── */
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
        box-sizing: border-box;
      }
      .ws-bottom-card--fixed {
        height: 300px;
      }
      .ws-bottom-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #0a2342;
        margin-bottom: 12px;
        flex-shrink: 0;
      }
      .ws-collapsible-title {
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        user-select: none;
        margin-bottom: 0;
      }
      .ws-collapsible-title:hover { opacity: 0.75; }
      .ws-chevron {
        font-size: 9px;
        color: #0a2342;
        transition: transform 0.15s;
      }

      /* ── Recent Activity (scrollable) ── */
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
        flex-shrink: 0;
        transition: background 0.1s;
      }
      .ws-activity-row:hover { background: var(--color-bg-3, rgba(0,0,0,0.04)); }
      .ws-activity-icon {
        width: 26px; height: 26px;
        border-radius: 5px;
        background: #dbeafe;
        display: flex; align-items: center; justify-content: center;
        font-size: 13px; flex-shrink: 0;
        color: #1d4ed8;
      }
      .ws-activity-body { flex: 1; min-width: 0; }
      .ws-activity-name {
        font-weight: 700; font-size: 12.5px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #0a2342;
      }
      .ws-activity-meta { font-size: 11px; color: #374151; margin-top: 1px; font-weight: 500; }
      .ws-activity-time { font-size: 11px; color: #374151; white-space: nowrap; flex-shrink: 0; font-weight: 500; }

      /* ── Distribution bars (full height, no scroll) ── */
      .ws-dist-bars {
        display: flex;
        flex-direction: column;
        gap: 9px;
        margin-top: 10px;
      }
      .ws-bar-row {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .ws-bar-row:hover .ws-bar-fill { opacity: 1; }
      .ws-bar-label {
        width: 120px; flex-shrink: 0;
        display: flex; align-items: center; gap: 5px;
        font-size: 12px; font-weight: 700;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #0a2342;
      }
      .ws-bar-label .ti {
        color: #1d4ed8;
        font-size: 13px;
      }
      .ws-bar-track {
        flex: 1; height: 7px;
        background: var(--color-bg-3, rgba(0,0,0,0.07));
        border-radius: 3px; overflow: hidden;
      }
      .ws-bar-fill {
        height: 100%; border-radius: 3px;
        background: var(--color-accent, #2563eb);
        opacity: 0.55;
        transition: opacity 0.15s;
      }
      .ws-bar-count {
        width: 30px; text-align: right;
        font-size: 12px; font-variant-numeric: tabular-nums;
        font-weight: 700;
        color: #0a2342;
      }

      /* ── Empty state / spinner ── */
      .ws-empty {
        font-size: 12px; opacity: 0.4;
        padding: 10px 0; text-align: center;
      }
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
