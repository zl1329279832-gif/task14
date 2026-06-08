/**
 * data-parser.js — 数据解析模块
 * 负责拓扑数据的导入解析、校验、去重、环形依赖检测、孤立节点检测、告警排序
 */
window.DataParser = (function () {
  'use strict';

  /* ─── 节点类型定义 ─── */
  const VALID_TYPES = new Set([
    'datacenter', 'switch', 'server', 'database', 'gateway', 'app'
  ]);

  const TYPE_LABELS = {
    datacenter: '机房',
    switch: '交换机',
    server: '服务器',
    database: '数据库',
    gateway: '网关',
    app: '业务应用'
  };

  const VALID_STATUSES = new Set(['normal', 'warning', 'critical', 'offline']);
  const VALID_ALARM_LEVELS = new Set(['critical', 'warning', 'info']);

  /* ─── 主解析入口 ─── */
  function parse(json) {
    const warnings = [];
    let data;
    if (typeof json === 'string') {
      try {
        data = JSON.parse(json);
      } catch (e) {
        return { nodes: [], edges: [], groups: [], alarms: [], warnings: ['JSON 解析失败: ' + e.message] };
      }
    } else {
      data = json;
    }

    const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
    const rawEdges = Array.isArray(data.edges) ? data.edges : [];
    const rawGroups = Array.isArray(data.groups) ? data.groups : [];
    const rawAlarms = Array.isArray(data.alarms) ? data.alarms : [];

    // 1. 去重节点
    const { items: nodes, dupeCount: nodeDupes } = deduplicateById(rawNodes);
    if (nodeDupes > 0) warnings.push('去除 ' + nodeDupes + ' 个重复节点ID');

    // 2. 去重边
    const { items: edges, dupeCount: edgeDupes } = deduplicateById(rawEdges);
    if (edgeDupes > 0) warnings.push('去除 ' + edgeDupes + ' 个重复边ID');

    // 3. 校验节点
    const nodeMap = new Map();
    const validNodes = [];
    nodes.forEach(function (n) {
      const validated = validateNode(n, warnings);
      if (validated) {
        nodeMap.set(validated.id, validated);
        validNodes.push(validated);
      }
    });

    // 4. 校验边（过滤引用不存在节点的边）
    const validEdges = [];
    edges.forEach(function (e) {
      const validated = validateEdge(e, nodeMap, warnings);
      if (validated) validEdges.push(validated);
    });

    // 5. 检测孤立节点
    const isolated = findIsolatedNodes(validNodes, validEdges);
    if (isolated.length > 0) {
      warnings.push('发现 ' + isolated.length + ' 个孤立节点: ' + isolated.map(function (n) { return n.name || n.id; }).join(', '));
    }

    // 6. 检测环形依赖
    const cycles = detectCycles(validNodes, validEdges);
    if (cycles.length > 0) {
      warnings.push('发现 ' + cycles.length + ' 个环形依赖');
    }

    // 7. 处理分组
    const validGroups = processGroups(rawGroups, nodeMap, warnings);

    // 8. 排序告警
    const validAlarms = sortAlarms(rawAlarms, nodeMap, warnings);

    return {
      nodes: validNodes,
      edges: validEdges,
      groups: validGroups,
      alarms: validAlarms,
      warnings: warnings,
      cycles: cycles,
      isolated: isolated
    };
  }

  /* ─── ID去重 ─── */
  function deduplicateById(items) {
    var seen = new Set();
    var result = [];
    var dupeCount = 0;
    items.forEach(function (item) {
      if (!item || !item.id) return;
      var id = String(item.id);
      if (seen.has(id)) {
        dupeCount++;
      } else {
        seen.add(id);
        item.id = id;
        result.push(item);
      }
    });
    return { items: result, dupeCount: dupeCount };
  }

  /* ─── 节点校验 ─── */
  function validateNode(node, warnings) {
    if (!node.id) {
      warnings.push('跳过无ID节点');
      return null;
    }
    var n = {
      id: String(node.id),
      name: node.name || node.id,
      type: VALID_TYPES.has(node.type) ? node.type : 'server',
      group: node.group || null,
      status: VALID_STATUSES.has(node.status) ? node.status : 'normal',
      x: typeof node.x === 'number' ? node.x : null,
      y: typeof node.y === 'number' ? node.y : null,
      details: node.details || {},
      ip: node.ip || '',
      description: node.description || ''
    };
    if (!VALID_TYPES.has(node.type)) {
      warnings.push('节点 ' + n.id + ' 类型 "' + node.type + '" 无效，默认为 server');
    }
    return n;
  }

  /* ─── 边校验 ─── */
  function validateEdge(edge, nodeMap, warnings) {
    if (!edge.source || !edge.target) {
      warnings.push('跳过缺少 source/target 的边');
      return null;
    }
    var src = String(edge.source);
    var tgt = String(edge.target);
    if (!nodeMap.has(src)) {
      warnings.push('边引用不存在的源节点: ' + src);
      return null;
    }
    if (!nodeMap.has(tgt)) {
      warnings.push('边引用不存在的目标节点: ' + tgt);
      return null;
    }
    return {
      id: edge.id ? String(edge.id) : src + '->' + tgt,
      source: src,
      target: tgt,
      linkType: edge.linkType || edge.type || 'dependency',
      status: VALID_STATUSES.has(edge.status) ? edge.status : 'normal',
      label: edge.label || '',
      bandwidth: edge.bandwidth || ''
    };
  }

  /* ─── 孤立节点检测 ─── */
  function findIsolatedNodes(nodes, edges) {
    var connected = new Set();
    edges.forEach(function (e) {
      connected.add(e.source);
      connected.add(e.target);
    });
    return nodes.filter(function (n) { return !connected.has(n.id); });
  }

  /* ─── 环形依赖检测 (Tarjan) ─── */
  function detectCycles(nodes, edges) {
    var adj = {};
    nodes.forEach(function (n) { adj[n.id] = []; });
    edges.forEach(function (e) {
      if (adj[e.source]) adj[e.source].push(e.target);
    });

    var index = 0;
    var stack = [];
    var onStack = {};
    var indices = {};
    var lowlinks = {};
    var cycles = [];

    function strongConnect(v) {
      indices[v] = index;
      lowlinks[v] = index;
      index++;
      stack.push(v);
      onStack[v] = true;

      var neighbors = adj[v] || [];
      for (var i = 0; i < neighbors.length; i++) {
        var w = neighbors[i];
        if (indices[w] === undefined) {
          strongConnect(w);
          lowlinks[v] = Math.min(lowlinks[v], lowlinks[w]);
        } else if (onStack[w]) {
          lowlinks[v] = Math.min(lowlinks[v], indices[w]);
        }
      }

      if (lowlinks[v] === indices[v]) {
        var scc = [];
        var w;
        do {
          w = stack.pop();
          onStack[w] = false;
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          cycles.push(scc);
        }
      }
    }

    nodes.forEach(function (n) {
      if (indices[n.id] === undefined) strongConnect(n.id);
    });
    return cycles;
  }

  /* ─── 分组处理 ─── */
  function processGroups(rawGroups, nodeMap, warnings) {
    var groups = [];
    var groupedNodes = new Set();
    rawGroups.forEach(function (g) {
      if (!g.id) return;
      var grp = {
        id: String(g.id),
        name: g.name || g.id,
        nodeIds: [],
        collapsed: !!g.collapsed
      };
      var ids = Array.isArray(g.nodeIds) ? g.nodeIds : (Array.isArray(g.nodes) ? g.nodes : []);
      ids.forEach(function (nid) {
        var sid = String(nid);
        if (nodeMap.has(sid)) {
          grp.nodeIds.push(sid);
          groupedNodes.add(sid);
          nodeMap.get(sid).group = grp.id;
        }
      });
      if (grp.nodeIds.length > 0) groups.push(grp);
    });

    // 根据节点的 group 字段自动生成分组
    nodeMap.forEach(function (node) {
      if (node.group && !groupedNodes.has(node.id)) {
        var existing = groups.find(function (g) { return g.id === node.group; });
        if (existing) {
          existing.nodeIds.push(node.id);
        } else {
          groups.push({
            id: node.group,
            name: node.group,
            nodeIds: [node.id],
            collapsed: false
          });
        }
        groupedNodes.add(node.id);
      }
    });

    return groups;
  }

  /* ─── 告警排序 ─── */
  function sortAlarms(rawAlarms, nodeMap, warnings) {
    var alarms = [];
    rawAlarms.forEach(function (a, idx) {
      if (!a.timestamp) {
        warnings.push('跳过无时间戳的告警 #' + idx);
        return;
      }
      var ts = new Date(a.timestamp).getTime();
      if (isNaN(ts)) {
        warnings.push('跳过无效时间戳的告警: ' + a.timestamp);
        return;
      }
      alarms.push({
        id: a.id ? String(a.id) : 'alarm-' + idx,
        timestamp: ts,
        timeStr: formatTime(ts),
        nodeId: a.nodeId ? String(a.nodeId) : null,
        level: VALID_ALARM_LEVELS.has(a.level) ? a.level : 'info',
        message: a.message || '未知告警',
        affectedNodes: Array.isArray(a.affectedNodes) ? a.affectedNodes.map(String) : [],
        edgeStates: a.edgeStates || null,
        nodeStates: a.nodeStates || null
      });
    });
    // 按时间排序，解决乱序问题
    alarms.sort(function (a, b) { return a.timestamp - b.timestamp; });
    return alarms;
  }

  /* ─── 影响分析：向上追踪受影响业务 ─── */
  function traceUpstream(nodeId, nodes, edges) {
    var result = [];
    var visited = new Set();
    // 构建反向邻接表（谁依赖了我 = 我是谁的target）
    var reverseAdj = {};
    nodes.forEach(function (n) { reverseAdj[n.id] = []; });
    edges.forEach(function (e) {
      if (reverseAdj[e.target]) reverseAdj[e.target].push(e.source);
    });

    function dfs(nid) {
      if (visited.has(nid)) return;
      visited.add(nid);
      var upstreams = reverseAdj[nid] || [];
      upstreams.forEach(function (uid) {
        result.push(uid);
        dfs(uid);
      });
    }
    dfs(nodeId);
    return result;
  }

  /* ─── 影响分析：向下查看依赖设备 ─── */
  function traceDownstream(nodeId, nodes, edges) {
    var result = [];
    var visited = new Set();
    var adj = {};
    nodes.forEach(function (n) { adj[n.id] = []; });
    edges.forEach(function (e) {
      if (adj[e.source]) adj[e.source].push(e.target);
    });

    function dfs(nid) {
      if (visited.has(nid)) return;
      visited.add(nid);
      var downstreams = adj[nid] || [];
      downstreams.forEach(function (did) {
        result.push(did);
        dfs(did);
      });
    }
    dfs(nodeId);
    return result;
  }

  /* ─── 辅助函数 ─── */
  function formatTime(ts) {
    var d = new Date(ts);
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  /* ─── 公共API ─── */
  return {
    parse: parse,
    findIsolatedNodes: findIsolatedNodes,
    detectCycles: detectCycles,
    traceUpstream: traceUpstream,
    traceDownstream: traceDownstream,
    TYPE_LABELS: TYPE_LABELS,
    VALID_TYPES: VALID_TYPES,
    formatTime: formatTime
  };
})();
