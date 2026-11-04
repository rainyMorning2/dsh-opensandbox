# Workspace 授权与 OpenSandbox 部署设计

更新日期：2026-11-03。本文件记录当前本地实现、验证结果及待推进事项。

## 单进程配置账号入口

新增`user-access.mjs`提供配置文件账号、持久登录Cookie、用户Workspace策略及非owner资源授权，使用与本分支匹配的宿主browser identity provider接口。全新部署通过`dev/users/launch.py`启动，配置、恢复语义和验收边界见[单进程部署说明](../dev/users/README.md)。本文件下文的固定权限表、旧本机端口及既有探针描述原`dev/local-sandbox`入口；该入口不自动启用多用户登录。

首版保留服务端登录状态、会话和Workspace，刷新及重启均可恢复；不迁移此前运行实例。用户间目录、会话、文件接口和实时事件受授权检查。未隔离的附件入口关闭，估值插件自身I/O和完整Docker容器验收仍待后续。

## 目标与对应关系

保留 DSH 的 Workspace 与 Session 概念。后续由外部用户系统初始化默认 Workspace，并可授权多个 Workspace；当前使用固定权限表，不接登录。

当前 DSH 进程内按规范 Workspace 路径缓存、复用沙箱。同一 Workspace 下的 Session 共享容器和文件，不提供这些 Session 之间的文件隔离。容器过期后可以重建；不同 DSH 进程的缓存不共享。

| 对象 | 当前职责 |
|---|---|
| 外部用户系统 | 尚未接入；后续提供身份、默认目录及授权根目录 |
| 固定权限表 | 规定当前部署可选择的目录及默认目录 |
| Workspace | DSH 持久化的目录记录；授权根及其子目录可注册 |
| Session | 对话与执行上下文，使用选中的 Workspace |
| OpenSandbox | 按 Workspace 路径复用容器；当前部署只挂载选中的目录 |

宿主机和容器内使用相同的绝对路径。路径名称不承担授权作用，授权由服务端路径检查和实际挂载决定。父 Workspace 可以看到子目录的文件；把子目录另外注册为 Workspace 时，只挂载子目录，但底层文件仍然重叠。

## 已实现的能力

DSH 本体基于 `0.2.2-alpha.2`，本体与插件均在 `feat/workspace-access-policy` 分支开发。当前运行源码版本，复用 `~/.dsh` 中的配置。

- DSH 提供可选的 `WorkspacePathPolicy` 服务。Workspace 创建及按路径查找、Session 直接指定或省略 cwd 的创建入口均检查授权；Workspace 的 get/list 隐藏未授权目录记录。
- 插件 `workspace-access.mjs` 实现固定根目录授权。目录必须存在，路径规范化及 realpath 后仍需位于授权范围内。
- 目录选择器默认打开配置的 Workspace。授权根及其子目录允许打开、新建文件夹；父级只显示通往授权根的分支，并禁用打开及创建。手动提交其他目录、路径穿越到外部、指向外部的符号链接均拒绝。
- 选中 Workspace 的子目录可以注册为独立 Workspace，容器只获得该子目录的挂载。
- `sessionWorkspaceOnly` 排除备用 Workspace 的隐含共享挂载；执行时从 Agent 的 Session header 确认根目录，命令 workdir 不会改变挂载权限。
- 模型文件工具继续通过宿主机侧后端读写，但受挂载目录约束。默认指令和项目标记扫描在越界时可以结束，不使整个对话失败。
- 容器启动等待 Running 和 execd 就绪；保留命令输出换行修复及容器内 rg 可执行文件映射。
- 源码启动器关闭开发路径提示；Web 模式不再写入验证用文件和跨目录测试链接。验证模式仍会准备专用测试文件。
- Web 终端已由用户实际进入容器，并验证无法读取宿主机同路径下未挂载的 `session-b` 文件。此结果覆盖实际进入和跨 Workspace 路径读取，不代表所有终端生命周期行为均已测试。
- 原模型配置已加载；清除当前 DSH 进程的代理变量、使用直连重启后，用户确认真实模型请求恢复正常。

## 路径显示与历史兼容

当前使用同路径挂载，已移除统一 `/workspace` 别名及其文件路径转换、Session 运行时提示覆盖、专门的宿主文件监听替换。隔离和执行所需的修复仍保留。

