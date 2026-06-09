/**
 * diff-renderer.js — 差异模式专用渲染器
 * 负责：diff可视化（新增/删除/变更标记）、传播波前动画、流动粒子、图例
 */
const DiffRenderer = (() => {
  'use strict';

  // 差异颜色定义
  const COLORS = {
    added: { fill: 'rgba(34,197,94,0.8)', stroke: '#16a34a', badge: '#22c55e', label: '新增' },
    removed: { fill: 'rgba(239,68,68,0.15)', stroke: '#ef4444', badge: '#ef4444', label: '删除' },
    changed: { fill: 'rgba(245,158,11,0.6)', stroke: '#d97706', badge: '#f59e0b', label: '变更' },
    unchanged: { alpha: 0.4, label: '不变' },
    propagation: {
      critical: '#ef4444',
      warning: '#f59e0b',
      info: '#22c55e'
    },
    businessGlow: 'rgba(139,92,246,0.4)',
    upstreamHighlight: 'rgba(59,130,246,0.7)',
    chainLink: '#ef4444'
  };

  let _animFrame = 0;

  /**
   * diff 模式主渲染
   */
  function render() {
    const nodes = TopoDiff.getMergedNodes();
    const links = TopoDiff.getMergedLinks();
    const nodeMap = TopoDiff.getMergedNodeMap();

    if (nodes.length === 0) return;

    const mainCtx = _getMainContext();
    const size = Renderer.getCanvasSize();

    mainCtx.clearRect(0, 0, size.width, size.height);
    mainCtx.save();
    mainCtx.translate(Renderer.viewport.x, Renderer.viewport.y);
    mainCtx.scale(Renderer.viewport.scale, Renderer.viewport.scale);

    // 1. 网格
    _drawGrid(mainCtx, size);

    // 2. 链路（分层绘制）
    _drawLinksByLayer(mainCtx, links, nodeMap);

    // 3. 传播波前（在节点后面）
    _drawPropagationWaves(mainCtx, nodes);

    // 4. 节点（分层绘制）
    _drawNodesByLayer(mainCtx, nodes);

    // 5. 业务节点光晕
    _drawBusinessGlows(mainCtx, nodes);

    mainCtx.restore();

    // 6. 覆盖层
    const overlayCtx = _getOverlayContext();
    overlayCtx.clearRect(0, 0, size.width, size.height);

    // 7. 小地图
    _drawMinimap(nodes, links, nodeMap);

    // 8. 动画帧计数
    _animFrame++;
  }

  // --- 内部绘制方法 ---

  function _drawGrid(ctx, size) {
    const gridSize = 40;
    const vp = Renderer.viewport;
    const startX = Math.floor(-vp.x / vp.scale / gridSize) * gridSize - gridSize;
    const startY = Math.floor(-vp.y / vp.scale / gridSize) * gridSize - gridSize;
    const endX = startX + size.width / vp.scale + gridSize * 2;
    const endY = startY + size.height / vp.scale + gridSize * 2;

    ctx.strokeStyle = 'rgba(42, 58, 74, 0.3)';
    ctx.lineWidth = 0.5 / vp.scale;
    ctx.beginPath();
    for (let x = startX; x <= endX; x += gridSize) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += gridSize) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();
  }

  function _drawLinksByLayer(ctx, links, nodeMap) {
    const vp = Renderer.viewport;
    const playbackState = FaultReplay.getPlaybackState();
    const time = _animFrame;

    // 按层级排序：不变 → 变更 → 新增 → 删除(ghost) → 传播链
    const order = { unchanged: 0, changed: 1, added: 2, removed: 3 };
    const sorted = [...links].sort((a, b) => (order[a._diffState] || 0) - (order[b._diffState] || 0));

    for (const link of sorted) {
      if (link._visible === false) continue;

      const src = nodeMap.get(link.source);
      const tgt = nodeMap.get(link.target);
      if (!src || !tgt) continue;
      if (src._visible === false || tgt._visible === false) continue;

      const isPropagationLink = playbackState.highlightedLinkIds.has(link.id);

      ctx.save();

      switch (link._diffState) {
        case 'added':
          ctx.strokeStyle = COLORS.added.stroke;
          ctx.lineWidth = 2 / vp.scale;
          ctx.globalAlpha = 0.8;
          ctx.setLineDash([6 / vp.scale, 4 / vp.scale]);
          break;

        case 'removed':
          ctx.strokeStyle = COLORS.removed.stroke;
          ctx.lineWidth = 1 / vp.scale;
          ctx.globalAlpha = 0.2;
          ctx.setLineDash([3 / vp.scale, 3 / vp.scale]);
          break;

        case 'changed':
          ctx.strokeStyle = COLORS.changed.stroke;
          ctx.lineWidth = 2.5 / vp.scale;
          ctx.globalAlpha = 0.8;
          ctx.setLineDash([]);
          // 脉冲效果
          const pulse = Math.sin(time * 0.05) * 0.3 + 0.7;
          ctx.shadowColor = COLORS.changed.badge;
          ctx.shadowBlur = 6 * pulse;
          break;

        default: // unchanged
          ctx.strokeStyle = 'rgba(90,106,122,0.4)';
          ctx.lineWidth = 1 / vp.scale;
          ctx.globalAlpha = 0.3;
          ctx.setLineDash([]);
          break;
      }

      if (link._highlighted || isPropagationLink) {
        ctx.strokeStyle = isPropagationLink ? COLORS.chainLink : '#4a9eff';
        ctx.lineWidth = 3 / vp.scale;
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.shadowColor = isPropagationLink ? COLORS.chainLink : '#4a9eff';
        ctx.shadowBlur = 8;
      }

      // 画线
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 150) {
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        const offset = dist * 0.1;
        const nx = -dy / dist * offset;
        const ny = dx / dist * offset;
        ctx.quadraticCurveTo(mx + nx, my + ny, tgt.x, tgt.y);
      } else {
        ctx.lineTo(tgt.x, tgt.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      // 箭头
      if (link._diffState !== 'removed') {
        const arrowColor = ctx.strokeStyle;
        const nx = dx / dist;
        const ny = dy / dist;
        const arrowSize = 6 / vp.scale;
        const endX = tgt.x - nx * (Renderer.NODE_RADIUS + 4);
        const endY = tgt.y - ny * (Renderer.NODE_RADIUS + 4);
        ctx.fillStyle = arrowColor;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - nx * arrowSize + ny * arrowSize * 0.4, endY - ny * arrowSize - nx * arrowSize * 0.4);
        ctx.lineTo(endX - nx * arrowSize - ny * arrowSize * 0.4, endY - ny * arrowSize + nx * arrowSize * 0.4);
        ctx.closePath();
        ctx.fill();
      }

      // 传播链上的流动粒子
      if (isPropagationLink) {
        _drawFlowingParticles(ctx, src.x, src.y, tgt.x, tgt.y, time);
      }

      ctx.restore();
    }
  }

  function _drawFlowingParticles(ctx, sx, sy, tx, ty, time) {
    const vp = Renderer.viewport;
    const particleCount = 5;
    const speed = 0.02;
    ctx.fillStyle = COLORS.chainLink;

    for (let i = 0; i < particleCount; i++) {
      const t = ((time * speed + i / particleCount) % 1.0);
      const px = sx + (tx - sx) * t;
      const py = sy + (ty - sy) * t;
      ctx.globalAlpha = 0.9 * (1 - t * 0.3);
      ctx.beginPath();
      ctx.arc(px, py, 3 / vp.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function _drawPropagationWaves(ctx, nodes) {
    const vp = Renderer.viewport;
    const playbackState = FaultReplay.getPlaybackState();
    const wavefront = playbackState.propagationWavefront;
    const time = _animFrame;

    for (const node of nodes) {
      if (!wavefront[node.id]) continue;
      const wf = wavefront[node.id];
      const severityColor = COLORS.propagation[wf.severity] || COLORS.propagation.warning;

      // 同心扩展环
      for (let ring = 1; ring <= 3; ring++) {
        const radius = Renderer.NODE_RADIUS + ring * 10 + Math.sin(time * 0.05 + ring) * 4;
        const alpha = (0.6 / ring);
        ctx.strokeStyle = severityColor;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1.5 / vp.scale;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  function _drawNodesByLayer(ctx, nodes) {
    const vp = Renderer.viewport;
    const playbackState = FaultReplay.getPlaybackState();

    // 按层级：不变 → 变更 → 删除(ghost) → 新增
    const order = { unchanged: 0, changed: 1, removed: 2, added: 3 };
    const sorted = [...nodes].sort((a, b) => (order[a._diffState] || 0) - (order[b._diffState] || 0));

    for (const node of sorted) {
      if (node._visible === false) continue;

      const typeInfo = DataParser.NODE_TYPES[node.type] || DataParser.NODE_TYPES.server;
      const r = Renderer.NODE_RADIUS;

      ctx.save();

      switch (node._diffState) {
        case 'added':
          _drawDiffNode(ctx, node, typeInfo, COLORS.added, '+', r);
          break;

        case 'removed':
          ctx.globalAlpha = 0.3;
          _drawGhostNode(ctx, node, typeInfo, r);
          break;

        case 'changed':
          _drawChangedNode(ctx, node, typeInfo, r);
          break;

        default: // unchanged
          ctx.globalAlpha = COLORS.unchanged.alpha;
          _drawNormalNode(ctx, node, typeInfo, r);
          break;
      }

      // 高亮环
      if (node._highlighted) {
        ctx.strokeStyle = COLORS.upstreamHighlight;
        ctx.lineWidth = 3 / vp.scale;
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 选中环
      if (node._selected) {
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 3 / vp.scale;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  function _drawNormalNode(ctx, node, typeInfo, r) {
    const vp = Renderer.viewport;
    const statusInfo = DataParser.STATUS_TYPES[node.status] || DataParser.STATUS_TYPES.normal;
    const bgColor = _hexToRgba(typeInfo.color, 0.15);
    const borderColor = _hexToRgba(statusInfo.color, 0.8);

    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2 / vp.scale;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 图标
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(typeInfo.icon, node.x, node.y);

    // 标签
    if (vp.scale > 0.35) {
      ctx.fillStyle = 'rgba(232,237,242,0.9)';
      ctx.font = `bold ${11 / vp.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(_truncate(node.label, 14), node.x, node.y + r + 4);
    }
  }

  function _drawDiffNode(ctx, node, typeInfo, colorDef, badgeChar, r) {
    const vp = Renderer.viewport;

    ctx.fillStyle = _hexToRgba(colorDef.badge, 0.2);
    ctx.strokeStyle = colorDef.stroke;
    ctx.lineWidth = 3 / vp.scale;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 图标
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(typeInfo.icon, node.x, node.y);

    // 徽章
    _drawBadge(ctx, node.x + r - 2, node.y - r + 2, badgeChar, colorDef.badge);

    // 标签
    if (vp.scale > 0.35) {
      ctx.fillStyle = 'rgba(232,237,242,0.9)';
      ctx.font = `bold ${11 / vp.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(_truncate(node.label, 14), node.x, node.y + r + 4);

      // 差异状态标签
      ctx.fillStyle = colorDef.badge;
      ctx.font = `${9 / vp.scale}px sans-serif`;
      ctx.fillText(colorDef.label, node.x, node.y + r + 18);
    }
  }

  function _drawGhostNode(ctx, node, typeInfo, r) {
    const vp = Renderer.viewport;
    ctx.strokeStyle = COLORS.removed.stroke;
    ctx.lineWidth = 2 / vp.scale;
    ctx.setLineDash([6 / vp.scale, 4 / vp.scale]);
    ctx.fillStyle = COLORS.removed.fill;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // 半透明图标
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(239,68,68,0.5)';
    ctx.fillText(typeInfo.icon, node.x, node.y);

    // × 徽章
    _drawBadge(ctx, node.x + r - 2, node.y - r + 2, '×', COLORS.removed.badge);

    // 标签
    if (vp.scale > 0.35) {
      ctx.fillStyle = 'rgba(239,68,68,0.6)';
      ctx.font = `bold ${11 / vp.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(_truncate(node.label, 14), node.x, node.y + r + 4);

      ctx.fillStyle = COLORS.removed.badge;
      ctx.font = `${9 / vp.scale}px sans-serif`;
      ctx.fillText('已删除', node.x, node.y + r + 18);
    }
  }

  function _drawChangedNode(ctx, node, typeInfo, r) {
    const vp = Renderer.viewport;
    const statusInfo = DataParser.STATUS_TYPES[node.status] || DataParser.STATUS_TYPES.normal;
    const time = _animFrame;

    // 找到变更详情
    const diffResult = TopoDiff.getDiffResult();
    const changeInfo = diffResult ? diffResult.nodesChanged.find(c => c.id === node.id) : null;
    const statusChanged = changeInfo && changeInfo.changes.some(c => c.field === 'status');

    if (statusChanged && changeInfo) {
      // 状态变更：左右分色
      const oldStatus = changeInfo.changes.find(c => c.field === 'status')?.from || 'normal';
      const oldColor = DataParser.STATUS_TYPES[oldStatus]?.color || '#4aff8a';
      const newColor = statusInfo.color;

      // 左半
      ctx.fillStyle = _hexToRgba(oldColor, 0.2);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, Math.PI * 0.5, Math.PI * 1.5);
      ctx.fill();

      // 右半
      ctx.fillStyle = _hexToRgba(newColor, 0.2);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, Math.PI * 1.5, Math.PI * 0.5);
      ctx.fill();
    } else {
      ctx.fillStyle = _hexToRgba(typeInfo.color, 0.15);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 琥珀色边框 + marching ants
    ctx.strokeStyle = COLORS.changed.stroke;
    ctx.lineWidth = 3 / vp.scale;
    ctx.setLineDash([6 / vp.scale, 3 / vp.scale]);
    ctx.lineDashOffset = -(time * 0.5);
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 图标
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(typeInfo.icon, node.x, node.y);

    // Δ 徽章
    _drawBadge(ctx, node.x + r - 2, node.y - r + 2, 'Δ', COLORS.changed.badge);

    // 标签
    if (vp.scale > 0.35) {
      ctx.fillStyle = 'rgba(232,237,242,0.9)';
      ctx.font = `bold ${11 / vp.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(_truncate(node.label, 14), node.x, node.y + r + 4);

      ctx.fillStyle = COLORS.changed.badge;
      ctx.font = `${9 / vp.scale}px sans-serif`;
      ctx.fillText('已变更', node.x, node.y + r + 18);
    }
  }

  function _drawBadge(ctx, x, y, char, color) {
    const vp = Renderer.viewport;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 8 / vp.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${10 / vp.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(char, x, y);
    ctx.restore();
  }

  function _drawBusinessGlows(ctx, nodes) {
    const playbackState = FaultReplay.getPlaybackState();
    const bizNodes = playbackState.affectedBusinessNodes;

    for (const node of nodes) {
      if (!bizNodes.has(node.id)) continue;

      const gradient = ctx.createRadialGradient(
        node.x, node.y, Renderer.NODE_RADIUS,
        node.x, node.y, Renderer.NODE_RADIUS * 2.5
      );
      gradient.addColorStop(0, COLORS.businessGlow);
      gradient.addColorStop(1, 'rgba(139,92,246,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(node.x, node.y, Renderer.NODE_RADIUS * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 绘制小地图
   */
  function _drawMinimap(nodes, links, nodeMap) {
    const mmCanvas = document.getElementById('minimap-canvas');
    const mmCtx = mmCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const mmW = mmCanvas.width / dpr;
    const mmH = mmCanvas.height / dpr;

    mmCtx.clearRect(0, 0, mmW, mmH);
    mmCtx.fillStyle = 'rgba(15, 25, 35, 0.9)';
    mmCtx.fillRect(0, 0, mmW, mmH);

    if (!nodes || nodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n._visible === false || n.x == null) continue;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    if (!isFinite(minX)) return;

    const padding = 60;
    minX -= padding; minY -= padding;
    maxX += padding; maxY += padding;
    const worldW = maxX - minX || 1;
    const worldH = maxY - minY || 1;
    const scale = Math.min(mmW / worldW, mmH / worldH);
    const offsetX = (mmW - worldW * scale) / 2;
    const offsetY = (mmH - worldH * scale) / 2;
    const toMiniX = (wx) => (wx - minX) * scale + offsetX;
    const toMiniY = (wy) => (wy - minY) * scale + offsetY;

    // 链路
    mmCtx.strokeStyle = 'rgba(90,106,122,0.3)';
    mmCtx.lineWidth = 0.5;
    for (const link of links) {
      const s = nodeMap.get(link.source);
      const t = nodeMap.get(link.target);
      if (!s || !t || s._visible === false || t._visible === false) continue;
      mmCtx.beginPath();
      mmCtx.moveTo(toMiniX(s.x), toMiniY(s.y));
      mmCtx.lineTo(toMiniX(t.x), toMiniY(t.y));
      mmCtx.stroke();
    }

    // 节点（使用 diff 颜色）
    for (const n of nodes) {
      if (n._visible === false || n.x == null) continue;
      let color;
      switch (n._diffState) {
        case 'added': color = COLORS.added.badge; break;
        case 'removed': color = COLORS.removed.badge; break;
        case 'changed': color = COLORS.changed.badge; break;
        default: color = '#5a6a7a'; break;
      }
      mmCtx.fillStyle = color;
      mmCtx.beginPath();
      mmCtx.arc(toMiniX(n.x), toMiniY(n.y), 2.5, 0, Math.PI * 2);
      mmCtx.fill();
    }

    // 视口指示器
    const vpEl = document.getElementById('minimap-viewport');
    const canvasSize = Renderer.getCanvasSize();
    const vp = Renderer.viewport;
    const vpWorldX = -vp.x / vp.scale;
    const vpWorldY = -vp.y / vp.scale;
    const vpWorldW = canvasSize.width / vp.scale;
    const vpWorldH = canvasSize.height / vp.scale;
    vpEl.style.left = toMiniX(vpWorldX) + 'px';
    vpEl.style.top = toMiniY(vpWorldY) + 'px';
    vpEl.style.width = Math.max(10, vpWorldW * scale) + 'px';
    vpEl.style.height = Math.max(10, vpWorldH * scale) + 'px';
  }

  /**
   * 更新时间线直方图
   */
  function renderTimelineHistogram(alerts, currentIndex) {
    const canvas = document.getElementById('timeline-histogram');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(15,25,35,0.8)';
    ctx.fillRect(0, 0, w, h);

    if (!alerts || alerts.length === 0) return;

    const barWidth = Math.max(2, w / alerts.length - 1);
    const severityColors = {
      critical: '#ef4444',
      warning: '#f59e0b',
      info: '#22c55e',
      normal: '#4aff8a'
    };

    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      const x = (i / alerts.length) * w;
      const barH = h * 0.8;
      ctx.fillStyle = severityColors[alert.severity] || '#5a6a7a';
      ctx.globalAlpha = i === currentIndex ? 1 : 0.5;
      ctx.fillRect(x, h - barH, barWidth, barH);
    }
    ctx.globalAlpha = 1;

    // 当前位置指示器
    if (currentIndex >= 0) {
      const cx = ((currentIndex + 0.5) / alerts.length) * w;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
    }
  }

  // --- 辅助函数 ---

  function _getMainContext() {
    return document.getElementById('main-canvas').getContext('2d');
  }

  function _getOverlayContext() {
    return document.getElementById('overlay-canvas').getContext('2d');
  }

  function _hexToRgba(hex, alpha) {
    if (!hex) return `rgba(90,106,122,${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function _truncate(str, max) {
    return str && str.length > max ? str.slice(0, max - 1) + '...' : (str || '');
  }

  return {
    render,
    renderTimelineHistogram,
    COLORS
  };
})();
