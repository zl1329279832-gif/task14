# 拓扑监控前端生命周期重构 — 测试复现指南

## 修复的问题清单

| # | 问题 | 根因 | 修复位置 |
|---|------|------|----------|
| 1 | 导入新拓扑后旧告警继续播放 | `loadData` 未停止旧 `AlertReplay` 定时器 | `app.js` → `AlertReplay.reset()` |
| 2 | 旧节点选中状态带入新图 | `interaction.js` 闭包内 `selectedNodes` 未清空 | `interaction.js` → `resetState()` |
| 3 | 旧折叠分组状态带入新图 | `restoreLayout` 无签名校验，盲目恢复旧折叠 | `import-export.js` → 签名比对 |
| 4 | 旧上下游高亮带入新图 | `clearHighlights()` 未在新数据加载前调用 | `interaction.js` → `resetState()` |
| 5 | 布局缓存跨拓扑复用 | `restoreLayout` 只按节点ID匹配，无拓扑签名 | `data-parser.js` → `computeTopologySignature()` |
| 6 | 乱序告警排序不稳定 | 相同时间戳的告警排序不确定 | `data-parser.js` → `localeCompare` 二级排序 |
| 7 | 重复告警ID导致状态混乱 | 未检测重复 `alert.id` | `data-parser.js` → 告警ID去重 |
| 8 | 孤立节点未被标记 | 已有检测但告警引用不存在的节点时崩溃 | `data-parser.js` → 引用校验 |
| 9 | 环路链路未阻断 | 已有检测但反向重复连线未处理 | `data-parser.js` → `reverseKey` 检查 |
| 10 | 分组折叠后搜索定位失效 | 点击搜索结果时不展开折叠分组 | `interaction.js` → 搜索点击自动展开 |
| 11 | 搜索与告警高亮互相清除 | `clearHighlights()` 同时清除搜索和告警高亮 | `alert-replay.js` → 独立高亮追踪集合 |

## 复现测试步骤

### 测试1: 导入新拓扑清空旧状态

1. 打开应用，点击 **"示例"** 加载默认拓扑
2. 播放告警到第5步（点击 ▶️ 或拖动滑块），观察节点高亮和状态变化
3. 选中几个节点（Shift+点击），折叠 "北京" 分组
4. 在搜索框输入 "API" 并观察高亮
5. **不暂停回放**，直接导入 `test-topology-a.json`
6. **验证**：
   - [x] 回放已停止，时间线重置为 `--:--:--`
   - [x] 无旧节点选中蓝环
   - [x] 无旧搜索高亮
   - [x] 无旧告警状态（所有节点为 normal）
   - [x] 所有分组已展开（无折叠状态残留）
   - [x] 搜索框已清空

### 测试2: 布局缓存签名校验

1. 加载 `test-topology-a.json`，手动拖动几个节点到特定位置，点击 **"保存"**
2. 刷新页面 → **验证**：节点恢复到保存位置
3. 导入 `test-topology-b.json`（有同名节点 `srv-1`, `srv-2`, `db-1`）
4. **验证**：
   - [x] 节点不沿用 A 拓扑的位置（自动布局）
   - [x] 控制台输出 `🔄 拓扑签名不匹配`
5. 重新加载 `test-topology-a.json`
6. **验证**：节点恢复到步骤1保存的位置（签名匹配）

### 测试3: 乱序告警和重复ID

1. 导入 `test-topology-a.json`
2. 观察验证对话框
3. **验证**：
   - [x] 提示"时间乱序"告警已按时间戳正确排序
   - [x] 提示"同时间戳"告警已按ID稳定排序
   - [x] 提示"引用不存在的节点 ghost-node"
   - [x] 提示"引用不存在的连线 nonexistent_link_id"
   - [x] 提示"受影响节点 also-ghost 不存在，已移除"
   - [x] 回放时不因空引用崩溃

### 测试4: 孤立节点和环路

1. 导入 `test-topology-a.json`
2. **验证**：
   - [x] 提示"1 个孤立节点: orphan-1"
   - [x] 提示"检测到环形依赖"
   - [x] 提示"重复连线" 和 "反向重复" 被跳过
   - [x] 提示源/目标不存在的连线被跳过

### 测试5: 分组折叠后搜索定位

1. 导入 `test-topology-c.json`
2. 折叠 "接入层" 分组（双击分组区域）
3. 搜索 "APP前端" 并点击搜索结果
4. **验证**：
   - [x] "接入层" 分组自动展开
   - [x] "APP前端" 节点被选中并居中显示
   - [x] 节点详情面板弹出

### 测试6: 搜索与告警高亮互不干扰

1. 导入 `test-topology-c.json`
2. 搜索 "数据库" → 观察 `c-db1`, `c-db2` 高亮（虚线蓝环）
3. 播放告警到第2步（`c-srv1` 宕机）
4. **验证**：
   - [x] 搜索框仍显示 "数据库"
   - [x] `c-db1`, `c-db2` 仍有搜索高亮
   - [x] `c-srv1` 有告警高亮
   - [x] 两种高亮可以共存

### 测试7: 告警严重度只升不降

1. 导入 `test-topology-a.json`
2. 播放到第1步：`srv-2` 变为 `critical`
3. 继续播放到最后一步：`srv-2` 收到 `normal` 恢复告警
4. **验证**：
   - [x] `srv-2` 状态仍为 `critical`（不降级）

## 文件变更清单

```
js/data-parser.js    +42行  拓扑签名计算、告警去重、引用校验、稳定排序
js/alert-replay.js   +35行  reset()方法、独立高亮追踪集合
js/interaction.js    +48行  resetState()方法、搜索自动展开折叠分组
js/import-export.js  +8行   布局签名保存与校验
js/app.js            +6行   loadData()前调用reset、signature状态字段
test-topology-a.json        边界场景测试：乱序、重复、孤立、环路
test-topology-b.json        跨拓扑签名测试：同名节点不同拓扑
test-topology-c.json        折叠+搜索+回放干扰测试
```
