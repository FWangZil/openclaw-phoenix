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

## 仓库基线

- 仓库默认安装方式和 CI 都使用 Bun（`bun.lock`、`packageManager: bun@1.3.10`）。
- 运行时目标 Node 版本为 `>=22.12.0`。
- CI 会校验 install、test、typecheck、build 和 CLI help smoke。
- 这个独立仓库的版本发布约定见 `docs/releasing.md`。

## 安装与运行

在独立仓库目录中：

```sh
cd openclaw-phoenix
bun install
```

`bun install` 是当前仓库默认安装路径。它会触发包里的 `prepare` 脚本，构建 `dist/`，并通过 `dist/cli.js` 暴露 `openclaw-phoenix` 可执行入口。

如果你只是想做一次本地包式安装，`npm install` 仍然可用；但仓库维护和 CI 应继续以 Bun 为准，避免与提交的锁文件漂移。

安装后常见的运行方式：

```sh
npx openclaw-phoenix --help
npm link && openclaw-phoenix --help
node dist/cli.js --help
```

## 先看这个：该用哪个命令？

- 想先确认当前部署是否满足 Phoenix 运行 / 自愈前提：用 `doctor`
- 想**常驻监控**配置 / OAuth / auth 相关文件变更，并在变更后自动备份：用 `watch`
- 想把一个**已有备份**恢复到当前部署正在使用的路径：用 `restore`
- 想给现有 OpenClaw 部署加上**启动后健康检查 + 自动回滚**：用 `hook install`
- 想手动调试 hook 执行链路：用 `hook run`
- 想拿到给本地控制台或其他读取器消费的结构化后端快照：用 `web snapshot`
- 想启动一个本地优先的 Phoenix 控制台：用 `web serve`
- 想干净移除 Phoenix 注入的 hook：用 `hook remove`

## 命令概览

- `openclaw-phoenix doctor`
  - 在你依赖 Phoenix 自愈前，先做一次本地 / 运行时预检
  - 检查 `openclaw` 二进制可访问性、config/state/output 路径、明显权限问题、`openclaw status --json` 的网关就绪度 / auth 告警，以及通知发送所需配置是否完整
- `openclaw-phoenix watch`
  - 长时间运行的 watcher
  - 默认是只做备份；加 `--self-heal` 后会走和 `hook run` 相同的备份 / 状态检查 / 回滚流程
  - 配置 / 凭据 / auth 相关文件变更后，防抖触发 `openclaw backup create --output ... --json`，然后执行旧归档清理
- `openclaw-phoenix restore <archive>`
  - 先运行 `openclaw backup verify <archive> --json`
  - 验证通过后，把归档内容恢复到**当前部署**对应的 live 路径
- `openclaw-phoenix hook install`
  - 向现有 OpenClaw 部署注入一个**受 Phoenix 管理**的内部 hook
- `openclaw-phoenix hook run`
  - 供已安装 hook 调用的内部命令，执行“备份 → 健康检查 → 回滚 / 保留已知健康备份”
- `openclaw-phoenix web snapshot`
  - 输出当前 Web v1 后端契约 JSON，包含 `overview`、`timeline`、`config`、`archives`、`setup`
- `openclaw-phoenix web serve`
  - 启动一个本地优先的 Phoenix 控制台，提供 Overview、Setup、Activity、Archives、Configuration 视图，以及显式、低风险的 `backup now` / `health check now` 浏览器动作
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
- Web v1 结构化状态文件

## `doctor` 预检

在生产环境依赖自愈之前，先跑一次：

```sh
openclaw-phoenix doctor \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups \
  --notify exceptional-only \
  --notify-target room://operators
```

`doctor` 的行为：

- 发现硬阻塞时会以非 0 退出
- 整个检查保持只读：不会发通知，也不会修改部署状态
- 网关 / 自愈探测依赖 `openclaw status --json`，所以要先修好这个命令暴露出来的问题
- 如果你想让自动化消费结果，可以传 `--json`

推荐做法：

- 用和生产环境一致的 `--config`、`--openclaw-bin`、`--output`、`--notify*` 参数跑 `doctor`
- 对于不带 `--self-heal` 的 `watch`，至少要满足“仅备份”就绪
- 对于 `hook install`、`hook run`、`watch --self-heal`，则把“自愈就绪”当作准入门槛
- 部署路径、`openclaw` 二进制位置或通知目标变化后，重新跑一次 `doctor`

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
- `watch` 默认是**只备份**；加 `--self-heal` 后，每次稳定下来的变更波次都会进入和 `hook run` 相同的恢复流程
- 只有在 `--self-heal` 模式下，`--notify ...` 才会生效；纯备份模式不会发通知
- 如果根配置文件变化，Phoenix 会在下一轮备份前刷新派生出来的监控目标集合
- 来自配置推导出的无效 / 缺失路径会记为 warning，但 watcher 不会因此退出
- 单次备份失败会记日志，但不会终止整个 watch 进程

### 纯备份 `watch` 与 `watch --self-heal`

