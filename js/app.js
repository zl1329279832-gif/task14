/**
 * app.js — 主应用入口
 * 负责：初始化所有模块、协调交互、管理全局状态
 */
const App = (() => {
  'use strict';

  // 全局应用状态
  const state = {
    nodes: [],
    links: [],
    groups: [],
    alerts: [],
    nodeMap: new Map(),
    selectedNodes: [],
    signature: null,
    onLayoutChange: null,
    onAlertClick: null,
  };

  // 模式管理
  let _mode = 'single'; // 'single' | 'diff'
  let _singleModeState = null;
  let _diffFilters = {
    diffStates: { added: true, removed: true, changed: true, unchanged: true },
    linkStatuses: { normal: true, warning: true, critical: true },
    alarmSeverities: { critical: true, warning: true, info: true }
  };

  /**
   * 应用初始化
   */
  async function init() {
    console.log('🚀 拓扑可视化平台启动中...');

    // 初始化渲染器
    Renderer.init();

    // 初始化交互控制器
    Interaction.init(state);

    // 初始化告警回放
    AlertReplay.init(state);

    // 绑定工具栏事件
    bindToolbar();

    // 设置布局变更回调
    state.onLayoutChange = () => {
      LayoutEngine.computeGroupBounds(state.groups, state.nodeMap);
      ImportExport.saveLayout(state);
    };

    // 设置告警点击回调
    state.onAlertClick = (index) => {
      AlertReplay.seekTo(index);
    };

    // 尝试从localStorage恢复数据
    const savedData = ImportExport.loadSavedData();
    if (savedData) {
      console.log('📂 从本地存储恢复数据...');
      await loadData(savedData, false);
    } else {
      // 无保存数据时加载示例
      console.log('📋 无保存数据，点击"示例"按钮加载演示数据');
      updateEmptyState();
    }

    // 检查是否有 diff 数据可恢复
    if (ImportExport.hasDiffData()) {
      _showDiffRestorePrompt();
    }

    // 初始化 FaultReplay
    if (typeof FaultReplay !== 'undefined') {
      FaultReplay.init();
    }

    // 绑定 diff 模式事件
    bindDiffToolbar();

    // 启动渲染循环
    startRenderLoop();

    console.log('✅ 拓扑可视化平台就绪');
  }

  /**
   * 绑定工具栏按钮
   */
  function bindToolbar() {
    // 导入
    document.getElementById('btn-import').addEventListener('click', async () => {
      try {
        const rawData = await ImportExport.importFile();
        await loadData(rawData, true);
      } catch (err) {
        if (err.message !== '未选择文件') {
          alert('导入失败: ' + err.message);
        }
      }
    });

    // 导出
    document.getElementById('btn-export').addEventListener('click', () => {
      if (state.nodes.length === 0) {
        alert('暂无数据可导出');
        return;
      }
      ImportExport.exportData(state);
    });

    // 示例数据
    document.getElementById('btn-sample').addEventListener('click', async () => {
      const sampleData = getSampleData();
      await loadData(sampleData, true);
    });

    // 自动布局
    document.getElementById('btn-auto-layout').addEventListener('click', async () => {
      if (state.nodes.length === 0) return;
      const bounds = Renderer.getCanvasSize();
      const btn = document.getElementById('btn-auto-layout');
      btn.disabled = true;
      btn.textContent = '⏳ 布局中...';

      // 解除所有固定
      for (const n of state.nodes) n.pinned = false;

      await LayoutEngine.layout(state.nodes, state.links, state.groups, bounds);
      LayoutEngine.resolveCollisions(state.nodes.filter(n => n._visible !== false));
      LayoutEngine.computeGroupBounds(state.groups, state.nodeMap);
      Renderer.fitToView(state.nodes);
      Interaction.renderAll();
      Interaction.updateGroupList();
      ImportExport.saveLayout(state);

      btn.disabled = false;
      btn.textContent = '🔄 布局';
    });

    // 适应画布
    document.getElementById('btn-fit-view').addEventListener('click', () => {
      Renderer.fitToView(state.nodes);
      Interaction.renderAll();
    });

    // 保存布局
    document.getElementById('btn-save-layout').addEventListener('click', () => {
      const ok = ImportExport.saveLayout(state);
      ImportExport.saveFullData(state);
      if (ok) {
        showToast('💿 布局已保存');
      } else {
        showToast('❌ 保存失败');
      }
    });

    // 折叠/展开
    document.getElementById('btn-collapse-all').addEventListener('click', () => {
      Interaction.collapseAllGroups();
    });

    document.getElementById('btn-expand-all').addEventListener('click', () => {
      Interaction.expandAllGroups();
    });

    // 关闭面板
    document.getElementById('btn-close-detail').addEventListener('click', () => {
      document.getElementById('detail-panel').classList.add('hidden');
    });

    document.getElementById('btn-close-trace').addEventListener('click', () => {
      document.getElementById('trace-panel').classList.add('hidden');
      Interaction.clearHighlights();
      Interaction.renderAll();
    });
  }

  /**
   * 加载数据
   */
  async function loadData(rawData, showValidation) {
    const result = DataParser.parse(rawData);

    if (showValidation && result.messages.length > 0) {
      const proceed = await ImportExport.showValidationDialog(result.messages);
      if (!proceed) return;
    }

    if (!result.data) return;

    // ★ 关键修复：在加载新数据前完全清空旧状态
    // 停止告警回放（防止旧定时器继续触发）
    AlertReplay.reset();

    // 清空交互状态（选区、高亮、搜索、筛选、面板）
    Interaction.resetState();

    // 更新全局状态
    state.nodes = result.data.nodes;
    state.links = result.data.links;
    state.groups = result.data.groups;
    state.alerts = result.data.alerts;
    state.nodeMap = result.data.nodeMap;
    state.signature = result.data.signature;
    state.selectedNodes = [];

    // 尝试恢复布局（仅匹配同一拓扑签名）
    const hasLayout = ImportExport.restoreLayout(state);

    if (!hasLayout) {
      // 自动布局
      const bounds = Renderer.getCanvasSize();
      if (bounds.width > 0 && bounds.height > 0 && state.nodes.length > 0) {
        await LayoutEngine.layout(state.nodes, state.links, state.groups, bounds);
        LayoutEngine.resolveCollisions(state.nodes.filter(n => n._visible !== false));
      }
    }

    // 计算分组边界
    LayoutEngine.computeGroupBounds(state.groups, state.nodeMap);

    // 保存原始状态（用于告警回放）
    AlertReplay.saveOriginalStatus();

    // 设置告警
    AlertReplay.setAlerts(state.alerts);

    // 适应画布（仅在布局未恢复时，避免覆盖已保存的视口位置）
    if (!hasLayout) {
      Renderer.fitToView(state.nodes);
    }

    // 更新UI
    Interaction.updateStats();
    Interaction.updateGroupList();
    Interaction.renderAll();

    // 保存到localStorage
    ImportExport.saveFullData(state);

    console.log(`📊 数据加载完成: ${state.nodes.length}节点, ${state.links.length}连线, ${state.alerts.length}告警`);
  }

  /**
   * 渲染循环
   */
  function startRenderLoop() {
    function loop() {
      Renderer.render(state);
      requestAnimationFrame(loop);
    }
    loop();
  }

  /**
   * 空状态更新
   */
  function updateEmptyState() {
    Interaction.updateStats();
    Interaction.updateGroupList();
    Interaction.updateEventList([], -1);
    Interaction.renderAll();
  }

  /**
   * 轻量提示
   */
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      padding: 8px 20px; background: var(--bg-tertiary); color: var(--text-primary);
      border: 1px solid var(--border-color); border-radius: 6px;
      font-size: 13px; z-index: 999; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      animation: toast-in 0.3s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  /**
   * 示例数据
   */
  function getSampleData() {
    return {
      nodes: [
        // 机房A
        { id: 'dc-a', type: 'datacenter', label: '北京数据中心', group: '北京' },
        { id: 'sw-a1', type: 'switch', label: '核心交换A1', group: '北京' },
        { id: 'sw-a2', type: 'switch', label: '汇聚交换A2', group: '北京' },
        { id: 'srv-a1', type: 'server', label: 'Web服务器01', group: '北京' },
        { id: 'srv-a2', type: 'server', label: 'Web服务器02', group: '北京' },
        { id: 'srv-a3', type: 'server', label: 'API服务器01', group: '北京' },
        { id: 'db-a1', type: 'database', label: 'MySQL主库', group: '北京' },
        { id: 'db-a2', type: 'database', label: 'Redis缓存', group: '北京' },

        // 机房B
        { id: 'dc-b', type: 'datacenter', label: '上海数据中心', group: '上海' },
        { id: 'sw-b1', type: 'switch', label: '核心交换B1', group: '上海' },
        { id: 'srv-b1', type: 'server', label: '计算节点B1', group: '上海' },
        { id: 'srv-b2', type: 'server', label: '计算节点B2', group: '上海' },
        { id: 'db-b1', type: 'database', label: 'MongoDB集群', group: '上海' },

        // 网关
        { id: 'gw-main', type: 'gateway', label: 'API网关' },
        { id: 'gw-backup', type: 'gateway', label: '备用网关' },
        { id: 'gw-cdn', type: 'gateway', label: 'CDN节点' },

        // 业务应用
        { id: 'app-web', type: 'app', label: '官网前端' },
        { id: 'app-mobile', type: 'app', label: '移动APP' },
        { id: 'app-admin', type: 'app', label: '管理后台' },
        { id: 'app-pay', type: 'app', label: '支付系统' },
        { id: 'app-order', type: 'app', label: '订单系统' },
        { id: 'app-notify', type: 'app', label: '消息推送' },
      ],
      links: [
        // 机房A内部
        { source: 'dc-a', target: 'sw-a1', status: 'normal' },
        { source: 'sw-a1', target: 'sw-a2', status: 'normal' },
        { source: 'sw-a1', target: 'srv-a1', status: 'normal' },
        { source: 'sw-a1', target: 'srv-a2', status: 'normal' },
        { source: 'sw-a2', target: 'srv-a3', status: 'normal' },
        { source: 'srv-a3', target: 'db-a1', status: 'normal' },
        { source: 'srv-a1', target: 'db-a2', status: 'normal' },
        { source: 'srv-a2', target: 'db-a2', status: 'normal' },

        // 机房B内部
        { source: 'dc-b', target: 'sw-b1', status: 'normal' },
        { source: 'sw-b1', target: 'srv-b1', status: 'normal' },
        { source: 'sw-b1', target: 'srv-b2', status: 'normal' },
        { source: 'srv-b1', target: 'db-b1', status: 'normal' },

        // 跨机房
        { source: 'sw-a1', target: 'sw-b1', status: 'normal', label: '专线' },

        // 网关连接
        { source: 'gw-main', target: 'srv-a1', status: 'normal' },
        { source: 'gw-main', target: 'srv-a2', status: 'normal' },
        { source: 'gw-backup', target: 'srv-b1', status: 'normal' },
        { source: 'gw-cdn', target: 'gw-main', status: 'normal' },
        { source: 'gw-cdn', target: 'gw-backup', status: 'normal' },

        // 业务应用连接
        { source: 'app-web', target: 'gw-main', status: 'normal' },
        { source: 'app-mobile', target: 'gw-main', status: 'normal' },
        { source: 'app-admin', target: 'srv-a3', status: 'normal' },
        { source: 'app-pay', target: 'srv-a3', status: 'normal' },
        { source: 'app-pay', target: 'db-a1', status: 'normal' },
        { source: 'app-order', target: 'srv-a3', status: 'normal' },
        { source: 'app-order', target: 'db-b1', status: 'normal' },
        { source: 'app-notify', target: 'srv-b2', status: 'normal' },
        { source: 'app-notify', target: 'db-a2', status: 'normal' },
      ],
      alerts: [
        {
          timestamp: '2026-06-08T10:00:00Z',
          nodeId: 'srv-a3',
          severity: 'warning',
          message: 'API服务器01 CPU使用率达到85%',
          type: 'performance',
        },
        {
          timestamp: '2026-06-08T10:02:30Z',
          nodeId: 'srv-a3',
          severity: 'critical',
          message: 'API服务器01 CPU使用率超过95%，服务响应延迟',
          type: 'performance',
          affectedNodes: ['app-pay', 'app-order'],
        },
        {
          timestamp: '2026-06-08T10:03:00Z',
          nodeId: 'db-a1',
          severity: 'warning',
          message: 'MySQL主库连接数接近上限 (480/500)',
          type: 'capacity',
          affectedNodes: ['app-pay'],
        },
        {
          timestamp: '2026-06-08T10:05:00Z',
          nodeId: 'srv-a3',
          linkId: 'srv-a3_db-a1',
          severity: 'critical',
          message: 'API服务器01与MySQL主库连接超时',
          type: 'connectivity',
          affectedNodes: ['app-pay', 'app-order', 'app-admin'],
        },
        {
          timestamp: '2026-06-08T10:05:30Z',
          nodeId: 'app-pay',
          severity: 'critical',
          message: '支付系统服务不可用，交易失败率100%',
          type: 'service',
          affectedNodes: ['gw-main'],
        },
        {
          timestamp: '2026-06-08T10:06:00Z',
          nodeId: 'app-order',
          severity: 'warning',
          message: '订单系统降级，启用缓存模式',
          type: 'degradation',
        },
        {
          timestamp: '2026-06-08T10:08:00Z',
          nodeId: 'gw-main',
          severity: 'warning',
          message: 'API网关流量自动切换到备用网关',
          type: 'failover',
          affectedNodes: ['gw-backup', 'srv-b1'],
        },
        {
          timestamp: '2026-06-08T10:10:00Z',
          nodeId: 'srv-a3',
          severity: 'warning',
          message: 'API服务器01触发自动重启',
          type: 'recovery',
        },
        {
          timestamp: '2026-06-08T10:12:00Z',
          nodeId: 'srv-a3',
          severity: 'normal',
          message: 'API服务器01重启成功，CPU恢复正常',
          type: 'recovery',
        },
        {
          timestamp: '2026-06-08T10:13:00Z',
          nodeId: 'app-pay',
          severity: 'normal',
          message: '支付系统恢复服务',
          type: 'recovery',
        },
      ],
    };
  }

  // DOM加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ==================== Diff 模式 ====================

  function bindDiffToolbar() {
    // 进入差异模式
    const btnEnterDiff = document.getElementById('btn-enter-diff');
    if (btnEnterDiff) {
      btnEnterDiff.addEventListener('click', () => {
        document.getElementById('diff-import-modal').classList.remove('hidden');
      });
    }

    // 差异导入确认
    const btnDiffConfirm = document.getElementById('btn-diff-import-confirm');
    if (btnDiffConfirm) {
      btnDiffConfirm.addEventListener('click', _handleDiffImportConfirm);
    }

    // 差异导入取消
    const btnDiffCancel = document.getElementById('btn-diff-import-cancel');
    if (btnDiffCancel) {
      btnDiffCancel.addEventListener('click', () => {
        document.getElementById('diff-import-modal').classList.add('hidden');
      });
    }

    // 退出差异模式
    const btnExitDiff = document.getElementById('btn-exit-diff');
    if (btnExitDiff) {
      btnExitDiff.addEventListener('click', exitDiffMode);
    }

    // 导出差异结果
    const btnExportDiff = document.getElementById('btn-export-diff');
    if (btnExportDiff) {
      btnExportDiff.addEventListener('click', () => {
        if (_mode === 'diff') ImportExport.exportDiffResult();
      });
    }

    // 差异筛选
    document.querySelectorAll('[data-diff-filter]').forEach(cb => {
      cb.addEventListener('change', () => _applyDiffFilters());
    });

    // 传播控制
    const btnPropStep = document.getElementById('btn-prop-step');
    if (btnPropStep) btnPropStep.addEventListener('click', () => FaultReplay.stepPropagation(TopoDiff.getAlerts()));

    const btnChainStep = document.getElementById('btn-chain-step');
    if (btnChainStep) btnChainStep.addEventListener('click', () => FaultReplay.stepChain(TopoDiff.getAlerts()));

    const btnRewind = document.getElementById('btn-rewind');
    if (btnRewind) btnRewind.addEventListener('click', () => FaultReplay.rewind(TopoDiff.getAlerts()));

    // diff 播放/暂停
    const btnDiffPlay = document.getElementById('btn-diff-play');
    if (btnDiffPlay) {
      btnDiffPlay.addEventListener('click', () => {
        const alerts = TopoDiff.getAlerts();
        if (FaultReplay.isPlaying()) {
          FaultReplay.pausePlayback();
          btnDiffPlay.textContent = '▶';
        } else {
          FaultReplay.startPlayback(alerts);
          btnDiffPlay.textContent = '⏸';
        }
      });
    }

    // diff 速度
    const diffSpeed = document.getElementById('diff-play-speed');
    if (diffSpeed) {
      diffSpeed.addEventListener('change', (e) => {
        FaultReplay.setSpeed(parseFloat(e.target.value));
      });
    }

    // diff 时间线
    const diffSlider = document.getElementById('diff-timeline-slider');
    if (diffSlider) {
      diffSlider.addEventListener('input', () => {
        const alerts = TopoDiff.getAlerts();
        if (!alerts || alerts.length === 0) return;
        const idx = Math.round(parseFloat(diffSlider.value) / 100 * (alerts.length - 1));
        FaultReplay.jumpToTime(alerts[idx]?.timestamp || 0, alerts);
      });
    }

    // 绑定 diff 告警列表
    Interaction.bindDiffAlarmEvents();
  }

  async function _handleDiffImportConfirm() {
    const fileA = document.getElementById('file-snapshot-a').files[0];
    const fileB = document.getElementById('file-snapshot-b').files[0];
    const fileAlerts = document.getElementById('file-alerts').files[0];

    if (!fileA || !fileB) {
      alert('请至少选择两份快照文件');
      return;
    }

    const readJSON = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => { try { resolve(JSON.parse(e.target.result)); } catch (err) { reject(err); } };
      reader.readAsText(file);
    });

    try {
      const snapshotA = await readJSON(fileA);
      const snapshotB = await readJSON(fileB);
      const alerts = fileAlerts ? await readJSON(fileAlerts) : null;

      document.getElementById('diff-import-modal').classList.add('hidden');
      await loadDiffData(snapshotA, snapshotB, alerts, fileA.name, fileB.name);
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  }

  async function loadDiffData(rawA, rawB, rawAlerts, labelA, labelB) {
    try {
      // 1. 解析快照
      const snapshotA = DataParser.parseSnapshot(rawA, labelA || '快照A');
      const snapshotB = DataParser.parseSnapshot(rawB, labelB || '快照B');

      // 2. 校验兼容性
      const validation = DataParser.validateSnapshotPair(snapshotA, snapshotB);
      if (!validation.valid) {
        alert('快照兼容性校验失败: ' + validation.warnings.map(w => w.text).join('; '));
        return;
      }
      if (validation.warnings.length > 0) {
        console.warn('快照兼容性警告:', validation.warnings);
      }

      // 3. 解析告警
      let alerts = [];
      if (rawAlerts) {
        alerts = Array.isArray(rawAlerts) ? DataParser.parseAlertTimeline(rawAlerts) : DataParser.parseAlertTimeline(rawAlerts.alerts || rawAlerts);
      }

      // 4. 计算差异
      TopoDiff.computeDiff(snapshotA, snapshotB);
      TopoDiff.buildMergedTopology();
      TopoDiff.setAlerts(alerts);

      // 5. 进入 diff 模式
      enterDiffMode();

      // 6. 布局
      const bounds = Renderer.getCanvasSize();
      const mergedNodes = TopoDiff.getMergedNodes();
      const mergedLinks = TopoDiff.getMergedLinks();

      // 尝试恢复布局
      const hasDiffLayout = ImportExport.restoreDiffLayout(mergedNodes);
      if (!hasDiffLayout) {
        LayoutEngine.layoutDiffNodes(null, mergedNodes, mergedLinks, bounds);
      }

      // 7. 构建传播图
      if (alerts.length > 0) {
        FaultReplay.buildPropagationGraph(alerts, mergedNodes, mergedLinks);
      }

      // 8. 恢复筛选
      const savedFilters = ImportExport.loadDiffFilters();
      if (savedFilters) _restoreDiffFilters(savedFilters);

      // 9. 更新 UI
      _updateDiffSummary();
      _updateDiffStatusBar();
      _populateDiffAlarmList(alerts);

      // 10. 适应画布（仅在布局未恢复时）
      if (!hasDiffLayout) {
        Renderer.fitToView(mergedNodes);
      }

      // 11. 恢复播放进度
      const playback = ImportExport.loadDiffPlayback();
      if (playback) {
        FaultReplay.setSpeed(playback.speed || 1);
        // 如果布局未恢复但从播放状态中有视口信息，恢复视口
        if (!hasDiffLayout && playback.viewport &&
            typeof playback.viewport.x === 'number' &&
            typeof playback.viewport.y === 'number' &&
            typeof playback.viewport.scale === 'number' &&
            isFinite(playback.viewport.x) &&
            isFinite(playback.viewport.y) &&
            playback.viewport.scale > 0) {
          Renderer.viewport.x = playback.viewport.x;
          Renderer.viewport.y = playback.viewport.y;
          Renderer.viewport.scale = playback.viewport.scale;
        }
        // 恢复到保存的告警位置
        if (playback.currentTime >= 0 && alerts.length > 0) {
          const restoreIdx = Math.min(playback.currentTime, alerts.length - 1);
          if (restoreIdx >= 0) {
            FaultReplay.jumpToTime(alerts[restoreIdx]?.timestamp || 0, alerts);
            // 更新 diff 时间线滑块
            const slider = document.getElementById('diff-timeline-slider');
            if (slider && alerts.length > 1) {
              slider.value = (restoreIdx / (alerts.length - 1)) * 100;
            }
          }
        }
      }

      // 12. 保存
      ImportExport.saveDiffSnapshots(snapshotA, snapshotB, alerts);
      ImportExport.saveDiffLayout(mergedNodes);

      Interaction.renderAll();
      console.log(`📊 差异分析完成: +${TopoDiff.getSummary().nodesAdded} -${TopoDiff.getSummary().nodesRemoved} ~${TopoDiff.getSummary().nodesChanged} 节点`);
    } catch (err) {
      alert('差异分析失败: ' + err.message);
      console.error(err);
    }
  }

  function enterDiffMode() {
    // 保存单拓扑状态
    _singleModeState = {
      nodes: state.nodes,
      links: state.links,
      groups: state.groups,
      alerts: state.alerts,
      nodeMap: state.nodeMap,
      signature: state.signature,
    };

    _mode = 'diff';
    Renderer.setDiffMode(true);
    AlertReplay.setMode('diff');

    // 切换 UI
    document.getElementById('diff-toolbar').style.display = 'flex';
    document.getElementById('diff-filter-section').style.display = 'block';
    document.getElementById('diff-right-panel').style.display = 'flex';
    document.getElementById('diff-status-bar').style.display = 'flex';
    document.getElementById('diff-legend').style.display = 'block';
    document.getElementById('diff-timeline-bar').style.display = 'flex';

    // 隐藏单拓扑控件
    document.getElementById('single-toolbar').style.display = 'none';
    document.getElementById('left-panel').style.display = 'none';
    document.getElementById('right-panel').style.display = 'none';
    document.getElementById('timeline-bar').style.display = 'none';
  }

  function exitDiffMode() {
    // 保存 diff 状态
    ImportExport.saveDiffLayout(TopoDiff.getMergedNodes());
    ImportExport.saveDiffFilters(_diffFilters);
    ImportExport.saveDiffPlayback(FaultReplay.getPlaybackState());

    // 重置 diff 模块
    FaultReplay.reset();
    TopoDiff.reset();

    _mode = 'single';
    Renderer.setDiffMode(false);
    AlertReplay.setMode('single');

    // 恢复单拓扑状态
    if (_singleModeState) {
      state.nodes = _singleModeState.nodes;
      state.links = _singleModeState.links;
      state.groups = _singleModeState.groups;
      state.alerts = _singleModeState.alerts;
      state.nodeMap = _singleModeState.nodeMap;
      state.signature = _singleModeState.signature;
      _singleModeState = null;
    }

    // 切换 UI
    document.getElementById('diff-toolbar').style.display = 'none';
    document.getElementById('diff-filter-section').style.display = 'none';
    document.getElementById('diff-right-panel').style.display = 'none';
    document.getElementById('diff-status-bar').style.display = 'none';
    document.getElementById('diff-legend').style.display = 'none';
    document.getElementById('diff-timeline-bar').style.display = 'none';

    document.getElementById('single-toolbar').style.display = 'flex';
    document.getElementById('left-panel').style.display = 'flex';
    document.getElementById('right-panel').style.display = 'flex';
    document.getElementById('timeline-bar').style.display = 'flex';

    Interaction.renderAll();
  }

  function _applyDiffFilters() {
    // 收集筛选状态
    document.querySelectorAll('[data-diff-filter]').forEach(cb => {
      const [group, key] = cb.dataset.diffFilter.split('.');
      if (group && key && _diffFilters[group]) {
        _diffFilters[group][key] = cb.checked;
      }
    });

    const nodes = TopoDiff.getMergedNodes();
    const links = TopoDiff.getMergedLinks();

    // 应用差异状态筛选
    for (const node of nodes) {
      const ds = node._diffState || 'unchanged';
      node._visible = _diffFilters.diffStates[ds] !== false;
      // 节点类型筛选
      if (node._visible && _diffFilters.nodeTypes) {
        node._visible = _diffFilters.nodeTypes[node.type] !== false;
      }
    }

    // 链路筛选
    const nodeMap = TopoDiff.getMergedNodeMap();
    for (const link of links) {
      const src = nodeMap.get(link.source);
      const tgt = nodeMap.get(link.target);
      link._visible = (src?._visible !== false && tgt?._visible !== false);
      if (link._visible) {
        const ls = link._diffState || 'unchanged';
        link._visible = _diffFilters.diffStates[ls] !== false;
      }
    }

    // 重建可见节点的 Set，用于更新传播链可见性
    const visibleNodeIds = new Set();
    for (const node of nodes) {
      if (node._visible !== false) visibleNodeIds.add(node.id);
    }

    // 更新 FaultReplay 中传播链的可见性标记
    const chains = FaultReplay.getChains();
    for (const chain of chains) {
      chain._visibleSteps = chain.steps.filter(s => visibleNodeIds.has(s.nodeId));
      chain._anyVisible = chain._visibleSteps.length > 0;
    }

    ImportExport.saveDiffFilters(_diffFilters);
    Interaction.renderAll();
    _updateDiffStatusBar();
  }

  function _restoreDiffFilters(filters) {
    _diffFilters = { ..._diffFilters, ...filters };
    document.querySelectorAll('[data-diff-filter]').forEach(cb => {
      const key = cb.dataset.diffFilter;
      if (key) {
        const [group, subkey] = key.split('.');
        if (_diffFilters[group] && _diffFilters[group][subkey] !== undefined) {
          cb.checked = _diffFilters[group][subkey];
        }
      }
    });
  }

  function _updateDiffSummary() {
    const summary = TopoDiff.getSummary();
    if (!summary) return;

    const el = document.getElementById('diff-summary');
    if (el) {
      el.innerHTML = `
        <div class="diff-stat added">🟢 新增节点: ${summary.nodesAdded}</div>
        <div class="diff-stat removed">🔴 删除节点: ${summary.nodesRemoved}</div>
        <div class="diff-stat changed">🟡 变更节点: ${summary.nodesChanged}</div>
        <div class="diff-stat-sep"></div>
        <div class="diff-stat added">🟢 新增链路: ${summary.linksAdded}</div>
        <div class="diff-stat removed">🔴 删除链路: ${summary.linksRemoved}</div>
        <div class="diff-stat changed">🟡 变更链路: ${summary.linksChanged}</div>
      `;
    }

    // 更新图例
    const legend = document.getElementById('diff-legend-content');
    if (legend) {
      const chains = FaultReplay.getChains();
      const rootCause = FaultReplay.getRootCause();
      legend.innerHTML = `
        <div class="legend-item"><span class="legend-dot" style="background:#22c55e"></span> 新增</div>
        <div class="legend-item"><span class="legend-dot" style="background:#ef4444"></span> 删除</div>
        <div class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span> 变更</div>
        <div class="legend-item"><span class="legend-dot" style="background:#5a6a7a"></span> 不变</div>
        ${chains.length > 0 ? `<div class="legend-sep"></div><div class="legend-item">传播链: ${chains.length} 条</div><div class="legend-item">根因: ${rootCause || '-'}</div>` : ''}
      `;
    }
  }

  function _updateDiffStatusBar() {
    const chains = FaultReplay.getChains();
    const rootCause = FaultReplay.getRootCause();
    const playbackState = FaultReplay.getPlaybackState();
    const allBizNodes = new Set();
    let visibleChainCount = 0;
    for (const chain of chains) {
      // 只统计可见的传播链
      if (chain._anyVisible === false) continue;
      visibleChainCount++;
      for (const biz of chain.affectedBusinessNodes) allBizNodes.add(biz);
    }

    const elChains = document.getElementById('status-chains');
    const elRoot = document.getElementById('status-root-cause');
    const elAffected = document.getElementById('status-affected');
    const elStep = document.getElementById('status-step');

    if (elChains) elChains.textContent = `传播链: ${visibleChainCount} 条`;
    if (elRoot) elRoot.textContent = `根因节点: ${rootCause || '-'}`;
    if (elAffected) elAffected.textContent = `影响业务: ${allBizNodes.size} 个`;
    if (elStep) elStep.textContent = `当前步: ${playbackState.activeAlertIndex + 1} / ${TopoDiff.getAlerts().length}`;
  }

  function _populateDiffAlarmList(alerts) {
    Interaction.updateDiffAlarmList(alerts, -1);

    // 更新 slider
    const slider = document.getElementById('diff-timeline-slider');
    if (slider && alerts.length > 0) {
      slider.min = 0;
      slider.max = 100;
      slider.step = 100 / Math.max(alerts.length - 1, 1);
      slider.value = 0;
    }

    // 直方图
    DiffRenderer.renderTimelineHistogram(alerts, -1);

    // 时间显示
    if (alerts.length > 0) {
      const timeEl = document.getElementById('diff-timeline-time');
      if (timeEl) {
        timeEl.textContent = `${new Date(alerts[0].timestamp).toLocaleTimeString()} — ${new Date(alerts[alerts.length-1].timestamp).toLocaleTimeString()}`;
      }
    }
  }

  function _showDiffRestorePrompt() {
    const toast = document.createElement('div');
    toast.innerHTML = `
      <div style="margin-bottom:8px;">检测到上次差异分析数据，是否恢复？</div>
      <button id="btn-restore-diff" style="margin-right:8px;">恢复差异模式</button>
      <button id="btn-clear-diff">清除</button>
    `;
    toast.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      padding: 12px 20px; background: var(--bg-tertiary); color: var(--text-primary);
      border: 1px solid var(--border-color); border-radius: 8px;
      font-size: 13px; z-index: 999; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(toast);

    document.getElementById('btn-restore-diff').addEventListener('click', async () => {
      toast.remove();
      const data = ImportExport.loadDiffSnapshots();
      if (data) {
        await loadDiffData(data.snapshotA, data.snapshotB, data.alerts);
      }
    });

    document.getElementById('btn-clear-diff').addEventListener('click', () => {
      toast.remove();
      ImportExport.clearDiffStorage();
    });
  }

  return {
    init,
    state,
    loadData,
    loadDiffData,
    getSampleData,
    enterDiffMode,
    exitDiffMode,
    getMode: () => _mode,
  };
})();
