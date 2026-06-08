/**
 * layout-engine.js — 布局计算模块
 * 实现分层自动布局（按节点类型分层），支持分组布局、力导向微调
 */
window.LayoutEngine = (function () {
  'use strict';

  /* ─── 类型层级映射（从上到下） ─── */
  var TYPE_LAYERS = {
    app: 0,
    gateway: 1,
    server: 2,
    database: 2,
    switch: 3,
    datacenter: 4
  };

  /* ─── 布局参数 ─── */
  var DEFAULTS = {
    layerGap: 160,      // 层间距
    nodeGap: 120,        // 同层节点间距
    groupPadding: 40,    // 分组内边距
    nodeWidth: 100,
    nodeHeight: 60,
    marginX: 80,
    marginY: 80
  };

  /**
   * 自动布局主入口
   * @param {Array} nodes
   * @param {Array} edges
   * @param {Array} groups
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @returns {Object} positions { nodeId: { x, y } }
   */
  function autoLayout(nodes, edges, groups, canvasWidth, canvasHeight) {
    if (nodes.length === 0) return {};

    // 1. 分层
    var layers = assignLayers(nodes);

    // 2. 层内排序（减少交叉）
    layers = orderWithinLayers(layers, edges);

    // 3. 计算坐标
    var positions = computePositions(layers, canvasWidth, canvasHeight);

    // 4. 分组内聚
    positions = adjustForGroups(positions, groups, nodes);

    // 5. 力导向微调（轻量，限次数以保持性能）
    positions = forceAdjust(positions, edges, nodes, 30);

    return positions;
  }

  /* ─── Step 1: 按类型分层 ─── */
  function assignLayers(nodes) {
    var layerMap = {};
    nodes.forEach(function (n) {
      var layer = TYPE_LAYERS[n.type] !== undefined ? TYPE_LAYERS[n.type] : 2;
      if (!layerMap[layer]) layerMap[layer] = [];
      layerMap[layer].push(n);
    });

    // 转为有序数组
    var keys = Object.keys(layerMap).map(Number).sort(function (a, b) { return a - b; });
    return keys.map(function (k) { return layerMap[k]; });
  }

  /* ─── Step 2: 层内排序以减少边交叉 ─── */
  function orderWithinLayers(layers, edges) {
    // 构建邻接关系
    var adj = {};
    edges.forEach(function (e) {
      if (!adj[e.source]) adj[e.source] = [];
      if (!adj[e.target]) adj[e.target] = [];
      adj[e.source].push(e.target);
      adj[e.target].push(e.source);
    });

    // 对每层进行重心排序（barycenter）
    for (var i = 1; i < layers.length; i++) {
      var prevLayer = layers[i - 1];
      var prevPositions = {};
      prevLayer.forEach(function (n, idx) { prevPositions[n.id] = idx; });

      layers[i].forEach(function (n) {
        var neighbors = adj[n.id] || [];
        var sum = 0;
        var count = 0;
        neighbors.forEach(function (nid) {
          if (prevPositions[nid] !== undefined) {
            sum += prevPositions[nid];
            count++;
          }
        });
        n._barycenter = count > 0 ? sum / count : Infinity;
      });

      layers[i].sort(function (a, b) {
        if (a._barycenter === b._barycenter) return 0;
        return a._barycenter - b._barycenter;
      });
    }

    // 反向再排一遍
    for (var i = layers.length - 2; i >= 0; i--) {
      var nextLayer = layers[i + 1];
      var nextPositions = {};
      nextLayer.forEach(function (n, idx) { nextPositions[n.id] = idx; });

      layers[i].forEach(function (n) {
        var neighbors = adj[n.id] || [];
        var sum = 0;
        var count = 0;
        neighbors.forEach(function (nid) {
          if (nextPositions[nid] !== undefined) {
            sum += nextPositions[nid];
            count++;
          }
        });
        n._barycenter = count > 0 ? sum / count : Infinity;
      });

      layers[i].sort(function (a, b) {
        if (a._barycenter === b._barycenter) return 0;
        return a._barycenter - b._barycenter;
      });
    }

    return layers;
  }

  /* ─── Step 3: 计算坐标 ─── */
  function computePositions(layers, canvasWidth, canvasHeight) {
    var positions = {};
    var maxNodesInLayer = 0;
    layers.forEach(function (layer) {
      if (layer.length > maxNodesInLayer) maxNodesInLayer = layer.length;
    });

    var totalHeight = (layers.length - 1) * DEFAULTS.layerGap + DEFAULTS.nodeHeight;
    var startY = Math.max(DEFAULTS.marginY, (canvasHeight - totalHeight) / 2);

    layers.forEach(function (layer, layerIdx) {
      var totalWidth = (layer.length - 1) * DEFAULTS.nodeGap + DEFAULTS.nodeWidth;
      var startX = Math.max(DEFAULTS.marginX, (canvasWidth - totalWidth) / 2);

      layer.forEach(function (node, nodeIdx) {
        positions[node.id] = {
          x: startX + nodeIdx * DEFAULTS.nodeGap,
          y: startY + layerIdx * DEFAULTS.layerGap
        };
      });
    });

    return positions;
  }

  /* ─── Step 4: 分组内聚调整 ─── */
  function adjustForGroups(positions, groups, nodes) {
    if (!groups || groups.length === 0) return positions;

    groups.forEach(function (group) {
      if (group.nodeIds.length < 2) return;

      // 计算分组质心
      var sumX = 0, sumY = 0, count = 0;
      group.nodeIds.forEach(function (nid) {
        if (positions[nid]) {
          sumX += positions[nid].x;
          sumY += positions[nid].y;
          count++;
        }
      });
      if (count === 0) return;

      var cx = sumX / count;
      var cy = sumY / count;

      // 将组内节点向质心靠拢（乘以收缩因子）
      var shrink = 0.7;
      group.nodeIds.forEach(function (nid) {
        if (positions[nid]) {
          positions[nid].x = cx + (positions[nid].x - cx) * shrink;
          positions[nid].y = cy + (positions[nid].y - cy) * shrink;
        }
      });
    });

    return positions;
  }

  /* ─── Step 5: 力导向微调 ─── */
  function forceAdjust(positions, edges, nodes, iterations) {
    var nodeIds = Object.keys(positions);
    if (nodeIds.length < 2) return positions;

    var repulsionForce = 5000;
    var attractionForce = 0.005;
    var damping = 0.9;

    // 初始化速度
    var vel = {};
    nodeIds.forEach(function (id) { vel[id] = { vx: 0, vy: 0 }; });

    for (var iter = 0; iter < iterations; iter++) {
      // 斥力（节点间）— 仅计算近距离的以优化性能
      for (var i = 0; i < nodeIds.length; i++) {
        for (var j = i + 1; j < nodeIds.length; j++) {
          var a = nodeIds[i];
          var b = nodeIds[j];
          var dx = positions[a].x - positions[b].x;
          var dy = positions[a].y - positions[b].y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist > 500) continue; // 远距离忽略

          var force = repulsionForce / (dist * dist);
          var fx = (dx / dist) * force;
          var fy = (dy / dist) * force;
          vel[a].vx += fx;
          vel[a].vy += fy;
          vel[b].vx -= fx;
          vel[b].vy -= fy;
        }
      }

      // 引力（沿边）
      edges.forEach(function (e) {
        if (!positions[e.source] || !positions[e.target]) return;
        var dx = positions[e.target].x - positions[e.source].x;
        var dy = positions[e.target].y - positions[e.source].y;
        var fx = dx * attractionForce;
        var fy = dy * attractionForce;
        vel[e.source].vx += fx;
        vel[e.source].vy += fy * 0.2; // 弱化Y方向引力以保持分层
        vel[e.target].vx -= fx;
        vel[e.target].vy -= fy * 0.2;
      });

      // 应用力
      nodeIds.forEach(function (id) {
        positions[id].x += vel[id].vx;
        positions[id].y += vel[id].vy;
        vel[id].vx *= damping;
        vel[id].vy *= damping;
      });
    }

    return positions;
  }

  /**
   * 获取所有节点的包围盒
   */
  function getBounds(positions) {
    var ids = Object.keys(positions);
    if (ids.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      var p = positions[id];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + DEFAULTS.nodeWidth > maxX) maxX = p.x + DEFAULTS.nodeWidth;
      if (p.y + DEFAULTS.nodeHeight > maxY) maxY = p.y + DEFAULTS.nodeHeight;
    });

    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
  }

  /* ─── 公共API ─── */
  return {
    autoLayout: autoLayout,
    getBounds: getBounds,
    TYPE_LAYERS: TYPE_LAYERS,
    DEFAULTS: DEFAULTS
  };
})();
