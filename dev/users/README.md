# 单进程配置用户部署

本入口用于全新部署：一个 DSH 进程、配置文件账号、持久 Cookie、每用户独立 Workspace 授权、OpenSandbox 执行。需要相邻 `deepseek-harness` 的 `feat/workspace-access-policy` 分支及本轮 browser identity provider 修改，Node 24.9+、Python 3、已构建宿主和插件的同版本 peer 依赖。原 `dev/local-sandbox` 仍是单部署静态授权入口，不会自动获得登录功能。

## 配置与启动

在仓库外准备私有配置，例如 `/srv/value-agent/config/users.json`，权限0600。所有 Workspace 根目录必须事先存在，采用实际规范绝对路径；不同根不能相同、包含或通过符号链接指向对方，不能与 DSH_HOME、账号配置及登录数据库目录重叠。

```json
{
  "version": 1,
  "users": [
    {
      "id": "user-a",
      "username": "alice",
      "passwordHash": "填写生成的scrypt哈希",
      "defaultWorkspace": "/srv/value-agent/workspaces/user-a",
      "workspaceRoots": ["/srv/value-agent/workspaces/user-a"]
    },
    {
      "id": "user-b",
      "username": "bob",
      "passwordHash": "填写生成的scrypt哈希",
      "defaultWorkspace": "/srv/value-agent/workspaces/user-b",
      "enabled": true
    }
  ]
}
```

`workspaceRoots` 省略时只授权默认目录及其子目录。`enabled: false` 禁用账号，所有配置变更需重启。稳定 `id` 用于归属，不采用用户名作为文件路径。

在 Bash 中生成密码哈希，密码不出现在命令行参数或历史里：

```bash
read -r -s -p 'Password: ' user_password
printf '\n'
printf '%s' "$user_password" | node dev/users/hash-password.mjs
unset user_password
```

密码至少12字符。将输出哈希写入配置，不把密码、真实配置或数据库提交Git。

先在宿主仓库运行 `pnpm install --frozen-lockfile && pnpm run build:artifacts`。外部插件 peer 必须解析到这份宿主构建；Value-Agent 的 `deploy/users/link-host-peers.py` 可建立本地链接，不能混用 npm 旧版宿主。使用已配置非空 API Key 的 OpenSandbox 服务；`OPEN_SANDBOX_API_KEY` 或 `OPEN_SANDBOX_API_KEY_FILE` 只提供给 DSH，不转发给执行容器。

```bash
python3 dev/users/launch.py \
  --users /srv/value-agent/config/users.json \
  --home /srv/value-agent/state \
  --origin https://your-domain.example \
  --port 3080 \
  --sandbox-domain host.docker.internal:4080 \
  --image your-verified-sandbox-image
```

`--origin` 为浏览器实际访问的站点，不带末尾斜杠。只有本机回环允许HTTP。默认绑定127.0.0.1，容器内使用`--host 0.0.0.0`。登录表单位于`/auth/login`，同一网址按Cookie身份显示各自目录；左侧边栏底部提供退出入口。无需用户名URL前缀。

管理员可用可重复的`--patch /绝对路径/部署.patch.yml`加载模型、主题和已安装插件配置；这些补丁先应用，用户认证及沙箱覆盖层最后应用。额外插件自身的文件I/O与接口授权仍需分别验收。

启动器生成受限standard preset：移除模型可调用的插件管理、插件市场和调度工具，关闭其他preset及管理UI。Agent创建时再次核对sandbox提供方和全局工具，配置未生效则拒绝创建。普通用户不能通过旧实例token、`/connect`、插件管理或配置接口获得owner权限。模型路由由管理员通过DSH部署配置及环境设置，用户可切换自己Session的模型和思考强度，选择持久化在Session中，不写全局默认值。

## 持久化与隔离

持久化整个DSH_HOME和所有用户Workspace。`user-auth/logins.sqlite`只存随机登录凭证的摘要、用户ID、配置摘要和到期时间；默认有效期一天，服务重启后未过期Cookie仍可恢复。密码或目录授权变化会使该账号旧Cookie失效。退出立即撤销登录并终止对应Peer的实时连接；已提交后台工作不因浏览器退出被隐式取消。新登录及退出清理该站点的浏览器缓存和本地存储，刷新不清理；工作区和会话记录以服务端为准。

