/**
 * renderer.js — Canvas 渲染模块
 * 负责拓扑图的绘制：节点、连线、分组背景、选中/高亮、告警状态、小地图
 * 使用视口裁剪优化超大拓扑性能
 */
window.Renderer = (function () {
  'use strict';

  /* ─── 节点类型视觉配置 ─── */
  var NODE_STYLES = {
    datacenter: { color: '#5c6bc0', shape: 'rect', icon: 'DC' },
    switch:     { color: '#26a69a', shape: 'diamond', icon: 'SW' },
    server:     { color: '#42a5f5', shape: 'rect', icon: 'SRV' },
    database:   { color: '#ab47bc', shape: 'cylinder', icon: 'DB' },
    gateway:    { color: '#ffa726', shape: 'hexagon', icon: 'GW' },
    app:        { color: '#66bb6a', shape: 'roundRect', icon: 'APP' }
  };

  var STATUS_COLORS = {
    normal: '#4caf50',
    warning: '#ff9800',
    critical: '#f44336',
    offline: '#9e9e9e'
  };

  var EDGE_STATUS_STYLES = {
    normal:   { color: '#556677', width: 1.5, dash: [] },
    warning:  { color: '#ff9800', width: 2, dash: [6, 3] },
    critical: { color: '#f44336', width: 2.5, dash: [] },
    offline:  { color: '#555555', width: 1, dash: [4, 4] }
  };

  var NODE_W = 100, NODE_H = 60;
  var LABEL_OFFSET = 14;

  /* ─── 状态 ─── */
  var canvas, ctx;
  var minimapCanvas, minimapCtx;
  var viewport = { x: 0, y: 0, scale: 1 };
  var appState = null;
  var highlightedNodes = new Set();
  var highlightedEdges = new Set();
  var highlightPath = { nodes: new Set(), edges: new Set() };
  var hoveredNode = null;
  var animFrame = null;
  var needsRender = true;

  /* ─── 初始化 ─── */
  function init(canvasEl, state) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    appState = state;

    minimapCanvas = document.getElementById('minimap-canvas');
    minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    startRenderLoop();
  }

  function resizeCanvas() {
    var container = canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
    canvas.style.width = container.clientWidth + 'px';
    canvas.style.height = container.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsRender = true;
  }

  /* ─── 渲染循环 ─── */
  function startRenderLoop() {
    function loop() {
      if (needsRender) {
        render();
        renderMinimap();
        needsRender = false;
      }
      animFrame = requestAnimationFrame(loop);
    }
    loop();
  }

  function requestRender() {
    needsRender = true;
  }

  /* ─── 主渲染 ─── */
  function render() {
    if (!appState) return;
    var w = canvas.width / (window.devicePixelRatio || 1);
    var h = canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // 应用视口变换
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.scale, viewport.scale);

    // 计算可视范围（世界坐标）
    var visibleRect = getVisibleRect(w, h);

    // 1. 绘制分组背景
    drawGroups(visibleRect);

    // 2. 绘制环形依赖标记
    drawCycleMarkers();

    // 3. 绘制边
    drawEdges(visibleRect);

    // 4. 绘制节点
    drawNodes(visibleRect);

    // 5. 绘制框选矩形
    if (appState.selectRect) {
      drawSelectRect(appState.selectRect);
    }

    ctx.restore();
  }

  /* ─── 可视范围计算 ─── */
  function getVisibleRect(w, h) {
    var margin = 200; // 额外边距防止节点闪烁
    return {
      x: (-viewport.x / viewport.scale) - margin,
      y: (-viewport.y / viewport.scale) - margin,
      w: (w / viewport.scale) + margin * 2,
      h: (h / viewport.scale) + margin * 2
    };
  }

  function isInView(x, y, w, h, vr) {
    return x + w > vr.x && x < vr.x + vr.w && y + h > vr.y && y < vr.y + vr.h;
  }

  /* ─── 绘制分组 ─── */
  function drawGroups(vr) {
    if (!appState.groups) return;
    appState.groups.forEach(function (group) {
      if (group.collapsed) return;
      var bounds = getGroupBounds(group);
      if (!bounds) return;
      if (!isInView(bounds.x, bounds.y, bounds.w, bounds.h, vr)) return;

      var pad = 30;
      ctx.fillStyle = 'rgba(79, 156, 247, 0.05)';
      ctx.strokeStyle = 'rgba(79, 156, 247, 0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);

      roundRect(ctx, bounds.x - pad, bounds.y - pad - 20, bounds.w + pad * 2, bounds.h + pad * 2 + 20, 8);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);

      // 分组名称
      ctx.fillStyle = 'rgba(79, 156, 247, 0.6)';
      ctx.font = '11px sans-serif';
      ctx.fillText(group.name, bounds.x - pad + 8, bounds.y - pad - 6);
    });
  }

  function getGroupBounds(group) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var count = 0;
    group.nodeIds.forEach(function (nid) {
      var node = appState.nodeMap.get(nid);
      if (!node) return;
      count++;
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x + NODE_W > maxX) maxX = node.x + NODE_W;
      if (node.y + NODE_H > maxY) maxY = node.y + NODE_H;
    });
    if (count === 0) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /* ─── 绘制环形依赖 ─── */
  function drawCycleMarkers() {
    if (!appState.cycles || appState.cycles.length === 0) return;
    appState.cycles.forEach(function (cycle) {
      cycle.forEach(function (nid) {
        var node = appState.nodeMap.get(nid);
        if (!node) return;
        ctx.save();
        ctx.strokeStyle = '#ff5252';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(node.x + NODE_W / 2, node.y + NODE_H / 2, Math.max(NODE_W, NODE_H) / 2 + 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      });
    });
  }

  /* ─── 绘制边 ─── */
  function drawEdges(vr) {
    if (!appState.edges) return;
    appState.edges.forEach(function (edge) {
      var srcNode = appState.nodeMap.get(edge.source);
      var tgtNode = appState.nodeMap.get(edge.target);
      if (!srcNode || !tgtNode) return;

      // 跳过折叠分组中隐藏的节点
      if (isNodeCollapsed(srcNode) || isNodeCollapsed(tgtNode)) return;

      // 视口裁剪
      var x1 = srcNode.x + NODE_W / 2;
      var y1 = srcNode.y + NODE_H / 2;
      var x2 = tgtNode.x + NODE_W / 2;
      var y2 = tgtNode.y + NODE_H / 2;

      var minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      var minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      if (!isInView(minX, minY, maxX - minX, maxY - minY, vr)) return;

      var style = EDGE_STATUS_STYLES[edge.status] || EDGE_STATUS_STYLES.normal;
      var isHighlighted = highlightPath.edges.has(edge.id) || highlightedEdges.has(edge.id);

      ctx.save();
      ctx.strokeStyle = isHighlighted ? '#4fc3f7' : style.color;
      ctx.lineWidth = isHighlighted ? style.width + 1 : style.width;
      ctx.setLineDash(style.dash);

      if (isHighlighted) {
        ctx.shadowColor = '#4fc3f7';
        ctx.shadowBlur = 6;
      }

      // 计算从节点边缘出发的连接点
      var pts = getEdgeEndpoints(srcNode, tgtNode);

      // 绘制曲线
      ctx.beginPath();
      ctx.moveTo(pts.x1, pts.y1);
      if (Math.abs(pts.y2 - pts.y1) > 20) {
        var midY = (pts.y1 + pts.y2) / 2;
        ctx.bezierCurveTo(pts.x1, midY, pts.x2, midY, pts.x2, pts.y2);
      } else {
        ctx.lineTo(pts.x2, pts.y2);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // 绘制箭头
      drawArrow(ctx, pts.x1, pts.y1, pts.x2, pts.y2, isHighlighted ? '#4fc3f7' : style.color);

      // 边标签
      if (edge.label && viewport.scale > 0.5) {
        var mx = (pts.x1 + pts.x2) / 2;
        var my = (pts.y1 + pts.y2) / 2;
        ctx.fillStyle = '#8899aa';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(edge.label, mx, my - 4);
      }

      ctx.restore();
    });
  }

  function getEdgeEndpoints(src, tgt) {
    var sx = src.x + NODE_W / 2, sy = src.y + NODE_H / 2;
    var tx = tgt.x + NODE_W / 2, ty = tgt.y + NODE_H / 2;
    var angle = Math.atan2(ty - sy, tx - sx);

    return {
      x1: sx + Math.cos(angle) * NODE_W / 2,
      y1: sy + Math.sin(angle) * NODE_H / 2.5,
      x2: tx - Math.cos(angle) * NODE_W / 2,
      y2: ty - Math.sin(angle) * NODE_H / 2.5
    };
  }

  function drawArrow(ctx, x1, y1, x2, y2, color) {
    var angle = Math.atan2(y2 - y1, x2 - x1);
    var size = 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - 0.4), y2 - size * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - size * Math.cos(angle + 0.4), y2 - size * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  /* ─── 绘制节点 ─── */
  function drawNodes(vr) {
    if (!appState.nodes) return;
    appState.nodes.forEach(function (node) {
      if (isNodeCollapsed(node)) return;
      if (!isInView(node.x, node.y, NODE_W, NODE_H, vr)) return;

      var style = NODE_STYLES[node.type] || NODE_STYLES.server;
      var status = node._alarmStatus || node.status;
      var statusColor = STATUS_COLORS[status] || STATUS_COLORS.normal;
      var isSelected = appState.selection && appState.selection.has(node.id);
      var isHighlight = highlightedNodes.has(node.id) || highlightPath.nodes.has(node.id);
      var isHovered = hoveredNode === node.id;

      ctx.save();

      // 选中/高亮光晕
      if (isSelected || isHighlight) {
        ctx.shadowColor = isHighlight ? '#4fc3f7' : '#4f9cf7';
        ctx.shadowBlur = 12;
      }

      // 绘制节点形状
      ctx.fillStyle = isHovered ? lightenColor(style.color, 20) : style.color;
      ctx.strokeStyle = isSelected ? '#4f9cf7' : (isHighlight ? '#4fc3f7' : 'rgba(255,255,255,0.1)');
      ctx.lineWidth = isSelected || isHighlight ? 2.5 : 1;

      drawShape(ctx, node.x, node.y, NODE_W, NODE_H, style.shape);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;

      // 状态指示灯
      ctx.fillStyle = statusColor;
      ctx.beginPath();
      ctx.arc(node.x + NODE_W - 8, node.y + 8, 4, 0, Math.PI * 2);
      ctx.fill();

      // 状态闪烁效果（故障/告警）
      if (status === 'critical' || status === 'warning') {
        var pulse = Math.sin(Date.now() / 300) * 0.5 + 0.5;
        ctx.fillStyle = hexToRgba(statusColor, pulse * 0.4);
        ctx.beginPath();
        ctx.arc(node.x + NODE_W - 8, node.y + 8, 4 + pulse * 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // 节点图标
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(style.icon, node.x + NODE_W / 2, node.y + NODE_H / 2 - 6);

      // 节点名称
      ctx.fillStyle = '#e4e7ec';
      ctx.font = '11px sans-serif';
      var name = truncateText(ctx, node.name, NODE_W - 10);
      ctx.fillText(name, node.x + NODE_W / 2, node.y + NODE_H / 2 + 10);

      // 底部标签
      if (viewport.scale > 0.6) {
        ctx.fillStyle = '#8899aa';
        ctx.font = '9px sans-serif';
        ctx.fillText(DataParser.TYPE_LABELS[node.type] || node.type, node.x + NODE_W / 2, node.y + NODE_H + LABEL_OFFSET);
      }

      ctx.restore();
    });
  }

  /* ─── 形状绘制 ─── */
  function drawShape(ctx, x, y, w, h, shape) {
    switch (shape) {
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w / 2, y + h);
        ctx.lineTo(x, y + h / 2);
        ctx.closePath();
        break;
      case 'cylinder':
        var ey = 6;
        ctx.beginPath();
        ctx.moveTo(x, y + ey);
        ctx.bezierCurveTo(x, y - ey / 2, x + w, y - ey / 2, x + w, y + ey);
        ctx.lineTo(x + w, y + h - ey);
        ctx.bezierCurveTo(x + w, y + h + ey / 2, x, y + h + ey / 2, x, y + h - ey);
        ctx.closePath();
        // 顶部椭圆
        ctx.moveTo(x, y + ey);
        ctx.bezierCurveTo(x, y + ey * 2, x + w, y + ey * 2, x + w, y + ey);
        break;
      case 'hexagon':
        var inset = 12;
        ctx.beginPath();
        ctx.moveTo(x + inset, y);
        ctx.lineTo(x + w - inset, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w - inset, y + h);
        ctx.lineTo(x + inset, y + h);
        ctx.lineTo(x, y + h / 2);
        ctx.closePath();
        break;
      case 'roundRect':
        roundRect(ctx, x, y, w, h, 12);
        break;
      default: // rect
        roundRect(ctx, x, y, w, h, 4);
        break;
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /* ─── 框选矩形绘制 ─── */
  function drawSelectRect(rect) {
    ctx.strokeStyle = 'rgba(79, 156, 247, 0.8)';
    ctx.fillStyle = 'rgba(79, 156, 247, 0.1)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([]);
  }

  /* ─── 小地图 ─── */
  function renderMinimap() {
    if (!minimapCtx || !appState || !appState.nodes || appState.nodes.length === 0) return;
    var mw = 180, mh = 120;
    minimapCtx.clearRect(0, 0, mw, mh);
    minimapCtx.fillStyle = '#1a1d23';
    minimapCtx.fillRect(0, 0, mw, mh);

    var bounds = LayoutEngine.getBounds(appState.positions || {});
    if (bounds.width === 0 || bounds.height === 0) return;

    var pad = 20;
    var scaleX = (mw - pad * 2) / (bounds.width + NODE_W);
    var scaleY = (mh - pad * 2) / (bounds.height + NODE_H);
    var s = Math.min(scaleX, scaleY, 1);
    var offX = pad + ((mw - pad * 2) - (bounds.width + NODE_W) * s) / 2 - bounds.minX * s;
    var offY = pad + ((mh - pad * 2) - (bounds.height + NODE_H) * s) / 2 - bounds.minY * s;

    // 绘制边
    minimapCtx.strokeStyle = 'rgba(85,102,119,0.3)';
    minimapCtx.lineWidth = 0.5;
    if (appState.edges) {
      appState.edges.forEach(function (edge) {
        var src = appState.nodeMap.get(edge.source);
        var tgt = appState.nodeMap.get(edge.target);
        if (!src || !tgt) return;
        minimapCtx.beginPath();
        minimapCtx.moveTo(offX + (src.x + NODE_W / 2) * s, offY + (src.y + NODE_H / 2) * s);
        minimapCtx.lineTo(offX + (tgt.x + NODE_W / 2) * s, offY + (tgt.y + NODE_H / 2) * s);
        minimapCtx.stroke();
      });
    }

    // 绘制节点
    appState.nodes.forEach(function (node) {
      var ns = NODE_STYLES[node.type] || NODE_STYLES.server;
      var status = node._alarmStatus || node.status;
      minimapCtx.fillStyle = status === 'critical' ? '#f44336' : (status === 'warning' ? '#ff9800' : ns.color);
      minimapCtx.fillRect(offX + node.x * s, offY + node.y * s, Math.max(NODE_W * s, 3), Math.max(NODE_H * s, 2));
    });

    // 绘制视口框
    var cw = canvas.width / (window.devicePixelRatio || 1);
    var ch = canvas.height / (window.devicePixelRatio || 1);
    var vpX = offX + (-viewport.x / viewport.scale) * s;
    var vpY = offY + (-viewport.y / viewport.scale) * s;
    var vpW = (cw / viewport.scale) * s;
    var vpH = (ch / viewport.scale) * s;

    var vpEl = document.getElementById('minimap-viewport');
    if (vpEl) {
      vpEl.style.left = vpX + 'px';
      vpEl.style.top = vpY + 'px';
      vpEl.style.width = vpW + 'px';
      vpEl.style.height = vpH + 'px';
    }
  }

  /* ─── 命中测试 ─── */
  function nodeAt(screenX, screenY) {
    var wx = (screenX - viewport.x) / viewport.scale;
    var wy = (screenY - viewport.y) / viewport.scale;

    if (!appState || !appState.nodes) return null;
    // 反向遍历（上层优先）
    for (var i = appState.nodes.length - 1; i >= 0; i--) {
      var n = appState.nodes[i];
      if (isNodeCollapsed(n)) continue;
      if (wx >= n.x && wx <= n.x + NODE_W && wy >= n.y && wy <= n.y + NODE_H) {
        return n;
      }
    }
    return null;
  }

  function nodesInRect(x1, y1, x2, y2) {
    var left = Math.min(x1, x2), right = Math.max(x1, x2);
    var top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    var result = [];
    if (!appState || !appState.nodes) return result;
    appState.nodes.forEach(function (n) {
      if (isNodeCollapsed(n)) return;
      var cx = n.x + NODE_W / 2;
      var cy = n.y + NODE_H / 2;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        result.push(n);
      }
    });
    return result;
  }

  /* ─── 屏幕坐标 → 世界坐标 ─── */
  function screenToWorld(sx, sy) {
    return {
      x: (sx - viewport.x) / viewport.scale,
      y: (sy - viewport.y) / viewport.scale
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * viewport.scale + viewport.x,
      y: wy * viewport.scale + viewport.y
    };
  }

  /* ─── 折叠检查 ─── */
  function isNodeCollapsed(node) {
    if (!appState.groups || !node.group) return false;
    var group = appState.groups.find(function (g) { return g.id === node.group; });
    return group && group.collapsed;
  }

  /* ─── 辅助函数 ─── */
  function truncateText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '...').width > maxW) {
      text = text.slice(0, -1);
    }
    return text + '...';
  }

  function hexToRgba(hex, alpha) {
    var num = parseInt(hex.slice(1), 16);
    var r = (num >> 16) & 255;
    var g = (num >> 8) & 255;
    var b = num & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function lightenColor(hex, percent) {
    var num = parseInt(hex.slice(1), 16);
    var r = Math.min(255, (num >> 16) + percent);
    var g = Math.min(255, ((num >> 8) & 0x00FF) + percent);
    var b = Math.min(255, (num & 0x0000FF) + percent);
    return '#' + (0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /* ─── Viewport 控制 ─── */
  function setViewport(x, y, scale) {
    viewport.x = x;
    viewport.y = y;
    viewport.scale = Math.max(0.1, Math.min(3, scale));
    needsRender = true;
  }

  function getViewport() { return viewport; }

  function fitToScreen() {
    if (!appState || !appState.nodes || appState.nodes.length === 0) return;
    var bounds = LayoutEngine.getBounds(appState.positions || {});
    var cw = canvas.width / (window.devicePixelRatio || 1);
    var ch = canvas.height / (window.devicePixelRatio || 1);
    var pad = 80;

    var scaleX = (cw - pad * 2) / (bounds.width + NODE_W);
    var scaleY = (ch - pad * 2) / (bounds.height + NODE_H);
    var scale = Math.min(scaleX, scaleY, 1.5);

    var cx = bounds.minX + bounds.width / 2;
    var cy = bounds.minY + bounds.height / 2;

    viewport.scale = scale;
    viewport.x = cw / 2 - cx * scale;
    viewport.y = ch / 2 - cy * scale;
    needsRender = true;
  }

  function focusNode(nodeId) {
    var node = appState.nodeMap.get(nodeId);
    if (!node) return;
    var cw = canvas.width / (window.devicePixelRatio || 1);
    var ch = canvas.height / (window.devicePixelRatio || 1);

    var targetScale = Math.max(viewport.scale, 0.8);
    viewport.scale = targetScale;
    viewport.x = cw / 2 - (node.x + NODE_W / 2) * targetScale;
    viewport.y = ch / 2 - (node.y + NODE_H / 2) * targetScale;
    needsRender = true;
  }

  /* ─── 高亮API ─── */
  function setHighlightedNodes(ids) {
    highlightedNodes = new Set(ids);
    needsRender = true;
  }

  function setHighlightedEdges(ids) {
    highlightedEdges = new Set(ids);
    needsRender = true;
  }

  function setHighlightPath(nodeIds, edgeIds) {
    highlightPath.nodes = new Set(nodeIds || []);
    highlightPath.edges = new Set(edgeIds || []);
    needsRender = true;
  }

  function clearHighlights() {
    highlightedNodes.clear();
    highlightedEdges.clear();
    highlightPath.nodes.clear();
    highlightPath.edges.clear();
    needsRender = true;
  }

  function setHoveredNode(nodeId) {
    if (hoveredNode !== nodeId) {
      hoveredNode = nodeId;
      needsRender = true;
    }
  }

  /* ─── 强制持续渲染（告警闪烁） ─── */
  function enablePulse(enable) {
    if (enable) {
      needsRender = true;
      // 持续渲染以支持闪烁动画
      var pulseLoop = function () {
        needsRender = true;
        if (appState._pulseEnabled) requestAnimationFrame(pulseLoop);
      };
      appState._pulseEnabled = true;
      pulseLoop();
    } else {
      appState._pulseEnabled = false;
    }
  }

  /* ─── 公共API ─── */
  return {
    init: init,
    render: render,
    requestRender: requestRender,
    resizeCanvas: resizeCanvas,
    setViewport: setViewport,
    getViewport: getViewport,
    fitToScreen: fitToScreen,
    focusNode: focusNode,
    nodeAt: nodeAt,
    nodesInRect: nodesInRect,
    screenToWorld: screenToWorld,
    worldToScreen: worldToScreen,
    setHighlightedNodes: setHighlightedNodes,
    setHighlightedEdges: setHighlightedEdges,
    setHighlightPath: setHighlightPath,
    clearHighlights: clearHighlights,
    setHoveredNode: setHoveredNode,
    enablePulse: enablePulse,
    NODE_W: NODE_W,
    NODE_H: NODE_H
  };
})();
