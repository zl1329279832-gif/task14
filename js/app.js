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
    onLayoutChange: null,
    onAlertClick: null,
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
   * 重置所有交互状态（导入新拓扑前调用）
   */
  function resetState() {
    // 停止告警回放
    AlertReplay.reset();

    // 清除选区和高亮
    Interaction.clearSelection();
    Interaction.clearHighlights();

    // 关闭所有面板
    document.getElementById('detail-panel').classList.add('hidden');
    document.getElementById('trace-panel').classList.add('hidden');
    document.getElementById('impact-panel').classList.add('hidden');

    // 重置类型过滤器为全选
    document.querySelectorAll('#type-filters input').forEach(cb => {
      cb.checked = true;
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

    // 重置所有交互状态
    resetState();

    // 更新全局状态
    state.nodes = result.data.nodes;
    state.links = result.data.links;
    state.groups = result.data.groups;
    state.alerts = result.data.alerts;
    state.nodeMap = result.data.nodeMap;
    state.selectedNodes = [];

    // 尝试恢复布局
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

    // 适应画布
    Renderer.fitToView(state.nodes);

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

  return {
    init,
    state,
    loadData,
    getSampleData,
  };
})();
