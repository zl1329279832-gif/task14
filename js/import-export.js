/**
 * import-export.js — 导入导出模块
 * 负责 JSON 文件导入/导出、布局位置 localStorage 持久化、Canvas 截图导出
 */
window.ImportExport = (function () {
  'use strict';

  var STORAGE_KEY = 'topo-layout-';

  /* ─── JSON 文件导入 ─── */
  function importJSON(callback) {
    var input = document.getElementById('file-input');
    if (!input) return;

    input.value = '';
    input.onchange = function (e) {
      var file = e.target.files[0];
      if (!file) return;
      if (!file.name.endsWith('.json')) {
        showToast('请选择 .json 文件', 'warning');
        return;
      }
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var text = ev.target.result;
          callback(text);
        } catch (err) {
          showToast('文件读取失败: ' + err.message, 'error');
        }
      };
      reader.onerror = function () {
        showToast('文件读取失败', 'error');
      };
      reader.readAsText(file);
    };
    input.click();
  }

  /* ─── JSON 导出 ─── */
  function exportJSON(state) {
    if (!state || !state.nodes) {
      showToast('没有可导出的拓扑数据', 'warning');
      return;
    }

    var data = {
      nodes: state.nodes.map(function (n) {
        return {
          id: n.id,
          name: n.name,
          type: n.type,
          group: n.group,
          status: n.status,
          x: Math.round(n.x),
          y: Math.round(n.y),
          ip: n.ip,
          description: n.description,
          details: n.details
        };
      }),
      edges: state.edges.map(function (e) {
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          linkType: e.linkType,
          status: e._originalStatus || e.status,
          label: e.label,
          bandwidth: e.bandwidth
        };
      }),
      groups: (state.groups || []).map(function (g) {
        return {
          id: g.id,
          name: g.name,
          nodeIds: g.nodeIds,
          collapsed: g.collapsed
        };
      }),
      alarms: (state.alarms || []).map(function (a) {
        return {
          id: a.id,
          timestamp: new Date(a.timestamp).toISOString(),
          nodeId: a.nodeId,
          level: a.level,
          message: a.message,
          affectedNodes: a.affectedNodes,
          nodeStates: a.nodeStates,
          edgeStates: a.edgeStates
        };
      })
    };

    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    downloadBlob(blob, 'topology-' + formatDate() + '.json');
    showToast('拓扑数据已导出', 'success');
  }

  /* ─── 布局保存到 localStorage ─── */
  function saveLayout(topoId, state) {
    if (!state || !state.nodes) return;
    var key = STORAGE_KEY + (topoId || 'default');
    var positions = {};
    state.nodes.forEach(function (n) {
      positions[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
    });
    var data = {
      positions: positions,
      viewport: Renderer.getViewport(),
      groups: (state.groups || []).map(function (g) {
        return { id: g.id, collapsed: g.collapsed };
      }),
      savedAt: Date.now()
    };
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      showToast('保存布局失败: 存储空间不足', 'warning');
    }
  }

  /* ─── 从 localStorage 加载布局 ─── */
  function loadLayout(topoId) {
    var key = STORAGE_KEY + (topoId || 'default');
    try {
      var json = localStorage.getItem(key);
      if (!json) return null;
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  /* ─── 清除保存的布局 ─── */
  function clearLayout(topoId) {
    var key = STORAGE_KEY + (topoId || 'default');
    localStorage.removeItem(key);
  }

  /* ─── Canvas 截图导出 ─── */
  function exportImage(canvasEl) {
    if (!canvasEl) {
      showToast('无法导出图片', 'error');
      return;
    }
    try {
      var dataURL = canvasEl.toDataURL('image/png');
      var link = document.createElement('a');
      link.download = 'topology-' + formatDate() + '.png';
      link.href = dataURL;
      link.click();
      showToast('拓扑截图已导出', 'success');
    } catch (e) {
      showToast('截图导出失败: ' + e.message, 'error');
    }
  }

  /* ─── Toast 消息提示 ─── */
  function showToast(message, type) {
    type = type || 'info';
    var container = document.getElementById('toast-container');
    if (!container) return;

    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(function () {
      toast.style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3000);
  }

  /* ─── 辅助函数 ─── */
  function formatDate() {
    var d = new Date();
    return d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '-' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0');
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ─── 公共API ─── */
  return {
    importJSON: importJSON,
    exportJSON: exportJSON,
    saveLayout: saveLayout,
    loadLayout: loadLayout,
    clearLayout: clearLayout,
    exportImage: exportImage,
    showToast: showToast
  };
})();