请有意识地区分这两种模式：

- `watch`（默认，纯备份）
  - 监听到配置 / auth 变更后创建归档
  - 执行保留清理
  - **不会**运行 `openclaw status --json`
  - **不会**提升 `latestKnownGoodArchivePath`
  - 即使带了 `--notify*` 参数，也**不会**发通知
- `watch --self-heal`
  - 仍然会先创建新备份
  - 然后执行与 `hook run` 相同的状态检查 / 回滚 / 保留 / 通知流程
  - 健康时可以把本次备份提升为 `latestKnownGoodArchivePath`
  - 不健康时可以尝试回滚
  - 也是唯一一个 `--notify exceptional-only|all` 与 `--notify-target ...` 真正生效的 watch 模式

对大多数运维场景，默认 `watch` 更安全；再额外配合 `hook install` 处理启动时回滚保护。只有当你明确希望每一轮配置 / auth 变更都跑完整恢复流程时，再启用 `watch --self-heal`。

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

## Web / 后端快照契约

如果你是从源码 checkout 运行 Phoenix，在使用 web 相关命令前，请先确认 `dist/` 是最新的：

```sh
bun run build
```

`bun install` 已经会通过包里的 `prepare` 脚本做这件事。如果你改过本地源码，或者安装时跳过了脚本，请重新执行一次 `bun run build`。

当你想拿到一个稳定、结构化、无需解析日志的读模型时，用 `web snapshot`：

```sh
openclaw-phoenix web snapshot \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups \
  > phoenix-web-snapshot.json
```

当前契约包含：

- `overview`：最新动作，以及最近一次 backup / health / rollback / notification / restore 的结果；如果存在，也会包含最近一次持久化的 web 触发动作
- `timeline`：近期结构化动作，保留 `origin`（`watch`、`hook`、`manual`），并附带派生出的运行摘要，串起 backup / health / known-good / rollback / notification 各阶段
- `config`：部署路径摘要，以及按来源记录的最近一次运行时配置
- `archives`：known-good / last-backup 指针，以及带角色信息的归档清单
- `setup`：环境、输出目录、保留数、自愈、通知与预览命令的就绪引导

`web snapshot` 的退出语义偏向“读模型构建”本身：只有在 Phoenix 连快照都构不出来时才会非 0 退出。即使部署不健康，只要快照能生成，命令仍然成功返回，好让本地控制台或其他读取器解释实际状态。

## 本地优先的 Web 控制台

当你想在浏览器里查看同一套结构化快照，并直接触发显式本地动作时，用 `web serve`。Phoenix 现在支持在浏览器里执行本机 `backup`、`health check`、`watch` 生命周期和受管 `hook` 操作，但仍然不会开放 restore 或配置编辑：

```sh
openclaw-phoenix web serve \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups \
  --host 127.0.0.1 \
  --port 48789
```

当前控制台提供：

- Overview：当前状态、最近动作、最近错误
- Setup：环境与配置就绪度
- Activity：近期结构化时间线
- Archives：归档清单与角色标记
- Configuration：Phoenix 视角下的运行配置，以及 `watch start/stop`、`hook install/remove/run` 控制区
- 显式本地动作：`backup now`、`health check now`、`watch start/stop`、`hook install/remove/run`

Phoenix 仍然坚持“本地优先、低风险、显式触发”原则：

- 这些变更动作只接受 Phoenix 主机本机 loopback 浏览器发起的 same-origin 请求
- 浏览器里仍然不会开放 restore 或任意配置编辑
- 当 web 启动的 watch 正在运行时，浏览器界面只允许 `stop watch`，其他动作会被禁用，避免和当前 watch 会话竞争

## 通知行为

通知默认关闭。只有在具备完整发送配置，且当前命令路径允许发送时，Phoenix 才会尝试投递。

- 远程投递至少需要同时具备发送模式（`--notify exceptional-only` 或 `--notify all`）和 `--notify-target <target>`
- `--notify-channel`、`--notify-account`、`--notify-thread-id` 只是传给 `openclaw gateway call send` 的路由提示，不能替代必需的 target
- 纯备份 `watch` 永远不会发通知；如果你期望通知实际发出，需要使用 `hook run`、已安装的 hook，或者 `watch --self-heal`
- 即使通知投递失败，也不会撤销已经成功的健康提升或回滚；Phoenix 会把恢复结果和通知失败分开记录

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

## 推荐部署模式

### 1. 只做持续备份

适合你只想在配置 / auth 变更后持续留档，而不希望 Phoenix 自动恢复 live 状态：

```sh
openclaw-phoenix watch \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups
```

### 2. 启动回滚保护

适合你希望在 OpenClaw 启动阶段出现异常时，由内部 hook 自动尝试回滚：

```sh
openclaw-phoenix hook install \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --phoenix-bin /usr/local/bin/openclaw-phoenix
```

### 3. 常见运维基线：纯备份 `watch` + 启动 hook

这是最推荐的常见组合：

