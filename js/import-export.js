/**
 * import-export.js — 数据导入导出 + localStorage持久化
 * 负责：JSON文件导入、JSON导出、布局保存/恢复、localStorage管理
 */
const ImportExport = (() => {
  'use strict';

  const STORAGE_KEY = 'topology_viewer_data';
  const LAYOUT_KEY = 'topology_viewer_layout';

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
      // 导出当前视口状态（世界坐标空间）
      viewport: {
        x: Math.round(Renderer.viewport.x * 100) / 100,
        y: Math.round(Renderer.viewport.y * 100) / 100,
        scale: Math.round(Renderer.viewport.scale * 1000) / 1000,
      },
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
          x: isFinite(n.x) ? Math.round(n.x) : 0,
          y: isFinite(n.y) ? Math.round(n.y) : 0,
          pinned: n.pinned,
        })),
        groups: state.groups.map(g => ({
          id: g.id,
          collapsed: g.collapsed,
        })),
        viewport: {
          x: isFinite(Renderer.viewport.x) ? Renderer.viewport.x : 0,
          y: isFinite(Renderer.viewport.y) ? Renderer.viewport.y : 0,
          scale: isFinite(Renderer.viewport.scale) && Renderer.viewport.scale > 0 ? Renderer.viewport.scale : 1,
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
   * @returns {boolean} 是否成功恢复了布局（包括视口位置）
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
      let viewportRestored = false;
      if (layoutData.viewport &&
          typeof layoutData.viewport.x === 'number' &&
          typeof layoutData.viewport.y === 'number' &&
          typeof layoutData.viewport.scale === 'number' &&
          isFinite(layoutData.viewport.x) &&
          isFinite(layoutData.viewport.y) &&
          layoutData.viewport.scale > 0) {
        Renderer.viewport.x = layoutData.viewport.x;
        Renderer.viewport.y = layoutData.viewport.y;
        Renderer.viewport.scale = layoutData.viewport.scale;
        viewportRestored = true;
      }

      return restored > 0 || viewportRestored;
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

  // --- Diff 模式相关 ---

  const DIFF_SNAPSHOT_A_KEY = 'topo-diff-snapshotA';
  const DIFF_SNAPSHOT_B_KEY = 'topo-diff-snapshotB';
  const DIFF_ALERTS_KEY = 'topo-diff-alerts';
  const DIFF_LAYOUT_KEY = 'topo-diff-layout';
  const DIFF_FILTERS_KEY = 'topo-diff-filters';
  const DIFF_PLAYBACK_KEY = 'topo-diff-playback';

  function importDiffFiles() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.multiple = true;
      input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length < 2) { reject(new Error('至少需要选择两份快照文件')); return; }
        try {
          const readJSON = (file) => new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = (ev) => { try { res(JSON.parse(ev.target.result)); } catch (err) { rej(new Error(`文件 ${file.name} 解析失败`)); } };
            reader.readAsText(file);
          });
          const results = await Promise.all(files.map(f => readJSON(f)));
          if (results[0].exportType === 'topology-diff-analysis') {
            resolve({ type: 'full-package', data: results[0] });
          } else {
            resolve({ type: 'separate', snapshotA: results[0], snapshotB: results[1], alerts: results[2] || null });
          }
        } catch (err) { reject(err); }
      };
      input.click();
    });
  }

  function importDiffFullPackage(jsonData) {
    const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    return {
      snapshotA: data.snapshots?.A || {},
      snapshotB: data.snapshots?.B || {},
      alerts: data.alerts || [],
      filterState: data.userAnnotations?.filterState || null,
    };
  }

  function exportDiffResult() {
    const diffResult = TopoDiff.getSerializableResult();
    const snapshotA = TopoDiff.getSnapshotA();
    const snapshotB = TopoDiff.getSnapshotB();
    const alerts = TopoDiff.getAlerts();
    const propagation = FaultReplay.getSerializableGraph();
    const mergedNodes = TopoDiff.getMergedNodes();
    const mergedLinks = TopoDiff.getMergedLinks();
    const pkg = {
      exportType: 'topology-diff-analysis', version: '1.0', exportedAt: new Date().toISOString(),
      snapshots: {
        A: { label: snapshotA?.label || '快照A', nodes: (snapshotA?.nodes || []), links: (snapshotA?.links || []) },
        B: { label: snapshotB?.label || '快照B', nodes: (snapshotB?.nodes || []), links: (snapshotB?.links || []) }
      },
      alerts: (alerts || []).map(a => ({ id: a.id, timestamp: a.timestamp, nodeId: a.nodeId, type: a.type, severity: a.severity, message: a.message })),
      diffResult, propagationAnalysis: propagation,
      // 导出合并拓扑的世界坐标（用于外部工具重新加载）
      mergedTopology: {
        nodes: mergedNodes.map(n => ({
          id: n.id, type: n.type, label: n.label,
          x: Math.round(n.x || 0), y: Math.round(n.y || 0),
          status: n.status, diffState: n._diffState,
        })),
        links: mergedLinks.map(l => ({
          id: l.id, source: l.source, target: l.target,
          status: l.status, diffState: l._diffState,
        })),
      },
      viewport: {
        x: Renderer.viewport.x, y: Renderer.viewport.y, scale: Renderer.viewport.scale,
      },
      userAnnotations: { pinnedNodePositions: Interaction.getPinnedPositions(), filterState: _getDiffFilters() }
    };
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topo-diff-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function saveDiffSnapshots(snapshotA, snapshotB, alerts) {
    try {
      localStorage.setItem(DIFF_SNAPSHOT_A_KEY, JSON.stringify(snapshotA));
      localStorage.setItem(DIFF_SNAPSHOT_B_KEY, JSON.stringify(snapshotB));
      if (alerts?.length > 0) localStorage.setItem(DIFF_ALERTS_KEY, JSON.stringify(alerts));
    } catch (e) { console.warn('保存差异快照失败:', e); }
  }

  function loadDiffSnapshots() {
    try {
      const a = localStorage.getItem(DIFF_SNAPSHOT_A_KEY);
      const b = localStorage.getItem(DIFF_SNAPSHOT_B_KEY);
      const alerts = localStorage.getItem(DIFF_ALERTS_KEY);
      if (a && b) return { snapshotA: JSON.parse(a), snapshotB: JSON.parse(b), alerts: alerts ? JSON.parse(alerts) : [] };
    } catch (e) {}
    return null;
  }

  function saveDiffLayout(mergedNodes) {
    try {
      const positions = {};
      for (const n of mergedNodes) {
        if (n.x != null && isFinite(n.x) && n.y != null && isFinite(n.y)) {
          positions[n.id] = { x: Math.round(n.x), y: Math.round(n.y), pinned: n.pinned };
        }
      }
      localStorage.setItem(DIFF_LAYOUT_KEY, JSON.stringify({
        positions,
        viewport: {
          x: isFinite(Renderer.viewport.x) ? Renderer.viewport.x : 0,
          y: isFinite(Renderer.viewport.y) ? Renderer.viewport.y : 0,
          scale: isFinite(Renderer.viewport.scale) && Renderer.viewport.scale > 0 ? Renderer.viewport.scale : 1,
        }
      }));
    } catch (e) {}
  }

  function restoreDiffLayout(mergedNodes) {
    try {
      const raw = localStorage.getItem(DIFF_LAYOUT_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      let restored = 0;
      for (const node of mergedNodes) {
        const saved = data.positions?.[node.id];
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
          node.x = saved.x;
          node.y = saved.y;
          node.pinned = saved.pinned || false;
          restored++;
        }
      }
      let viewportRestored = false;
      if (data.viewport &&
          typeof data.viewport.x === 'number' &&
          typeof data.viewport.y === 'number' &&
          typeof data.viewport.scale === 'number' &&
          isFinite(data.viewport.x) &&
          isFinite(data.viewport.y) &&
          data.viewport.scale > 0) {
        Renderer.viewport.x = data.viewport.x;
        Renderer.viewport.y = data.viewport.y;
        Renderer.viewport.scale = data.viewport.scale;
        viewportRestored = true;
      }
      return restored > 0 || viewportRestored;
    } catch (e) { return false; }
  }

  function saveDiffFilters(filters) { try { localStorage.setItem(DIFF_FILTERS_KEY, JSON.stringify(filters)); } catch(e) {} }
  function loadDiffFilters() { try { const r = localStorage.getItem(DIFF_FILTERS_KEY); return r ? JSON.parse(r) : null; } catch(e) { return null; } }
  function saveDiffPlayback(state) {
    try {
      localStorage.setItem(DIFF_PLAYBACK_KEY, JSON.stringify({
        currentTime: state.activeAlertIndex,
        speed: state.speed,
        viewport: {
          x: Renderer.viewport.x,
          y: Renderer.viewport.y,
          scale: Renderer.viewport.scale,
        }
      }));
    } catch(e) {}
  }
  function loadDiffPlayback() {
    try {
      const r = localStorage.getItem(DIFF_PLAYBACK_KEY);
      return r ? JSON.parse(r) : null;
    } catch(e) { return null; }
  }

  function clearDiffStorage() {
    [DIFF_SNAPSHOT_A_KEY, DIFF_SNAPSHOT_B_KEY, DIFF_ALERTS_KEY, DIFF_LAYOUT_KEY, DIFF_FILTERS_KEY, DIFF_PLAYBACK_KEY]
      .forEach(k => localStorage.removeItem(k));
  }

  function hasDiffData() { return !!localStorage.getItem(DIFF_SNAPSHOT_A_KEY); }

  function _getDiffFilters() {
    const filters = {};
    document.querySelectorAll('[data-diff-filter]').forEach(cb => {
      const key = cb.dataset.diffFilter;
      if (key) filters[key] = cb.checked;
    });
    return filters;
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
    STORAGE_KEY,
    LAYOUT_KEY,
    // Diff 模式
    importDiffFiles,
    importDiffFullPackage,
    exportDiffResult,
    saveDiffSnapshots,
    loadDiffSnapshots,
    saveDiffLayout,
    restoreDiffLayout,
    saveDiffFilters,
    loadDiffFilters,
    saveDiffPlayback,
    loadDiffPlayback,
    clearDiffStorage,
    hasDiffData,
  };
})();
