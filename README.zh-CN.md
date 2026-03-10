# openclaw-phoenix

`openclaw-phoenix` 是一个**独立仓库**里的 OpenClaw 运维工具，面向已经部署好的 OpenClaw 实例：

- 持续监控配置 / 凭据相关变更，并自动创建备份
- 在需要时从已有备份恢复到当前部署路径
- 作为内部 hook 接入现有部署，在启动失败时回滚到“最近一次已知健康”的备份

它**不要求修改 OpenClaw 主仓库源码**，也**不依赖上游文档变更**。Phoenix 的工作方式是：调用已部署环境中的 `openclaw` CLI；在 hook 模式下，则把一个受管的内部 hook 写入当前部署正在使用的状态目录和配置路径。

如果你是这个独立仓库的维护者，可以把它理解为：**围绕已部署 OpenClaw 的备份 / 恢复 / 启动回滚保护层**，而不是 OpenClaw 本体的一部分。

## 历史过程归档

给后续维护者保留的实现背景资料在：

- `docs/archive/README.md`
- `docs/archive/project-journey.md`
- `docs/archive/operator-handoff.md`

## 安装与运行

在独立仓库目录中：

```sh
cd openclaw-phoenix
npm install
```

补充说明：

- 当前 `package.json` 要求 Node `>=22.12.0`
- `npm install` 会触发 `prepare`，自动构建 `dist/`
- 安装后，包暴露的可执行命令是 `openclaw-phoenix`，入口为 `dist/cli.js`

安装后常见的运行方式：

```sh
npx openclaw-phoenix --help
npm link && openclaw-phoenix --help
node dist/cli.js --help
```

## 先看这个：该用哪个命令？

- 想**常驻监控**配置 / OAuth / auth 相关文件变更，并在变更后自动备份：用 `watch`
- 想把一个**已有备份**恢复到当前部署正在使用的路径：用 `restore`
- 想给现有 OpenClaw 部署加上**启动后健康检查 + 自动回滚**：用 `hook install`
- 想手动调试 hook 执行链路：用 `hook run`
- 想干净移除 Phoenix 注入的 hook：用 `hook remove`

## 命令概览

- `openclaw-phoenix watch`
  - 长时间运行的 watcher
  - 配置 / 凭据 / auth 相关文件变更后，防抖触发 `openclaw backup create --output ... --json`
  - 备份完成后执行旧归档清理
- `openclaw-phoenix restore <archive>`
  - 先运行 `openclaw backup verify <archive> --json`
  - 验证通过后，把归档内容恢复到**当前部署**对应的 live 路径
- `openclaw-phoenix hook install`
  - 向现有 OpenClaw 部署注入一个**受 Phoenix 管理**的内部 hook
- `openclaw-phoenix hook run`
  - 供已安装 hook 调用的内部命令，执行“备份 → 健康检查 → 回滚 / 保留已知健康备份”
- `openclaw-phoenix hook remove`
  - 只移除 Phoenix 自己管理的 hook 条目和文件，不碰无关 hook

## 运行前提与路径解析

Phoenix 的设计前提是：**它总是对接一个已经存在的 OpenClaw 部署**。

### `openclaw` 可执行文件

- 默认值：`openclaw`
- 覆盖方式：`--openclaw-bin <path>`

如果目标环境里 `openclaw` 不在 `PATH` 上，请显式传入已部署 CLI 的绝对路径。

### 根配置文件路径

Phoenix 按以下顺序解析部署配置：

1. `--config <path>`
2. `OPENCLAW_CONFIG_PATH`
3. `CLAWDBOT_CONFIG_PATH`
4. `<stateDir>/openclaw.json`
5. 同一状态目录里的历史兼容文件：`clawdbot.json`、`moldbot.json`、`moltbot.json`

### 状态目录

Phoenix 按以下顺序解析部署状态目录：

1. `OPENCLAW_STATE_DIR`
2. `CLAWDBOT_STATE_DIR`
3. 如果已存在，则使用 `~/.openclaw`
4. 否则回退到历史目录（若存在）：`~/.clawdbot`、`~/.moldbot`、`~/.moltbot`
5. 如果以上都不存在，最终默认 `~/.openclaw`

### OAuth / 凭据目录

- 默认：`<stateDir>/credentials`
- 覆盖方式：`OPENCLAW_OAUTH_DIR`

### 备份输出目录

- 默认：`~/openclaw-backups`
- 覆盖方式：`--output <dir>`

Phoenix 会把以下内容都放在这个目录里：

