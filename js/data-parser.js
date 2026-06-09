/**
 * data-parser.js — 数据解析、校验、标准化
 * 负责：导入JSON解析、重复ID检测、孤儿节点检测、环形依赖检测、告警时间排序
 */
const DataParser = (() => {
  'use strict';

  // 节点类型定义及图标映射
  const NODE_TYPES = {
    datacenter: { label: '机房', icon: '🏢', color: '#4a9eff', layer: 0 },
    switch:     { label: '交换机', icon: '🔀', color: '#4aff8a', layer: 1 },
    server:     { label: '服务器', icon: '🖥️', color: '#aa6aff', layer: 2 },
    database:   { label: '数据库', icon: '🗄️', color: '#ffaa4a', layer: 2 },
    gateway:    { label: '网关', icon: '🌐', color: '#4affee', layer: 1 },
    app:        { label: '业务应用', icon: '📱', color: '#ff6ab0', layer: 3 },
  };

  const STATUS_TYPES = {
    normal:   { label: '正常', color: '#4aff8a' },
    warning:  { label: '告警', color: '#ffaa4a' },
    critical: { label: '严重', color: '#ff4a6a' },
    offline:  { label: '离线', color: '#5a6a7a' },
  };

  /**
   * 解析并校验导入的拓扑数据
   * @param {Object} rawData - 原始JSON数据
   * @returns {{ data: Object|null, messages: Array<{level:string, text:string}> }}
   */
  function parse(rawData) {
    const messages = [];
    if (!rawData || typeof rawData !== 'object') {
      messages.push({ level: 'error', text: '数据格式无效，需要JSON对象' });
      return { data: null, messages };
    }

    const nodes = Array.isArray(rawData.nodes) ? rawData.nodes : [];
    const links = Array.isArray(rawData.links) ? rawData.links : [];
    const alerts = Array.isArray(rawData.alerts) ? rawData.alerts : [];
    const groups = Array.isArray(rawData.groups) ? rawData.groups : [];

    if (nodes.length === 0) {
      messages.push({ level: 'error', text: '未找到任何节点数据' });
      return { data: null, messages };
    }

    // 1. 标准化节点
    const nodeMap = new Map();
    const idCount = {};
    const parsedNodes = [];

    for (const raw of nodes) {
      if (!raw.id) {
        messages.push({ level: 'warn', text: `存在无ID节点，已跳过: ${JSON.stringify(raw).slice(0, 60)}` });
        continue;
      }

      // 重复ID检测
      const id = String(raw.id);
      if (idCount[id]) {
        idCount[id]++;
        messages.push({ level: 'warn', text: `重复ID "${id}" 出现 ${idCount[id]} 次，保留首个` });
        continue;
      }
      idCount[id] = 1;

      const type = NODE_TYPES[raw.type] ? raw.type : 'server';
      if (!NODE_TYPES[raw.type]) {
        messages.push({ level: 'info', text: `节点 "${id}" 类型 "${raw.type}" 无效，默认为 server` });
      }

      const node = {
        id,
        type,
        label: raw.label || raw.name || id,
        group: raw.group || null,
        status: STATUS_TYPES[raw.status] ? raw.status : 'normal',
        x: typeof raw.x === 'number' ? raw.x : null,
        y: typeof raw.y === 'number' ? raw.y : null,
        pinned: !!raw.pinned,
        metadata: raw.metadata || {},
        // 运行时属性
        _vx: 0, _vy: 0,
        _selected: false,
        _highlighted: false,
        _visible: true,
        _fx: null, _fy: null,
      };

      parsedNodes.push(node);
      nodeMap.set(id, node);
    }

    // 2. 标准化连线
    const parsedLinks = [];
    const linkSet = new Set();

    for (const raw of links) {
      const src = String(raw.source || raw.from || '');
      const tgt = String(raw.target || raw.to || '');

      if (!src || !tgt) {
        messages.push({ level: 'warn', text: `存在无效连线 (缺少source/target)，已跳过` });
        continue;
      }

      if (!nodeMap.has(src)) {
        messages.push({ level: 'warn', text: `连线源节点 "${src}" 不存在，已跳过` });
        continue;
      }
      if (!nodeMap.has(tgt)) {
        messages.push({ level: 'warn', text: `连线目标节点 "${tgt}" 不存在，已跳过` });
        continue;
      }

      const linkKey = `${src}->${tgt}`;
      const reverseKey = `${tgt}->${src}`;
      if (linkSet.has(linkKey) || linkSet.has(reverseKey)) {
        messages.push({ level: 'info', text: `重复连线 ${src} → ${tgt}，已跳过` });
        continue;
      }
      linkSet.add(linkKey);

      parsedLinks.push({
        id: raw.id || `${src}_${tgt}`,
        source: src,
        target: tgt,
        status: STATUS_TYPES[raw.status] ? raw.status : 'normal',
        label: raw.label || '',
        metadata: raw.metadata || {},
        _highlighted: false,
        _visible: true,
      });
    }

    // 3. 环形依赖检测
    const cycles = detectCycles(parsedNodes, parsedLinks);
    if (cycles.length > 0) {
      for (const cycle of cycles) {
        messages.push({ level: 'warn', text: `检测到环形依赖: ${cycle.join(' → ')} → ${cycle[0]}` });
      }
    }

    // 4. 孤儿节点检测
    const connectedIds = new Set();
    for (const link of parsedLinks) {
      connectedIds.add(link.source);
      connectedIds.add(link.target);
    }
    const orphans = parsedNodes.filter(n => !connectedIds.has(n.id) && parsedNodes.length > 1);
    if (orphans.length > 0) {
      messages.push({ level: 'info', text: `检测到 ${orphans.length} 个孤立节点: ${orphans.map(n => n.id).slice(0, 5).join(', ')}${orphans.length > 5 ? '...' : ''}` });
    }

    // 5. 标准化分组
    const parsedGroups = [];
    for (const raw of groups) {
      if (!raw.id) continue;
      const children = (raw.children || []).filter(cid => nodeMap.has(String(cid)));
      parsedGroups.push({
        id: String(raw.id),
        label: raw.label || raw.name || raw.id,
        children: children.map(String),
        collapsed: !!raw.collapsed,
        _bounds: null,
      });
    }

    // 自动按 group 字段生成分组
    const autoGroups = {};
    for (const node of parsedNodes) {
      if (node.group) {
        if (!autoGroups[node.group]) autoGroups[node.group] = [];
        autoGroups[node.group].push(node.id);
      }
    }
    for (const [gid, children] of Object.entries(autoGroups)) {
      if (!parsedGroups.find(g => g.id === gid)) {
        parsedGroups.push({
          id: gid,
          label: gid,
          children,
          collapsed: false,
          _bounds: null,
        });
      }
    }

    // 6. 告警排序
    const parsedAlerts = alerts
      .filter(a => a && a.timestamp != null)
      .map((a, i) => ({
        id: a.id || `alert_${i}`,
        timestamp: new Date(a.timestamp).getTime() || Date.now(),
        nodeId: a.nodeId ? String(a.nodeId) : null,
        linkId: a.linkId || null,
        type: a.type || 'fault',
        severity: a.severity || 'warning',
        message: a.message || '未知告警',
        affectedNodes: (a.affectedNodes || []).map(String),
        _raw: a,
      }))
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

    if (alerts.length > 0 && parsedAlerts.length !== alerts.length) {
      messages.push({ level: 'warn', text: `${alerts.length - parsedAlerts.length} 条告警因缺少时间戳被过滤` });
    }

    // 7. 告警去重与引用校验
    const alertIdSet = new Set();
    for (const a of parsedAlerts) {
      if (alertIdSet.has(a.id)) {
        a.id = a.id + '_' + alertIdSet.size;
        messages.push({ level: 'warn', text: `告警ID重复，已重命名为 "${a.id}"` });
      }
      alertIdSet.add(a.id);

      if (a.nodeId && !nodeMap.has(a.nodeId)) {
        messages.push({ level: 'warn', text: `告警引用不存在的节点 "${a.nodeId}"，已忽略该引用` });
        a.nodeId = null;
      }
      if (a.linkId) {
        const linkExists = parsedLinks.some(l => l.id === a.linkId);
        if (!linkExists) {
          messages.push({ level: 'warn', text: `告警引用不存在的连线 "${a.linkId}"，已忽略该引用` });
          a.linkId = null;
        }
      }
      // 清理受影响节点中不存在的
      a.affectedNodes = a.affectedNodes.filter(id => {
        if (!nodeMap.has(id)) {
          messages.push({ level: 'info', text: `告警受影响节点 "${id}" 不存在，已移除` });
          return false;
        }
        return true;
      });
    }

    messages.push({ level: 'info', text: `解析完成: ${parsedNodes.length} 节点, ${parsedLinks.length} 连线, ${parsedGroups.length} 分组, ${parsedAlerts.length} 告警` });

    // 8. 计算拓扑签名（用于布局缓存校验）
    const signature = computeTopologySignature(parsedNodes, parsedLinks);

    return {
      data: {
        nodes: parsedNodes,
        links: parsedLinks,
        groups: parsedGroups,
        alerts: parsedAlerts,
        nodeMap,
        cycles,
        orphans: orphans.map(n => n.id),
        signature,
      },
      messages,
    };
  }

  /**
   * 计算拓扑签名 — 基于节点ID和连线结构的哈希
   * 同一拓扑结构（相同节点+连线）产生相同签名
   */
  function computeTopologySignature(nodes, links) {
    const nodeIds = nodes.map(n => n.id).sort().join(',');
    const linkKeys = links.map(l => `${l.source}->${l.target}`).sort().join(',');
    const raw = `N:${nodeIds}|L:${linkKeys}`;
    // 简单哈希
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const chr = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return 'topo_' + Math.abs(hash).toString(36);
  }

  /**
   * 环形依赖检测 (DFS)
   */
  function detectCycles(nodes, links) {
    const adj = {};
    for (const n of nodes) adj[n.id] = [];
    for (const l of links) {
      if (adj[l.source]) adj[l.source].push(l.target);
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = {};
    const parent = {};
    const cycles = [];

    for (const n of nodes) {
      color[n.id] = WHITE;
      parent[n.id] = null;
    }

    function dfs(u, path) {
      color[u] = GRAY;
      path.push(u);
      for (const v of (adj[u] || [])) {
        if (color[v] === GRAY) {
          // 找到环
          const cycleStart = path.indexOf(v);
          if (cycleStart >= 0) {
            cycles.push(path.slice(cycleStart));
          }
        } else if (color[v] === WHITE) {
          dfs(v, path);
        }
      }
      path.pop();
      color[u] = BLACK;
    }

    for (const n of nodes) {
      if (color[n.id] === WHITE) {
        dfs(n.id, []);
      }
    }

    return cycles;
  }

  /**
   * 获取上游受影响节点 (BFS反向追踪)
   */
  function traceUpstream(nodeId, links, nodeMap) {
    // 构建反向邻接表: target -> [sources]
    const reverseAdj = {};
    for (const l of links) {
      if (!reverseAdj[l.target]) reverseAdj[l.target] = [];
      reverseAdj[l.target].push(l.source);
    }

    const visited = new Set();
    const queue = [nodeId];
    visited.add(nodeId);
    const result = [];

    while (queue.length > 0) {
      const current = queue.shift();
      for (const upstream of (reverseAdj[current] || [])) {
        if (!visited.has(upstream)) {
          visited.add(upstream);
          result.push(upstream);
          queue.push(upstream);
        }
      }
    }

    return result.map(id => nodeMap.get(id)).filter(Boolean);
  }

  /**
   * 获取下游依赖节点 (BFS正向追踪)
   */
  function traceDownstream(nodeId, links, nodeMap) {
    const adj = {};
    for (const l of links) {
      if (!adj[l.source]) adj[l.source] = [];
      adj[l.source].push(l.target);
    }

    const visited = new Set();
    const queue = [nodeId];
    visited.add(nodeId);
    const result = [];

    while (queue.length > 0) {
      const current = queue.shift();
      for (const downstream of (adj[current] || [])) {
        if (!visited.has(downstream)) {
          visited.add(downstream);
          result.push(downstream);
          queue.push(downstream);
        }
      }
    }

    return result.map(id => nodeMap.get(id)).filter(Boolean);
  }

  /**
   * 获取指定类型的所有上游/下游路径
   */
  function tracePathToType(startId, targetType, links, nodeMap, direction = 'upstream') {
    const adj = {};
    if (direction === 'upstream') {
      for (const l of links) {
        if (!adj[l.target]) adj[l.target] = [];
        adj[l.target].push(l.source);
      }
    } else {
      for (const l of links) {
        if (!adj[l.source]) adj[l.source] = [];
        adj[l.source].push(l.target);
      }
    }

    const visited = new Set();
    const queue = [{ id: startId, path: [startId] }];
    visited.add(startId);
    const paths = [];

    while (queue.length > 0) {
      const { id, path } = queue.shift();
      const node = nodeMap.get(id);
      if (node && node.type === targetType && id !== startId) {
        paths.push(path);
        continue;
      }
      for (const next of (adj[id] || [])) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ id: next, path: [...path, next] });
        }
      }
    }

    return paths;
  }

  return {
    NODE_TYPES,
    STATUS_TYPES,
    parse,
    detectCycles,
    traceUpstream,
    traceDownstream,
    tracePathToType,
    computeTopologySignature,
  };
})();
