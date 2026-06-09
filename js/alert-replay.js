/**
 * alert-replay.js — 告警时间线回放引擎
 * 负责：时间线控制、告警播放、状态同步、影响范围更新
 */
const AlertReplay = (() => {
  'use strict';

  let appState = null;
  let currentIndex = -1;
  let isPlaying = false;
  let playSpeed = 1;
  let playTimer = null;
  let slider = null;

  // 追踪告警系统设置的高亮节点（避免清除搜索高亮）
  let alertHighlightedNodes = new Set();
  let alertHighlightedLinks = new Set();

  // 回放间隔（毫秒）
  const BASE_INTERVAL = 1500;

  /**
   * 初始化回放引擎
   */
  function init(state) {
    appState = state;
    slider = document.getElementById('timeline-slider');

    // 绑定控制按钮
    document.getElementById('btn-play').addEventListener('click', togglePlay);
    document.getElementById('btn-step-back').addEventListener('click', stepBack);
    document.getElementById('btn-step-forward').addEventListener('click', stepForward);
    document.getElementById('play-speed').addEventListener('change', (e) => {
      playSpeed = parseFloat(e.target.value);
      if (isPlaying) {
        stopTimer();
        startTimer();
      }
    });

    // 滑块拖动
    slider.addEventListener('input', () => {
      const alerts = appState.alerts;
      if (!alerts || alerts.length === 0) return;
      const idx = Math.round(parseFloat(slider.value) / 100 * (alerts.length - 1));
      seekTo(idx);
    });

    // 清除告警
    document.getElementById('btn-clear-alerts').addEventListener('click', clearAllAlerts);

    updateTimelineMarkers();
  }

  /**
   * 完全重置回放引擎（导入新拓扑时调用）
   * 停止播放、清除定时器、重置索引和所有可视化状态
   */
  function reset() {
    // 停止播放
    pause();

    // 重置索引
    currentIndex = -1;

    // 清除告警高亮追踪
    for (const node of alertHighlightedNodes) {
      if (node) node._highlighted = false;
    }
    alertHighlightedNodes.clear();
    for (const link of alertHighlightedLinks) {
      if (link) link._highlighted = false;
    }
    alertHighlightedLinks.clear();

    // 重置UI
    slider.value = 0;
    slider.disabled = true;
    document.getElementById('timeline-time').textContent = '--:--:--';
    document.getElementById('timeline-markers').innerHTML = '';
    updateProgress();
  }

  /**
   * 设置告警数据并更新时间线
   */
  function setAlerts(alerts) {
    appState.alerts = alerts;
    currentIndex = -1;
    updateTimelineMarkers();
    resetVisualization();
    Interaction.updateEventList(alerts, -1);
    updateProgress();
  }

  /**
   * 更新时间线标记
   */
  function updateTimelineMarkers() {
    const markers = document.getElementById('timeline-markers');
    const alerts = appState.alerts;

    if (!alerts || alerts.length === 0) {
      markers.innerHTML = '';
      slider.value = 0;
      slider.disabled = true;
      return;
    }

    slider.disabled = false;
    slider.min = 0;
    slider.max = 100;
    slider.step = 100 / Math.max(alerts.length - 1, 1);

    // 生成标记
    const timeMin = alerts[0].timestamp;
    const timeMax = alerts[alerts.length - 1].timestamp;
    const timeRange = timeMax - timeMin || 1;

    markers.innerHTML = alerts.map(alert => {
      const pct = ((alert.timestamp - timeMin) / timeRange) * 100;
      const severity = alert.severity || 'warning';
      return `<div class="timeline-marker ${severity}" style="left:${pct}%"></div>`;
    }).join('');
  }

  /**
   * 跳转到指定告警索引
   */
  function seekTo(index) {
    const alerts = appState.alerts;
    if (!alerts || index < 0 || index >= alerts.length) return;

    currentIndex = index;
    const alert = alerts[index];

    // 更新滑块
    slider.value = (index / (alerts.length - 1)) * 100;

    // 更新时间显示
    document.getElementById('timeline-time').textContent =
      new Date(alert.timestamp).toLocaleTimeString();

    // 应用告警状态到节点和连线
    applyAlertState(index);

    // 更新事件列表
    Interaction.updateEventList(alerts, index);

    // 更新影响范围
    if (alert.nodeId) {
      Interaction.showImpact(alert.nodeId);
    }

    updateProgress();
    Interaction.renderAll();
  }

  /**
   * 应用告警状态（累积到指定索引）
   */
  function applyAlertState(upToIndex) {
    const alerts = appState.alerts;

    // 先重置所有节点/连线状态
    resetNodeStatus();

    // 累积应用告警
    for (let i = 0; i <= upToIndex; i++) {
      const alert = alerts[i];

      // 更新节点状态
      if (alert.nodeId) {
        const node = appState.nodeMap.get(alert.nodeId);
        if (node) {
          // 状态只升级不降级
          const severityRank = { normal: 0, warning: 1, critical: 2, offline: 3 };
          const newRank = severityRank[alert.severity] || 1;
          const curRank = severityRank[node.status] || 0;
          if (newRank > curRank) {
            node.status = alert.severity;
          }
        }
      }

      // 更新连线状态
      if (alert.linkId) {
        const link = appState.links.find(l => l.id === alert.linkId);
        if (link) {
          const severityRank = { normal: 0, warning: 1, critical: 2 };
          const newRank = severityRank[alert.severity] || 1;
          const curRank = severityRank[link.status] || 0;
          if (newRank > curRank) {
            link.status = alert.severity;
          }
        }
      }

      // 更新受影响节点
      if (alert.affectedNodes) {
        for (const affectedId of alert.affectedNodes) {
          const node = appState.nodeMap.get(affectedId);
          if (node) {
            const severityRank = { normal: 0, warning: 1, critical: 2 };
            const newRank = Math.min((severityRank[alert.severity] || 1) - 1, 2);
            const curRank = severityRank[node.status] || 0;
            const degradedStatus = ['normal', 'warning', 'critical'][Math.max(newRank, 0)];
            if (severityRank[degradedStatus] > curRank) {
              node.status = degradedStatus;
            }
          }
        }
      }
    }

    // 只清除告警系统设置的高亮（不影响搜索/追踪高亮）
    for (const node of alertHighlightedNodes) {
      node._highlighted = false;
    }
    alertHighlightedNodes.clear();
    for (const link of alertHighlightedLinks) {
      link._highlighted = false;
    }
    alertHighlightedLinks.clear();

    const currentAlert = alerts[upToIndex];
    if (currentAlert?.nodeId) {
      const node = appState.nodeMap.get(currentAlert.nodeId);
      if (node) {
        node._highlighted = true;
        alertHighlightedNodes.add(node);
      }

      // 高亮相关连线
      for (const link of appState.links) {
        if (link.source === currentAlert.nodeId || link.target === currentAlert.nodeId) {
          link._highlighted = true;
          alertHighlightedLinks.add(link);
        }
      }
    }
  }

  /**
   * 重置所有节点状态为normal
   */
  function resetNodeStatus() {
    for (const node of appState.nodes) {
      node.status = node._originalStatus || 'normal';
    }
    for (const link of appState.links) {
      link.status = link._originalStatus || 'normal';
    }
  }

  /**
   * 保存原始状态
   */
  function saveOriginalStatus() {
    for (const node of appState.nodes) {
      node._originalStatus = node.status;
    }
    for (const link of appState.links) {
      link._originalStatus = link.status;
    }
  }

  /**
   * 重置可视化状态
   */
  function resetVisualization() {
    resetNodeStatus();
    Interaction.clearHighlights();
    Interaction.hideImpact();
    Interaction.renderAll();
  }

  /**
   * 播放/暂停切换
   */
  function togglePlay() {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }

  /**
   * 开始播放
   */
  function play() {
    const alerts = appState.alerts;
    if (!alerts || alerts.length === 0) return;

    // 如果已播放完毕，从头开始
    if (currentIndex >= alerts.length - 1) {
      currentIndex = -1;
      saveOriginalStatus();
      resetNodeStatus();
    }

    // 首次播放时保存原始状态
    if (currentIndex < 0) {
      saveOriginalStatus();
    }

    isPlaying = true;
    document.getElementById('btn-play').textContent = '⏸';
    document.getElementById('btn-play').classList.add('playing');
    startTimer();
  }

  /**
   * 暂停播放
   */
  function pause() {
    isPlaying = false;
    document.getElementById('btn-play').textContent = '▶️';
    document.getElementById('btn-play').classList.remove('playing');
    stopTimer();
  }

  /**
   * 上一步
   */
  function stepBack() {
    if (currentIndex > 0) {
      seekTo(currentIndex - 1);
    }
  }

  /**
   * 下一步
   */
  function stepForward() {
    const alerts = appState.alerts;
    if (!alerts || alerts.length === 0) return;

    if (currentIndex < 0) {
      saveOriginalStatus();
    }

    if (currentIndex < alerts.length - 1) {
      seekTo(currentIndex + 1);
    }
  }

  /**
   * 播放计时器
   */
  function startTimer() {
    stopTimer();
    const interval = BASE_INTERVAL / playSpeed;
    playTimer = setInterval(() => {
      const alerts = appState.alerts;
      if (!alerts) return;

      if (currentIndex < alerts.length - 1) {
        seekTo(currentIndex + 1);
      } else {
        pause();
      }
    }, interval);
  }

  function stopTimer() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
  }

  /**
   * 清除所有告警效果
   */
  function clearAllAlerts() {
    pause();
    currentIndex = -1;
    // 清除告警高亮追踪
    for (const node of alertHighlightedNodes) {
      if (node) node._highlighted = false;
    }
    alertHighlightedNodes.clear();
    for (const link of alertHighlightedLinks) {
      if (link) link._highlighted = false;
    }
    alertHighlightedLinks.clear();
    resetVisualization();
    Interaction.updateEventList(appState.alerts || [], -1);
    slider.value = 0;
    document.getElementById('timeline-time').textContent = '--:--:--';
    updateProgress();
  }

  /**
   * 更新进度显示
   */
  function updateProgress() {
    const total = appState.alerts?.length || 0;
    document.getElementById('event-progress').textContent =
      `${Math.max(currentIndex + 1, 0)} / ${total}`;
  }

  /**
   * 获取当前回放状态
   */
  function getState() {
    return {
      currentIndex,
      isPlaying,
      totalAlerts: appState.alerts?.length || 0,
    };
  }

  return {
    init,
    reset,
    setAlerts,
    play,
    pause,
    seekTo,
    stepBack,
    stepForward,
    clearAllAlerts,
    saveOriginalStatus,
    getState,
  };
})();