首次或新浏览器登录按服务端可见Workspace恢复，只有一个默认目录时自动进入。相同账号可以使用多个浏览器。用户会话列表、详情、取消、文件读取及实时事件按当前身份过滤。每用户允许多个不重叠根；同一Workspace下的Session共享文件，子目录Workspace与父目录底层文件仍重叠。子Agent必须保持父Session所属用户，当前只提供内置standard组合。

沙箱实际只挂载当前Session的Workspace。用户模式强制`sessionWorkspaceOnly: true`、`allowDynamicMounts: false`，禁止额外共享挂载与trustedReadPaths；备用目录与用户根分开。OpenSandbox服务端的`allowed_host_paths`也应只列这些用户根。服务端、DSH应用容器及执行容器必须使用一致的绝对目录路径。Docker socket只提供给OpenSandbox服务。

账号路径和登录数据库校验失败时插件不提供身份；连接层保持拒绝访问，不退回实例owner模式。认证服务失败返回503而不暴露凭据；失败尝试限流，客户端可等待后重试。

## 首版范围

这不是完整估值应用租户隔离。首版不加载估值插件；其直接Node/Python I/O、专有页面和RPC留待后续审查。不开放全局图片附件读取、上传及非文本prompt内容，也不开放全局文件下载捷径；这些入口在完成资源归属校验后才能启用。Workspace文件预览与终端按Session资源授权。设置页面与插件管理对所有登录用户关闭；仅返回只读界面显示默认值，不开放部署配置和凭据。安全会话命令包括/plan、/goal、/compact、/feedback；全局管理命令仍拒绝。

用户的密码、Workspace及启停由管理员配置；不提供注册、找回密码、动态权限编辑或跨用户共享。该实现信任管理员配置、已安装插件和OpenSandbox控制服务，不给登录用户安装任意宿主插件的能力。

## 验证

```bash
node --test test/users.mjs
npm test
node test/users-live.mjs
```

`users-live`启动真实源码DSH profile，以两名合成用户验证86项HTTP/RPC与重启检查，运行结束清理临时服务和数据；不调用模型或OpenSandbox服务。设置`DSH_USERS_BROWSER=1`加入浏览器登录、默认目录、刷新及退出，共93项，包含完全空状态的首次浏览器登录；需要宿主apps/web的Playwright及其浏览器系统依赖，可用`DSH_TEST_CHROMIUM`指定现有浏览器二进制。

本轮已通过上述用户逻辑、真实宿主和浏览器检查，以及既有插件的挂载/文件后端/mock-execd回归。在Value-Agent联合测试部署中已执行14项真实Docker/execd双工作区检查，覆盖挂载隔离、符号链接拒绝、持久写入和沙箱重建；test/users-sandbox.mjs的命令timeout采用毫秒单位。具体部署证据由Value-Agent的deploy/users记录；这些结果不替代估值插件业务隔离验收。新增源码需重新构建宿主；生产HTTPS代理、镜像构建、配额与容器过期重建还需在目标部署环境验收。

## 联合部署的交互权限

目录选择器沿用原组件，只列出当前账号获准目录；文件侧栏和终端按当前Session授权。终端仅列沙箱镜像自带的/bin/bash与/bin/sh，不探测宿主或其他Shell。用户可重命名、分叉、取消自己的会话、调整待发队列、归档和置顶，以及管理自己获准的工作区。工作区控制器沿用原生前端，变更后的归档、置顶和排序响应再次按用户过滤，避免返回其他用户的ID。

单独关闭的能力及原因：全局设置、插件安装和启停会影响共享DSH进程；其他Agent preset和任意管理命令可能绕过沙箱约束；调度和全局附件接口尚未完成归属适配。这些能力保持关闭，不设置管理员特例或插件锁定。估值专属接口与业务适配另行处理。

本机补充：调整为只读显示设置后，隔离容器中92项真实HTTP/RPC检查通过；联合部署浏览器另验证目录弹窗、Session模型/思考强度与刷新、文件预览、沙箱终端命令。此结果不包含模型推理和估值业务验收。

## 两档权限测试配置

用户启动器要求secureExecution：独立execd令牌、非root工作负载及完全生效的Landlock。执行镜像需包含/opt/dsh-policy/landlock-run，文件和父目录由root所有且普通用户不可写。UID/GID取DSH应用的运行身份，应与持久工作区所有者一致。Full不提升Unix身份，仅取消命令级Landlock限制；两档都不能通过execd访问其他沙箱。
