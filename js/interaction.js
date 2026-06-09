/**
 * interaction.js — 交互控制器
 * 负责：拖拽、缩放、平移、框选、搜索定位、键盘快捷键、右键菜单
 */
const Interaction = (() => {
  'use strict';

  let appState = null;
  let canvasContainer, mainCanvas;

  // 拖拽状态
  let dragState = {
    active: false,
    node: null,
    lastWorldX: 0, lastWorldY: 0,
  };

  // 平移状态
  let panState = {
    active: false,
    startX: 0, startY: 0,
    startVpX: 0, startVpY: 0,
  };

  // 框选状态
  let boxSelectState = {
    active: false,
    startX: 0, startY: 0,
    currentX: 0, currentY: 0,
  };

  // 选中的节点集合
  let selectedNodes = [];

  // 空格键平移模式
  let spacePressed = false;

  /**
   * 初始化交互控制器
   */
  function init(state) {
    appState = state;
    canvasContainer = document.getElementById('canvas-container');
    mainCanvas = document.getElementById('main-canvas');

    bindCanvasEvents();
    bindKeyboardEvents();
    bindContextMenu();
    bindSearchEvents();
    bindFilterEvents();
  }

  /**
   * 绑定画布事件
   */
  function bindCanvasEvents() {
    mainCanvas.addEventListener('mousedown', onMouseDown);
    mainCanvas.addEventListener('mousemove', onMouseMove);
    mainCanvas.addEventListener('mouseup', onMouseUp);
    mainCanvas.addEventListener('wheel', onWheel, { passive: false });
    mainCanvas.addEventListener('dblclick', onDblClick);

    // 触摸支持
    mainCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
    mainCanvas.addEventListener('touchmove', onTouchMove, { passive: false });
    mainCanvas.addEventListener('touchend', onTouchEnd);
  }

  function getCanvasPos(e) {
    const rect = mainCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onMouseDown(e) {
    const pos = getCanvasPos(e);
    const worldPos = Renderer.screenToWorld(pos.x, pos.y);

    // 右键不处理（由contextmenu处理）
    if (e.button === 2) return;

    // diff 模式特殊处理
    if (Renderer.isDiffMode()) {
      _handleDiffMouseDown(e, pos, worldPos);
      return;
    }

    // 中键平移
    if (e.button === 1) {
      e.preventDefault();
      startPan(pos);
      return;
    }

    // 检查是否点中节点
    const hitNode = Renderer.hitTest(worldPos.x, worldPos.y, appState.nodes);

    if (hitNode) {
      // 节点拖拽
      if (e.shiftKey) {
        // Shift+点击：切换选中
        toggleSelect(hitNode);
      } else if (!selectedNodes.includes(hitNode)) {
        // 单选
        clearSelection();
        selectNode(hitNode);
      }
      startDrag(hitNode, worldPos, pos);
      showNodeDetail(hitNode);
    } else {
      // 检查是否点中分组
      const hitGroup = Renderer.hitTestGroup(worldPos.x, worldPos.y, appState.groups);
      if (hitGroup && hitGroup.collapsed) {
        // 点击折叠的分组：展开
        toggleGroupCollapse(hitGroup);
        return;
      }

      if (!e.shiftKey) {
        clearSelection();
      }

      // 空格键+拖拽 或 Alt 或 中键 → 平移
      if (spacePressed || e.altKey || e.button === 1) {
        startPan(pos);
      } else {
        // 框选
        startBoxSelect(pos);
      }
    }
  }

  function onMouseMove(e) {
    const pos = getCanvasPos(e);
    const worldPos = Renderer.screenToWorld(pos.x, pos.y);

    if (dragState.active && dragState.node) {
      // 计算世界坐标位移增量
      const dx = worldPos.x - dragState.lastWorldX;
      const dy = worldPos.y - dragState.lastWorldY;

      if (selectedNodes.length > 1 && selectedNodes.includes(dragState.node)) {
        // 多选拖拽：所有选中节点一起移动
        for (const n of selectedNodes) {
          n.x += dx;
          n.y += dy;
        }
      } else {
        dragState.node.x += dx;
        dragState.node.y += dy;
      }
      dragState.lastWorldX = worldPos.x;
      dragState.lastWorldY = worldPos.y;

      // 更新分组边界
      LayoutEngine.computeGroupBounds(appState.groups, appState.nodeMap);
      renderAll();
    } else if (panState.active) {
      // 平移画布
      const dx = pos.x - panState.startX;
      const dy = pos.y - panState.startY;
      Renderer.viewport.x = panState.startVpX + dx;
      Renderer.viewport.y = panState.startVpY + dy;
      canvasContainer.classList.add('dragging');
      renderAll();
    } else if (boxSelectState.active) {
      // 框选
      boxSelectState.currentX = pos.x;
      boxSelectState.currentY = pos.y;
      drawSelectionBox();
    } else {
      // 悬停效果
      const hitNode = Renderer.hitTest(worldPos.x, worldPos.y, appState.nodes);
      mainCanvas.style.cursor = hitNode ? 'pointer' : 'grab';
    }
  }

  function onMouseUp(e) {
    const pos = getCanvasPos(e);

    if (dragState.active) {
      endDrag();
    }
    if (panState.active) {
      endPan();
    }
    if (boxSelectState.active) {
      endBoxSelect(pos);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const pos = getCanvasPos(e);
    const delta = -e.deltaY * 0.001;
    const newScale = Renderer.viewport.scale * (1 + delta);
    const clampedScale = Math.max(Renderer.viewport.minScale, Math.min(Renderer.viewport.maxScale, newScale));

    // 以鼠标位置为中心缩放
    const worldBefore = Renderer.screenToWorld(pos.x, pos.y);
    Renderer.viewport.scale = clampedScale;
    const worldAfter = Renderer.screenToWorld(pos.x, pos.y);

    Renderer.viewport.x += (worldAfter.x - worldBefore.x) * clampedScale;
    Renderer.viewport.y += (worldAfter.y - worldBefore.y) * clampedScale;

    // 显示缩放指示器
    showZoomIndicator(clampedScale);
    renderAll();
  }

  function onDblClick(e) {
    const pos = getCanvasPos(e);
    const worldPos = Renderer.screenToWorld(pos.x, pos.y);

    const hitNode = Renderer.hitTest(worldPos.x, worldPos.y, appState.nodes);
    if (hitNode) {
      // 双击节点：居中并放大
      Renderer.centerOn(hitNode.x, hitNode.y, Math.max(Renderer.viewport.scale, 1.2));
      renderAll();
      return;
    }

    // 双击分组：折叠/展开
    const hitGroup = Renderer.hitTestGroup(worldPos.x, worldPos.y, appState.groups);
    if (hitGroup) {
      toggleGroupCollapse(hitGroup);
    }
  }

  // 触摸事件
  let lastTouchDist = 0;
  let lastTouchCenter = null;

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const pos = { x: touch.clientX - mainCanvas.getBoundingClientRect().left,
                    y: touch.clientY - mainCanvas.getBoundingClientRect().top };
      const worldPos = Renderer.screenToWorld(pos.x, pos.y);
      const hitNode = Renderer.hitTest(worldPos.x, worldPos.y, appState.nodes);
      if (hitNode) {
        clearSelection();
        selectNode(hitNode);
        startDrag(hitNode, worldPos, pos);
      } else {
        startPan(pos);
      }
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      lastTouchDist = Math.sqrt(dx * dx + dy * dy);
      lastTouchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - mainCanvas.getBoundingClientRect().left,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - mainCanvas.getBoundingClientRect().top,
      };
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && (dragState.active || panState.active)) {
      const touch = e.touches[0];
      const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
      onMouseMove(fakeEvent);
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastTouchDist > 0) {
        const scale = dist / lastTouchDist;
        Renderer.viewport.scale = Math.max(Renderer.viewport.minScale,
          Math.min(Renderer.viewport.maxScale, Renderer.viewport.scale * scale));
        renderAll();
      }
      lastTouchDist = dist;
    }
  }

  function onTouchEnd(e) {
    if (dragState.active) endDrag();
    if (panState.active) endPan();
    lastTouchDist = 0;
  }

  // --- 拖拽 ---
  function startDrag(node, worldPos, screenPos) {
    dragState.active = true;
    dragState.node = node;
    dragState.lastWorldX = worldPos.x;
    dragState.lastWorldY = worldPos.y;
    canvasContainer.classList.add('dragging');
  }

  function endDrag() {
    dragState.active = false;
    dragState.node = null;
    canvasContainer.classList.remove('dragging');
    // 自动保存布局
    if (appState.onLayoutChange) appState.onLayoutChange();
  }

  // --- 平移 ---
  function startPan(pos) {
    panState.active = true;
    panState.startX = pos.x;
    panState.startY = pos.y;
    panState.startVpX = Renderer.viewport.x;
    panState.startVpY = Renderer.viewport.y;
    canvasContainer.classList.add('dragging');
  }

  function endPan() {
    panState.active = false;
    canvasContainer.classList.remove('dragging');
  }

  // --- 框选 ---
  function startBoxSelect(pos) {
    boxSelectState.active = true;
    boxSelectState.startX = pos.x;
    boxSelectState.startY = pos.y;
    boxSelectState.currentX = pos.x;
    boxSelectState.currentY = pos.y;
    canvasContainer.classList.add('selecting');
  }

  function drawSelectionBox() {
    const box = document.getElementById('selection-box');
    const x = Math.min(boxSelectState.startX, boxSelectState.currentX);
    const y = Math.min(boxSelectState.startY, boxSelectState.currentY);
    const w = Math.abs(boxSelectState.currentX - boxSelectState.startX);
    const h = Math.abs(boxSelectState.currentY - boxSelectState.startY);

    box.classList.remove('hidden');
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  }

  function endBoxSelect(pos) {
    boxSelectState.active = false;
    canvasContainer.classList.remove('selecting');
    document.getElementById('selection-box').classList.add('hidden');

    const x1 = Math.min(boxSelectState.startX, boxSelectState.currentX);
    const y1 = Math.min(boxSelectState.startY, boxSelectState.currentY);
    const x2 = Math.max(boxSelectState.startX, boxSelectState.currentX);
    const y2 = Math.max(boxSelectState.startY, boxSelectState.currentY);

    // 太小的框选视为点击
    if (x2 - x1 < 5 && y2 - y1 < 5) {
      renderAll();
      return;
    }

    const w1 = Renderer.screenToWorld(x1, y1);
    const w2 = Renderer.screenToWorld(x2, y2);

    clearSelection();
    for (const node of appState.nodes) {
      if (node._visible === false) continue;
      if (node.x >= w1.x && node.x <= w2.x && node.y >= w1.y && node.y <= w2.y) {
        selectNode(node);
      }
    }
    renderAll();
  }

  // --- 选中管理 ---
  function selectNode(node) {
    node._selected = true;
    if (!selectedNodes.includes(node)) {
      selectedNodes.push(node);
    }
    appState.selectedNodes = selectedNodes;
  }

  function toggleSelect(node) {
    if (selectedNodes.includes(node)) {
      deselectNode(node);
    } else {
      selectNode(node);
    }
  }

  function deselectNode(node) {
    node._selected = false;
    selectedNodes = selectedNodes.filter(n => n !== node);
    appState.selectedNodes = selectedNodes;
  }

  function clearSelection() {
    for (const n of selectedNodes) n._selected = false;
    selectedNodes = [];
    appState.selectedNodes = selectedNodes;
    hideDetail();
  }

  function selectNodesByIds(ids) {
    clearSelection();
    for (const id of ids) {
      const node = appState.nodeMap.get(id);
      if (node) selectNode(node);
    }
    renderAll();
  }

  /**
   * 完全重置交互状态（导入新拓扑时调用）
   * 清空选区、高亮、搜索、筛选、面板
   */
  function resetState() {
    // 清空选中
    clearSelection();

    // 清空所有高亮
    clearHighlights();

    // 清空搜索
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    const searchResults = document.getElementById('search-results');
    if (searchResults) searchResults.classList.remove('visible');

    // 重置所有节点可见性（筛选状态）
    if (appState.nodes) {
      for (const n of appState.nodes) {
        n._visible = true;
        n._selected = false;
        n._highlighted = false;
      }
    }
    if (appState.links) {
      for (const l of appState.links) {
        l._visible = true;
        l._highlighted = false;
      }
    }

    // 重置筛选复选框
    document.querySelectorAll('#type-filters input').forEach(cb => {
      cb.checked = true;
    });

    // 关闭面板
    hideDetail();
    hideImpact();
    const tracePanel = document.getElementById('trace-panel');
    if (tracePanel) tracePanel.classList.add('hidden');
  }

  // --- 分组折叠 ---
  function toggleGroupCollapse(group) {
    group.collapsed = !group.collapsed;

    if (group.collapsed) {
      // 隐藏子节点
      for (const childId of group.children) {
        const child = appState.nodeMap.get(childId);
        if (child) child._visible = false;
      }
    } else {
      // 显示子节点
      for (const childId of group.children) {
        const child = appState.nodeMap.get(childId);
        if (child) child._visible = true;
      }
    }

    LayoutEngine.computeGroupBounds(appState.groups, appState.nodeMap);
    updateGroupList();
    renderAll();
  }

  function collapseAllGroups() {
    for (const group of appState.groups) {
      if (!group.collapsed) {
        group.collapsed = true;
        for (const childId of group.children) {
          const child = appState.nodeMap.get(childId);
          if (child) child._visible = false;
        }
      }
    }
    LayoutEngine.computeGroupBounds(appState.groups, appState.nodeMap);
    updateGroupList();
    renderAll();
  }

  function expandAllGroups() {
    for (const group of appState.groups) {
      group.collapsed = false;
      for (const childId of group.children) {
        const child = appState.nodeMap.get(childId);
        if (child) child._visible = true;
      }
    }
    LayoutEngine.computeGroupBounds(appState.groups, appState.nodeMap);
    updateGroupList();
    renderAll();
  }

  // --- 右键菜单 ---
  function bindContextMenu() {
    const menu = document.getElementById('context-menu');

    mainCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pos = getCanvasPos(e);
      const worldPos = Renderer.screenToWorld(pos.x, pos.y);
      const hitNode = Renderer.hitTest(worldPos.x, worldPos.y, appState.nodes);
      const hitGroup = Renderer.hitTestGroup(worldPos.x, worldPos.y, appState.groups);

      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.remove('hidden');
      menu._targetNode = hitNode;
      menu._targetGroup = hitGroup;
    });

    document.addEventListener('click', () => {
      menu.classList.add('hidden');
    });

    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        const node = menu._targetNode;
        const group = menu._targetGroup;

        switch (action) {
          case 'view-detail':
            if (node) showNodeDetail(node);
            break;
          case 'trace-up':
            if (node) showTrace(node, 'upstream');
            break;
          case 'trace-down':
            if (node) showTrace(node, 'downstream');
            break;
          case 'collapse-group':
            if (group && !group.collapsed) toggleGroupCollapse(group);
            break;
          case 'expand-group':
            if (group && group.collapsed) toggleGroupCollapse(group);
            break;
          case 'pin-node':
            if (node) { node.pinned = true; renderAll(); }
            break;
          case 'unpin-node':
            if (node) { node.pinned = false; renderAll(); }
            break;
        }
        menu.classList.add('hidden');
      });
    });
  }

  // --- 搜索 ---
  function bindSearchEvents() {
    const input = document.getElementById('search-input');
    const dropdown = document.getElementById('search-results');

    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      if (!query) {
        dropdown.classList.remove('visible');
        clearHighlights();
        renderAll();
        return;
      }

      const results = appState.nodes.filter(n =>
        n.label.toLowerCase().includes(query) ||
        n.id.toLowerCase().includes(query) ||
        (n.type && n.type.includes(query))
      ).slice(0, 10);

      if (results.length === 0) {
        dropdown.innerHTML = '<div class="search-result-item" style="color:var(--text-muted)">未找到匹配节点</div>';
      } else {
        dropdown.innerHTML = results.map(n => {
          const typeInfo = DataParser.NODE_TYPES[n.type];
          return `<div class="search-result-item" data-id="${n.id}">
            <span>${typeInfo?.icon || '⬡'}</span>
            <span>${escapeHtml(n.label)}</span>
            <span class="type-badge">${typeInfo?.label || n.type}</span>
          </div>`;
        }).join('');
      }

      dropdown.classList.add('visible');

      // 高亮匹配节点
      clearHighlights();
      for (const n of results) n._highlighted = true;
      renderAll();
    });

    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.search-result-item');
      if (!item || !item.dataset.id) return;

      const node = appState.nodeMap.get(item.dataset.id);
      if (node) {
        // 如果节点在折叠的分组中，先展开
        if (node._visible === false) {
          for (const group of appState.groups) {
            if (group.collapsed && group.children.includes(node.id)) {
              toggleGroupCollapse(group);
              break;
            }
          }
        }
        clearSelection();
        selectNode(node);
        Renderer.centerOn(node.x, node.y, Math.max(Renderer.viewport.scale, 1));
        showNodeDetail(node);
        renderAll();
      }

      dropdown.classList.remove('visible');
      input.value = '';
      clearHighlights();
    });

    input.addEventListener('blur', () => {
      setTimeout(() => dropdown.classList.remove('visible'), 200);
    });

    input.addEventListener('focus', () => {
      if (input.value.trim()) {
        input.dispatchEvent(new Event('input'));
      }
    });
  }

  function clearHighlights() {
    for (const n of appState.nodes) n._highlighted = false;
    for (const l of appState.links) l._highlighted = false;
  }

  // --- 筛选 ---
  function bindFilterEvents() {
    document.querySelectorAll('#type-filters input').forEach(cb => {
      cb.addEventListener('change', () => {
        const type = cb.dataset.type;
        const visible = cb.checked;
        for (const node of appState.nodes) {
          if (node.type === type) node._visible = visible;
        }
        // 更新连线可见性
        for (const link of appState.links) {
          const src = appState.nodeMap.get(link.source);
          const tgt = appState.nodeMap.get(link.target);
          link._visible = src?._visible !== false && tgt?._visible !== false;
        }
        LayoutEngine.computeGroupBounds(appState.groups, appState.nodeMap);
        renderAll();
        updateStats();
      });
    });
  }

  // --- 键盘事件 ---
  function bindKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+F: 搜索
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        document.getElementById('search-input').focus();
      }

      // Ctrl+A: 全选
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        clearSelection();
        for (const n of appState.nodes) {
          if (n._visible !== false) selectNode(n);
        }
        renderAll();
      }

      // Escape: 取消选中
      if (e.key === 'Escape') {
        clearSelection();
        clearHighlights();
        document.getElementById('search-input').value = '';
        document.getElementById('search-results').classList.remove('visible');
        renderAll();
      }

      // F: 适应画布
      if (e.key === 'f' && !e.ctrlKey && !isInputFocused()) {
        Renderer.fitToView(appState.nodes);
        renderAll();
      }

      // Delete: 取消固定
      if (e.key === 'Delete' && selectedNodes.length > 0) {
        for (const n of selectedNodes) n.pinned = false;
        renderAll();
      }

      // Ctrl+I: 导入
      if (e.ctrlKey && e.key === 'i') {
        e.preventDefault();
        document.getElementById('btn-import').click();
      }

      // Ctrl+E: 导出
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        document.getElementById('btn-export').click();
      }

      // Space: 开始平移模式
      if (e.key === ' ' && !isInputFocused()) {
        e.preventDefault();
        spacePressed = true;
        mainCanvas.style.cursor = 'grab';
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        spacePressed = false;
        mainCanvas.style.cursor = 'default';
      }
    });
  }

  function isInputFocused() {
    const active = document.activeElement;
    return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
  }

  // --- 节点详情 ---
  function showNodeDetail(node) {
    const panel = document.getElementById('detail-panel');
    const content = document.getElementById('detail-content');
    const typeInfo = DataParser.NODE_TYPES[node.type];
    const statusInfo = DataParser.STATUS_TYPES[node.status];

    // 统计连入连出
    const inLinks = appState.links.filter(l => l.target === node.id);
    const outLinks = appState.links.filter(l => l.source === node.id);

    let metaHtml = '';
    if (node.metadata && Object.keys(node.metadata).length > 0) {
      metaHtml = '<div style="margin-top:8px;"><strong style="font-size:11px;color:var(--text-secondary)">元数据</strong>';
      for (const [k, v] of Object.entries(node.metadata)) {
        metaHtml += `<div class="detail-row"><span class="detail-label">${escapeHtml(k)}</span><span class="detail-value">${escapeHtml(String(v))}</span></div>`;
      }
      metaHtml += '</div>';
    }

    content.innerHTML = `
      <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">${escapeHtml(node.id)}</span></div>
      <div class="detail-row"><span class="detail-label">名称</span><span class="detail-value">${escapeHtml(node.label)}</span></div>
      <div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">${typeInfo?.icon || ''} ${typeInfo?.label || node.type}</span></div>
      <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value"><span class="status-badge ${node.status}">${statusInfo?.label || node.status}</span></span></div>
      <div class="detail-row"><span class="detail-label">分组</span><span class="detail-value">${node.group || '-'}</span></div>
      <div class="detail-row"><span class="detail-label">坐标</span><span class="detail-value">(${Math.round(node.x)}, ${Math.round(node.y)})</span></div>
      <div class="detail-row"><span class="detail-label">固定</span><span class="detail-value">${node.pinned ? '是' : '否'}</span></div>
      <div class="detail-row"><span class="detail-label">连入</span><span class="detail-value">${inLinks.length}</span></div>
      <div class="detail-row"><span class="detail-label">连出</span><span class="detail-value">${outLinks.length}</span></div>
      ${metaHtml}
    `;

    panel.classList.remove('hidden');
  }

  function hideDetail() {
    document.getElementById('detail-panel').classList.add('hidden');
  }

  // --- 依赖追踪 ---
  function showTrace(node, direction) {
    const panel = document.getElementById('trace-panel');
    const content = document.getElementById('trace-content');

    const upstream = DataParser.traceUpstream(node.id, appState.links, appState.nodeMap);
    const downstream = DataParser.traceDownstream(node.id, appState.links, appState.nodeMap);

    // 高亮追踪路径
    clearHighlights();
    node._highlighted = true;
    for (const n of upstream) n._highlighted = true;
    for (const n of downstream) n._highlighted = true;

    // 高亮相关连线
    const highlightedIds = new Set([node.id, ...upstream.map(n => n.id), ...downstream.map(n => n.id)]);
    for (const link of appState.links) {
      if (highlightedIds.has(link.source) && highlightedIds.has(link.target)) {
        link._highlighted = true;
      }
    }

    const renderNodeList = (nodes) => nodes.map(n => {
      const typeInfo = DataParser.NODE_TYPES[n.type];
      return `<div class="trace-node" data-id="${n.id}">
        <span class="trace-icon">${typeInfo?.icon || '⬡'}</span>
        <span>${escapeHtml(n.label)}</span>
        <span class="status-badge ${n.status}" style="font-size:9px">${n.status}</span>
      </div>`;
    }).join('');

    content.innerHTML = `
      <div style="margin-bottom:8px;padding:4px 6px;background:var(--bg-secondary);border-radius:4px;">
        <strong>${DataParser.NODE_TYPES[node.type]?.icon} ${escapeHtml(node.label)}</strong>
        <span class="status-badge ${node.status}" style="margin-left:4px">${node.status}</span>
      </div>
      <div class="trace-section">
        <h4>⬆️ 上游受影响 (${upstream.length})</h4>
        <div class="trace-path">${upstream.length > 0 ? renderNodeList(upstream) : '<div style="color:var(--text-muted);font-size:11px;padding:4px">无上游节点</div>'}</div>
      </div>
      <div class="trace-section">
        <h4>⬇️ 下游依赖 (${downstream.length})</h4>
        <div class="trace-path">${downstream.length > 0 ? renderNodeList(downstream) : '<div style="color:var(--text-muted);font-size:11px;padding:4px">无下游节点</div>'}</div>
      </div>
    `;

    // 点击追踪节点定位
    content.querySelectorAll('.trace-node').forEach(el => {
      el.addEventListener('click', () => {
        const targetNode = appState.nodeMap.get(el.dataset.id);
        if (targetNode) {
          Renderer.centerOn(targetNode.x, targetNode.y);
          clearSelection();
          selectNode(targetNode);
          showNodeDetail(targetNode);
          renderAll();
        }
      });
    });

    panel.classList.remove('hidden');
    renderAll();
  }

  // --- UI更新 ---
  function showZoomIndicator(scale) {
    const indicator = document.getElementById('zoom-indicator');
    indicator.textContent = Math.round(scale * 100) + '%';
    indicator.classList.remove('hidden');
    clearTimeout(indicator._timeout);
    indicator._timeout = setTimeout(() => indicator.classList.add('hidden'), 1500);
  }

  function updateStats() {
    const visibleNodes = appState.nodes.filter(n => n._visible !== false);
    const visibleLinks = appState.links.filter(l => l._visible !== false);
    document.getElementById('stat-nodes').textContent = visibleNodes.length;
    document.getElementById('stat-links').textContent = visibleLinks.length;
    document.getElementById('stat-groups').textContent = appState.groups.length;
    document.getElementById('stat-alerts').textContent = appState.alerts.length;
  }

  function updateGroupList() {
    const list = document.getElementById('group-list');
    list.innerHTML = appState.groups.map(g => `
      <div class="group-item ${g.collapsed ? 'collapsed' : ''}" data-group-id="${g.id}">
        <span><span class="collapse-icon">▼</span> ${escapeHtml(g.label)}</span>
        <span class="group-count">${g.children.length}</span>
      </div>
    `).join('');

    list.querySelectorAll('.group-item').forEach(el => {
      el.addEventListener('click', () => {
        const group = appState.groups.find(g => g.id === el.dataset.groupId);
        if (group) {
          // 定位到分组中心
          if (group._bounds) {
            const cx = group._bounds.x + group._bounds.width / 2;
            const cy = group._bounds.y + group._bounds.height / 2;
            Renderer.centerOn(cx, cy);
            renderAll();
          }
        }
      });

      el.addEventListener('dblclick', () => {
        const group = appState.groups.find(g => g.id === el.dataset.groupId);
        if (group) toggleGroupCollapse(group);
      });
    });
  }

  function updateEventList(alerts, currentIndex) {
    const list = document.getElementById('event-list');
    const count = document.getElementById('alert-count');
    count.textContent = alerts.length;
    count.classList.toggle('zero', alerts.length === 0);

    list.innerHTML = alerts.map((alert, i) => {
      const time = new Date(alert.timestamp).toLocaleTimeString();
      const severity = alert.severity || 'warning';
      return `<div class="event-item ${severity} ${i === currentIndex ? 'active' : ''}" data-index="${i}">
        <div class="event-time">${time}</div>
        <div class="event-msg">${escapeHtml(alert.message)}</div>
        ${alert.nodeId ? `<div class="event-node">📍 ${escapeHtml(alert.nodeId)}</div>` : ''}
      </div>`;
    }).join('');

    list.querySelectorAll('.event-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        if (appState.onAlertClick) appState.onAlertClick(idx);
      });
    });

    // 滚动到当前事件
    const activeItem = list.querySelector('.event-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function showImpact(nodeId) {
    const panel = document.getElementById('impact-panel');
    const content = document.getElementById('impact-content');

    const upstream = DataParser.traceUpstream(nodeId, appState.links, appState.nodeMap);
    const downstream = DataParser.traceDownstream(nodeId, appState.links, appState.nodeMap);
    const affected = [...new Set([...upstream, ...downstream])];

    if (affected.length === 0) {
      panel.classList.add('hidden');
      return;
    }

    content.innerHTML = affected.map(n => {
      const typeInfo = DataParser.NODE_TYPES[n.type];
      return `<div class="impact-item">
        <span class="impact-icon">${typeInfo?.icon || '⬡'}</span>
        <span>${escapeHtml(n.label)}</span>
        <span class="status-badge ${n.status}" style="font-size:9px;margin-left:auto">${n.status}</span>
      </div>`;
    }).join('');

    panel.classList.remove('hidden');
  }

  function hideImpact() {
    document.getElementById('impact-panel').classList.add('hidden');
  }

  /**
   * diff 模式鼠标处理
   */
  function _handleDiffMouseDown(e, pos, worldPos) {
    const nodes = TopoDiff.getMergedNodes();
    const hitNode = Renderer.hitTest(worldPos.x, worldPos.y, nodes);

    if (hitNode) {
      if (hitNode._diffState === 'removed') return; // ghost 不可拖拽

      // 拖拽
      if (!e.shiftKey) {
        clearSelection();
        selectNode(hitNode);
      }
      startDrag(hitNode, worldPos, pos);

      // 检查传播链
      const chains = FaultReplay.getChainsForNode(hitNode.id);
      if (chains.length > 0) {
        FaultReplay.highlightChain(chains[0].chainId);
        const chain = chains[0];
        for (const bizId of chain.affectedBusinessNodes) {
          const node = TopoDiff.getMergedNodeMap().get(bizId);
          if (node) node._highlighted = true;
        }
        // 高亮上游
        FaultReplay.highlightUpstreamFrom(hitNode.id, TopoDiff.getMergedLinks(), TopoDiff.getMergedNodeMap());
      }

      // 显示差异 tooltip
      _showDiffTooltip(hitNode);
      renderAll();
    } else {
      if (!e.shiftKey) clearSelection();
      if (spacePressed || e.altKey || e.button === 1) {
        startPan(pos);
      }
    }
  }

  /**
   * 显示差异 tooltip
   */
  function _showDiffTooltip(node) {
    const panel = document.getElementById('detail-panel');
    const content = document.getElementById('detail-content');
    const typeInfo = DataParser.NODE_TYPES[node.type];

    let diffHtml = '';
    const diffResult = TopoDiff.getDiffResult();
    if (diffResult) {
      const changeInfo = diffResult.nodesChanged.find(c => c.id === node.id);
      if (changeInfo) {
        diffHtml = '<div style="margin-top:8px;"><strong style="font-size:11px;color:#f59e0b">变更详情</strong>';
        for (const change of changeInfo.changes) {
          diffHtml += `<div class="detail-row"><span class="detail-label">${escapeHtml(change.field)}</span><span class="detail-value" style="color:#ef4444">${escapeHtml(String(change.from || '-'))}</span> → <span class="detail-value" style="color:#22c55e">${escapeHtml(String(change.to || '-'))}</span></div>`;
        }
        diffHtml += '</div>';
      }
    }

    // 传播链信息
    const chains = FaultReplay.getChainsForNode(node.id);
    let chainHtml = '';
    if (chains.length > 0) {
      chainHtml = '<div style="margin-top:8px;"><strong style="font-size:11px;color:#ef4444">传播链</strong>';
      for (const chain of chains) {
        const step = chain.steps.find(s => s.nodeId === node.id);
        chainHtml += `<div class="detail-row"><span class="detail-label">链</span><span class="detail-value">${escapeHtml(chain.chainId)} (步骤 #${step ? step.order : '?'})</span></div>`;
      }
      chainHtml += '</div>';
    }

    const diffStateLabels = { added: '🟢 新增', removed: '🔴 已删除', changed: '🟡 已变更', unchanged: '⚪ 不变' };

    content.innerHTML = `
      <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">${escapeHtml(node.id)}</span></div>
      <div class="detail-row"><span class="detail-label">名称</span><span class="detail-value">${escapeHtml(node.label)}</span></div>
      <div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">${typeInfo?.icon || ''} ${typeInfo?.label || node.type}</span></div>
      <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value">${node.status}</span></div>
      <div class="detail-row"><span class="detail-label">差异</span><span class="detail-value">${diffStateLabels[node._diffState] || node._diffState}</span></div>
      ${diffHtml}
      ${chainHtml}
    `;
    panel.classList.remove('hidden');
  }

  /**
   * 绑定 diff 告警列表事件
   */
  function bindDiffAlarmEvents() {
    const list = document.getElementById('diff-alarm-list');
    if (!list) return;

    list.addEventListener('click', (e) => {
      const item = e.target.closest('.diff-alarm-item');
      if (!item) return;
      const alertId = item.dataset.alertId;
      const alerts = TopoDiff.getAlerts();
      const alert = alerts.find(a => a.id === alertId);
      if (!alert) return;

      // 跳转到该告警
      FaultReplay.jumpToAlert(alert, alerts);

      // 高亮链
      const chain = FaultReplay.getChainForAlert(alertId);
      if (chain) {
        const step = chain.steps.find(s => s.alertId === alertId);
        FaultReplay.highlightChainUpTo(chain.chainId, step ? step.order : 0);
        FaultReplay.highlightAffectedBusiness(chain);
        // 高亮上游依赖
        if (alert.nodeId) {
          FaultReplay.highlightUpstreamFrom(alert.nodeId, TopoDiff.getMergedLinks(), TopoDiff.getMergedNodeMap());
        }
      }

      renderAll();
    });
  }

  /**
   * 更新 diff 告警列表
   */
  function updateDiffAlarmList(alerts, currentIndex) {
    const list = document.getElementById('diff-alarm-list');
    if (!list) return;

    const severityIcons = { critical: '🔴', warning: '🟠', info: '🟡', normal: '🟢' };

    list.innerHTML = alerts.map((alert, i) => {
      const time = new Date(alert.timestamp).toLocaleTimeString();
      const icon = severityIcons[alert.severity] || '⚪';
      const chain = FaultReplay.getChainForAlert(alert.id);
      return `<div class="diff-alarm-item ${i === currentIndex ? 'active' : ''} ${chain ? 'in-chain' : ''}" data-alert-id="${escapeHtml(alert.id)}">
        <span class="alarm-icon">${icon}</span>
        <div class="alarm-info">
          <div class="alarm-time">${time}</div>
          <div class="alarm-msg">${escapeHtml(alert.message)}</div>
          ${alert.nodeId ? `<div class="alarm-node">📍 ${escapeHtml(alert.nodeId)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    // 滚动到当前
    const active = list.querySelector('.diff-alarm-item.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * 获取固定节点位置
   */
  function getPinnedPositions() {
    const positions = {};
    for (const n of appState.nodes) {
      if (n.pinned) {
        positions[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
      }
    }
    return positions;
  }

  function renderAll() {
    Renderer.render(appState);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    init,
    resetState,
    selectNode,
    clearSelection,
    selectNodesByIds,
    clearHighlights,
    toggleGroupCollapse,
    collapseAllGroups,
    expandAllGroups,
    showNodeDetail,
    showTrace,
    showImpact,
    hideImpact,
    updateStats,
    updateGroupList,
    updateEventList,
    renderAll,
    getSelectedNodes: () => selectedNodes,
    bindDiffAlarmEvents,
    updateDiffAlarmList,
    getPinnedPositions,
    _showDiffTooltip,
  };
})();
