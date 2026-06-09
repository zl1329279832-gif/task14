/**
 * renderer.js — Canvas渲染引擎
 * 负责：节点绘制、连线绘制、分组框、小地图、选中高亮、告警动效
 */
const Renderer = (() => {
  'use strict';

  let mainCanvas, mainCtx;
  let overlayCanvas, overlayCtx;
  let minimapCanvas, minimapCtx;

  // 视口变换
  const viewport = {
    x: 0, y: 0,
    scale: 1,
    minScale: 0.1,
    maxScale: 5,
  };

  // 节点尺寸
  const NODE_RADIUS = 24;
  const NODE_ICON_SIZE = 18;

  // 动画状态
  let animFrame = 0;
  let animRunning = false;

  /**
   * 初始化渲染器
   */
  function init() {
    mainCanvas = document.getElementById('main-canvas');
    mainCtx = mainCanvas.getContext('2d');
    overlayCanvas = document.getElementById('overlay-canvas');
    overlayCtx = overlayCanvas.getContext('2d');
    minimapCanvas = document.getElementById('minimap-canvas');
    minimapCtx = minimapCanvas.getContext('2d');

    resize();
    window.addEventListener('resize', resize);
    startAnimationLoop();
  }

  /**
   * 调整画布尺寸
   */
  function resize() {
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    for (const canvas of [mainCanvas, overlayCanvas]) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const mmContainer = document.getElementById('minimap-container');
    minimapCanvas.width = mmContainer.offsetWidth * dpr;
    minimapCanvas.height = mmContainer.offsetHeight * dpr;
    minimapCanvas.style.width = mmContainer.offsetWidth + 'px';
    minimapCanvas.style.height = mmContainer.offsetHeight + 'px';
    minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 获取画布尺寸（CSS像素）
   */
  function getCanvasSize() {
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  /**
   * 屏幕坐标转世界坐标
   */
  function screenToWorld(sx, sy) {
    return {
      x: (sx - viewport.x) / viewport.scale,
      y: (sy - viewport.y) / viewport.scale,
    };
  }

  /**
   * 世界坐标转屏幕坐标
   */
  function worldToScreen(wx, wy) {
    return {
      x: wx * viewport.scale + viewport.x,
      y: wy * viewport.scale + viewport.y,
    };
  }

  // diff 模式标志
  let _diffMode = false;
  let _renderRequested = false;

  /**
   * 主渲染循环 — diff 模式委托给 DiffRenderer
   */
  function render(state) {
    if (_diffMode && typeof DiffRenderer !== 'undefined') {
      DiffRenderer.render();
      return;
    }
    if (!state) return;
    const { nodes, links, groups, selectedNodes } = state;
    const size = getCanvasSize();

    // 清空
    mainCtx.clearRect(0, 0, size.width, size.height);

    mainCtx.save();
    mainCtx.translate(viewport.x, viewport.y);
    mainCtx.scale(viewport.scale, viewport.scale);

    // 1. 绘制网格背景
    drawGrid(mainCtx, size);

    // 2. 绘制分组框
    drawGroups(mainCtx, groups, state.nodeMap);

    // 3. 绘制连线
    drawLinks(mainCtx, links, state.nodeMap);

    // 4. 绘制节点
    drawNodes(mainCtx, nodes, selectedNodes);

    mainCtx.restore();

    // 5. 绘制覆盖层（框选等）
    overlayCtx.clearRect(0, 0, size.width, size.height);

    // 6. 绘制小地图
    drawMinimap(state);
  }

  /**
   * 绘制网格
   */
  function drawGrid(ctx, size) {
    const gridSize = 40;
    const startX = Math.floor(-viewport.x / viewport.scale / gridSize) * gridSize - gridSize;
    const startY = Math.floor(-viewport.y / viewport.scale / gridSize) * gridSize - gridSize;
    const endX = startX + size.width / viewport.scale + gridSize * 2;
    const endY = startY + size.height / viewport.scale + gridSize * 2;

    ctx.strokeStyle = 'rgba(42, 58, 74, 0.3)';
    ctx.lineWidth = 0.5 / viewport.scale;

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

  /**
   * 绘制分组框
   */
  function drawGroups(ctx, groups, nodeMap) {
    if (!groups) return;

    for (const group of groups) {
      if (!group._bounds) continue;
      const b = group._bounds;

      // 背景
      ctx.fillStyle = 'rgba(74, 158, 255, 0.04)';
      ctx.strokeStyle = 'rgba(74, 158, 255, 0.2)';
      ctx.lineWidth = 1.5 / viewport.scale;

      const radius = 12;
      roundRect(ctx, b.x, b.y, b.width, b.height, radius);
      ctx.fill();
      ctx.stroke();

      // 标签
      ctx.fillStyle = 'rgba(74, 158, 255, 0.6)';
      ctx.font = `${11 / viewport.scale}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`📁 ${group.label}${group.collapsed ? ' (已折叠)' : ''}`, b.x + 8, b.y + 6);

      // 折叠标记
      if (group.collapsed) {
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        ctx.fillStyle = 'rgba(74, 158, 255, 0.15)';
        ctx.beginPath();
        ctx.arc(cx, cy, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(74, 158, 255, 0.8)';
        ctx.font = `${20 / viewport.scale}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('📁', cx, cy);
        ctx.font = `${10 / viewport.scale}px sans-serif`;
        ctx.fillText(`${group.children.length}`, cx, cy + 20);
      }
    }
  }

  /**
   * 绘制连线
   */
  function drawLinks(ctx, links, nodeMap) {
    if (!links) return;

    for (const link of links) {
      if (link._visible === false) continue;

      const src = nodeMap.get(link.source);
      const tgt = nodeMap.get(link.target);
      if (!src || !tgt) continue;
      if (src._visible === false || tgt._visible === false) continue;

      const statusColor = DataParser.STATUS_TYPES[link.status]?.color || '#5a6a7a';

      ctx.strokeStyle = link._highlighted
        ? '#4a9eff'
        : statusColor;
      ctx.lineWidth = link._highlighted ? 3 / viewport.scale : 1.5 / viewport.scale;
      ctx.globalAlpha = link._highlighted ? 1 : 0.6;

      // 虚线样式
      if (link.status === 'warning') {
        ctx.setLineDash([6 / viewport.scale, 4 / viewport.scale]);
      } else if (link.status === 'critical') {
        ctx.setLineDash([3 / viewport.scale, 3 / viewport.scale]);
      } else {
        ctx.setLineDash([]);
      }

      // 绘制连线
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);

      // 贝塞尔曲线使连线更美观
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

      // 箭头
      drawArrow(ctx, src.x, src.y, tgt.x, tgt.y, statusColor, link._highlighted);

      // 连线标签
      if (link.label && viewport.scale > 0.5) {
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        ctx.fillStyle = 'rgba(136,153,170,0.8)';
        ctx.font = `${9 / viewport.scale}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(link.label, mx, my - 8 / viewport.scale);
      }

      ctx.globalAlpha = 1;
    }
  }

  /**
   * 绘制箭头
   */
  function drawArrow(ctx, x1, y1, x2, y2, color, highlighted) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;

    const nx = dx / dist;
    const ny = dy / dist;
    const arrowSize = (highlighted ? 8 : 6) / viewport.scale;
    const endX = x2 - nx * (NODE_RADIUS + 4);
    const endY = y2 - ny * (NODE_RADIUS + 4);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - nx * arrowSize + ny * arrowSize * 0.4, endY - ny * arrowSize - nx * arrowSize * 0.4);
    ctx.lineTo(endX - nx * arrowSize - ny * arrowSize * 0.4, endY - ny * arrowSize + nx * arrowSize * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * 绘制节点
   */
  function drawNodes(ctx, nodes, selectedNodes) {
    if (!nodes) return;

    const selectedSet = new Set((selectedNodes || []).map(n => n.id));
    const time = animFrame;

    for (const node of nodes) {
      if (node._visible === false) continue;

      const typeInfo = DataParser.NODE_TYPES[node.type] || DataParser.NODE_TYPES.server;
      const statusInfo = DataParser.STATUS_TYPES[node.status] || DataParser.STATUS_TYPES.normal;
      const isSelected = selectedSet.has(node.id);
      const isHighlighted = node._highlighted;

      const x = node.x;
      const y = node.y;
      const r = NODE_RADIUS;

      // 告警脉冲效果
      if (node.status === 'critical') {
        const pulse = Math.sin(time * 0.05) * 0.3 + 0.7;
        ctx.fillStyle = `rgba(255, 74, 106, ${0.15 * pulse})`;
        ctx.beginPath();
        ctx.arc(x, y, r + 12 + Math.sin(time * 0.03) * 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (node.status === 'warning') {
        const pulse = Math.sin(time * 0.04) * 0.2 + 0.5;
        ctx.fillStyle = `rgba(255, 170, 74, ${0.1 * pulse})`;
        ctx.beginPath();
        ctx.arc(x, y, r + 8, 0, Math.PI * 2);
        ctx.fill();
      }

      // 选中/高亮光环
      if (isSelected) {
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 3 / viewport.scale;
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      } else if (isHighlighted) {
        ctx.strokeStyle = 'rgba(74, 158, 255, 0.5)';
        ctx.lineWidth = 2 / viewport.scale;
        ctx.setLineDash([4 / viewport.scale, 3 / viewport.scale]);
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 节点主体
      drawNodeShape(ctx, node.type, x, y, r, typeInfo, statusInfo, node.pinned);

      // 图标
      ctx.font = `${NODE_ICON_SIZE / viewport.scale * viewport.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(typeInfo.icon, x, y);

      // 标签
      if (viewport.scale > 0.35) {
        ctx.fillStyle = 'rgba(232, 237, 242, 0.9)';
        ctx.font = `bold ${11 / viewport.scale}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(truncate(node.label, 14), x, y + r + 4);

        // 状态小标签
        if (node.status !== 'normal') {
          ctx.fillStyle = statusInfo.color;
          ctx.font = `${9 / viewport.scale}px sans-serif`;
          ctx.fillText(statusInfo.label, x, y + r + 18);
        }
      }

      // 固定标记
      if (node.pinned) {
        ctx.fillStyle = 'rgba(255, 170, 74, 0.8)';
        ctx.font = `${10}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('📌', x + r - 2, y - r + 2);
      }
    }
  }

  /**
   * 绘制节点形状
   */
  function drawNodeShape(ctx, type, x, y, r, typeInfo, statusInfo, pinned) {
    const bgColor = hexToRgba(typeInfo.color, 0.15);
    const borderColor = hexToRgba(statusInfo.color, 0.8);

    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2 / viewport.scale;

    switch (type) {
      case 'datacenter':
        // 圆角矩形
        roundRect(ctx, x - r, y - r, r * 2, r * 2, 8);
        ctx.fill();
        ctx.stroke();
        break;

      case 'database':
        // 圆柱体
        ctx.beginPath();
        ctx.ellipse(x, y - r * 0.6, r, r * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - r, y - r * 0.6);
        ctx.lineTo(x - r, y + r * 0.4);
        ctx.ellipse(x, y + r * 0.4, r, r * 0.35, 0, Math.PI, Math.PI * 2);
        ctx.lineTo(x + r, y - r * 0.6);
        ctx.fill();
        ctx.stroke();
        break;

      case 'gateway':
        // 菱形
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;

      case 'switch':
        // 六边形
        drawHexagon(ctx, x, y, r);
        ctx.fill();
        ctx.stroke();
        break;

      case 'app':
        // 圆角正方形
        roundRect(ctx, x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7, r * 0.3);
        ctx.fill();
        ctx.stroke();
        break;

      default: // server
        // 圆形
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
    }
  }

  /**
   * 绘制六边形
   */
  function drawHexagon(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + r * Math.cos(angle);
      const py = y + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * 圆角矩形
   */
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

  /**
   * 绘制小地图
   */
  function drawMinimap(state) {
    const { nodes, links, groups } = state;
    const mmW = minimapCanvas.width / (window.devicePixelRatio || 1);
    const mmH = minimapCanvas.height / (window.devicePixelRatio || 1);

    minimapCtx.clearRect(0, 0, mmW, mmH);
    minimapCtx.fillStyle = 'rgba(15, 25, 35, 0.9)';
    minimapCtx.fillRect(0, 0, mmW, mmH);

    if (!nodes || nodes.length === 0) return;

    // 计算包围盒
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n._visible === false) continue;
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

    // 画连线
    minimapCtx.strokeStyle = 'rgba(90, 106, 122, 0.3)';
    minimapCtx.lineWidth = 0.5;
    const nodeMap = state.nodeMap;
    for (const link of links || []) {
      const s = nodeMap.get(link.source);
      const t = nodeMap.get(link.target);
      if (!s || !t || s._visible === false || t._visible === false) continue;
      minimapCtx.beginPath();
      minimapCtx.moveTo(toMiniX(s.x), toMiniY(s.y));
      minimapCtx.lineTo(toMiniX(t.x), toMiniY(t.y));
      minimapCtx.stroke();
    }

    // 画节点
    for (const n of nodes) {
      if (n._visible === false) continue;
      const statusColor = DataParser.STATUS_TYPES[n.status]?.color || '#5a6a7a';
      minimapCtx.fillStyle = statusColor;
      minimapCtx.beginPath();
      minimapCtx.arc(toMiniX(n.x), toMiniY(n.y), 2.5, 0, Math.PI * 2);
      minimapCtx.fill();
    }

    // 视口指示器
    const vpEl = document.getElementById('minimap-viewport');
    const canvasSize = getCanvasSize();
    const vpWorldX = -viewport.x / viewport.scale;
    const vpWorldY = -viewport.y / viewport.scale;
    const vpWorldW = canvasSize.width / viewport.scale;
    const vpWorldH = canvasSize.height / viewport.scale;

    const mmVpX = toMiniX(vpWorldX);
    const mmVpY = toMiniY(vpWorldY);
    const mmVpW = vpWorldW * scale;
    const mmVpH = vpWorldH * scale;

    vpEl.style.left = mmVpX + 'px';
    vpEl.style.top = mmVpY + 'px';
    vpEl.style.width = Math.max(10, mmVpW) + 'px';
    vpEl.style.height = Math.max(10, mmVpH) + 'px';
  }

  /**
   * 动画循环
   */
  function startAnimationLoop() {
    animRunning = true;
    function loop() {
      if (!animRunning) return;
      animFrame++;
      requestAnimationFrame(loop);
    }
    loop();
  }

  // 辅助函数
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  /**
   * 命中测试
   */
  function hitTest(worldX, worldY, nodes) {
    // 逆序遍历（后绘制的在上层）
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node._visible === false) continue;
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= (NODE_RADIUS + 4) * (NODE_RADIUS + 4)) {
        return node;
      }
    }
    return null;
  }

  /**
   * 分组命中测试
   */
  function hitTestGroup(worldX, worldY, groups) {
    for (const group of groups) {
      if (!group._bounds) continue;
      const b = group._bounds;
      if (worldX >= b.x && worldX <= b.x + b.width &&
          worldY >= b.y && worldY <= b.y + b.height) {
        return group;
      }
    }
    return null;
  }

  /**
   * 将视口居中到指定世界坐标
   */
  function centerOn(wx, wy, targetScale) {
    const size = getCanvasSize();
    if (targetScale != null) viewport.scale = clamp(targetScale, viewport.minScale, viewport.maxScale);
    viewport.x = size.width / 2 - wx * viewport.scale;
    viewport.y = size.height / 2 - wy * viewport.scale;
  }

  /**
   * 适应画布
   */
  function fitToView(nodes) {
    if (!nodes || nodes.length === 0) return;

    const visible = nodes.filter(n => n._visible !== false);
    if (visible.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of visible) {
      minX = Math.min(minX, n.x - NODE_RADIUS);
      minY = Math.min(minY, n.y - NODE_RADIUS);
      maxX = Math.max(maxX, n.x + NODE_RADIUS);
      maxY = Math.max(maxY, n.y + NODE_RADIUS);
    }

    const padding = 60;
    const size = getCanvasSize();
    const worldW = maxX - minX + padding * 2;
    const worldH = maxY - minY + padding * 2;

    viewport.scale = Math.min(size.width / worldW, size.height / worldH, 2);
    viewport.scale = Math.max(viewport.scale, viewport.minScale);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    viewport.x = size.width / 2 - cx * viewport.scale;
    viewport.y = size.height / 2 - cy * viewport.scale;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /**
   * 设置/获取 diff 模式
   */
  function setDiffMode(enabled) {
    _diffMode = enabled;
  }

  function isDiffMode() {
    return _diffMode;
  }

  /**
   * 请求渲染（防重复）
   */
  function requestRender() {
    if (!_renderRequested) {
      _renderRequested = true;
      requestAnimationFrame(() => {
        _renderRequested = false;
      });
    }
  }

  function getMainContext() { return mainCtx; }
  function getOverlayContext() { return overlayCtx; }
  function getMinimapContext() { return minimapCtx; }
  function getMainCanvas() { return mainCanvas; }

  return {
    init,
    resize,
    render,
    screenToWorld,
    worldToScreen,
    hitTest,
    hitTestGroup,
    centerOn,
    fitToView,
    viewport,
    getCanvasSize,
    NODE_RADIUS,
    setDiffMode,
    isDiffMode,
    requestRender,
    getMainContext,
    getOverlayContext,
    getMinimapContext,
    getMainCanvas,
  };
})();