- `watch` 生成的备份归档
- `hook run` 生成的备份归档
- hook 模式使用的 Phoenix 状态文件

## `watch` 模式

`watch` 适合放在现有部署旁边持续运行：当运维人员修改配置、凭据或相关 auth 文件时，Phoenix 会自动创建备份。

示例：

```sh
openclaw-phoenix watch \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --output ~/openclaw-backups \
  --retain 100 \
  --debounce-ms 1000
```

`watch` 的行为：

1. 解析当前部署路径
2. 监控以下目标：
   - OpenClaw 根配置文件
   - OAuth / credentials 目录
   - 递归解析出来的 `$include` 配置文件
   - 默认 agent 及配置里引用 agent 的 auth store 文件
3. 对短时间内的变更进行防抖（默认 `1000ms`）
4. 防抖窗口结束后执行 `openclaw backup create --output <dir> --json`
5. 把匹配的 `*-openclaw-backup.tar.gz` 旧归档裁剪到 `--retain`（默认 `100`）

运维层面需要注意：

- `watch` 是**变更驱动**的；启动时**不会**先做一次初始备份
- 如果根配置文件变化，Phoenix 会在下一轮备份前刷新派生出来的监控目标集合
- 来自配置推导出的无效 / 缺失路径会记为 warning，但 watcher 不会因此退出
- 单次备份失败会记日志，但不会终止整个 watch 进程

## `restore` 模式

`restore` 用于把一个**已验证**的 OpenClaw 备份归档写回到当前部署正在使用的 live 路径。

仅预览恢复计划：

```sh
openclaw-phoenix restore ~/openclaw-backups/2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --dry-run
```

真正执行恢复：

```sh
openclaw-phoenix restore ~/openclaw-backups/2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --yes
```

`restore` 的行为：

1. 先执行 `openclaw backup verify <archive> --json`
2. 读取归档 manifest 和归档内容
3. 使用与 watcher 相同的路径解析逻辑，确定**当前部署**的目标路径
4. 把 manifest 中的资源映射回当前部署的 config / state / credentials 位置
5. 打印恢复计划
6. 除非传入 `--yes`，否则要求确认
7. 把文件 / 目录复制回目标位置

安全约束：

- `--dry-run` 只验证并打印计划，不写入文件
- 如果目标目录或目标文件是符号链接，恢复会拒绝写入
- 如果归档路径不合法，或者恢复计划里出现重复目标路径，恢复会拒绝执行
- Phoenix 预期输入是由 OpenClaw backup 生成的归档；写入前会校验 manifest / archive 结构

## `hook install` / `hook remove` 行为

`hook install` 用于把 Phoenix 接到一个已经部署好的 OpenClaw 实例上。

示例：

```sh
openclaw-phoenix hook install \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --phoenix-bin /usr/local/bin/openclaw-phoenix \
  --output ~/openclaw-backups \
  --retain 100 \
  --event gateway:startup
```

默认事件：

- 如果不显式传 `--event`，Phoenix 默认订阅内部 hook 事件 `gateway:startup`
- 事件键必须包含冒号；非法值会被拒绝

安装行为：

- 创建 hook 目录：`<stateDir>/hooks/openclaw-phoenix-backup-rollback`
- 往目录里写入 3 个 Phoenix 管理的文件：
  - `HOOK.md`
  - `handler.js`
  - `install-record.json`
- 更新部署配置中的 `hooks.internal.entries.openclaw-phoenix-backup-rollback`
- 强制设置 `hooks.internal.enabled = true`，确保 hook 能运行
- 记录安装前的 `hooks.internal.enabled` 状态（`unset` / `false` / `true`），供移除时恢复

安装过程是保守的：

- 不会覆盖非 Phoenix 管理的 hook 目录
- 不会覆盖同名但无关的 hook 配置条目
- 不会影响其他内部 hook 条目

关于 `--phoenix-bin`：

- 如果省略该参数，Phoenix 会尝试捕获**当前 CLI 调用方式**，并生成一个可工作的 handler 命令
- 常见可识别形式包括：`openclaw-phoenix ...`、`node dist/cli.js ...`、`node --import tsx src/cli.ts ...`
- 但对长期部署场景，仍建议显式传入 `--phoenix-bin`，让 handler 永远指向你希望长期保留的可执行文件或入口
- 如果你是从源码 checkout 安装，不要依赖 shell alias，也不要依赖临时工作目录路径

移除 Phoenix 管理的 hook：

```sh
openclaw-phoenix hook remove --config ~/.openclaw/openclaw.json
```

移除行为：

