/**
 * Workspace Statistics Plugin for Thymer v1.02
 * 
 * Shows comprehensive statistics about your workspace including:
 * - Collections, records, and content counts
 * - Property and view configurations
 * - User activity
 * - Content type breakdowns
 */

class Plugin extends AppPlugin {
  
  onLoad() {
    // Register custom panel type for statistics
    this.ui.registerCustomPanelType('workspace-stats', (panel) => {
      this.renderStatsPanel(panel);
    });
    
    // Add command to open statistics
    this.ui.addCommandPaletteCommand({
      label: 'Show Workspace Statistics',
      icon: 'chart-bar',
      onSelected: async () => {
        await this.openStatsInRightPanel();
      }
    });
    
    // Add sidebar item
    this.ui.addSidebarItem({
      label: 'Statistics',
      icon: 'chart-bar',
      tooltip: 'View workspace statistics',
      onClick: async () => {
        await this.openStatsInRightPanel();
      }
    });
  }
  
  async openStatsInRightPanel() {
    // Get all currently open panels
    const panels = this.ui.getPanels();
    
    // Find the rightmost panel (last in the list)
    const rightmostPanel = panels.length > 0 ? panels[panels.length - 1] : null;
    
    // Create new panel to the right of the rightmost panel
    const panel = await this.ui.createPanel({
      afterPanel: rightmostPanel
    });
    
    if (panel) {
      panel.navigateToCustomType('workspace-stats');
      panel.setTitle('Stats'); // Generic title until data loads
    }
  }
  
  async renderStatsPanel(panel) {
    const element = panel.getElement();
    
    // Show loading state
    element.innerHTML = `
      <div style="padding: 40px; text-align: center;">
        <div class="spinner"></div>
        <p style="margin-top: 20px; color: #666;">Analyzing workspace...</p>
      </div>
    `;
    
    // Inject CSS
    this.injectStyles();
    
    // Collect statistics
    const stats = await this.collectStatistics();
    
    // Get username for title
    const userName = stats.users.length > 0 
      ? stats.users[0].getDisplayName() || stats.users[0].getEmail()
      : 'Workspace';
    
    // Set the panel title with username
    panel.setTitle(`${userName}'s Stats`);
    
    // Render statistics
    element.innerHTML = this.renderStats(stats);
    
    // Add event listeners
    this.attachEventListeners(element, panel, stats);
  }
  
  async collectStatistics() {
    const stats = {
      collections: [],
      totalRecords: 0,
      totalLineItems: 0,
      totalTasks: 0,
      users: [],
      globalPlugins: [],
      lineItemTypes: {},
      taskStatuses: {},
      propertyTypes: {},
      viewTypes: {},
      largestRecords: [],
      recentlyUpdated: [],
      emptyRecords: []
    };
    
    // Get all collections
    const collections = await this.data.getAllCollections();
    const config = this.getConfiguration();
    const excludeJournalFromEmpty = config.custom?.emptyRecordsExcludeJournal !== false;
    
    for (const collection of collections) {
      const collectionData = {
        guid: collection.getGuid(),
        name: collection.getName(),
        isJournal: collection.isJournalPlugin(),
        records: [],
        recordCount: 0,
        lineItemCount: 0,
        taskCount: 0,
        config: collection.getConfiguration()
      };
      
      // Get all records in collection
      const records = await collection.getAllRecords();
      collectionData.recordCount = records.length;
      stats.totalRecords += records.length;
      
      for (const record of records) {
        const lineItems = await record.getLineItems();
        const recordData = {
          guid: record.guid,
          name: record.getName(),
          lineItemCount: lineItems.length,
          taskCount: 0,
          collectionName: collectionData.name
        };
        
        collectionData.lineItemCount += lineItems.length;
        stats.totalLineItems += lineItems.length;
        
        // Analyze line items
        for (const item of lineItems) {
          // Count line item types
          stats.lineItemTypes[item.type] = (stats.lineItemTypes[item.type] || 0) + 1;
          
          // Count tasks and their statuses
          if (item.type === 'task') {
            const status = item.getTaskStatus();
            stats.taskStatuses[status] = (stats.taskStatuses[status] || 0) + 1;
            stats.totalTasks++;
            collectionData.taskCount++;
            recordData.taskCount++;
          }
        }
        
        collectionData.records.push(recordData);
        
        // Track largest records and empty records (optionally exclude journal collections)
        if (lineItems.length > 0) {
          stats.largestRecords.push(recordData);
        } else if (!excludeJournalFromEmpty || !collection.isJournalPlugin()) {
          stats.emptyRecords.push(recordData);
        }
      }
      
      // Analyze collection configuration
      const config = collectionData.config;
      
      // Count property types
      if (config.fields) {
        for (const field of config.fields) {
          if (field.active) {
            stats.propertyTypes[field.type] = (stats.propertyTypes[field.type] || 0) + 1;
          }
        }
      }
      
      // Count view types
      if (config.views) {
        for (const view of config.views) {
          if (view.shown) {
            stats.viewTypes[view.type] = (stats.viewTypes[view.type] || 0) + 1;
          }
        }
      }
      
      stats.collections.push(collectionData);
    }
    
    // Sort largest records
    stats.largestRecords.sort((a, b) => b.lineItemCount - a.lineItemCount);
    stats.largestRecords = stats.largestRecords.slice(0, 10);
    
    // Get users
    stats.users = this.data.getActiveUsers();
    
    // Get global plugins
    stats.globalPlugins = await this.data.getAllGlobalPlugins();
    
    return stats;
  }
  
