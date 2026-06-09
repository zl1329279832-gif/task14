/**
 * import-export.js — 数据导入导出 + localStorage持久化
 * 负责：JSON文件导入、JSON导出、布局保存/恢复、localStorage管理
 */
const ImportExport = (() => {
  'use strict';

  const STORAGE_KEY = 'topology_viewer_data';
  const LAYOUT_KEY = 'topology_viewer_layout';
  const DIFF_STATE_KEY = 'topology_viewer_diff_state';

  /**
   * 导入JSON文件
   * @returns {Promise<Object>} 解析后的原始数据
   */
  function importFile() {
    return new Promise((resolve, reject) => {
      const input = document.getElementById('file-input');
      input.value = '';

      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) {
          reject(new Error('未选择文件'));
          return;
        }

        if (!file.name.endsWith('.json')) {
          reject(new Error('仅支持 .json 文件'));
          return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = JSON.parse(ev.target.result);
            resolve(data);
          } catch (err) {
            reject(new Error('JSON解析失败: ' + err.message));
          }
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsText(file);
      };

      input.click();
    });
  }

  /**
   * 导出拓扑数据为JSON文件
   */
  function exportData(state) {
    const data = {
      nodes: state.nodes.map(n => ({
        id: n.id,
        type: n.type,
        label: n.label,
        group: n.group,
        status: n.status,
        x: Math.round(n.x),
        y: Math.round(n.y),
        pinned: n.pinned,
        metadata: n.metadata,
      })),
      links: state.links.map(l => ({
        id: l.id,
        source: l.source,
        target: l.target,
        status: l.status,
        label: l.label,
        metadata: l.metadata,
      })),
      groups: state.groups.map(g => ({
        id: g.id,
        label: g.label,
        children: g.children,
        collapsed: g.collapsed,
      })),
      alerts: state.alerts.map(a => ({
        id: a.id,
        timestamp: a.timestamp,
        nodeId: a.nodeId,
        linkId: a.linkId,
        type: a.type,
        severity: a.severity,
        message: a.message,
        affectedNodes: a.affectedNodes,
      })),
      exportTime: new Date().toISOString(),
      signature: state.signature || null,
      version: '1.0',
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `topology_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 保存布局到localStorage
   */
  function saveLayout(state) {
    try {
      const layoutData = {
        signature: state.signature || null,
        nodes: state.nodes.map(n => ({
          id: n.id,
          x: Math.round(n.x),
          y: Math.round(n.y),
          pinned: n.pinned,
        })),
        groups: state.groups.map(g => ({
          id: g.id,
          collapsed: g.collapsed,
        })),
        viewport: {
          x: Renderer.viewport.x,
          y: Renderer.viewport.y,
          scale: Renderer.viewport.scale,
        },
        savedAt: new Date().toISOString(),
      };

      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutData));
      return true;
    } catch (err) {
      console.warn('保存布局失败:', err);
      return false;
    }
  }

  /**
   * 恢复布局（仅当拓扑签名匹配时）
   */
  function restoreLayout(state) {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return false;

      const layoutData = JSON.parse(raw);
      if (!layoutData || !layoutData.nodes) return false;

      // ★ 关键修复：校验拓扑签名，不同拓扑不能复用布局
      if (state.signature && layoutData.signature &&
          state.signature !== layoutData.signature) {
        console.log(`🔄 拓扑签名不匹配 (缓存: ${layoutData.signature}, 当前: ${state.signature})，跳过布局恢复`);
        return false;
      }

      // 恢复节点位置
      const layoutMap = new Map(layoutData.nodes.map(n => [n.id, n]));
      let restored = 0;

      for (const node of state.nodes) {
        const saved = layoutMap.get(node.id);
        if (saved) {
          node.x = saved.x;
          node.y = saved.y;
          node.pinned = saved.pinned || false;
          restored++;
        }
      }

      // 恢复分组折叠状态
      if (layoutData.groups) {
        const groupMap = new Map(layoutData.groups.map(g => [g.id, g]));
        for (const group of state.groups) {
          const saved = groupMap.get(group.id);
          if (saved) {
            group.collapsed = saved.collapsed;
            if (group.collapsed) {
              for (const childId of group.children) {
                const child = state.nodeMap.get(childId);
                if (child) child._visible = false;
              }
            }
          }
        }
      }

      // 恢复视口
      if (layoutData.viewport) {
        Renderer.viewport.x = layoutData.viewport.x;
        Renderer.viewport.y = layoutData.viewport.y;
        Renderer.viewport.scale = layoutData.viewport.scale;
      }

      return restored > 0;
    } catch (err) {
      console.warn('恢复布局失败:', err);
      return false;
    }
  }

  /**
   * 保存完整数据到localStorage
   */
  function saveFullData(state) {
    try {
      const data = {
        nodes: state.nodes.map(n => ({
          id: n.id,
          type: n.type,
          label: n.label,
          group: n.group,
          status: n.status,
          x: Math.round(n.x),
          y: Math.round(n.y),
          pinned: n.pinned,
          metadata: n.metadata,
        })),
        links: state.links.map(l => ({
          id: l.id,
          source: l.source,
          target: l.target,
          status: l.status,
          label: l.label,
          metadata: l.metadata,
        })),
        groups: state.groups.map(g => ({
          id: g.id,
          label: g.label,
          children: g.children,
          collapsed: g.collapsed,
        })),
        alerts: state.alerts.map(a => ({
          id: a.id,
          timestamp: a.timestamp,
          nodeId: a.nodeId,
          linkId: a.linkId,
          type: a.type,
          severity: a.severity,
          message: a.message,
          affectedNodes: a.affectedNodes,
        })),
        signature: state.signature || null,
        savedAt: new Date().toISOString(),
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      console.warn('保存数据失败:', err);
      return false;
    }
  }

  /**
   * 从localStorage加载数据
   */
  function loadSavedData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('加载数据失败:', err);
      return null;
    }
  }

  /**
   * 清除localStorage
   */
  function clearStorage() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem(DIFF_STATE_KEY);
  }

  /**
   * 导出差异报告JSON
   */
  function exportDiffData(diffState) {
    const data = TopologyDiff.exportDiffResult();
    if (!data) return;

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'topology_diff_' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 保存对比状态到localStorage
   */
  function saveDiffState(diffState) {
    try {
      const data = {
        active: diffState.active,
        filters: diffState.filters,
        replayIndex: typeof AlertReplay !== 'undefined' ? AlertReplay.getState().currentIndex : -1,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(DIFF_STATE_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      console.warn('保存对比状态失败:', err);
      return false;
    }
  }

  /**
   * 加载对比状态
   */
  function loadDiffState() {
    try {
      const raw = localStorage.getItem(DIFF_STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  /**
   * 清除对比状态
   */
  function clearDiffState() {
    localStorage.removeItem(DIFF_STATE_KEY);
  }

  /**
   * 显示验证对话框
   */
  function showValidationDialog(messages) {
    return new Promise((resolve) => {
      const dialog = document.getElementById('validation-dialog');
      const msgContainer = document.getElementById('validation-messages');

      msgContainer.innerHTML = messages.map(m =>
        `<div class="validation-msg ${m.level}">${m.level === 'error' ? '❌' : m.level === 'warn' ? '⚠️' : 'ℹ️'} ${escapeHtml(m.text)}</div>`
      ).join('');

      dialog.classList.remove('hidden');

      const hasErrors = messages.some(m => m.level === 'error');
      const okBtn = document.getElementById('btn-validation-ok');
      okBtn.textContent = hasErrors ? '关闭' : '继续导入';
      okBtn.disabled = hasErrors;

      const cleanup = () => {
        dialog.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        document.getElementById('btn-validation-cancel').removeEventListener('click', onCancel);
      };

      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };

      okBtn.addEventListener('click', onOk);
      document.getElementById('btn-validation-cancel').addEventListener('click', onCancel);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    importFile,
    exportData,
    saveLayout,
    restoreLayout,
    saveFullData,
    loadSavedData,
    clearStorage,
    showValidationDialog,
    exportDiffData,
    saveDiffState,
    loadDiffState,
    clearDiffState,
    STORAGE_KEY,
    LAYOUT_KEY,
    DIFF_STATE_KEY,
  };
})();