- 只删除 `hooks.internal.entries.openclaw-phoenix-backup-rollback`
- 删除 Phoenix 管理的 hook 目录
- 保留无关 hook 条目
- 如果 Phoenix 在安装时记录到此前状态是 `false` 或 `unset`，则在移除时恢复 `hooks.internal.enabled`
- 如果安装前内部 hook 已经是启用状态，则移除时保持启用
- 遇到非 Phoenix 管理的 hook 目录时会拒绝移除

## 已安装 hook 实际做了什么

生成出来的 `handler.js` 只是运维适配层，不是第二套 Phoenix 逻辑实现。

运行时它会：

1. 启动记录下来的 Phoenix 命令，并追加参数：

   `hook run --json --config ... --openclaw-bin ... --output ... --retain ...`

2. 收集该子进程的 stdout / stderr
3. 尝试把 stdout 解析成 JSON
4. 如果 OpenClaw 的 hook 事件对象里带有 `messages` 数组，且 Phoenix 返回了通知消息，就把该消息追加到 `event.messages`
5. 当子进程退出码非 0 或发生错误时，把失败信息写到 stderr

也就是说，部署后的 hook 行为依然由**独立仓库里的 Phoenix CLI**定义，而不是把业务逻辑硬编码进 OpenClaw 主仓库。

## `hook run` 的运维语义

`hook run` 是 hook 模式的核心执行命令。正常情况下它由已安装的 handler 调用；人工手动执行主要用于测试或排障。

示例：

```sh
openclaw-phoenix hook run \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --output ~/openclaw-backups \
  --retain 100 \
  --json
```

执行流程：

1. 运行 `openclaw backup create --output <dir> --json` 创建一个新备份
2. 运行 `openclaw status --json`
3. 评估健康状态
4. 如果健康，则把这次新备份提升为 `latestKnownGoodArchivePath`
5. 如果不健康，则尝试恢复到之前记录的最近一次已知健康备份
6. 把 Phoenix 状态写到 `<outputDir>/.openclaw-phoenix-state.json`
7. 执行归档保留清理

传入 `--json` 时，输出对象包含：

- `ok`
- `healthy`
- `backupArchivePath`
- `backupError`
- `latestKnownGoodArchivePath`
- `healthReason`
- `rollback`
- `retention`
- `notification`

退出语义：

- 健康路径：要求状态健康，且备份没有出错，才算成功
- 不健康路径：要求回滚恢复成功，才算成功

## 健康检查判定

Phoenix 只有在以下条件同时满足时，才认为 `openclaw status --json` 返回的是“健康”：

- `gateway.reachable === true`
- `gateway.misconfigured !== true`

以下任一情况都会被视为“不健康”：

- `gateway.misconfigured === true`
- `gateway.reachable === false`
- `gateway.reachable` 缺失或不为 `true`
- `openclaw status --json` 执行失败，或返回无效 / 缺失 JSON

这套判定明显偏向“启动保护”语义：Phoenix 关心的是**网关是否能正常起来，且没有处于 misconfigured 状态**。

## 最近一次已知健康备份、回滚与保留策略

Phoenix 在以下文件中维护 hook 状态：

- `<outputDir>/.openclaw-phoenix-state.json`

提升为“最近一次已知健康备份”的条件：

- 本次新备份确实成功产出了 archive path
- 同一次运行里的状态检查结果是健康的

回滚规则：

- 当结果不健康时，Phoenix 会尝试恢复此前记录的 `latestKnownGoodArchivePath`
- 如果当前这次运行不健康，即使备份成功，也**不会**把这次新备份提升为已知健康备份
- 如果此前还没有已知健康备份，Phoenix 只会报告不健康状态，不会凭空恢复任何内容

保留规则：

- 常规保留策略会保留最新的 `--retain` 个匹配归档
- 当前 `latestKnownGoodArchivePath` 会被额外加入 keep 集合
- 因此，即使该已知健康归档已经超出普通保留窗口，也不会被清理掉

## 建议的运维工作流

在运行中的部署旁边长期保留一个持续备份 watcher：

```sh
openclaw-phoenix watch --config ~/.openclaw/openclaw.json --output ~/openclaw-backups
```

给现有部署接入启动回滚保护：

```sh
openclaw-phoenix hook install \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --phoenix-bin /usr/local/bin/openclaw-phoenix
```

手动验证已安装 hook 的执行链路：

```sh
openclaw-phoenix hook run --config ~/.openclaw/openclaw.json --json
```

干净移除 Phoenix 注入的 hook：

```sh
openclaw-phoenix hook remove --config ~/.openclaw/openclaw.json
```