/**
 * app.js — 主应用入口
 * 负责初始化、模块整合、示例数据、事件绑定
 */
(function () {
  'use strict';

  /* ─── 全局状态 ─── */
  var state = {
    nodes: [],
    edges: [],
    groups: [],
    alarms: [],
    nodeMap: new Map(),
    edgeMap: new Map(),
    positions: {},
    selection: new Set(),
    selectRect: null,
    cycles: [],
    isolated: [],
    _pulseEnabled: false
  };

  /* ─── 应用初始化 ─── */
  function init() {
    var canvas = document.getElementById('topo-canvas');
    if (!canvas) return;

    // 初始化渲染器
    Renderer.init(canvas, state);

    // 初始化交互
    Interaction.init(canvas, state);

    // 绑定工具栏按钮
    bindToolbar();

    // 绑定告警控制按钮
    bindAlarmControls();

    // 显示初始状态
    Interaction.updateStats();
    Interaction.updateZoomDisplay();

    ImportExport.showToast('系统就绪，点击"示例数据"或"导入"加载拓扑', 'info');
  }

  /* ─── 工具栏事件绑定 ─── */
  function bindToolbar() {
    on('btn-import', function () {
      ImportExport.importJSON(function (jsonText) {
        loadTopology(jsonText);
      });
    });

    on('btn-export', function () {
      ImportExport.exportJSON(state);
    });

    on('btn-export-img', function () {
      ImportExport.exportImage(document.getElementById('topo-canvas'));
    });

    on('btn-auto-layout', function () {
      doAutoLayout();
      ImportExport.showToast('自动布局完成', 'success');
    });

    on('btn-fit', function () {
      Renderer.fitToScreen();
      Interaction.updateZoomDisplay();
    });

    on('btn-zoom-in', function () { Interaction.zoomIn(); });
    on('btn-zoom-out', function () { Interaction.zoomOut(); });

    on('btn-load-demo', function () { loadDemoData(); });

    on('btn-collapse-all', function () {
      if (state.groups) {
        var allCollapsed = state.groups.every(function (g) { return g.collapsed; });
        state.groups.forEach(function (g) { g.collapsed = !allCollapsed; });
        Interaction.renderGroupPanel();
        Renderer.requestRender();
      }
    });
  }

  /* ─── 告警控制绑定 ─── */
  function bindAlarmControls() {
    on('btn-play', function () { AlarmPlayer.play(); Renderer.enablePulse(true); });
    on('btn-pause', function () { AlarmPlayer.pause(); });
    on('btn-stop', function () { AlarmPlayer.stop(); Renderer.enablePulse(false); });
    on('btn-step-back', function () { AlarmPlayer.stepBack(); });
    on('btn-step-forward', function () { AlarmPlayer.stepForward(); });

    var speedSelect = document.getElementById('play-speed');
    if (speedSelect) {
      speedSelect.addEventListener('change', function () {
        AlarmPlayer.setSpeed(parseFloat(this.value));
      });
    }
  }

  /* ─── 加载拓扑数据 ─── */
  function loadTopology(jsonText) {
    var result = DataParser.parse(jsonText);

    // 显示解析警告
    if (result.warnings.length > 0) {
      result.warnings.forEach(function (w) {
        ImportExport.showToast(w, 'warning');
      });
    }

    state.nodes = result.nodes;
    state.edges = result.edges;
    state.groups = result.groups;
    state.alarms = result.alarms;
    state.cycles = result.cycles;
    state.isolated = result.isolated;

    // 构建查找映射
    state.nodeMap = new Map();
    state.nodes.forEach(function (n) { state.nodeMap.set(n.id, n); });

    state.edgeMap = new Map();
    state.edges.forEach(function (e) {
      e._originalStatus = e.status;
      state.edgeMap.set(e.id, e);
    });

    state.selection = new Set();

    // 尝试从 localStorage 恢复布局
    var saved = ImportExport.loadLayout('default');
    var hasValidSaved = saved && saved.positions && Object.keys(saved.positions).length > 0;
    var allNodesHavePositions = state.nodes.every(function (n) { return n.x !== null && n.y !== null; });

    if (hasValidSaved) {
      // 恢复保存的布局
      state.positions = saved.positions;
      state.nodes.forEach(function (n) {
        if (saved.positions[n.id]) {
          n.x = saved.positions[n.id].x;
          n.y = saved.positions[n.id].y;
        }
      });
      // 恢复分组折叠状态
      if (saved.groups) {
        saved.groups.forEach(function (sg) {
          var g = state.groups.find(function (g) { return g.id === sg.id; });
          if (g) g.collapsed = sg.collapsed;
        });
      }
      // 恢复视口
      if (saved.viewport) {
        Renderer.setViewport(saved.viewport.x, saved.viewport.y, saved.viewport.scale);
      }
      ImportExport.showToast('已恢复上次布局', 'info');
    } else if (allNodesHavePositions) {
      // 使用数据中的坐标
      state.positions = {};
      state.nodes.forEach(function (n) {
        state.positions[n.id] = { x: n.x, y: n.y };
      });
    } else {
      // 自动布局
      doAutoLayout();
    }

    // 初始化告警回放
    AlarmPlayer.init(state.alarms, state, onAlarmUpdate);

    // 更新UI
    Interaction.renderGroupPanel();
    Interaction.updateStats();
    Renderer.fitToScreen();
    Interaction.updateZoomDisplay();
    Renderer.requestRender();

    ImportExport.showToast('拓扑加载完成: ' + state.nodes.length + ' 个节点, ' + state.edges.length + ' 条连线', 'success');
  }

  /* ─── 自动布局 ─── */
  function doAutoLayout() {
    var cw = document.getElementById('canvas-container').clientWidth || 1200;
    var ch = document.getElementById('canvas-container').clientHeight || 600;
    state.positions = LayoutEngine.autoLayout(state.nodes, state.edges, state.groups, cw, ch);

    // 应用布局位置到节点
    state.nodes.forEach(function (n) {
      if (state.positions[n.id]) {
        n.x = state.positions[n.id].x;
        n.y = state.positions[n.id].y;
      }
    });

    Renderer.fitToScreen();
    Interaction.updateZoomDisplay();
    Renderer.requestRender();
    Interaction.scheduleLayoutSave();
  }

  /* ─── 告警更新回调 ─── */
  function onAlarmUpdate(snapshot) {
    // 告警播放时更新分组面板中的状态点颜色
    Interaction.renderGroupPanel();
    Renderer.requestRender();
  }

  /* ─── 辅助函数 ─── */
  function on(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  /* ─── 示例数据 ─── */
  function loadDemoData() {
    var demo = {
      nodes: [
        // 机房
        { id: 'dc-bj-1', name: '北京机房A', type: 'datacenter', group: '北京区域', ip: '10.0.0.0/16', description: '北京核心机房，承载核心业务' },
        { id: 'dc-bj-2', name: '北京机房B', type: 'datacenter', group: '北京区域', ip: '10.1.0.0/16', description: '北京灾备机房' },
        { id: 'dc-sh-1', name: '上海机房', type: 'datacenter', group: '上海区域', ip: '10.2.0.0/16', description: '上海核心机房' },

        // 交换机
        { id: 'sw-bj-core', name: '北京核心交换', type: 'switch', group: '北京区域', ip: '10.0.0.1', details: { vendor: 'Huawei', model: 'CE12800' } },
        { id: 'sw-bj-acc1', name: '北京接入交换1', type: 'switch', group: '北京区域', ip: '10.0.1.1' },
        { id: 'sw-bj-acc2', name: '北京接入交换2', type: 'switch', group: '北京区域', ip: '10.0.2.1' },
        { id: 'sw-sh-core', name: '上海核心交换', type: 'switch', group: '上海区域', ip: '10.2.0.1', details: { vendor: 'Cisco', model: 'Nexus 9000' } },

        // 服务器
        { id: 'srv-web-1', name: 'Web服务器1', type: 'server', group: '北京区域', ip: '10.0.1.10', details: { cpu: '32核', ram: '64GB', os: 'CentOS 7' } },
        { id: 'srv-web-2', name: 'Web服务器2', type: 'server', group: '北京区域', ip: '10.0.1.11', details: { cpu: '32核', ram: '64GB', os: 'CentOS 7' } },
        { id: 'srv-app-1', name: '应用服务器1', type: 'server', group: '北京区域', ip: '10.0.2.10', details: { cpu: '64核', ram: '128GB', os: 'Ubuntu 20.04' } },
        { id: 'srv-app-2', name: '应用服务器2', type: 'server', group: '北京区域', ip: '10.0.2.11', details: { cpu: '64核', ram: '128GB', os: 'Ubuntu 20.04' } },
        { id: 'srv-sh-1', name: '上海应用服务器', type: 'server', group: '上海区域', ip: '10.2.1.10' },

        // 数据库
        { id: 'db-master', name: 'MySQL主库', type: 'database', group: '北京区域', ip: '10.0.2.20', details: { engine: 'MySQL 8.0', role: 'Master', storage: '2TB SSD' } },
        { id: 'db-slave', name: 'MySQL从库', type: 'database', group: '北京区域', ip: '10.0.2.21', details: { engine: 'MySQL 8.0', role: 'Slave' } },
        { id: 'db-redis', name: 'Redis集群', type: 'database', group: '北京区域', ip: '10.0.2.30', details: { engine: 'Redis 7.0', mode: 'Cluster' } },
        { id: 'db-sh', name: '上海MySQL', type: 'database', group: '上海区域', ip: '10.2.2.20' },

        // 网关
        { id: 'gw-api', name: 'API网关', type: 'gateway', group: '北京区域', ip: '10.0.0.100', details: { type: 'Kong', version: '3.0' } },
        { id: 'gw-lb', name: '负载均衡', type: 'gateway', group: '北京区域', ip: '10.0.0.101', details: { type: 'Nginx', version: '1.24' } },
        { id: 'gw-sh', name: '上海API网关', type: 'gateway', group: '上海区域', ip: '10.2.0.100' },

        // 业务应用
        { id: 'app-mall', name: '电商平台', type: 'app', description: '核心电商业务系统' },
        { id: 'app-pay', name: '支付系统', type: 'app', description: '在线支付处理' },
        { id: 'app-user', name: '用户中心', type: 'app', description: '用户认证与管理' },
        { id: 'app-order', name: '订单系统', type: 'app', description: '订单处理与管理' },
        { id: 'app-monitor', name: '监控平台', type: 'app', description: '基础设施监控' },

        // 孤立节点（用于测试检测）
        { id: 'orphan-1', name: '测试服务器', type: 'server', ip: '10.99.0.1', description: '未接入的测试环境' }
      ],
      edges: [
        // 机房 → 交换机
        { id: 'e1', source: 'dc-bj-1', target: 'sw-bj-core', label: '万兆', bandwidth: '10Gbps' },
        { id: 'e2', source: 'dc-bj-2', target: 'sw-bj-core', label: '万兆', bandwidth: '10Gbps' },
        { id: 'e3', source: 'dc-sh-1', target: 'sw-sh-core', label: '万兆', bandwidth: '10Gbps' },

        // 交换机 → 交换机
        { id: 'e4', source: 'sw-bj-core', target: 'sw-bj-acc1', label: '千兆' },
        { id: 'e5', source: 'sw-bj-core', target: 'sw-bj-acc2', label: '千兆' },
        { id: 'e6', source: 'sw-bj-core', target: 'sw-sh-core', label: '专线', bandwidth: '1Gbps' },

        // 交换机 → 服务器
        { id: 'e7', source: 'sw-bj-acc1', target: 'srv-web-1' },
        { id: 'e8', source: 'sw-bj-acc1', target: 'srv-web-2' },
        { id: 'e9', source: 'sw-bj-acc2', target: 'srv-app-1' },
        { id: 'e10', source: 'sw-bj-acc2', target: 'srv-app-2' },
        { id: 'e11', source: 'sw-sh-core', target: 'srv-sh-1' },

        // 交换机 → 数据库
        { id: 'e12', source: 'sw-bj-acc2', target: 'db-master' },
        { id: 'e13', source: 'sw-bj-acc2', target: 'db-slave' },
        { id: 'e14', source: 'sw-bj-acc2', target: 'db-redis' },
        { id: 'e15', source: 'sw-sh-core', target: 'db-sh' },
        { id: 'e16', source: 'db-master', target: 'db-slave', label: '主从复制', linkType: 'replication' },

        // 服务器 → 网关
        { id: 'e17', source: 'srv-web-1', target: 'gw-lb' },
        { id: 'e18', source: 'srv-web-2', target: 'gw-lb' },
        { id: 'e19', source: 'gw-lb', target: 'gw-api' },
        { id: 'e20', source: 'srv-sh-1', target: 'gw-sh' },

        // 服务器 → 数据库
        { id: 'e21', source: 'srv-app-1', target: 'db-master' },
        { id: 'e22', source: 'srv-app-1', target: 'db-redis' },
        { id: 'e23', source: 'srv-app-2', target: 'db-master' },
        { id: 'e24', source: 'srv-app-2', target: 'db-redis' },

        // 网关 → 业务应用
        { id: 'e25', source: 'gw-api', target: 'app-mall' },
        { id: 'e26', source: 'gw-api', target: 'app-pay' },
        { id: 'e27', source: 'gw-api', target: 'app-user' },
        { id: 'e28', source: 'gw-api', target: 'app-order' },
        { id: 'e29', source: 'gw-sh', target: 'app-mall' },

        // 业务应用间依赖
        { id: 'e30', source: 'app-mall', target: 'app-order', linkType: 'dependency' },
        { id: 'e31', source: 'app-mall', target: 'app-user', linkType: 'dependency' },
        { id: 'e32', source: 'app-order', target: 'app-pay', linkType: 'dependency' },

        // 监控
        { id: 'e33', source: 'app-monitor', target: 'gw-api', linkType: 'monitor' },
        { id: 'e34', source: 'app-monitor', target: 'sw-bj-core', linkType: 'monitor' }
      ],
      groups: [
        { id: '北京区域', name: '北京区域', nodeIds: ['dc-bj-1', 'dc-bj-2', 'sw-bj-core', 'sw-bj-acc1', 'sw-bj-acc2', 'srv-web-1', 'srv-web-2', 'srv-app-1', 'srv-app-2', 'db-master', 'db-slave', 'db-redis', 'gw-api', 'gw-lb'] },
        { id: '上海区域', name: '上海区域', nodeIds: ['dc-sh-1', 'sw-sh-core', 'srv-sh-1', 'db-sh', 'gw-sh'] }
      ],
      alarms: [
        // 故意设置乱序来测试排序
        {
          id: 'a3',
          timestamp: '2024-03-15T10:05:00Z',
          nodeId: 'db-master',
          level: 'critical',
          message: 'MySQL主库连接超时，主从复制中断',
          affectedNodes: ['db-slave', 'srv-app-1', 'srv-app-2'],
          edgeStates: { 'e16': 'critical', 'e21': 'critical', 'e23': 'critical' }
        },
        {
          id: 'a1',
          timestamp: '2024-03-15T10:00:00Z',
          nodeId: 'sw-bj-acc2',
          level: 'warning',
          message: '北京接入交换2端口流量异常，丢包率上升至5%',
          nodeStates: { 'sw-bj-acc2': 'warning' }
        },
        {
          id: 'a2',
          timestamp: '2024-03-15T10:02:30Z',
          nodeId: 'srv-app-1',
          level: 'warning',
          message: '应用服务器1 CPU使用率达到85%',
          nodeStates: { 'srv-app-1': 'warning' }
        },
        {
          id: 'a4',
          timestamp: '2024-03-15T10:06:00Z',
          nodeId: 'gw-api',
          level: 'warning',
          message: 'API网关响应延迟增加至 2.5s',
          affectedNodes: ['app-mall', 'app-pay', 'app-user', 'app-order']
        },
        {
          id: 'a5',
          timestamp: '2024-03-15T10:08:00Z',
          nodeId: 'app-pay',
          level: 'critical',
          message: '支付系统服务不可用，交易失败率100%',
          nodeStates: { 'app-pay': 'critical' },
          affectedNodes: ['app-mall', 'app-order']
        },
        {
          id: 'a6',
          timestamp: '2024-03-15T10:10:00Z',
          nodeId: 'app-mall',
          level: 'critical',
          message: '电商平台大面积报错，用户无法下单',
          nodeStates: { 'app-mall': 'critical' }
        },
        {
          id: 'a7',
          timestamp: '2024-03-15T10:15:00Z',
          nodeId: 'sw-bj-acc2',
          level: 'info',
          message: '接入交换2端口重置完成，流量恢复正常',
          nodeStates: { 'sw-bj-acc2': 'normal' }
        },
        {
          id: 'a8',
          timestamp: '2024-03-15T10:18:00Z',
          nodeId: 'db-master',
          level: 'info',
          message: 'MySQL主库连接恢复，主从复制重新同步',
          nodeStates: { 'db-master': 'normal', 'db-slave': 'normal' },
          edgeStates: { 'e16': 'normal', 'e21': 'normal', 'e23': 'normal' }
        },
        {
          id: 'a9',
          timestamp: '2024-03-15T10:20:00Z',
          nodeId: 'app-pay',
          level: 'info',
          message: '支付系统恢复正常，交易成功率回升至99.9%',
          nodeStates: { 'app-pay': 'normal', 'app-mall': 'normal', 'gw-api': 'normal', 'srv-app-1': 'normal' }
        },
        {
          id: 'a10',
          timestamp: '2024-03-15T14:30:00Z',
          nodeId: 'sw-sh-core',
          level: 'warning',
          message: '上海核心交换温度告警 65°C',
          nodeStates: { 'sw-sh-core': 'warning' }
        }
      ]
    };

    loadTopology(JSON.stringify(demo));
  }

  /* ─── 启动 ─── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
