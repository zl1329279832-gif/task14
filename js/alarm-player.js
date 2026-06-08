/**
 * alarm-player.js — 告警回放模块
 * 负责时间线播放控制、状态同步、事件列表更新
 */
window.AlarmPlayer = (function () {
  'use strict';

  /* ─── 状态 ─── */
  var alarms = [];
  var appState = null;
  var isPlaying = false;
  var currentIndex = -1;
  var currentTime = 0;
  var startTime = 0;
  var endTime = 0;
  var playSpeed = 1;
  var playTimer = null;
  var onUpdate = null; // 回调：(stateSnapshot) => void

  var timelineCanvas, timelineCtx;

  /* ─── 初始化 ─── */
  function init(alarmList, state, callback) {
    alarms = alarmList || [];
    appState = state;
    onUpdate = callback;

    if (alarms.length > 0) {
      startTime = alarms[0].timestamp;
      endTime = alarms[alarms.length - 1].timestamp;
      currentTime = startTime;
      currentIndex = -1;
    }

    timelineCanvas = document.getElementById('timeline-canvas');
    if (timelineCanvas) {
      timelineCtx = timelineCanvas.getContext('2d');
      resizeTimeline();
      renderTimeline();
      window.addEventListener('resize', function () {
        resizeTimeline();
        renderTimeline();
      });
    }

    updateTimeDisplay();
    updateEventList();
  }

  function resizeTimeline() {
    if (!timelineCanvas) return;
    var container = timelineCanvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    timelineCanvas.width = container.clientWidth * dpr;
    timelineCanvas.height = 32 * dpr;
    timelineCanvas.style.width = container.clientWidth + 'px';
    timelineCanvas.style.height = '32px';
    timelineCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ─── 时间线绘制 ─── */
  function renderTimeline() {
    if (!timelineCtx) return;
    var w = timelineCanvas.width / (window.devicePixelRatio || 1);
    var h = 32;

    timelineCtx.clearRect(0, 0, w, h);

    if (alarms.length === 0) {
      timelineCtx.fillStyle = '#6b7280';
      timelineCtx.font = '11px sans-serif';
      timelineCtx.textAlign = 'center';
      timelineCtx.fillText('暂无告警数据', w / 2, h / 2 + 4);
      return;
    }

    var duration = endTime - startTime || 1;

    // 绘制时间刻度
    timelineCtx.fillStyle = '#3a3f4a';
    timelineCtx.fillRect(0, h - 4, w, 2);

    // 绘制告警标记
    alarms.forEach(function (alarm, idx) {
      var x = ((alarm.timestamp - startTime) / duration) * w;
      var color = alarm.level === 'critical' ? '#f44336' :
                  alarm.level === 'warning' ? '#ff9800' : '#2196f3';

      timelineCtx.fillStyle = color;
      // 三角标记
      timelineCtx.beginPath();
      timelineCtx.moveTo(x - 4, h);
      timelineCtx.lineTo(x + 4, h);
      timelineCtx.lineTo(x, h - 10);
      timelineCtx.closePath();
      timelineCtx.fill();

      // 高亮当前及之前的事件
      if (idx <= currentIndex) {
        timelineCtx.globalAlpha = 0.3;
        timelineCtx.fillStyle = color;
        timelineCtx.fillRect(x - 1, 0, 2, h - 10);
        timelineCtx.globalAlpha = 1;
      }
    });

    // 绘制时间标签
    timelineCtx.fillStyle = '#9aa0ab';
    timelineCtx.font = '9px monospace';
    timelineCtx.textAlign = 'left';
    timelineCtx.fillText(DataParser.formatTime(startTime), 4, 12);
    timelineCtx.textAlign = 'right';
    timelineCtx.fillText(DataParser.formatTime(endTime), w - 4, 12);
  }

  /* ─── 播放控制 ─── */
  function play() {
    if (alarms.length === 0) return;
    if (currentIndex >= alarms.length - 1) {
      // 已到末尾，从头播放
      currentIndex = -1;
      currentTime = startTime;
      resetNodeStates();
    }
    isPlaying = true;
    updateButtons();
    scheduleNext();
  }

  function pause() {
    isPlaying = false;
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
    updateButtons();
  }

  function stop() {
    isPlaying = false;
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
    currentIndex = -1;
    currentTime = startTime;
    resetNodeStates();
    updateButtons();
    updateTimeDisplay();
    updateCursor();
    renderTimeline();
    updateEventList();
    fireUpdate();
  }

  function stepForward() {
    if (currentIndex < alarms.length - 1) {
      currentIndex++;
      applyAlarm(alarms[currentIndex]);
      currentTime = alarms[currentIndex].timestamp;
      updateTimeDisplay();
      updateCursor();
      renderTimeline();
      updateEventList();
      fireUpdate();
    }
  }

  function stepBack() {
    if (currentIndex >= 0) {
      currentIndex--;
      // 重新从头应用到 currentIndex
      resetNodeStates();
      for (var i = 0; i <= currentIndex; i++) {
        applyAlarm(alarms[i]);
      }
      currentTime = currentIndex >= 0 ? alarms[currentIndex].timestamp : startTime;
      updateTimeDisplay();
      updateCursor();
      renderTimeline();
      updateEventList();
      fireUpdate();
    }
  }

  function seekToPosition(ratio) {
    if (alarms.length === 0) return;
    ratio = Math.max(0, Math.min(1, ratio));
    var targetTime = startTime + (endTime - startTime) * ratio;
    seekToTime(targetTime);
  }

  function seekToTime(targetTime) {
    resetNodeStates();
    currentIndex = -1;
    for (var i = 0; i < alarms.length; i++) {
      if (alarms[i].timestamp <= targetTime) {
        currentIndex = i;
        applyAlarm(alarms[i]);
      } else {
        break;
      }
    }
    currentTime = targetTime;
    updateTimeDisplay();
    updateCursor();
    renderTimeline();
    updateEventList();
    fireUpdate();
  }

  function setSpeed(speed) {
    playSpeed = speed;
  }

  /* ─── 内部播放调度 ─── */
  function scheduleNext() {
    if (!isPlaying) return;
    var nextIdx = currentIndex + 1;
    if (nextIdx >= alarms.length) {
      pause();
      return;
    }

    var delay;
    if (currentIndex < 0) {
      delay = 500 / playSpeed;
    } else {
      delay = Math.max(100, (alarms[nextIdx].timestamp - alarms[currentIndex].timestamp)) / playSpeed;
      delay = Math.min(delay, 3000 / playSpeed); // 最大延迟限制
    }

    playTimer = setTimeout(function () {
      currentIndex = nextIdx;
      applyAlarm(alarms[currentIndex]);
      currentTime = alarms[currentIndex].timestamp;
      updateTimeDisplay();
      updateCursor();
      renderTimeline();
      updateEventList();
      fireUpdate();
      scheduleNext();
    }, delay);
  }

  /* ─── 应用单条告警 ─── */
  function applyAlarm(alarm) {
    if (!appState || !appState.nodeMap) return;

    // 设置触发节点状态
    if (alarm.nodeId && appState.nodeMap.has(alarm.nodeId)) {
      var node = appState.nodeMap.get(alarm.nodeId);
      if (alarm.level === 'critical') {
        node._alarmStatus = 'critical';
      } else if (alarm.level === 'warning') {
        node._alarmStatus = 'warning';
      }
    }

    // 批量设置节点状态
    if (alarm.nodeStates) {
      Object.keys(alarm.nodeStates).forEach(function (nid) {
        if (appState.nodeMap.has(nid)) {
          appState.nodeMap.get(nid)._alarmStatus = alarm.nodeStates[nid];
        }
      });
    }

    // 设置边状态
    if (alarm.edgeStates && appState.edgeMap) {
      Object.keys(alarm.edgeStates).forEach(function (eid) {
        if (appState.edgeMap.has(eid)) {
          appState.edgeMap.get(eid).status = alarm.edgeStates[eid];
        }
      });
    }

    // 受影响节点
    if (alarm.affectedNodes && alarm.affectedNodes.length > 0) {
      alarm.affectedNodes.forEach(function (nid) {
        if (appState.nodeMap.has(nid)) {
          var n = appState.nodeMap.get(nid);
          if (!n._alarmStatus || n._alarmStatus === 'normal') {
            n._alarmStatus = 'warning';
          }
        }
      });
    }

    Renderer.requestRender();
  }

  /* ─── 重置节点状态 ─── */
  function resetNodeStates() {
    if (!appState) return;
    if (appState.nodeMap) {
      appState.nodeMap.forEach(function (node) {
        node._alarmStatus = node.status;
      });
    }
    if (appState.edgeMap) {
      appState.edgeMap.forEach(function (edge) {
        edge.status = edge._originalStatus || 'normal';
      });
    }
    Renderer.requestRender();
  }

  /* ─── UI 更新 ─── */
  function updateButtons() {
    var playBtn = document.getElementById('btn-play');
    var pauseBtn = document.getElementById('btn-pause');
    if (playBtn && pauseBtn) {
      playBtn.classList.toggle('hidden', isPlaying);
      pauseBtn.classList.toggle('hidden', !isPlaying);
    }
  }

  function updateTimeDisplay() {
    var el = document.getElementById('alarm-time');
    if (el) {
      el.textContent = currentTime > 0 ? DataParser.formatTime(currentTime) : '--:--:--';
    }
  }

  function updateCursor() {
    var cursor = document.getElementById('timeline-cursor');
    if (!cursor || alarms.length === 0) return;
    var duration = endTime - startTime || 1;
    var ratio = (currentTime - startTime) / duration;
    var track = document.getElementById('timeline-track');
    if (track) {
      cursor.style.left = (ratio * track.clientWidth) + 'px';
    }
  }

  function updateEventList() {
    var container = document.getElementById('event-list');
    if (!container) return;

    container.innerHTML = '';
    if (alarms.length === 0) {
      container.innerHTML = '<div style="padding:12px;color:#6b7280;text-align:center">暂无告警事件</div>';
      return;
    }

    // 显示当前索引附近的事件
    var showStart = Math.max(0, currentIndex - 2);
    var showEnd = Math.min(alarms.length, (currentIndex < 0 ? 0 : currentIndex) + 8);
    if (currentIndex < 0) { showStart = 0; showEnd = Math.min(alarms.length, 10); }

    for (var i = showStart; i < showEnd; i++) {
      var alarm = alarms[i];
      var div = document.createElement('div');
      div.className = 'event-item level-' + alarm.level;
      if (i === currentIndex) div.className += ' active';

      var nodeName = '';
      if (alarm.nodeId && appState && appState.nodeMap && appState.nodeMap.has(alarm.nodeId)) {
        nodeName = appState.nodeMap.get(alarm.nodeId).name;
      }

      div.innerHTML =
        '<div class="event-time">' + alarm.timeStr + '</div>' +
        '<div class="event-node">' + (nodeName || alarm.nodeId || '') + '</div>' +
        '<div class="event-msg">' + alarm.message + '</div>';

      div.setAttribute('data-index', i);
      div.addEventListener('click', (function (idx) {
        return function () { seekToIndex(idx); };
      })(i));

      container.appendChild(div);
    }

    // 滚动到当前事件
    var activeItem = container.querySelector('.event-item.active');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
  }

  function seekToIndex(idx) {
    if (idx < 0 || idx >= alarms.length) return;
    resetNodeStates();
    currentIndex = -1;
    for (var i = 0; i <= idx; i++) {
      currentIndex = i;
      applyAlarm(alarms[i]);
    }
    currentTime = alarms[idx].timestamp;
    updateTimeDisplay();
    updateCursor();
    renderTimeline();
    updateEventList();
    fireUpdate();
  }

  function fireUpdate() {
    if (onUpdate) {
      onUpdate({
        currentIndex: currentIndex,
        currentTime: currentTime,
        isPlaying: isPlaying,
        alarm: currentIndex >= 0 ? alarms[currentIndex] : null
      });
    }
  }

  /* ─── 获取当前告警状态快照 ─── */
  function getCurrentState() {
    return {
      currentIndex: currentIndex,
      currentTime: currentTime,
      isPlaying: isPlaying,
      totalAlarms: alarms.length,
      alarm: currentIndex >= 0 ? alarms[currentIndex] : null
    };
  }

  /* ─── 公共API ─── */
  return {
    init: init,
    play: play,
    pause: pause,
    stop: stop,
    stepForward: stepForward,
    stepBack: stepBack,
    seekToPosition: seekToPosition,
    seekToTime: seekToTime,
    seekToIndex: seekToIndex,
    setSpeed: setSpeed,
    getCurrentState: getCurrentState,
    renderTimeline: renderTimeline,
    resizeTimeline: resizeTimeline,
    isPlaying: function () { return isPlaying; }
  };
})();