旧测试 Session 的日志或工作目录事件中可能保留 `/workspace`，切换后应新建 Session 验证；不改写旧日志。测试目录中原有的链接和文件不自动删除。

## 文件场景与实际落点

不是所有文件都需要进入 Workspace。聊天附件、用户工作文件、容器临时文件及 DSH 后台数据目前有不同的存储和访问方式。

| 场景 | 当前实际落点 | 沙箱访问及持久化情况 |
|---|---|---|
| 对话框选择、拖拽上传普通文件 | 宿主机 `~/.dsh/attachments/v1/`，按内容哈希保存；文件引用对应 `files/<哈希前缀>/<哈希>/<安全文件名>`，底层对象另存于 `file-objects/` | 不自动进入 Workspace，也不会自动挂载到容器；上传成功不等于容器内程序可以直接打开 |
| 对话框上传图片 | 同一附件库，带图片规范化处理及独立缓存 | 模型可通过图片附件接收；容器里不一定存在对应文件路径 |
| 插件使用 DSH 统一上传服务 | 同一附件库；上传回执绑定接收它的 Session | 与对话框上传相同；回执的 Session 约束不等于完整用户鉴权 |
| 插件自行实现上传或保存 | 由具体插件决定，可能是宿主机目录、插件存储、缓存或外部服务 | 没有统一落点，需要逐个核对；不会因安装了 OpenSandbox 就自动进入容器 |
| 模型通过 write/edit 文件工具写文件 | 当前部署主要写入宿主机 Workspace，再通过挂载同步到容器 | 文件工具执行授权检查；Workspace 文件保留在宿主机 |
| Bash、Web 终端运行程序生成文件 | 由程序指定的绝对路径或当前工作目录决定 | 写入 Workspace 路径时落到宿主机挂载目录；写入容器 `/tmp`、`/root` 等未挂载目录时属于容器文件，不保证销毁后保留 |
| 插件运行时通过 ctx.fs 读写 | 使用配置的文件系统后端，本部署为受限的宿主机文件后端 | 受该后端的路径和读写规则约束，不能据此推断插件其他 I/O 也受限 |
| 插件通过 ctx.subprocess 执行程序 | 本部署通过 OpenSandbox 在容器执行 | 输出文件按程序写入路径决定，遵循上面的挂载与容器目录区别 |
| 插件直接调用 Node 文件 API | 宿主机文件系统；相对路径由宿主机进程 cwd 决定 | 不自动经过沙箱文件后端；插件本身仍是受信任的宿主机代码 |
| DSH 的 Session 日志、存储和附件 | 本地 DSH home 中的相应目录，例如 `~/.dsh/sessions/`、`~/.dsh/storages/`、`~/.dsh/attachments/` | 属于宿主机控制面数据，不会全部挂入容器 |
| 图片派生缓存、工具长输出溢出文件 | 各自后端的缓存或临时目录；默认长输出溢出使用宿主机私有临时根，并在其下按 Session 分目录 | 不是 Workspace 工作文件，也不自动对容器可见；清理与生命周期由相应后端负责 |
| present 等交付物引用 | 引用已有文件；不因呈现操作自动把原文件搬到新目录 | 原文件的位置、挂载和生命周期仍决定能否访问及是否保留 |

附件存储实现见 [attachment-local](../../deepseek-harness/packages/attachment/attachment-local/src/index.ts) 与 [普通文件存储](../../deepseek-harness/packages/attachment/attachment-local/src/file-store.ts)；统一上传与回执绑定见 [file-upload](../../deepseek-harness/packages/client/file-upload/src/index.ts)。以上是当前代码路径的梳理，不代表每个插件和文件类型均已完成真实上传验证。

## 附件挂载：可行方案，尚未实现

当前附件库按内容组织，不按用户或 Session 物理分目录。把整个 `~/.dsh/attachments` 挂入某个容器，会扩大到其他用户或 Session 的附件读取范围。只读挂载只能阻止修改，不能解决读取授权；内容哈希也不是权限机制。

可以继续保留原附件库，另将获得授权、需要供容器处理的附件复制到专用目录，再单独挂载到 `/attachments` 等容器路径，无须放入 Workspace。访问范围可以按 Workspace 共享，也可以按 Session 限定；两者尚未选定。采用 Session 范围时，还需明确子 Agent 如何继承父级附件访问。