  renderStats(stats) {
    const completedTasks = stats.taskStatuses['done'] || 0;
    const taskCompletionRate = stats.totalTasks > 0 
      ? Math.round((completedTasks / stats.totalTasks) * 100) 
      : 0;
    
    // Get username for title
    const userName = stats.users.length > 0 
      ? stats.users[0].getDisplayName() || stats.users[0].getEmail()
      : 'Workspace';
    
    // Get section visibility settings from config
    const config = this.getConfiguration();
    const sections = config.custom?.sections || {};
    
    // Default all sections to true if not specified
    const showOverview = sections.showOverview !== false;
    const showCollections = sections.showCollections !== false;
    const showContentTypes = sections.showContentTypes !== false;
    const showTaskStatuses = sections.showTaskStatuses !== false;
    const showPropertyTypes = sections.showPropertyTypes !== false;
    const showViewTypes = sections.showViewTypes !== false;
    const showLargestRecords = sections.showLargestRecords !== false;
    const showEmptyRecords = sections.showEmptyRecords !== false;
    const showUsers = sections.showUsers !== false;
    
    return `
      <div class="stats-container">
        <div class="stats-header">
          <h1>📊 ${userName}'s Stats</h1>
          <button class="refresh-btn" data-action="refresh">🔄 Refresh</button>
        </div>
        
        <!-- Overview Cards -->
        ${showOverview ? `
        <div class="stats-cards">
          <div class="stat-card">
            <div class="stat-value">${stats.collections.length}</div>
            <div class="stat-label">Collections</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.totalRecords.toLocaleString()}</div>
            <div class="stat-label">Records</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.totalLineItems.toLocaleString()}</div>
            <div class="stat-label">Line Items</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.totalTasks.toLocaleString()}</div>
            <div class="stat-label">Tasks</div>
            <div class="stat-detail">${taskCompletionRate}% completed</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.users.length}</div>
            <div class="stat-label">Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.globalPlugins.length}</div>
            <div class="stat-label">Global Plugins</div>
          </div>
        </div>
        ` : ''}
        
        <!-- Collections List -->
        ${showCollections ? `
        <div class="stats-section">
          <h2>📁 Collections</h2>
          <div class="collection-list">
            ${stats.collections.map(col => `
              <div class="collection-item" data-collection-guid="${col.guid}">
                <div class="collection-name">
                  ${col.name}
                  ${col.isJournal ? '<span class="badge">Journal</span>' : ''}
                </div>
                <div class="collection-stats">
                  <span>${col.recordCount} records</span>
                  <span>${col.lineItemCount} items</span>
                  <span>${col.taskCount} tasks</span>
                  <span>${col.config.fields ? col.config.fields.filter(f => f.active).length : 0} properties</span>
                  <span>${col.config.views ? col.config.views.filter(v => v.shown).length : 0} views</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- Content Type Breakdown -->
        ${showContentTypes ? `
        <div class="stats-section">
          <h2>📝 Content Types</h2>
          <div class="breakdown-grid">
            ${Object.entries(stats.lineItemTypes)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => `
                <div class="breakdown-item">
                  <div class="breakdown-label">${this.formatLineItemType(type)}</div>
                  <div class="breakdown-value">${count.toLocaleString()}</div>
                </div>
              `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- Task Breakdown -->
        ${showTaskStatuses && stats.totalTasks > 0 ? `
        <div class="stats-section">
          <h2>✓ Task Statuses</h2>
          <div class="breakdown-grid">
            ${Object.entries(stats.taskStatuses)
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => `
                <div class="breakdown-item">
                  <div class="breakdown-label">${this.formatTaskStatus(status)}</div>
                  <div class="breakdown-value">${count.toLocaleString()}</div>
                </div>
              `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- Property Types -->
        ${showPropertyTypes && Object.keys(stats.propertyTypes).length > 0 ? `
        <div class="stats-section">
          <h2>🏷️ Property Types</h2>
          <div class="breakdown-grid">
            ${Object.entries(stats.propertyTypes)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => `
                <div class="breakdown-item">
                  <div class="breakdown-label">${this.formatPropertyType(type)}</div>
                  <div class="breakdown-value">${count.toLocaleString()}</div>
                </div>
              `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- View Types -->
        ${showViewTypes && Object.keys(stats.viewTypes).length > 0 ? `
        <div class="stats-section">
          <h2>👁️ View Types</h2>
          <div class="breakdown-grid">
            ${Object.entries(stats.viewTypes)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => `
                <div class="breakdown-item">
                  <div class="breakdown-label">${this.formatViewType(type)}</div>
                  <div class="breakdown-value">${count.toLocaleString()}</div>
                </div>
              `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- Largest Records -->
        ${showLargestRecords && stats.largestRecords.length > 0 ? `
        <div class="stats-section">
          <h2>📄 Largest Records</h2>
          <div class="record-list">
            ${stats.largestRecords.slice(0, 10).map(record => `
              <div class="record-item" data-record-guid="${record.guid}">
                <div class="record-name">${record.name}</div>
                <div class="record-meta">
                  <span>${record.collectionName}</span>
                  <span>${record.lineItemCount} items</span>
                  ${record.taskCount > 0 ? `<span>${record.taskCount} tasks</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- Empty Records -->
        ${showEmptyRecords && stats.emptyRecords.length > 0 ? `
        <div class="stats-section">
          <h2>📭 Empty Records</h2>
          <div class="record-list">
            ${stats.emptyRecords.slice(0, 10).map(record => `
              <div class="record-item" data-record-guid="${record.guid}">
                <div class="record-name">${record.name}</div>
                <div class="record-meta">
                  <span>${record.collectionName}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        <!-- Users -->
        ${showUsers ? `
        <div class="stats-section">
          <h2>👥 Users</h2>
          <div class="user-list">
            ${stats.users.map(user => `
              <div class="user-item">
                <div class="user-name">
                  ${user.getDisplayName() || user.getEmail()}
                  ${user.isAdmin() ? '<span class="badge admin">Admin</span>' : ''}
                  ${user.isOwner() ? '<span class="badge owner">Owner</span>' : ''}
                </div>
                <div class="user-email">${user.getEmail()}</div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }
  
  attachEventListeners(element, panel, stats) {
    // Refresh button
    const refreshBtn = element.querySelector('[data-action="refresh"]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.renderStatsPanel(panel);
      });
    }
    
    // Collection items - click to open collection
    element.querySelectorAll('[data-collection-guid]').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const guid = el.dataset.collectionGuid;
        panel.navigateTo({
          type: 'overview',
          rootId: guid,
          subId: null,
          workspaceGuid: this.getWorkspaceGuid()
        });
      });
    });
    
    // Record items - click to open record
    element.querySelectorAll('[data-record-guid]').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const guid = el.dataset.recordGuid;
        panel.navigateTo({
          type: 'edit_panel',
          rootId: guid,
          subId: null,
          workspaceGuid: this.getWorkspaceGuid()
        });
      });
    });
  }
  
  formatLineItemType(type) {
    const types = {
      'task': '✓ Task',
      'text': '📝 Text',
      'heading': '📌 Heading',
      'ulist': '• List',
      'olist': '1. Ordered List',
      'quote': '❝ Quote',
      'block': '▢ Block',
      'image': '🖼️ Image',
      'file': '📎 File',
      'table': '⊞ Table',
      'br': '↵ Line Break',
      'empty': '∅ Empty'
    };
    return types[type] || type;
  }
  
  formatTaskStatus(status) {
    const statuses = {
      'done': '✓ Done',
      'none': '◯ None',
      'started': '▶ Started',
      'waiting': '⏸ Waiting',
      'important': '! Important',
      'starred': '★ Starred',
      'billable': '$ Billable',
      'discuss': '💬 Discuss',
      'alert': '⚠ Alert'
    };
    return statuses[status] || status;
  }
  
  formatPropertyType(type) {
    const types = {
      'text': 'Text',
      'number': 'Number',
      'choice': 'Choice/Select',
      'datetime': 'Date/Time',
      'user': 'User',
      'record': 'Record Reference',
      'file': 'File',
      'image': 'Image',
      'url': 'URL',
      'hashtag': 'Hashtag',
      'dynamic': 'Formula/Dynamic'
    };
    return types[type] || type;
  }
  
  formatViewType(type) {
    const types = {
      'table': 'Table',
      'board': 'Board/Kanban',
      'gallery': 'Gallery',
      'calendar': 'Calendar',
      'custom': 'Custom'
    };
    return types[type] || type;
  }
  
  injectStyles() {
    this.ui.injectCSS(`
      .stats-container {
        padding: 24px;
        max-width: 1200px;
        margin: 0 auto;
      }
      
      .stats-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 32px;
      }
      
      .stats-header h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 600;
      }
      
      .refresh-btn {
        padding: 8px 16px;
        background: #808080;
        color: #fff;
        border: 1px solid #666;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
      }
      
      .refresh-btn:hover {
        background: #6a6a6a;
      }
      
      .stats-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 16px;
        margin-bottom: 32px;
      }
      
      .stat-card {
        background: #fff;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
      }
      
      .stat-value {
        font-size: 32px;
        font-weight: 700;
        color: #333;
        margin-bottom: 8px;
      }
      
      .stat-label {
        font-size: 13px;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .stat-detail {
        font-size: 12px;
        color: #999;
        margin-top: 4px;
      }
      
      .stats-section {
        background: #fff;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 24px;
        margin-bottom: 24px;
      }
      
      .stats-section h2 {
        margin: 0 0 20px 0;
        font-size: 18px;
        font-weight: 600;
        color: #1a1a1a;
      }
      
      .collection-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .collection-item {
        padding: 16px;
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        transition: all 0.2s;
      }
      
      .collection-item:hover {
        background: #f0f0f0;
        border-color: #ccc;
      }
      
      .collection-name {
        font-weight: 600;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .collection-stats {
        display: flex;
        gap: 16px;
        font-size: 13px;
        color: #666;
      }
      
      .breakdown-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 12px;
      }
      
      .breakdown-item {
        padding: 12px;
        background: #f9f9f9;
        border-radius: 6px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .breakdown-label {
        font-size: 14px;
        color: #666;
      }
      
      .breakdown-value {
        font-size: 18px;
        font-weight: 600;
        color: #333;
      }
      
      .record-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .record-item {
        padding: 12px;
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        transition: all 0.2s;
      }
      
      .record-item:hover {
        background: #f0f0f0;
        border-color: #ccc;
      }
      
      .record-name {
        font-weight: 500;
        margin-bottom: 4px;
      }
      
      .record-meta {
        display: flex;
        gap: 12px;
        font-size: 12px;
        color: #666;
      }
      
      .user-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .user-item {
        padding: 12px;
        background: #f9f9f9;
        border-radius: 6px;
      }
      
      .user-name {
        font-weight: 500;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .user-email {
        font-size: 13px;
        color: #666;
      }
      
      .badge {
        display: inline-block;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        background: #e0e0e0;
        border-radius: 3px;
        letter-spacing: 0.5px;
      }
      
      .badge.admin {
        background: #ffd700;
        color: #333;
      }
      
      .badge.owner {
        background: #ff6b6b;
        color: #fff;
      }
      
      .spinner {
        border: 3px solid #f3f3f3;
        border-top: 3px solid #3498db;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
        margin: 0 auto;
      }
      
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `);
  }
}