1. 长期开 `watch`，为配置 / auth 变更生成高频归档
2. 安装 `hook install`，只在启动阶段提供回滚保护
3. 在部署健康时手动执行一次 `hook run --json`

这样可以同时获得频繁备份和启动期回滚保护，而不会让每一次 watch 触发的备份都具备恢复 live 状态的能力。

### 4. 持续自愈 watch

只有当你明确希望每一次稳定下来的配置 / auth 变更波次，都触发健康检查并可能自动回滚时，才使用 `watch --self-heal`。同时请保证这条命令上的通知参数，与运维实际依赖的 `hook install` / `hook run` 通知配置保持一致。

## 故障排查

### `watch` 已经在跑，但没有触发备份

先检查这些：

- `watch` 是变更驱动的；启动后不会立刻创建备份
- Phoenix 只监控解析出来的根配置文件、OAuth / credentials 目录、发现的 `$include` 文件、以及 agent auth-store 文件；落在这套范围之外的改动不会触发备份
- 看启动日志里的 `watching N path(s)`，以及后续是否出现 `change detected: ...`
- 如果出现 `watch target refresh skipped config-derived paths: ...`，先修复对应的 config/include/auth-store 问题；watcher 会继续运行，但只覆盖仍能解析出来的基础路径
- 如果你改了根配置路径或 `OPENCLAW_CONFIG_PATH`，请用正确的 `--config` 重启 `watch`，并重新跑 `doctor`

### Phoenix 找不到 `openclaw`

- 先运行 `openclaw-phoenix doctor --openclaw-bin /path/to/openclaw ...`
- 如果 `doctor` 报 `could not find openclaw on PATH`，就把 `openclaw` 安装到 `PATH` 上，或显式传 `--openclaw-bin`
- 如果 `doctor` 报执行权限问题，修复部署环境里对应服务用户对该二进制的权限
- 对长期运行的运维脚本和 hook 安装，优先显式传 `--openclaw-bin`，不要依赖交互 shell 的 `PATH`

### 配置文件缺失或无效

- 当解析到的根配置文件缺失、不可读或不是普通文件时，`doctor` 会把它报告为阻塞项
- 如果由配置推导出来的 watch 目标无法解析，`watch` 不会退出，但会记 warning，并退回到仍可监控的基础路径
- `hook install` 与 `hook remove` 使用的是同一套部署路径解析逻辑；如果你传错 `--config`，就会修改到错误的部署
- 如果你覆盖了 hook 事件键，它必须包含冒号，例如 `gateway:startup`

### 通知没有送达

- 通知默认关闭；只传 `--notify-target` 或路由提示不足以启用发送
- 远程投递必须同时具备发送模式和 `--notify-target <target>`
- `--notify-channel`、`--notify-account`、`--notify-thread-id` 只是路由提示，不能替代 target
- 纯备份 `watch` 不会发通知；如果你期待通知送达，请改用 `hook run`、已安装的 hook 或 `watch --self-heal`
- 通知投递失败不会影响健康提升或回滚结果；Phoenix 会单独报告通知失败

### 结果不健康，且没有 known-good 归档

这意味着 Phoenix 识别到了不健康状态，但 `latestKnownGoodArchivePath` 还没被提升出来。

常见原因：

- Phoenix 之前只跑过纯备份 `watch`
- 第一次自愈运行或第一次 hook 运行就发生在不健康启动期间
- 之前曾有健康运行并产出备份，但由于健康检查没有通过，备份路径从未被提升

修复方式：

1. 先把部署恢复到健康状态
2. 手动运行 `openclaw-phoenix hook run --json ...`，或者让 `watch --self-heal` 完成一次健康周期
3. 确认 `<outputDir>/.openclaw-phoenix-state.json` 或 `hook run --json` 输出里已经有 `latestKnownGoodArchivePath`

### 回滚失败

当 Phoenix 报告回滚失败时：

1. 从 `hook run --json` 输出或 `<outputDir>/.openclaw-phoenix-state.json` 里确认它尝试恢复的是哪个归档
2. 手动执行 `openclaw backup verify <archive> --json` 验证该归档
3. 用 `openclaw-phoenix restore <archive> --config ... --openclaw-bin ... --dry-run` 预览恢复计划
4. 修复底层恢复问题，例如当前目标路径的权限或路径异常
5. 只有在恢复路径重新可信之后，再重新执行 `hook run --json`

请记住，Phoenix 的恢复安全检查会拒绝 malformed 归档、重复目标写入，以及符号链接目标路径。

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

## 运维 smoke checks 与发布基线

对外文档里提到的 CLI 面，最小可用的 smoke checks 是：

```sh
node dist/cli.js doctor --help
node dist/cli.js watch --help
node dist/cli.js hook --help
```

对一个全新 checkout 或发布候选版本，仓库基线仍然是：

1. `bun install`
2. `bun run test`
3. `bun run typecheck`
4. `bun run build`
5. `bun run smoke:cli`

独立仓库的发布预期见 `docs/releasing.md`。