仅供模型看图、聊天记录保存或后台插件处理的附件，可以继续留在独立存储中。附件暴露、下载授权、同名文件处理、工作副本修改和清理策略，均需在实际接入时确定。当前没有把全局附件库挂进沙箱，也没有实施上述按范围复制和挂载。

## 子 Agent 与文件访问

源码中的内置 spawn/fork 子 Agent 继承父 Session header 的 Workspace 根目录；其有效工作目录可继承父 Agent 当前目录或显式设置。在继续使用同一 OpenSandbox 执行提供方的通常配置下，它们会复用对应 Workspace 的沙箱，而不是为每个子 Agent 复制一份文件系统。工作目录变化本身不能扩大挂载范围。

这些子 Agent 共享 Workspace 文件，因此并发修改同一文件仍可能产生覆盖或冲突。内置子 Agent 当前不能直接通过聊天上传接口接收文件；它们可以使用同 Workspace 中已有的文件，但附件库中的文件仍受前述可见性限制。

这一结论来自内置实现的源码梳理，尚未完成本部署中子 Agent 的真实容器专项验证。独立 preset 若替换执行提供方，或使用外部 SDK、ACP、Codex 等后端，需要分别核对执行位置、目录继承、文件访问和生命周期，不能直接套用内置后端结论。源码依据见 [子 Session 元数据](../../deepseek-harness/packages/subagent/subagent/src/child-agent.ts) 与 [子 Agent 管理器](../../deepseek-harness/packages/subagent/subagent/src/manager.ts)。

## 当前配置与启动

固定表位于 [workspace-access.json](../dev/local-sandbox/workspace-access.json)，默认只授权 `/tmp/dsh-sandbox-demo/session-a` 及其子目录，并以该目录作为初始目录。管理员增加 roots 后需要重启 DSH；OpenSandbox 的 allowed_host_paths 也需覆盖新增目录，但容器实际仍只挂载选中的 Workspace。

当前 OpenSandbox 服务由用户自行启动，端口为 4080；源码 DSH Web 使用 4090。模型配置来自 `~/.dsh`。当前 DSH 进程已清除代理环境变量，使用直连；启动器本身仍继承调用终端的环境，普通启动命令不会自动清除代理。

需要沿用当前直连方式时，在插件源码目录执行：

```sh
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    python3 dev/local-sandbox/launch.py web --home ~/.dsh --port 4090
```

更多启动和验证说明见 [本地源码部署说明](../dev/local-sandbox/README.md)。此部署关闭动态增加宿主挂载；并未把模型 API Key 转发给容器。OpenSandbox 的服务端 API Key 与模型凭据相互独立。

## 已有验证与待推进事项

已有验证：

- DSH 针对性测试：4 个测试文件、195 项测试通过，覆盖 Workspace/Session 路径校验与目录选择器状态。
- 插件语法和本地测试通过，包含授权父级过滤、合法目录创建、越权及符号链接拒绝、同路径和子目录挂载检查。
- 真实 OpenSandbox 探针：两个 Workspace 中共 38 次工具调用，结合 PTY、Session 恢复等共 44 项检查通过。使用脚本模型和独立 DSH home，不承担真实模型连通性验证。
- 浏览器与真实 Web 接口：9 项检查通过，覆盖直接提交越权路径的拒绝、授权子目录注册、父级禁用状态和 Workspace 内新建文件夹。
- 完整构建与 Host/Client 类型检查通过；用户随后确认 Web 终端无法读取 `session-b`，并确认直连重启后真实模型请求可用。

尚待推进：

- 用户登录、按身份提供目录授权，以及 Session 列表、历史、附件下载和管理接口的访问控制。固定表是进程级路径约束，不是完整多用户鉴权。
- 实际使用插件的 I/O 盘点：上传入口、宿主机直接读写、缓存与工作产物的落点。按用途决定保存位置，不要求所有文件进入 Workspace。
- 按授权范围向容器暴露附件；尚未确定按 Workspace 共享还是按 Session 限定。
- 子 Agent 的真实容器专项测试，包括目录继承、沙箱复用、文件读写与越权拒绝。
- 明确需要持久化的运行产物，处理容器未挂载目录的数据生命周期，并完善生产资源配额、过期重建、镜像依赖及网络配置。
- Web 终端其余生命周期行为，以及相关插件和后台任务的完整流程验证。
