/**
 * layout.js — 自动布局引擎
 * 实现：力导向布局 + 分层约束 + 分组聚类 + 碰撞检测
 */
const LayoutEngine = (() => {
  'use strict';

  // 力导向参数
  const CONFIG = {
    repulsion: 8000,        // 斥力系数
    attraction: 0.005,      // 引力系数
    damping: 0.85,          // 阻尼
    maxVelocity: 50,        // 最大速度
    minDistance: 80,         // 最小间距
    layerSpacing: 180,      // 层间距
    groupPadding: 40,       // 分组内边距
    groupAttraction: 0.02,  // 分组内聚力
    centerGravity: 0.01,   // 中心引力
    iterations: 300,        // 最大迭代次数
    convergenceThreshold: 0.5,
  };

  /**
   * 执行自动布局
   * @param {Array} nodes - 节点数组
   * @param {Array} links - 连线数组
   * @param {Array} groups - 分组数组
   * @param {Object} bounds - 画布范围 {width, height}
   * @param {Function} onProgress - 进度回调
   */
  async function layout(nodes, links, groups, bounds, onProgress) {
    const visibleNodes = nodes.filter(n => n._visible !== false);
    if (visibleNodes.length === 0) return;

    // 初始化位置
    initializePositions(visibleNodes, groups, bounds);

    // 构建邻接表
    const adj = buildAdjacency(links);

    // 力导向迭代
    for (let iter = 0; iter < CONFIG.iterations; iter++) {
      const temperature = 1 - iter / CONFIG.iterations;
      const energy = applyForces(visibleNodes, links, groups, adj, temperature, bounds);

      if (energy < CONFIG.convergenceThreshold) break;

      if (onProgress && iter % 20 === 0) {
        onProgress(iter / CONFIG.iterations);
        await sleep(0); // 让出主线程
      }
    }

    // 最终调整：居中、避免超出边界
    finalizePositions(visibleNodes, bounds);
  }

  /**
   * 初始化节点位置（基于分层+分组）
   */
  function initializePositions(nodes, groups, bounds) {
    const cx = bounds.width / 2;
    const cy = bounds.height / 2;

    // 按层分组
    const layers = {};
    for (const node of nodes) {
      const layer = DataParser.NODE_TYPES[node.type]?.layer || 2;
      if (!layers[layer]) layers[layer] = [];
      layers[layer].push(node);
    }

    const layerKeys = Object.keys(layers).sort((a, b) => a - b);
    const totalLayers = layerKeys.length;
    const vSpacing = Math.min(CONFIG.layerSpacing, bounds.height / (totalLayers + 1));

    for (let li = 0; li < layerKeys.length; li++) {
      const layerNodes = layers[layerKeys[li]];
      const y = cy - (totalLayers - 1) * vSpacing / 2 + li * vSpacing;
      const hSpacing = Math.min(120, bounds.width / (layerNodes.length + 1));

      for (let ni = 0; ni < layerNodes.length; ni++) {
        const node = layerNodes[ni];
        if (node.x == null || node.y == null) {
          node.x = cx - (layerNodes.length - 1) * hSpacing / 2 + ni * hSpacing;
          node.y = y;
          // 加点随机扰动避免完全对齐
          node.x += (Math.random() - 0.5) * 30;
          node.y += (Math.random() - 0.5) * 20;
        }
        node._vx = 0;
        node._vy = 0;
      }
    }
  }

  /**
   * 构建邻接表
   */
  function buildAdjacency(links) {
    const adj = {};
    for (const link of links) {
      if (!adj[link.source]) adj[link.source] = [];
      if (!adj[link.target]) adj[link.target] = [];
      adj[link.source].push(link.target);
      adj[link.target].push(link.source);
    }
    return adj;
  }

  /**
   * 施加力学约束
   */
  function applyForces(nodes, links, groups, adj, temperature, bounds) {
    const cx = bounds.width / 2;
    const cy = bounds.height / 2;
    let totalEnergy = 0;

    // 重置力
    for (const n of nodes) {
      if (n.pinned) continue;
      n._fx = 0;
      n._fy = 0;
    }

    // 1. 节点间斥力 (Coulomb)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) { dist = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }

        const force = CONFIG.repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (!a.pinned) { a._fx -= fx; a._fy -= fy; }
        if (!b.pinned) { b._fx += fx; b._fy += fy; }
      }
    }

    // 2. 连线引力 (Hooke)
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    for (const link of links) {
      const a = nodeMap.get(link.source);
      const b = nodeMap.get(link.target);
      if (!a || !b) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;

      const idealDist = CONFIG.minDistance * 2;
      const force = CONFIG.attraction * (dist - idealDist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!a.pinned) { a._fx += fx; a._fy += fy; }
      if (!b.pinned) { b._fx -= fx; b._fy -= fy; }
    }

    // 3. 分层约束力
    const layerKeys = [...new Set(nodes.map(n => DataParser.NODE_TYPES[n.type]?.layer || 2))].sort((a, b) => a - b);
    const totalLayers = layerKeys.length;
    const vSpacing = Math.min(CONFIG.layerSpacing, bounds.height / (totalLayers + 1));

    for (const node of nodes) {
      if (node.pinned) continue;
      const layer = DataParser.NODE_TYPES[node.type]?.layer || 2;
      const li = layerKeys.indexOf(layer);
      const targetY = cy - (totalLayers - 1) * vSpacing / 2 + li * vSpacing;
      node._fy += (targetY - node.y) * 0.05;
    }

    // 4. 分组内聚力
    for (const group of groups) {
      if (group.collapsed) continue;
      const members = group.children.map(id => nodeMap.get(id)).filter(Boolean);
      if (members.length < 2) continue;

      const gcx = members.reduce((s, n) => s + n.x, 0) / members.length;
      const gcy = members.reduce((s, n) => s + n.y, 0) / members.length;

      for (const m of members) {
        if (m.pinned) continue;
        m._fx += (gcx - m.x) * CONFIG.groupAttraction;
        m._fy += (gcy - m.y) * CONFIG.groupAttraction;
      }
    }

    // 5. 中心引力
    for (const node of nodes) {
      if (node.pinned) continue;
      node._fx += (cx - node.x) * CONFIG.centerGravity;
      node._fy += (cy - node.y) * CONFIG.centerGravity;
    }

    // 应用力
    for (const node of nodes) {
      if (node.pinned) continue;

      node._vx = (node._vx + node._fx) * CONFIG.damping * temperature;
      node._vy = (node._vy + node._fy) * CONFIG.damping * temperature;

      // 限速
      const speed = Math.sqrt(node._vx * node._vx + node._vy * node._vy);
      if (speed > CONFIG.maxVelocity) {
        node._vx = (node._vx / speed) * CONFIG.maxVelocity;
        node._vy = (node._vy / speed) * CONFIG.maxVelocity;
      }

      node.x += node._vx;
      node.y += node._vy;

      totalEnergy += speed;
    }

    return totalEnergy;
  }

  /**
   * 最终位置调整
   */
  function finalizePositions(nodes, bounds) {
    if (nodes.length === 0) return;

    // 计算包围盒
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }

    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const padding = 80;
    const scaleX = (bounds.width - padding * 2) / w;
    const scaleY = (bounds.height - padding * 2) / h;
    const scale = Math.min(scaleX, scaleY, 1.5);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    for (const n of nodes) {
      n.x = (n.x - cx) * scale + bounds.width / 2;
      n.y = (n.y - cy) * scale + bounds.height / 2;
    }
  }

  /**
   * 计算分组包围盒
   */
  function computeGroupBounds(groups, nodeMap) {
    for (const group of groups) {
      const members = group.children.map(id => nodeMap.get(id)).filter(n => n && n._visible !== false);
      if (members.length === 0) {
        group._bounds = null;
        continue;
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        minX = Math.min(minX, m.x - 30);
        minY = Math.min(minY, m.y - 30);
        maxX = Math.max(maxX, m.x + 30);
        maxY = Math.max(maxY, m.y + 30);
      }

      group._bounds = {
        x: minX - CONFIG.groupPadding,
        y: minY - CONFIG.groupPadding,
        width: maxX - minX + CONFIG.groupPadding * 2,
        height: maxY - minY + CONFIG.groupPadding * 2,
      };
    }
  }

  /**
   * 碰撞检测与修正
   */
  function resolveCollisions(nodes) {
    const minDist = CONFIG.minDistance;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist && dist > 0) {
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          if (!a.pinned) { a.x -= nx * overlap; a.y -= ny * overlap; }
          if (!b.pinned) { b.x += nx * overlap; b.y += ny * overlap; }
        }
      }
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    layout,
    computeGroupBounds,
    resolveCollisions,
    CONFIG,
  };
})();
