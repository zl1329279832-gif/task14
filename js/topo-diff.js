/**
 * topo-diff.js — 拓扑差异计算引擎
 * 负责：两份快照对比、差异数据模型、合并拓扑构建
 */
const TopoDiff = (() => {
  'use strict';

  // 差异比较的字段白名单
  const DIFF_FIELDS = [
    'status', 'label', 'group',
    'metadata.cpu', 'metadata.memory', 'metadata.bandwidth',
    'metadata.connections', 'metadata.uptime'
  ];

  const DIFF_STATES = {
    ADDED: 'added',
    REMOVED: 'removed',
    CHANGED: 'changed',
    UNCHANGED: 'unchanged'
  };

  // 内部状态
  let _diffResult = null;
  let _snapshotA = null;
  let _snapshotB = null;
  let _alerts = [];
  let _mergedNodes = [];
  let _mergedLinks = [];
  let _mergedNodeMap = new Map();

  /**
   * 计算两份快照的差异
   */
  function computeDiff(snapshotA, snapshotB) {
    _snapshotA = snapshotA;
    _snapshotB = snapshotB;

    const nodeMapA = new Map(snapshotA.nodes.map(n => [n.id, n]));
    const nodeMapB = new Map(snapshotB.nodes.map(n => [n.id, n]));
    const linkMapA = buildLinkMap(snapshotA.links);
    const linkMapB = buildLinkMap(snapshotB.links);

    // 节点差异
    const nodesAdded = [];
    const nodesRemoved = [];
    const nodesChanged = [];
    const nodesUnchanged = [];

    // B 中有的节点
    for (const nodeB of snapshotB.nodes) {
      if (!nodeMapA.has(nodeB.id)) {
        nodesAdded.push({
          ...cloneNode(nodeB),
          _diffState: DIFF_STATES.ADDED
        });
      } else {
        const nodeA = nodeMapA.get(nodeB.id);
        const changes = deepFieldDiff(nodeA, nodeB, DIFF_FIELDS);
        if (changes.length > 0) {
          nodesChanged.push({
            id: nodeB.id,
            type: nodeB.type,
            label: nodeB.label,
            changes,
            _nodeA: cloneNode(nodeA),
            _nodeB: cloneNode(nodeB),
            _diffState: DIFF_STATES.CHANGED
          });
        } else {
          nodesUnchanged.push({
            id: nodeB.id,
            _diffState: DIFF_STATES.UNCHANGED
          });
        }
      }
    }

    // A 中有但 B 中没有的 → 删除
    for (const nodeA of snapshotA.nodes) {
      if (!nodeMapB.has(nodeA.id)) {
        nodesRemoved.push({
          ...cloneNode(nodeA),
          _diffState: DIFF_STATES.REMOVED
        });
      }
    }

    // 链路差异
    const linksAdded = [];
    const linksRemoved = [];
    const linksChanged = [];
    const linksUnchanged = [];

    const matchedLinksA = new Set();

    for (const linkB of snapshotB.links) {
      const matchA = findMatchingLink(linkB, snapshotA.links, linkMapA);
      if (!matchA) {
        linksAdded.push({
          ...cloneLink(linkB),
          _diffState: DIFF_STATES.ADDED
        });
      } else {
        matchedLinksA.add(matchA.id);
        const changes = deepFieldDiff(matchA, linkB, ['status', 'label']);
        if (changes.length > 0) {
          linksChanged.push({
            id: linkB.id,
            source: linkB.source,
            target: linkB.target,
            changes,
            _linkA: cloneLink(matchA),
            _linkB: cloneLink(linkB),
            _diffState: DIFF_STATES.CHANGED
          });
        } else {
          linksUnchanged.push({
            id: linkB.id,
            _diffState: DIFF_STATES.UNCHANGED
          });
        }
      }
    }

    for (const linkA of snapshotA.links) {
      if (!matchedLinksA.has(linkA.id) && !findMatchingLink(linkA, snapshotB.links, linkMapB)) {
        linksRemoved.push({
          ...cloneLink(linkA),
          _diffState: DIFF_STATES.REMOVED
        });
      }
    }

    _diffResult = {
      meta: {
        snapshotALabel: snapshotA.label || '快照A',
        snapshotBLabel: snapshotB.label || '快照B',
        generatedAt: new Date().toISOString(),
        summary: {
          nodesAdded: nodesAdded.length,
          nodesRemoved: nodesRemoved.length,
          nodesChanged: nodesChanged.length,
          linksAdded: linksAdded.length,
          linksRemoved: linksRemoved.length,
          linksChanged: linksChanged.length
        }
      },
      nodesAdded,
      nodesRemoved,
      nodesChanged,
      nodesUnchanged,
      linksAdded,
      linksRemoved,
      linksChanged,
      linksUnchanged,
      propagationGraph: null
    };

    return _diffResult;
  }

  /**
   * 构建合并拓扑供渲染使用
   */
  function buildMergedTopology() {
    if (!_diffResult) return;

    _mergedNodes = [];
    _mergedLinks = [];
    _mergedNodeMap = new Map();

    // 快照B的节点（主体）
    for (const nodeB of _snapshotB.nodes) {
      const diffState = getNodeDiffState(nodeB.id);
      const merged = cloneNode(nodeB);
      merged._diffState = diffState;
      merged._originalStatus = merged.status;
      merged._highlighted = false;
      merged._visible = true;
      merged._selected = false;
      merged._vx = 0;
      merged._vy = 0;
      merged._fx = null;
      merged._fy = null;
      merged.pinned = false;
      _mergedNodes.push(merged);
      _mergedNodeMap.set(merged.id, merged);
    }

    // 删除的节点作为 ghost
    for (const removed of _diffResult.nodesRemoved) {
      const merged = cloneNode(removed);
      merged._diffState = DIFF_STATES.REMOVED;
      merged._diffGhost = true;
      merged._originalStatus = merged.status;
      merged._highlighted = false;
      merged._visible = true;
      merged._selected = false;
      merged._vx = 0;
      merged._vy = 0;
      merged._fx = null;
      merged._fy = null;
      merged.pinned = false;
      // 位置偏移，避免和现有节点重叠
      if (typeof merged.x === 'number') merged.x += 15;
      if (typeof merged.y === 'number') merged.y += 15;
      _mergedNodes.push(merged);
      _mergedNodeMap.set(merged.id, merged);
    }

    // 快照B的链路
    for (const linkB of _snapshotB.links) {
      const diffState = getLinkDiffState(linkB.id);
      const merged = cloneLink(linkB);
      merged._diffState = diffState;
      merged._originalStatus = merged.status;
      merged._highlighted = false;
      merged._visible = true;
      _mergedLinks.push(merged);
    }

    // 删除的链路作为 ghost
    for (const removed of _diffResult.linksRemoved) {
      const merged = cloneLink(removed);
      merged._diffState = DIFF_STATES.REMOVED;
      merged._diffGhost = true;
      merged._originalStatus = merged.status;
      merged._highlighted = false;
      merged._visible = true;
      // 只保留两端节点都存在的 ghost 链路
      if (_mergedNodeMap.has(merged.source) && _mergedNodeMap.has(merged.target)) {
        _mergedLinks.push(merged);
      }
    }
  }

  /**
   * 设置告警数据
   */
  function setAlerts(alerts) {
    _alerts = alerts || [];
  }

  /**
   * 获取节点差异状态
   */
  function getNodeDiffState(nodeId) {
    if (!_diffResult) return DIFF_STATES.UNCHANGED;
    if (_diffResult.nodesAdded.some(n => n.id === nodeId)) return DIFF_STATES.ADDED;
    if (_diffResult.nodesRemoved.some(n => n.id === nodeId)) return DIFF_STATES.REMOVED;
    if (_diffResult.nodesChanged.some(n => n.id === nodeId)) return DIFF_STATES.CHANGED;
    return DIFF_STATES.UNCHANGED;
  }

  /**
   * 获取链路差异状态
   */
  function getLinkDiffState(linkId) {
    if (!_diffResult) return DIFF_STATES.UNCHANGED;
    if (_diffResult.linksAdded.some(l => l.id === linkId)) return DIFF_STATES.ADDED;
    if (_diffResult.linksRemoved.some(l => l.id === linkId)) return DIFF_STATES.REMOVED;
    if (_diffResult.linksChanged.some(l => l.id === linkId)) return DIFF_STATES.CHANGED;
    return DIFF_STATES.UNCHANGED;
  }

  /**
   * 获取可序列化的差异结果（去除 _ 前缀字段）
   */
  function getSerializableResult() {
    if (!_diffResult) return null;
    return {
      meta: _diffResult.meta,
      nodesAdded: _diffResult.nodesAdded.map(n => ({ id: n.id, type: n.type, label: n.label })),
      nodesRemoved: _diffResult.nodesRemoved.map(n => ({ id: n.id, type: n.type, label: n.label })),
      nodesChanged: _diffResult.nodesChanged.map(n => ({ id: n.id, type: n.type, label: n.label, changes: n.changes })),
      linksAdded: _diffResult.linksAdded.map(l => ({ id: l.id, source: l.source, target: l.target, status: l.status })),
      linksRemoved: _diffResult.linksRemoved.map(l => ({ id: l.id, source: l.source, target: l.target, status: l.status })),
      linksChanged: _diffResult.linksChanged.map(l => ({ id: l.id, source: l.source, target: l.target, changes: l.changes })),
    };
  }

  function getDiffResult() { return _diffResult; }
  function getMergedNodes() { return _mergedNodes; }
  function getMergedLinks() { return _mergedLinks; }
  function getMergedNodeMap() { return _mergedNodeMap; }
  function getSnapshotA() { return _snapshotA; }
  function getSnapshotB() { return _snapshotB; }
  function getAlerts() { return _alerts; }
  function getSummary() { return _diffResult ? _diffResult.meta.summary : null; }

  function reset() {
    _diffResult = null;
    _snapshotA = null;
    _snapshotB = null;
    _alerts = [];
    _mergedNodes = [];
    _mergedLinks = [];
    _mergedNodeMap = new Map();
  }

  // --- 内部辅助函数 ---

  function buildLinkMap(links) {
    const map = new Map();
    for (const l of links) {
      map.set(l.id, l);
      map.set(`${l.source}->${l.target}`, l);
      map.set(`${l.target}->${l.source}`, l);
    }
    return map;
  }

  function findMatchingLink(link, otherLinks, otherMap) {
    // 先按 ID 匹配
    if (otherMap.has(link.id)) return otherMap.get(link.id);
    // 再按 (source,target) 双向匹配
    const key1 = `${link.source}->${link.target}`;
    const key2 = `${link.target}->${link.source}`;
    if (otherMap.has(key1)) return otherMap.get(key1);
    if (otherMap.has(key2)) return otherMap.get(key2);
    return null;
  }

  function deepFieldDiff(a, b, fields) {
    const changes = [];
    for (const field of fields) {
      const valA = getNestedValue(a, field);
      const valB = getNestedValue(b, field);
      if (String(valA) !== String(valB)) {
        changes.push({ field, from: valA, to: valB });
      }
    }
    return changes;
  }

  function getNestedValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
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
      pinned: node.pinned || false,
      metadata: node.metadata ? { ...node.metadata } : {}
    };
  }

  function cloneLink(link) {
    return {
      id: link.id,
      source: link.source,
      target: link.target,
      status: link.status,
      label: link.label || '',
      metadata: link.metadata ? { ...link.metadata } : {}
    };
  }

  return {
    computeDiff,
    buildMergedTopology,
    setAlerts,
    getDiffResult,
    getMergedNodes,
    getMergedLinks,
    getMergedNodeMap,
    getSnapshotA,
    getSnapshotB,
    getAlerts,
    getSummary,
    getSerializableResult,
    getNodeDiffState,
    getLinkDiffState,
    reset,
    DIFF_STATES
  };
})();
