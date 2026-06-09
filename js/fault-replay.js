/**
 * fault-replay.js — 故障传播分析与回放引擎
 * 负责：传播图构建、根因推断、链管理、回放控制、高亮联动
 */
const FaultReplay = (() => {
  'use strict';

  // 配置常量
  const T_WINDOW = 60000;           // 根因候选时间窗口 (60s)
  const MAX_PROPAGATION_DELAY = 120000; // 最大传播延迟 (120s)
  const BFS_MAX_DEPTH = 20;
  const BUSINESS_NODE_TYPES = ['app'];
  const CLUSTER_GAP = 60000;        // 时间聚类间隔

  // 内部状态
  let _propagationGraph = null;
  let _adjacencyMap = null;
  let _alertByNode = null;
  let _chains = [];
  let _rootCauseNodeId = null;

  let _playbackState = {
    mode: 'diff',
    playing: false,
    speed: 1,
    activeAlertIndex: -1,
    playTimer: null,
    highlightedChainIds: [],
    highlightedNodeIds: new Set(),
    highlightedLinkIds: new Set(),
    propagationWavefront: {},  // nodeId -> { arrivalTime, severity, pulsePhase }
    affectedBusinessNodes: new Set()
  };

  const BASE_INTERVAL = 1500;

  /**
   * 初始化 — 设置 AlertReplay 回调
   */
  function init() {
    // 设置 diff 模式回调
    if (typeof AlertReplay !== 'undefined') {
      AlertReplay.onDiffAlertFired = _onAlertActivated;
    }
  }

  /**
   * 构建传播图
   */
  function buildPropagationGraph(alerts, nodes, links) {
    if (!alerts || alerts.length === 0) {
      _propagationGraph = { rootCauseNodeId: null, chains: [] };
      _chains = [];
      _rootCauseNodeId = null;
      return _propagationGraph;
    }

    // 构建邻接表（双向）
    _adjacencyMap = {};
    for (const link of links) {
      if (!_adjacencyMap[link.source]) _adjacencyMap[link.source] = [];
      if (!_adjacencyMap[link.target]) _adjacencyMap[link.target] = [];
      _adjacencyMap[link.source].push({ neighbor: link.target, linkId: link.id });
      _adjacencyMap[link.target].push({ neighbor: link.source, linkId: link.id });
    }

    // 构建告警-节点索引
    _alertByNode = new Map();
    for (const alert of alerts) {
      if (alert.nodeId) {
        if (!_alertByNode.has(alert.nodeId)) _alertByNode.set(alert.nodeId, []);
        _alertByNode.get(alert.nodeId).push(alert);
      }
    }

    // 按时间排序每个节点的告警
    for (const [nodeId, nodeAlerts] of _alertByNode) {
      nodeAlerts.sort((a, b) => a.timestamp - b.timestamp);
    }

    // 识别根因
    _rootCauseNodeId = _findRootCause(alerts);

    // 构建传播链
    _chains = [];
    const visited = new Set();

    // 从根因开始 BFS 追踪
    if (_rootCauseNodeId) {
      const rootAlerts = _alertByNode.get(_rootCauseNodeId) || [];
      if (rootAlerts.length > 0) {
        const mainChain = _bfsForwardTrace(rootAlerts[0], alerts, visited);
        if (mainChain.steps.length > 0) {
          _chains.push(mainChain);
        }
      }
    }

    // 处理未入链的告警 → 时间聚类 → 独立链
    const unchainedAlerts = alerts.filter(a => !visited.has(a.id));
    if (unchainedAlerts.length > 0) {
      const clusters = _temporalCluster(unchainedAlerts);
      for (const cluster of clusters) {
        if (cluster.length > 0 && cluster[0].nodeId) {
          const chain = _bfsForwardTrace(cluster[0], alerts, visited);
          if (chain.steps.length > 0) {
            _chains.push(chain);
          }
        }
      }
    }

    // 识别受影响业务节点
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    for (const chain of _chains) {
      chain.affectedBusinessNodes = _findAffectedBusiness(chain.steps, nodes, links, nodeMap);
    }

    _propagationGraph = {
      rootCauseNodeId: _rootCauseNodeId,
      chains: _chains
    };

    // 更新 TopoDiff 结果
    if (typeof TopoDiff !== 'undefined') {
      const diffResult = TopoDiff.getDiffResult();
      if (diffResult) {
        diffResult.propagationGraph = _propagationGraph;
      }
    }

    return _propagationGraph;
  }

  /**
   * 根因推断
   */
  function _findRootCause(alerts) {
    if (alerts.length === 0) return null;

    const firstTimestamp = alerts[0].timestamp;
    const candidates = alerts.filter(a =>
      a.timestamp - firstTimestamp <= T_WINDOW && a.nodeId
    );

    if (candidates.length === 0) return alerts[0].nodeId;

    // 选择时间窗口内可达节点最多的告警节点
    let bestNode = candidates[0].nodeId;
    let bestCount = 0;

    const checked = new Set();
    for (const candidate of candidates) {
      if (checked.has(candidate.nodeId)) continue;
      checked.add(candidate.nodeId);

      const count = _bfsReachableCount(candidate.nodeId, candidate.timestamp);
      if (count > bestCount) {
        bestCount = count;
        bestNode = candidate.nodeId;
      }
    }

    return bestNode;
  }

  /**
   * BFS 可达计数
   */
  function _bfsReachableCount(nodeId, startTime) {
    const visited = new Set([nodeId]);
    const queue = [nodeId];
    let count = 0;

    while (queue.length > 0 && count < BFS_MAX_DEPTH) {
      const current = queue.shift();
      for (const { neighbor } of (_adjacencyMap[current] || [])) {
        if (visited.has(neighbor)) continue;
        // 检查该邻居是否在时间窗口内有告警
        const neighborAlerts = _alertByNode.get(neighbor) || [];
        const hasTimelyAlert = neighborAlerts.some(a =>
          a.timestamp >= startTime && a.timestamp <= startTime + T_WINDOW
        );
        if (hasTimelyAlert) {
          visited.add(neighbor);
          queue.push(neighbor);
          count++;
        }
      }
    }

    return count;
  }

  /**
   * BFS 前向追踪 — 从根告警沿拓扑传播
   */
  function _bfsForwardTrace(rootAlert, allAlerts, globalVisited) {
    const chain = {
      chainId: 'chain-' + (_chains.length + 1).toString().padStart(3, '0'),
      rootAlertId: rootAlert.id,
      originNodeId: rootAlert.nodeId,
      steps: [],
      affectedBusinessNodes: [],
      totalDurationMs: 0
    };

    // 按时间排序的优先队列（简化为排序数组）
    const pending = [{ alert: rootAlert, viaLinkId: null, order: 0 }];
    const chainVisited = new Set();

    while (pending.length > 0) {
      // 取最早的
      pending.sort((a, b) => a.alert.timestamp - b.alert.timestamp);
      const { alert, viaLinkId, order } = pending.shift();

      if (chainVisited.has(alert.id)) continue;
      chainVisited.add(alert.id);
      globalVisited.add(alert.id);

      chain.steps.push({
        order,
        alertId: alert.id,
        nodeId: alert.nodeId,
        timestamp: alert.timestamp,
        severity: alert.severity,
        message: alert.message,
        viaLinkId
      });

      // 找邻居中时间上后续的告警
      for (const { neighbor, linkId } of (_adjacencyMap[alert.nodeId] || [])) {
        const neighborAlerts = (_alertByNode.get(neighbor) || [])
          .filter(a => a.timestamp >= alert.timestamp)
          .filter(a => a.timestamp - alert.timestamp <= MAX_PROPAGATION_DELAY)
          .filter(a => !chainVisited.has(a.id));

        for (const na of neighborAlerts) {
          pending.push({ alert: na, viaLinkId: linkId, order: order + 1 });
        }
      }
    }

    if (chain.steps.length > 0) {
      chain.totalDurationMs = chain.steps[chain.steps.length - 1].timestamp - chain.steps[0].timestamp;
    }

    return chain;
  }

  /**
   * 时间聚类
   */
  function _temporalCluster(alerts) {
    if (alerts.length === 0) return [];
    const sorted = [...alerts].sort((a, b) => a.timestamp - b.timestamp);
    const clusters = [];
    let current = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timestamp - current[current.length - 1].timestamp > CLUSTER_GAP) {
        clusters.push(current);
        current = [sorted[i]];
      } else {
        current.push(sorted[i]);
      }
    }
    clusters.push(current);
    return clusters;
  }

  /**
   * 识别受影响业务节点
   */
  function _findAffectedBusiness(steps, nodes, links, nodeMap) {
    const stepNodeIds = new Set(steps.map(s => s.nodeId).filter(Boolean));
    const affected = new Set();

    // 从传播链节点 BFS 下游，找业务类型节点
    const adj = {};
    for (const link of links) {
      if (!adj[link.source]) adj[link.source] = [];
      adj[link.source].push(link.target);
    }

    const visited = new Set(stepNodeIds);
    const queue = [...stepNodeIds];

    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of (adj[current] || [])) {
        if (visited.has(next)) continue;
        visited.add(next);
        const node = nodeMap.get(next);
        if (node && BUSINESS_NODE_TYPES.includes(node.type)) {
          affected.add(next);
        }
        queue.push(next);
      }
    }

    // 也检查传播链节点本身是否是业务节点
    for (const id of stepNodeIds) {
      const node = nodeMap.get(id);
      if (node && BUSINESS_NODE_TYPES.includes(node.type)) {
        affected.add(id);
      }
    }

    return [...affected];
  }

  // --- 回放控制 ---

  function startPlayback(alerts) {
    if (!alerts || alerts.length === 0) return;

    if (_playbackState.activeAlertIndex >= alerts.length - 1) {
      _playbackState.activeAlertIndex = -1;
      _resetWavefront();
    }

    if (_playbackState.activeAlertIndex < 0) {
      _resetWavefront();
    }

    _playbackState.playing = true;
    _startTimer(alerts);
  }

  function pausePlayback() {
    _playbackState.playing = false;
    _stopTimer();
  }

  function stepPropagation(alerts) {
    if (!alerts || alerts.length === 0) return;
    if (_playbackState.activeAlertIndex < alerts.length - 1) {
      const nextIdx = _playbackState.activeAlertIndex + 1;
      _seekToIndex(nextIdx, alerts);
    }
  }

  function stepChain(alerts) {
    if (_chains.length === 0) return;
    const currentIdx = _playbackState.activeAlertIndex;
    const currentAlert = currentIdx >= 0 ? alerts[currentIdx] : null;

    // 找下一条链的起始告警
    for (const chain of _chains) {
      const chainStartIdx = alerts.findIndex(a => a.id === chain.rootAlertId);
      if (chainStartIdx > currentIdx) {
        _seekToIndex(chainStartIdx, alerts);
        return;
      }
    }
    // 已到最后一条链，跳到末尾
    _seekToIndex(alerts.length - 1, alerts);
  }

  function rewind(alerts) {
    pausePlayback();
    _playbackState.activeAlertIndex = -1;
    _resetWavefront();
    clearHighlights();
    if (typeof App !== 'undefined' && App.state) {
      Interaction.updateEventList(alerts || [], -1);
      Interaction.renderAll();
    }
  }

  function setSpeed(speed) {
    _playbackState.speed = speed;
    if (_playbackState.playing) {
      _stopTimer();
      if (typeof App !== 'undefined') {
        _startTimer(App.state.alerts);
      }
    }
  }

  function jumpToAlert(alert, alerts) {
    const idx = alerts.findIndex(a => a.id === alert.id);
    if (idx >= 0) {
      _seekToIndex(idx, alerts);
    }
  }

  function jumpToTime(timestamp, alerts) {
    if (!alerts || alerts.length === 0) return;
    // 找到最接近的告警索引
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < alerts.length; i++) {
      const diff = Math.abs(alerts[i].timestamp - timestamp);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    _seekToIndex(bestIdx, alerts);
  }

  function _seekToIndex(index, alerts) {
    if (index < 0 || index >= alerts.length) return;
    _playbackState.activeAlertIndex = index;

    // 重建波前状态
    _resetWavefront();
    for (let i = 0; i <= index; i++) {
      const alert = alerts[i];
      if (alert.nodeId) {
        _playbackState.propagationWavefront[alert.nodeId] = {
          arrivalTime: alert.timestamp,
          severity: alert.severity,
          pulsePhase: 0
        };
      }
    }

    // 更新告警回放状态
    if (typeof AlertReplay !== 'undefined') {
      AlertReplay.seekTo(index);
    }

    // 居中视口到当前告警节点（如果不在可视区域）
    const currentAlert = alerts[index];
    if (currentAlert && currentAlert.nodeId) {
      const nodeMap = TopoDiff.getMergedNodeMap();
      const node = nodeMap.get(currentAlert.nodeId);
      if (node && node._visible !== false && node.x != null && node.y != null) {
        const screenPos = Renderer.worldToScreen(node.x, node.y);
        const size = Renderer.getCanvasSize();
        const margin = 80;
        if (screenPos.x < margin || screenPos.x > size.width - margin ||
            screenPos.y < margin || screenPos.y > size.height - margin) {
          Renderer.centerOn(node.x, node.y);
        }
      }
    }

    // 更新事件列表
    Interaction.updateEventList(alerts, index);
    Interaction.renderAll();
  }

  function _startTimer(alerts) {
    _stopTimer();
    const interval = BASE_INTERVAL / _playbackState.speed;
    _playbackState.playTimer = setInterval(() => {
      if (!alerts) return;
      if (_playbackState.activeAlertIndex < alerts.length - 1) {
        _seekToIndex(_playbackState.activeAlertIndex + 1, alerts);
      } else {
        pausePlayback();
      }
    }, interval);
  }

  function _stopTimer() {
    if (_playbackState.playTimer) {
      clearInterval(_playbackState.playTimer);
      _playbackState.playTimer = null;
    }
  }

  function _resetWavefront() {
    _playbackState.propagationWavefront = {};
    _playbackState.affectedBusinessNodes = new Set();
  }

  // --- 高亮控制 ---

  function highlightChain(chainId) {
    clearHighlights();
    const chain = _chains.find(c => c.chainId === chainId);
    if (!chain) return;

    for (const step of chain.steps) {
      if (step.nodeId) {
        _playbackState.highlightedNodeIds.add(step.nodeId);
      }
      if (step.viaLinkId) {
        _playbackState.highlightedLinkIds.add(step.viaLinkId);
      }
    }

    // 高亮受影响业务节点
    for (const bizId of chain.affectedBusinessNodes) {
      _playbackState.highlightedNodeIds.add(bizId);
      _playbackState.affectedBusinessNodes.add(bizId);
    }

    _playbackState.highlightedChainIds = [chainId];
    _applyHighlightsToNodes();
  }

  function highlightChainUpTo(chainId, stepOrder) {
    clearHighlights();
    const chain = _chains.find(c => c.chainId === chainId);
    if (!chain) return;

    for (const step of chain.steps) {
      if (step.order > stepOrder) break;
      if (step.nodeId) {
        _playbackState.highlightedNodeIds.add(step.nodeId);
      }
      if (step.viaLinkId) {
        _playbackState.highlightedLinkIds.add(step.viaLinkId);
      }
    }

    _playbackState.highlightedChainIds = [chainId];
    _applyHighlightsToNodes();
  }

  function highlightAffectedBusiness(chain) {
    for (const bizId of (chain.affectedBusinessNodes || [])) {
      _playbackState.highlightedNodeIds.add(bizId);
      _playbackState.affectedBusinessNodes.add(bizId);
    }
    _applyHighlightsToNodes();
  }

  function highlightUpstreamFrom(nodeId, links, nodeMap) {
    // BFS 反向追踪上游
    const reverseAdj = {};
    for (const l of links) {
      if (!reverseAdj[l.target]) reverseAdj[l.target] = [];
      reverseAdj[l.target].push({ source: l.source, linkId: l.id });
    }

    const visited = new Set([nodeId]);
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const { source, linkId } of (reverseAdj[current] || [])) {
        if (!visited.has(source)) {
          visited.add(source);
          _playbackState.highlightedNodeIds.add(source);
          _playbackState.highlightedLinkIds.add(linkId);
          queue.push(source);
        }
      }
    }
    _applyHighlightsToNodes();
  }

  function clearHighlights() {
    _playbackState.highlightedChainIds = [];
    _playbackState.highlightedNodeIds = new Set();
    _playbackState.highlightedLinkIds = new Set();
    _playbackState.affectedBusinessNodes = new Set();
    _clearHighlightsFromNodes();
  }

  function _applyHighlightsToNodes() {
    const nodes = TopoDiff.getMergedNodes();
    const links = TopoDiff.getMergedLinks();
    for (const node of nodes) {
      // 只对可见节点应用高亮，避免隐藏节点的高亮状态残留
      if (node._visible === false) {
        node._highlighted = false;
      } else {
        node._highlighted = _playbackState.highlightedNodeIds.has(node.id);
      }
    }
    for (const link of links) {
      if (link._visible === false) {
        link._highlighted = false;
      } else {
        link._highlighted = _playbackState.highlightedLinkIds.has(link.id);
      }
    }
  }

  function _clearHighlightsFromNodes() {
    const nodes = TopoDiff.getMergedNodes();
    const links = TopoDiff.getMergedLinks();
    for (const node of nodes) {
      node._highlighted = false;
    }
    for (const link of links) {
      link._highlighted = false;
    }
  }

  // --- 查询方法 ---

  function getChainsForNode(nodeId) {
    return _chains.filter(c => c.steps.some(s => s.nodeId === nodeId));
  }

  function getChainForAlert(alertId) {
    return _chains.find(c => c.steps.some(s => s.alertId === alertId)) || null;
  }

  function getRootCause() { return _rootCauseNodeId; }
  function getChains() { return _chains; }
  function getPlaybackState() { return _playbackState; }
  function isPlaying() { return _playbackState.playing; }

  function getSerializableGraph() {
    if (!_propagationGraph) return null;
    return {
      rootCauseNodeId: _rootCauseNodeId,
      rootCauseLabel: _rootCauseNodeId,
      chains: _chains.map(c => ({
        chainId: c.chainId,
        originNodeId: c.originNodeId,
        stepCount: c.steps.length,
        steps: c.steps.map(s => ({
          order: s.order,
          nodeId: s.nodeId,
          timestamp: s.timestamp,
          severity: s.severity,
          message: s.message
        })),
        affectedBusinessNodes: c.affectedBusinessNodes,
        totalDurationMs: c.totalDurationMs
      }))
    };
  }

  function _onAlertActivated(alert) {
    // AlertReplay 在 diff 模式下触发此回调
    if (alert && alert.nodeId) {
      _playbackState.propagationWavefront[alert.nodeId] = {
        arrivalTime: alert.timestamp,
        severity: alert.severity,
        pulsePhase: 0
      };
    }
  }

  function reset() {
    pausePlayback();
    _propagationGraph = null;
    _adjacencyMap = null;
    _alertByNode = null;
    _chains = [];
    _rootCauseNodeId = null;
    _resetWavefront();
    clearHighlights();
    _playbackState.activeAlertIndex = -1;
    _playbackState.playing = false;
  }

  return {
    init,
    buildPropagationGraph,
    startPlayback,
    pausePlayback,
    stepPropagation,
    stepChain,
    rewind,
    setSpeed,
    jumpToAlert,
    jumpToTime,
    highlightChain,
    highlightChainUpTo,
    highlightAffectedBusiness,
    highlightUpstreamFrom,
    clearHighlights,
    getChainsForNode,
    getChainForAlert,
    getRootCause,
    getChains,
    getPlaybackState,
    getSerializableGraph,
    isPlaying,
    reset
  };
})();
