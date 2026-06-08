/**
 * interaction.js — 交互模块
 * 负责拖拽、缩放、框选、搜索、节点详情、影响分析、分组面板、键盘快捷键
 */
window.Interaction = (function () {
  'use strict';

  var canvas, appState;
  var isDraggingCanvas = false;
  var isDraggingNode = false;
  var isSelecting = false;
  var dragStartX = 0, dragStartY = 0;
  var dragNodeId = null;
  var dragNodeOffsetX = 0, dragNodeOffsetY = 0;
  var draggedNodeIds = []; // 多选拖拽
  var selectStartWorld = null;
  var lastMouseX = 0, lastMouseY = 0;

  /* ─── 初始化 ─── */
  function init(canvasEl, state) {
    canvas = canvasEl;
    appState = state;
    var container = document.getElementById('canvas-container');

    // 鼠标事件
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // 搜索
    var searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', onSearchInput);
      searchInput.addEventListener('focus', function () {
        if (searchInput.value.trim()) onSearchInput();
      });
      searchInput.addEventListener('blur', function () {
        setTimeout(function () {
          var results = document.getElementById('search-results');
          if (results) results.classList.add('hidden');
        }, 200);
      });
    }

    // 详情面板关闭
    var closeBtn = document.getElementById('btn-close-detail');
    if (closeBtn) closeBtn.addEventListener('click', hideDetail);

    // 小地图导航
    var minimap = document.getElementById('minimap-canvas');
    if (minimap) {
      minimap.addEventListener('mousedown', onMinimapClick);
    }

    // 时间线点击
    var timelineTrack = document.getElementById('timeline-track');
    if (timelineTrack) {
      timelineTrack.addEventListener('click', onTimelineClick);
    }

    // 键盘快捷键
    document.addEventListener('keydown', onKeyDown);
  }

  /* ─── 鼠标按下 ─── */
  function onMouseDown(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    var hitNode = Renderer.nodeAt(sx, sy);

    if (e.shiftKey && !hitNode) {
      // Shift + 空白区域 = 框选
      isSelecting = true;
      selectStartWorld = Renderer.screenToWorld(sx, sy);
      appState.selectRect = { x: selectStartWorld.x, y: selectStartWorld.y, w: 0, h: 0 };
      canvas.parentElement.classList.add('selecting');
      return;
    }

    if (hitNode) {
      // 点击节点
      if (e.shiftKey) {
        // Shift + 点击 = 切换选中
        if (!appState.selection) appState.selection = new Set();
        if (appState.selection.has(hitNode.id)) {
          appState.selection.delete(hitNode.id);
        } else {
          appState.selection.add(hitNode.id);
        }
        Renderer.requestRender();
      } else {
        // 普通点击 = 选中并准备拖拽
        if (!appState.selection || !appState.selection.has(hitNode.id)) {
          appState.selection = new Set([hitNode.id]);
        }
        isDraggingNode = true;
        dragNodeId = hitNode.id;
        var world = Renderer.screenToWorld(sx, sy);
        dragNodeOffsetX = world.x - hitNode.x;
        dragNodeOffsetY = world.y - hitNode.y;

        // 收集多选拖拽的节点
        draggedNodeIds = [];
        if (appState.selection && appState.selection.size > 1) {
          appState.selection.forEach(function (id) { draggedNodeIds.push(id); });
        } else {
          draggedNodeIds = [hitNode.id];
        }

        canvas.parentElement.classList.add('dragging');
      }
      Renderer.requestRender();
      return;
    }

    // 空白区域拖拽画布
    isDraggingCanvas = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    canvas.parentElement.classList.add('dragging');
  }

  /* ─── 鼠标移动 ─── */
  function onMouseMove(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;

    // 悬停效果
    if (!isDraggingCanvas && !isDraggingNode && !isSelecting) {
      var hitNode = Renderer.nodeAt(sx, sy);
      Renderer.setHoveredNode(hitNode ? hitNode.id : null);
      canvas.style.cursor = hitNode ? 'pointer' : 'grab';
    }

    if (isDraggingCanvas) {
      var vp = Renderer.getViewport();
      var dx = e.clientX - lastMouseX;
      var dy = e.clientY - lastMouseY;
      Renderer.setViewport(vp.x + dx, vp.y + dy, vp.scale);
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      updateZoomDisplay();
      return;
    }

    if (isDraggingNode && draggedNodeIds.length > 0) {
      var world = Renderer.screenToWorld(sx, sy);
      var mainNode = appState.nodeMap.get(dragNodeId);
      if (!mainNode) return;

      var newX = world.x - dragNodeOffsetX;
      var newY = world.y - dragNodeOffsetY;
      var deltaX = newX - mainNode.x;
      var deltaY = newY - mainNode.y;

      // 移动所有选中的节点
      draggedNodeIds.forEach(function (id) {
        var node = appState.nodeMap.get(id);
        if (node) {
          node.x += deltaX;
          node.y += deltaY;
          if (appState.positions) {
            appState.positions[id] = { x: node.x, y: node.y };
          }
        }
      });

      Renderer.requestRender();
      return;
    }

    if (isSelecting && selectStartWorld) {
      var currentWorld = Renderer.screenToWorld(sx, sy);
      appState.selectRect = {
        x: Math.min(selectStartWorld.x, currentWorld.x),
        y: Math.min(selectStartWorld.y, currentWorld.y),
        w: Math.abs(currentWorld.x - selectStartWorld.x),
        h: Math.abs(currentWorld.y - selectStartWorld.y)
      };
      Renderer.requestRender();
    }
  }

  /* ─── 鼠标抬起 ─── */
  function onMouseUp(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;

    if (isSelecting && selectStartWorld) {
      var endWorld = Renderer.screenToWorld(sx, sy);
      var selected = Renderer.nodesInRect(
        Math.min(selectStartWorld.x, endWorld.x),
        Math.min(selectStartWorld.y, endWorld.y),
        Math.max(selectStartWorld.x, endWorld.x),
        Math.max(selectStartWorld.y, endWorld.y)
      );
      appState.selection = new Set(selected.map(function (n) { return n.id; }));
      if (selected.length > 0) {
        ImportExport.showToast('选中 ' + selected.length + ' 个节点', 'info');
      }
    }

    if (isDraggingNode) {
      // 拖拽结束，保存布局
      scheduleLayoutSave();
    }

    // 如果是单击（未拖拽），显示详情
    if (!isDraggingCanvas && !isSelecting && isDraggingNode) {
      var dx = Math.abs(e.clientX - lastMouseX);
      var dy = Math.abs(e.clientY - lastMouseY);
      if (dx < 3 && dy < 3) {
        // 单击 - 已在mousedown中处理了selection
      }
    }

    // 重置状态
    isDraggingCanvas = false;
    isDraggingNode = false;
    isSelecting = false;
    selectStartWorld = null;
    appState.selectRect = null;
    dragNodeId = null;
    draggedNodeIds = [];
    canvas.parentElement.classList.remove('dragging', 'selecting');
    Renderer.requestRender();
  }

  /* ─── 滚轮缩放 ─── */
  function onWheel(e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;

    var vp = Renderer.getViewport();
    var zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    var newScale = Math.max(0.1, Math.min(3, vp.scale * zoomFactor));

    // 以鼠标位置为中心缩放
    var wx = (mx - vp.x) / vp.scale;
    var wy = (my - vp.y) / vp.scale;
    var newX = mx - wx * newScale;
    var newY = my - wy * newScale;

    Renderer.setViewport(newX, newY, newScale);
    updateZoomDisplay();
  }

  /* ─── 双击 ─── */
  function onDoubleClick(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    var hitNode = Renderer.nodeAt(sx, sy);

    if (hitNode) {
      showDetail(hitNode.id);
    }
  }

  /* ─── 搜索 ─── */
  function onSearchInput() {
    var input = document.getElementById('search-input');
    var resultsEl = document.getElementById('search-results');
    if (!input || !resultsEl || !appState || !appState.nodes) return;

    var query = input.value.trim().toLowerCase();
    if (!query) {
      resultsEl.classList.add('hidden');
      Renderer.clearHighlights();
      return;
    }

    var matches = appState.nodes.filter(function (n) {
      return n.name.toLowerCase().indexOf(query) !== -1 ||
             n.id.toLowerCase().indexOf(query) !== -1 ||
             (n.ip && n.ip.toLowerCase().indexOf(query) !== -1);
    }).slice(0, 10);

    resultsEl.innerHTML = '';
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="search-item" style="color:#6b7280">无匹配结果</div>';
    } else {
      matches.forEach(function (node) {
        var item = document.createElement('div');
        item.className = 'search-item';
        item.innerHTML = '<span class="node-type-badge">' + (DataParser.TYPE_LABELS[node.type] || node.type) + '</span>' +
          '<span>' + highlightMatch(node.name, query) + '</span>';
        item.addEventListener('click', function () {
          focusAndSelect(node.id);
          resultsEl.classList.add('hidden');
          input.value = node.name;
        });
        resultsEl.appendChild(item);
      });
    }
    resultsEl.classList.remove('hidden');

    // 高亮匹配的节点
    Renderer.setHighlightedNodes(matches.map(function (n) { return n.id; }));
  }

  function highlightMatch(text, query) {
    var idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return text;
    return text.substring(0, idx) + '<b style="color:#4f9cf7">' + text.substring(idx, idx + query.length) + '</b>' + text.substring(idx + query.length);
  }

  /* ─── 节点详情面板 ─── */
  function showDetail(nodeId) {
    var panel = document.getElementById('detail-panel');
    var content = document.getElementById('detail-content');
    var title = document.getElementById('detail-title');
    var impactSection = document.getElementById('impact-section');
    if (!panel || !content || !appState || !appState.nodeMap) return;

    var node = appState.nodeMap.get(nodeId);
    if (!node) return;

    title.textContent = node.name;
    panel.classList.remove('hidden');

    var status = node._alarmStatus || node.status;
    var statusLabel = { normal: '正常', warning: '告警', critical: '故障', offline: '离线' };

    var html = '';
    html += '<div class="detail-field"><div class="detail-label">ID</div><div class="detail-value">' + node.id + '</div></div>';
    html += '<div class="detail-field"><div class="detail-label">类型</div><div class="detail-value">' + (DataParser.TYPE_LABELS[node.type] || node.type) + '</div></div>';
    html += '<div class="detail-field"><div class="detail-label">状态</div><div class="detail-value"><span class="status-badge ' + status + '">' + (statusLabel[status] || status) + '</span></div></div>';
    if (node.ip) html += '<div class="detail-field"><div class="detail-label">IP</div><div class="detail-value">' + node.ip + '</div></div>';
    if (node.group) html += '<div class="detail-field"><div class="detail-label">分组</div><div class="detail-value">' + node.group + '</div></div>';
    if (node.description) html += '<div class="detail-field"><div class="detail-label">描述</div><div class="detail-value">' + node.description + '</div></div>';

    if (node.details && Object.keys(node.details).length > 0) {
      Object.keys(node.details).forEach(function (key) {
        html += '<div class="detail-field"><div class="detail-label">' + key + '</div><div class="detail-value">' + node.details[key] + '</div></div>';
      });
    }

    content.innerHTML = html;

    // 影响分析
    showImpactAnalysis(nodeId);

    // 高亮选中节点
    appState.selection = new Set([nodeId]);
    Renderer.requestRender();
  }

  function showImpactAnalysis(nodeId) {
    var impactSection = document.getElementById('impact-section');
    var upstreamList = document.getElementById('upstream-list');
    var downstreamList = document.getElementById('downstream-list');
    if (!impactSection || !upstreamList || !downstreamList) return;

    var upstream = DataParser.traceUpstream(nodeId, appState.nodes, appState.edges);
    var downstream = DataParser.traceDownstream(nodeId, appState.nodes, appState.edges);

    if (upstream.length === 0 && downstream.length === 0) {
      impactSection.classList.add('hidden');
      return;
    }
    impactSection.classList.remove('hidden');

    // 渲染上游列表
    upstreamList.innerHTML = '';
    if (upstream.length === 0) {
      upstreamList.innerHTML = '<li style="color:#6b7280">无上游依赖</li>';
    } else {
      upstream.forEach(function (nid) {
        var node = appState.nodeMap.get(nid);
        if (!node) return;
        var li = document.createElement('li');
        li.innerHTML = '<span class="impact-type">' + (DataParser.TYPE_LABELS[node.type] || '') + '</span>' + node.name;
        li.addEventListener('click', function () {
          focusAndSelect(nid);
          showDetail(nid);
        });
        upstreamList.appendChild(li);
      });
    }

    // 渲染下游列表
    downstreamList.innerHTML = '';
    if (downstream.length === 0) {
      downstreamList.innerHTML = '<li style="color:#6b7280">无下游设备</li>';
    } else {
      downstream.forEach(function (nid) {
        var node = appState.nodeMap.get(nid);
        if (!node) return;
        var li = document.createElement('li');
        li.innerHTML = '<span class="impact-type">' + (DataParser.TYPE_LABELS[node.type] || '') + '</span>' + node.name;
        li.addEventListener('click', function () {
          focusAndSelect(nid);
          showDetail(nid);
        });
        downstreamList.appendChild(li);
      });
    }

    // 高亮影响路径
    var pathEdges = [];
    var allImpacted = new Set(upstream.concat(downstream).concat([nodeId]));
    appState.edges.forEach(function (e) {
      if (allImpacted.has(e.source) && allImpacted.has(e.target)) {
        pathEdges.push(e.id);
      }
    });
    Renderer.setHighlightPath(Array.from(allImpacted), pathEdges);
  }

  function hideDetail() {
    var panel = document.getElementById('detail-panel');
    if (panel) panel.classList.add('hidden');
    Renderer.clearHighlights();
    Renderer.requestRender();
  }

  /* ─── 聚焦并选中节点 ─── */
  function focusAndSelect(nodeId) {
    Renderer.focusNode(nodeId);
    appState.selection = new Set([nodeId]);
    Renderer.requestRender();
    updateZoomDisplay();
  }

  /* ─── 分组面板 ─── */
  function renderGroupPanel() {
    var container = document.getElementById('group-list');
    if (!container || !appState) return;
    container.innerHTML = '';

    if (!appState.groups || appState.groups.length === 0) {
      container.innerHTML = '<div style="padding:8px;color:#6b7280">暂无分组</div>';
      return;
    }

    appState.groups.forEach(function (group) {
      var div = document.createElement('div');

      // 分组头
      var header = document.createElement('div');
      header.className = 'group-item';
      header.innerHTML =
        '<span class="group-toggle ' + (group.collapsed ? 'collapsed' : '') + '">&#9660;</span>' +
        '<span class="group-name">' + group.name + '</span>' +
        '<span class="group-count">' + group.nodeIds.length + '</span>';

      header.addEventListener('click', function () {
        group.collapsed = !group.collapsed;
        renderGroupPanel();
        Renderer.requestRender();
        scheduleLayoutSave();
      });

      div.appendChild(header);

      // 子节点列表
      if (!group.collapsed) {
        var children = document.createElement('div');
        children.className = 'group-children';
        group.nodeIds.forEach(function (nid) {
          var node = appState.nodeMap.get(nid);
          if (!node) return;
          var status = node._alarmStatus || node.status;
          var statusColor = { normal: '#4caf50', warning: '#ff9800', critical: '#f44336', offline: '#9e9e9e' };
          var item = document.createElement('div');
          item.className = 'node-item';
          item.innerHTML = '<span class="status-dot" style="background:' + (statusColor[status] || '#4caf50') + '"></span>' + node.name;
          item.addEventListener('click', function () {
            focusAndSelect(nid);
            showDetail(nid);
          });
          children.appendChild(item);
        });
        div.appendChild(children);
      }

      container.appendChild(div);
    });
  }

  /* ─── 小地图点击导航 ─── */
  function onMinimapClick(e) {
    if (!appState || !appState.nodes || appState.nodes.length === 0) return;
    var minimap = e.target;
    var rect = minimap.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var mw = 180, mh = 120;

    var bounds = LayoutEngine.getBounds(appState.positions || {});
    if (bounds.width === 0) return;

    var pad = 20;
    var nw = Renderer.NODE_W, nh = Renderer.NODE_H;
    var scaleX = (mw - pad * 2) / (bounds.width + nw);
    var scaleY = (mh - pad * 2) / (bounds.height + nh);
    var s = Math.min(scaleX, scaleY, 1);
    var offX = pad + ((mw - pad * 2) - (bounds.width + nw) * s) / 2 - bounds.minX * s;
    var offY = pad + ((mh - pad * 2) - (bounds.height + nh) * s) / 2 - bounds.minY * s;

    var worldX = (mx - offX) / s;
    var worldY = (my - offY) / s;

    var cw = canvas.width / (window.devicePixelRatio || 1);
    var ch = canvas.height / (window.devicePixelRatio || 1);
    var vp = Renderer.getViewport();

    Renderer.setViewport(cw / 2 - worldX * vp.scale, ch / 2 - worldY * vp.scale, vp.scale);
    updateZoomDisplay();
  }

  /* ─── 时间线点击 ─── */
  function onTimelineClick(e) {
    var track = document.getElementById('timeline-track');
    if (!track) return;
    var rect = track.getBoundingClientRect();
    var ratio = (e.clientX - rect.left) / rect.width;
    AlarmPlayer.seekToPosition(ratio);
  }

  /* ─── 键盘快捷键 ─── */
  function onKeyDown(e) {
    // 搜索框聚焦时不处理
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case 'Escape':
        hideDetail();
        appState.selection = new Set();
        Renderer.clearHighlights();
        Renderer.requestRender();
        break;
      case 'Delete':
      case 'Backspace':
        // 可扩展：删除选中节点
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          // 全选
          appState.selection = new Set(appState.nodes.map(function (n) { return n.id; }));
          Renderer.requestRender();
        }
        break;
      case 'f':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          var searchInput = document.getElementById('search-input');
          if (searchInput) searchInput.focus();
        }
        break;
      case ' ':
        e.preventDefault();
        if (AlarmPlayer.isPlaying()) {
          AlarmPlayer.pause();
        } else {
          AlarmPlayer.play();
        }
        break;
      case 'ArrowLeft':
        AlarmPlayer.stepBack();
        break;
      case 'ArrowRight':
        AlarmPlayer.stepForward();
        break;
      case '+':
      case '=':
        zoomIn();
        break;
      case '-':
        zoomOut();
        break;
      case '0':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          Renderer.fitToScreen();
          updateZoomDisplay();
        }
        break;
    }
  }

  /* ─── 缩放按钮 ─── */
  function zoomIn() {
    var vp = Renderer.getViewport();
    var cw = canvas.width / (window.devicePixelRatio || 1);
    var ch = canvas.height / (window.devicePixelRatio || 1);
    var newScale = Math.min(3, vp.scale * 1.2);
    Renderer.setViewport(
      cw / 2 - (cw / 2 - vp.x) * (newScale / vp.scale),
      ch / 2 - (ch / 2 - vp.y) * (newScale / vp.scale),
      newScale
    );
    updateZoomDisplay();
  }

  function zoomOut() {
    var vp = Renderer.getViewport();
    var cw = canvas.width / (window.devicePixelRatio || 1);
    var ch = canvas.height / (window.devicePixelRatio || 1);
    var newScale = Math.max(0.1, vp.scale / 1.2);
    Renderer.setViewport(
      cw / 2 - (cw / 2 - vp.x) * (newScale / vp.scale),
      ch / 2 - (ch / 2 - vp.y) * (newScale / vp.scale),
      newScale
    );
    updateZoomDisplay();
  }

  /* ─── UI 更新 ─── */
  function updateZoomDisplay() {
    var el = document.getElementById('zoom-level');
    if (el) {
      el.textContent = Math.round(Renderer.getViewport().scale * 100) + '%';
    }
  }

  function updateStats() {
    var el = document.getElementById('topo-stats');
    if (el && appState) {
      el.textContent = (appState.nodes ? appState.nodes.length : 0) + ' 节点 / ' +
        (appState.edges ? appState.edges.length : 0) + ' 连线';
    }
  }

  /* ─── 布局保存节流 ─── */
  var saveTimer = null;
  function scheduleLayoutSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      ImportExport.saveLayout('default', appState);
    }, 1000);
  }

  /* ─── 公共API ─── */
  return {
    init: init,
    showDetail: showDetail,
    hideDetail: hideDetail,
    focusAndSelect: focusAndSelect,
    renderGroupPanel: renderGroupPanel,
    updateStats: updateStats,
    updateZoomDisplay: updateZoomDisplay,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    scheduleLayoutSave: scheduleLayoutSave
  };
})();
