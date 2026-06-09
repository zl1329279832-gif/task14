/**
 * topology-diff.js — 拓扑差异对比引擎
 * 实现：双快照导入、差异计算、合并拓扑、告警传播路径、差异筛选、差异导出
 */
const TopologyDiff = (() => {
  'use strict';

  const diffState = {
    active: false,
    snapshotA: null,
    snapshotB: null,
    diff: {
      nodes: { added: [], deleted: [], changed: [], unchanged: [] },
      links: { added: [], deleted: [], changed: [], unchanged: [] },
      summary: {
        totalNodesA: 0, totalNodesB: 0,
        totalLinksA: 0, totalLinksB: 0,
        addedNodes: 0, deletedNodes: 0, changedNodes: 0,
        addedLinks: 0, deletedLinks: 0, changedLinks: 0,
      },
    },
    propagationPaths: [],
    filters: {
      showAdded: true,
      showDeleted: true,
      showChanged: true,
      showUnchanged: true,
      alertSeverity: { warning: true, critical: true, normal: true },
    },
  };

  // ========== 差异计算 ==========

  function computeDiff(parsedA, parsedB) {
    const nodeMapA = parsedA.nodeMap;
    const nodeMapB = parsedB.nodeMap;

    const nodeDiff = { added: [], deleted: [], changed: [], unchanged: [] };

    // 节点差异：基于 ID 的集合运算
    for (const [id, nodeB] of nodeMapB) {
      if (!nodeMapA.has(id)) {
        nodeDiff.added.push(id);
      } else {
        const nodeA = nodeMapA.get(id);
        const changes = compareNode(nodeA, nodeB);
        if (changes.length > 0) {
          nodeDiff.changed.push({ id, changes });
        } else {
          nodeDiff.unchanged.push(id);
        }
      }
    }
    for (const [id] of nodeMapA) {
      if (!nodeMapB.has(id)) {
        nodeDiff.deleted.push(id);
      }
    }

    // 链路差异：基于 source->target 复合键
    const linkMapA = buildLinkMap(parsedA.links);
    const linkMapB = buildLinkMap(parsedB.links);
    const linkDiff = { added: [], deleted: [], changed: [], unchanged: [] };

    for (const [key, linkB] of linkMapB) {
      if (!linkMapA.has(key)) {
        linkDiff.added.push(key);
      } else {
        const linkA = linkMapA.get(key);
        const changes = compareLink(linkA, linkB);
        if (changes.length > 0) {
          linkDiff.changed.push({ key, id: linkB.id, changes });
        } else {
          linkDiff.unchanged.push(key);
        }
      }
    }
    for (const [key] of linkMapA) {
      if (!linkMapB.has(key)) {
        linkDiff.deleted.push(key);
      }
    }

    const summary = {
      totalNodesA: parsedA.nodes.length,
      totalNodesB: parsedB.nodes.length,
      totalLinksA: parsedA.links.length,
      totalLinksB: parsedB.links.length,
      addedNodes: nodeDiff.added.length,
      deletedNodes: nodeDiff.deleted.length,
      changedNodes: nodeDiff.changed.length,
      addedLinks: linkDiff.added.length,
      deletedLinks: linkDiff.deleted.length,
      changedLinks: linkDiff.changed.length,
    };

    return { nodes: nodeDiff, links: linkDiff, summary };
  }

  function compareNode(a, b) {
    const changes = [];
    const fields = ['status', 'type', 'label', 'group'];
    for (const f of fields) {
      if (a[f] !== b[f]) {
        changes.push({ field: f, before: a[f], after: b[f] });
      }
    }
    const metaA = JSON.stringify(a.metadata || {});
    const metaB = JSON.stringify(b.metadata || {});
    if (metaA !== metaB) {
      changes.push({ field: 'metadata', before: a.metadata, after: b.metadata });
    }
    return changes;
  }

  function compareLink(a, b) {
    const changes = [];
    if (a.status !== b.status) {
      changes.push({ field: 'status', before: a.status, after: b.status });
    }
    if (a.label !== b.label) {
      changes.push({ field: 'label', before: a.label, after: b.label });
    }
    const metaA = JSON.stringify(a.metadata || {});
    const metaB = JSON.stringify(b.metadata || {});
    if (metaA !== metaB) {
      changes.push({ field: 'metadata', before: a.metadata, after: b.metadata });
    }
    return changes;
  }

  function buildLinkMap(links) {
    const map = new Map();
    for (const link of links) {
      const key = link.source + '->' + link.target;
      map.set(key, link);
    }
    return map;
  }

  // ========== 合并拓扑构建 ==========

  function buildMergedTopology(parsedA, parsedB, diff) {
    const mergedNodes = [];
    const mergedNodeMap = new Map();
    const mergedLinks = [];

    // 以快照B的节点为基础
    for (const nodeB of parsedB.nodes) {
      const cloned = cloneNode(nodeB);
      if (diff.nodes.added.includes(cloned.id)) {
        cloned._diffStatus = 'added';
        cloned._diffSource = 'B';
      } else {
        const changedEntry = diff.nodes.changed.find(c => c.id === cloned.id);
        if (changedEntry) {
          cloned._diffStatus = 'changed';
          cloned._diffChanges = changedEntry.changes;
          cloned._diffSource = 'both';
        } else {
          cloned._diffStatus = 'unchanged';
          cloned._diffSource = 'both';
        }
      }
      mergedNodes.push(cloned);
      mergedNodeMap.set(cloned.id, cloned);
    }

    // 加入A中已删除的节点
    for (const deletedId of diff.nodes.deleted) {
      const nodeA = parsedA.nodeMap.get(deletedId);
      if (nodeA) {
        const cloned = cloneNode(nodeA);
        cloned._diffStatus = 'deleted';
        cloned._diffSource = 'A';
        mergedNodes.push(cloned);
        mergedNodeMap.set(cloned.id, cloned);
      }
    }

    // 链路合并 — 以B为基础
    const linkMapA = buildLinkMap(parsedA.links);
    const linkMapB = buildLinkMap(parsedB.links);

    for (const linkB of parsedB.links) {
      const key = linkB.source + '->' + linkB.target;
      const cloned = cloneLink(linkB);
      // 只保留两端都在合并拓扑中的链路
      if (!mergedNodeMap.has(cloned.source) || !mergedNodeMap.has(cloned.target)) continue;
      if (diff.links.added.includes(key)) {
        cloned._diffStatus = 'added';
      } else {
        const changedEntry = diff.links.changed.find(c => c.key === key);
        if (changedEntry) {
          cloned._diffStatus = 'changed';
          cloned._diffChanges = changedEntry.changes;
        } else {
          cloned._diffStatus = 'unchanged';
        }
      }
      mergedLinks.push(cloned);
    }

    // 加入A中已删除的链路
    for (const deletedKey of diff.links.deleted) {
      const linkA = linkMapA.get(deletedKey);
      if (linkA) {
        const cloned = cloneLink(linkA);
        // 只保留两端都在合并拓扑中的链路
        if (!mergedNodeMap.has(cloned.source) || !mergedNodeMap.has(cloned.target)) continue;
        cloned._diffStatus = 'deleted';
        mergedLinks.push(cloned);
      }
    }

    // 合并分组
    const mergedGroups = mergeGroups(parsedA.groups, parsedB.groups, mergedNodeMap);

    // 合并并排序告警
    const mergedAlerts = mergeAlerts(parsedA.alerts, parsedB.alerts, mergedNodeMap, mergedLinks);

    // 计算合并拓扑签名
    const signature = DataParser.computeTopologySignature(mergedNodes, mergedLinks);

    return {
      nodes: mergedNodes,
      links: mergedLinks,
      groups: mergedGroups,
      alerts: mergedAlerts,
      nodeMap: mergedNodeMap,
      signature,
    };
  }

  function cloneNode(node) {
    return {
      id: node.id,
      type: node.type,
      label: node.label,
      group: node.group,
      status: node.status,
      x: node.x,
      y: node.y,
      pinned: node.pinned,
      metadata: Object.assign({}, node.metadata),
      _vx: 0, _vy: 0,
      _selected: false,
      _highlighted: false,
      _visible: true,
      _fx: null, _fy: null,
      _diffStatus: null,
      _diffChanges: null,
      _diffSource: null,
    };
  }

  function cloneLink(link) {
    return {
      id: link.id,
      source: link.source,
      target: link.target,
      status: link.status,
      label: link.label,
      metadata: Object.assign({}, link.metadata),
      _highlighted: false,
      _visible: true,
      _diffStatus: null,
      _diffChanges: null,
    };
  }

  function mergeGroups(groupsA, groupsB, mergedNodeMap) {
    const groupMap = new Map();

    // B的分组优先
    for (const g of groupsB) {
      const validChildren = g.children.filter(id => mergedNodeMap.has(id));
      if (validChildren.length > 0) {
        groupMap.set(g.id, {
          id: g.id,
          label: g.label,
          children: validChildren,
          collapsed: false,
          _bounds: null,
        });
      }
    }

    // A的分组补充（仅含删除节点的分组）
    for (const g of groupsA) {
      if (groupMap.has(g.id)) {
        // 把A分组中的已删节点加入对应B分组
        const existing = groupMap.get(g.id);
        for (const childId of g.children) {
          const node = mergedNodeMap.get(childId);
          if (node && node._diffStatus === 'deleted' && !existing.children.includes(childId)) {
            existing.children.push(childId);
          }
        }
      } else {
        // A独有的分组（所有成员都是删除节点）
        const validChildren = g.children.filter(id => mergedNodeMap.has(id));
        if (validChildren.length > 0) {
          groupMap.set(g.id, {
            id: g.id,
            label: g.label,
            children: validChildren,
            collapsed: false,
            _bounds: null,
          });
        }
      }
    }

    return Array.from(groupMap.values());
  }

  function mergeAlerts(alertsA, alertsB, mergedNodeMap, mergedLinks) {
    const linkIdSet = new Set(mergedLinks.map(l => l.id));
    const seen = new Set();
    const merged = [];

    const allAlerts = [
      ...alertsA.map(a => Object.assign({}, a, { _diffSource: 'A' })),
      ...alertsB.map(a => Object.assign({}, a, { _diffSource: 'B' })),
    ];

    for (const alert of allAlerts) {
      // 去重：相同id优先保留B的
      if (seen.has(alert.id)) {
        if (alert._diffSource === 'B') {
          const idx = merged.findIndex(m => m.id === alert.id);
          if (idx !== -1) merged[idx] = alert;
        }
        continue;
      }
      seen.add(alert.id);

      // 验证引用合法性
      if (alert.nodeId && !mergedNodeMap.has(alert.nodeId)) {
        alert.nodeId = null;
      }
      if (alert.linkId && !linkIdSet.has(alert.linkId)) {
        alert.linkId = null;
      }
      if (alert.affectedNodes) {
        alert.affectedNodes = alert.affectedNodes.filter(id => mergedNodeMap.has(id));
      }

      merged.push(alert);
    }

    // 按时间戳排序
    merged.sort((a, b) => a.timestamp - b.timestamp || (a.id || '').localeCompare(b.id || ''));
    return merged;
  }

  // ========== 告警传播路径 ==========

  function computePropagationPaths(alerts, nodeMap, links) {
    const paths = [];

    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      if (!alert.nodeId || !nodeMap.has(alert.nodeId)) continue;

      const upstream = DataParser.traceUpstream(alert.nodeId, links, nodeMap);
      const downstream = DataParser.traceDownstream(alert.nodeId, links, nodeMap);

      const entry = {
        alertId: alert.id,
        alertIndex: i,
        nodeId: alert.nodeId,
        timestamp: alert.timestamp,
        severity: alert.severity,
        upstream: upstream.map(n => n.id),
        downstream: downstream.map(n => n.id),
        propagatedFrom: null,
      };

      // 检测传播关系：当前告警节点是否在前序告警的下游集合中
      for (let j = i - 1; j >= 0; j--) {
        const prev = paths[j - (alerts.length - paths.length - (alerts.length - i))];
        if (!prev) continue;
        const prevPath = paths.find(p => p.alertIndex === j);
        if (prevPath && prevPath.downstream.includes(alert.nodeId)) {
          entry.propagatedFrom = prevPath.alertId;
          break;
        }
      }

      paths.push(entry);
    }

    // 简化传播关系检测
    for (let i = 1; i < paths.length; i++) {
      if (paths[i].propagatedFrom) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (paths[j].downstream.includes(paths[i].nodeId)) {
          paths[i].propagatedFrom = paths[j].alertId;
          break;
        }
      }
    }

    return paths;
  }

  // ========== 对比模式控制 ==========

  function enterDiffMode(rawA, rawB) {
    const resultA = DataParser.parse(rawA);
    const resultB = DataParser.parse(rawB);

    // 收集两份快照的验证消息
    const allMessages = [];
    if (resultA.messages.length > 0) {
      allMessages.push({ level: 'info', text: '--- 快照A 验证结果 ---' });
      allMessages.push(...resultA.messages);
    }
    if (resultB.messages.length > 0) {
      allMessages.push({ level: 'info', text: '--- 快照B 验证结果 ---' });
      allMessages.push(...resultB.messages);
    }

    if (!resultA.data || !resultB.data) {
      allMessages.push({ level: 'error', text: '快照数据无效，无法进行对比' });
      return { data: null, messages: allMessages };
    }

    diffState.snapshotA = resultA.data;
    diffState.snapshotB = resultB.data;

    // 计算差异
    const diff = computeDiff(resultA.data, resultB.data);
    diffState.diff = diff;

    // 构建合并拓扑
    const merged = buildMergedTopology(resultA.data, resultB.data, diff);

    // 计算传播路径
    diffState.propagationPaths = computePropagationPaths(
      merged.alerts, merged.nodeMap, merged.links
    );

    diffState.active = true;

    // 重置筛选
    diffState.filters = {
      showAdded: true,
      showDeleted: true,
      showChanged: true,
      showUnchanged: true,
      alertSeverity: { warning: true, critical: true, normal: true },
    };

    return { data: merged, messages: allMessages };
  }

  function exitDiffMode() {
    diffState.active = false;
    diffState.snapshotA = null;
    diffState.snapshotB = null;
    diffState.diff = {
      nodes: { added: [], deleted: [], changed: [], unchanged: [] },
      links: { added: [], deleted: [], changed: [], unchanged: [] },
      summary: {
        totalNodesA: 0, totalNodesB: 0,
        totalLinksA: 0, totalLinksB: 0,
        addedNodes: 0, deletedNodes: 0, changedNodes: 0,
        addedLinks: 0, deletedLinks: 0, changedLinks: 0,
      },
    };
    diffState.propagationPaths = [];
    diffState.filters = {
      showAdded: true,
      showDeleted: true,
      showChanged: true,
      showUnchanged: true,
      alertSeverity: { warning: true, critical: true, normal: true },
    };
  }

  function isDiffMode() {
    return diffState.active;
  }

  // ========== 差异筛选 ==========

  function setDiffFilter(key, value) {
    if (key === 'showAdded' || key === 'showDeleted' || key === 'showChanged' || key === 'showUnchanged') {
      diffState.filters[key] = value;
    } else if (key.startsWith('severity_')) {
      const sev = key.replace('severity_', '');
      diffState.filters.alertSeverity[sev] = value;
    }
  }

  function applyDiffFilters(state) {
    if (!diffState.active) return;

    const f = diffState.filters;

    for (const node of state.nodes) {
      const diffStatus = node._diffStatus || 'unchanged';
      let visible = true;

      // 差异状态筛选
      if (diffStatus === 'added' && !f.showAdded) visible = false;
      if (diffStatus === 'deleted' && !f.showDeleted) visible = false;
      if (diffStatus === 'changed' && !f.showChanged) visible = false;
      if (diffStatus === 'unchanged' && !f.showUnchanged) visible = false;

      node._visible = visible;
    }

    // 链路可见性取决于两端节点 + 自身差异状态
    for (const link of state.links) {
      const src = state.nodeMap.get(link.source);
      const tgt = state.nodeMap.get(link.target);
      const endpointsVisible = src && src._visible !== false && tgt && tgt._visible !== false;

      const diffStatus = link._diffStatus || 'unchanged';
      let linkVisible = true;
      if (diffStatus === 'added' && !f.showAdded) linkVisible = false;
      if (diffStatus === 'deleted' && !f.showDeleted) linkVisible = false;
      if (diffStatus === 'changed' && !f.showChanged) linkVisible = false;
      if (diffStatus === 'unchanged' && !f.showUnchanged) linkVisible = false;

      link._visible = endpointsVisible && linkVisible;
    }
  }

  // ========== 差异导出 ==========

  function exportDiffResult() {
    if (!diffState.active) return null;

    const changedNodesDetail = diffState.diff.nodes.changed.map(c => {
      const node = diffState.snapshotB.nodeMap.get(c.id);
      return {
        id: c.id,
        label: node ? node.label : c.id,
        changes: c.changes,
      };
    });

    const changedLinksDetail = diffState.diff.links.changed.map(c => ({
      key: c.key,
      id: c.id,
      changes: c.changes,
    }));

    return {
      type: 'topology_diff_report',
      version: '1.0',
      exportTime: new Date().toISOString(),
      snapshotA: {
        signature: diffState.snapshotA ? diffState.snapshotA.signature : null,
        nodeCount: diffState.diff.summary.totalNodesA,
        linkCount: diffState.diff.summary.totalLinksA,
      },
      snapshotB: {
        signature: diffState.snapshotB ? diffState.snapshotB.signature : null,
        nodeCount: diffState.diff.summary.totalNodesB,
        linkCount: diffState.diff.summary.totalLinksB,
      },
      diff: {
        nodes: {
          added: diffState.diff.nodes.added,
          deleted: diffState.diff.nodes.deleted,
          changed: changedNodesDetail,
        },
        links: {
          added: diffState.diff.links.added,
          deleted: diffState.diff.links.deleted,
          changed: changedLinksDetail,
        },
        summary: diffState.diff.summary,
      },
      propagationPaths: diffState.propagationPaths,
      filters: diffState.filters,
    };
  }

  // ========== UI HTML 生成 ==========

  function getDiffDetailHtml(node) {
    if (!node || !node._diffStatus) return '';

    const statusLabels = {
      added: '新增',
      deleted: '已删除',
      changed: '已变更',
      unchanged: '无变化',
    };
    const statusColors = {
      added: '#4aff8a',
      deleted: '#ff4a6a',
      changed: '#ffaa4a',
      unchanged: '#5a6a7a',
    };

    let html = '<div class="diff-detail-section">';
    html += '<h4 style="margin:8px 0 4px;font-size:12px;color:var(--text-secondary)">差异信息</h4>';
    html += '<div class="diff-change-row">';
    html += '<span>差异状态</span>';
    html += '<span class="diff-badge ' + node._diffStatus + '">' + statusLabels[node._diffStatus] + '</span>';
    html += '</div>';

    if (node._diffSource) {
      const sourceLabels = { A: '仅快照A', B: '仅快照B', both: '两者都有' };
      html += '<div class="diff-change-row">';
      html += '<span>数据来源</span>';
      html += '<span style="color:var(--text-secondary)">' + sourceLabels[node._diffSource] + '</span>';
      html += '</div>';
    }

    if (node._diffChanges && node._diffChanges.length > 0) {
      html += '<h4 style="margin:8px 0 4px;font-size:12px;color:var(--text-secondary)">字段变更</h4>';
      const fieldLabels = {
        status: '状态', type: '类型', label: '名称', group: '分组', metadata: '元数据',
      };
      for (const change of node._diffChanges) {
        const label = fieldLabels[change.field] || change.field;
        const before = change.field === 'metadata'
          ? JSON.stringify(change.before)
          : String(change.before || '(空)');
        const after = change.field === 'metadata'
          ? JSON.stringify(change.after)
          : String(change.after || '(空)');
        html += '<div class="diff-change-row">';
        html += '<span>' + escapeHtml(label) + '</span>';
        html += '<div>';
        html += '<span class="diff-before">' + escapeHtml(before) + '</span>';
        html += ' &rarr; ';
        html += '<span class="diff-after">' + escapeHtml(after) + '</span>';
        html += '</div>';
        html += '</div>';
      }
    }

    // 传播路径信息
    if (diffState.propagationPaths.length > 0) {
      const relatedPaths = diffState.propagationPaths.filter(
        p => p.nodeId === node.id || p.upstream.includes(node.id) || p.downstream.includes(node.id)
      );
      if (relatedPaths.length > 0) {
        html += '<h4 style="margin:8px 0 4px;font-size:12px;color:var(--text-secondary)">关联告警</h4>';
        for (const p of relatedPaths.slice(0, 5)) {
          const role = p.nodeId === node.id ? '告警源' : (p.upstream.includes(node.id) ? '上游依赖' : '受影响');
          html += '<div class="diff-change-row">';
          html += '<span>' + escapeHtml(p.alertId) + '</span>';
          html += '<span class="diff-badge ' + (p.severity === 'critical' ? 'deleted' : 'changed') + '">' + role + '</span>';
          html += '</div>';
        }
      }
    }

    html += '</div>';
    return html;
  }

  function getDiffLinkDetailHtml(link) {
    if (!link || !link._diffStatus) return '';

    const statusLabels = { added: '新增', deleted: '已删除', changed: '已变更', unchanged: '无变化' };

    let html = '<div class="diff-detail-section">';
    html += '<h4 style="margin:8px 0 4px;font-size:12px;color:var(--text-secondary)">链路差异</h4>';
    html += '<div class="diff-change-row">';
    html += '<span>差异状态</span>';
    html += '<span class="diff-badge ' + link._diffStatus + '">' + statusLabels[link._diffStatus] + '</span>';
    html += '</div>';

    if (link._diffChanges && link._diffChanges.length > 0) {
      const fieldLabels = { status: '状态', label: '标签', metadata: '元数据' };
      for (const change of link._diffChanges) {
        const label = fieldLabels[change.field] || change.field;
        const before = change.field === 'metadata'
          ? JSON.stringify(change.before)
          : String(change.before || '(空)');
        const after = change.field === 'metadata'
          ? JSON.stringify(change.after)
          : String(change.after || '(空)');
        html += '<div class="diff-change-row">';
        html += '<span>' + escapeHtml(label) + '</span>';
        html += '<div>';
        html += '<span class="diff-before">' + escapeHtml(before) + '</span>';
        html += ' &rarr; ';
        html += '<span class="diff-after">' + escapeHtml(after) + '</span>';
        html += '</div>';
        html += '</div>';
      }
    }

    html += '</div>';
    return html;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ========== 公共 API ==========

  return {
    diffState,
    enterDiffMode,
    exitDiffMode,
    computeDiff,
    buildMergedTopology,
    computePropagationPaths,
    isDiffMode,
    setDiffFilter,
    applyDiffFilters,
    exportDiffResult,
    getDiffDetailHtml,
    getDiffLinkDetailHtml,
  };
})();
