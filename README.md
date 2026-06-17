# kohme 管理后台

一个独立的、自带网页界面的 kohme 插件管理后台。它不修改你现有的插件机制，而是把你已有的
`plugins.yaml` + `build.sh`（go generate → go build）这条链路，包成「网页里编辑配置 → 一键重新
构建 → 自动重启 bot → 实时看日志」。

前端是纯 HTML/CSS/JavaScript，没有 Vue / React，也没有任何前端构建步骤，全部用 `embed` 打进
一个二进制里。

## 它能做什么

- 浏览/编辑 `plugins.yaml` 里的每个插件：`repo`、`version`、`seq`、`disable`、`exclude`、
  `groups`，以及插件自己的 `conf`（直接当 YAML 编辑，对你所有现有插件零改动）。
- 编辑顶层全局设置：`bot_name`、`super_users`、`groups`、`path`。
- 独立的「驱动配置」板块，编辑 `conf/config.json`（对接 ZeroBot 的 `ZeroConf`：`zero` 的
  nickname / command_prefix / super_users / ring_len / latency / max_process_time /
  mark_message / keep_at_me_message，以及正向 `ws` 和反向 `rws` 的 url/token）。
- 账号密码登录（首次用一次性口令初始化），支持修改密码与退出。
- 添加 / 删除插件（即往 `plugins.yaml` 增删一条 `repo`）。
- 一键「重新构建并重启」：在仓库目录跑 `build.sh`，把输出实时推到网页；构建成功才替换并重启
  bot，**构建失败则保持原 bot 不变**。
- 「仅重启」：不重新编译，只重启 bot，用于只改了 `disable` / `conf` / `groups` 这类运行期配置时。
- 顶部状态条区分「期望状态」和「实际运行」：当你改动了 `repo` / `version` / `exclude` 后，会
  提示「需要重新构建」。
- **bot 的实时日志同时输出到网页和后台所在终端**，方便调试。
- **可选的 conf 表单**：插件实现 `ConfigSchema()` 后，网页用表单编辑配置；没实现的插件回退到
  YAML 文本框（见下方「conf 表单」）。
- 每次写入 `plugins.yaml` 前自动生成带时间戳的备份（保留最近 20 份）。

## 构建

```sh
cd kohme-admin
go mod tidy
go build -o kadmin .
```

得到一个 `kadmin` 二进制，拷到任何地方都能跑。

## 运行

把它指向你的 kohme 仓库根目录：

```sh
./kadmin -repo /path/to/kohme
```

**首次登录**：终端会打印一个一次性「初始化口令」。浏览器打开后台地址，页面会让你用这个口令
创建账号和密码：

```
初始化: 首次打开网页用此一次性口令创建账户密码: 3f9a1c...
```

之后再登录就用你设置的账号密码，初始化口令不再用于登录。账号密码以加盐哈希（PBKDF2-HMAC-SHA256）
存放在 `-auth` 指定的文件里（默认当前目录 `kadmin-auth.json`，权限 0600），明文密码不落盘。
忘记密码时，用 `-reset-auth` 启动一次即可清除账户、重新走初始化流程。登录后右上角可「修改密码」。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-repo` | `.` | kohme 仓库根目录 |
| `-plugins` | `conf/plugins.yaml` | `plugins.yaml` 相对仓库根目录的路径 |
| `-config` | `conf/config.json` | `config.json`（ZeroBot 驱动配置）相对仓库根目录的路径 |
| `-bin` | `./kohme` | `build.sh` 产出的 bot 二进制（相对仓库根目录）。kohme 的 `build.sh` 用 `go build -o kohme ./cmd/bot`，所以默认就是 `./kohme` |
| `-build` | linux/mac 用 `build.sh`，windows 用 `build.bat` | 构建命令，可自定义 |
| `-bot-args` | 空 | 传给 bot 的额外参数 |
| `-addr` | `127.0.0.1:8787` | 监听地址 |
| `-token` | 自动随机生成 | 首次初始化账户用的一次性口令，留空则启动时随机生成并打印 |
| `-auth` | `kadmin-auth.json` | 存放账号密码（加盐哈希）的文件路径 |
| `-reset-auth` | `false` | 启动时清除已设置的账户，重新走首次初始化 |

## 安全须知

这个后台能编辑「哪些代码会被编译进 bot」并执行构建/运行，**本质上等于远程执行代码**。所以：

- 默认只监听 `127.0.0.1`，请勿直接 `-addr 0.0.0.0:xxxx` 暴露到公网。
- 需要远程访问时，走 SSH 端口转发或放在带认证的反向代理后面。
- 口令会随每次启动变化（除非你用 `-token` 固定），别把它写进公开的脚本里。

## conf 表单（可选的 ConfigSchema）

默认每个插件的 `conf` 用 YAML 文本框编辑，对你现有插件零改动。如果想把某个插件的配置变成
带标题、下拉、开关的表单，给它加一个可选的 `ConfigSchema()` 方法即可，其它插件不受影响。

做两步：

1. 把 `bot-side/schema_export.go` 拷到你的 kohme 仓库 `cmd/bot/` 目录下（它是 `package main`，
   定义了可选接口和一个导出器）。然后在 `cmd/bot` 的 `main` 里、插件注册之后，调用一次：

   ```go
   ExportConfigSchemas("conf") // 传入存放 plugins.yaml 的目录
   ```

   它会在 `conf/.schemas.json` 写出 `{插件名: schema}`，管理后台读取这个文件来渲染表单。

2. 在想要表单的插件类型上实现 `ConfigSchema() string`，返回一段 JSON Schema：

   ```go
   func (p *MyPlugin) ConfigSchema() string {
       return `{
         "type":"object",
         "properties":{
           "room":    {"type":"integer","title":"房间号"},
           "quality": {"type":"string","title":"画质","enum":["流畅","高清","原画"]},
           "notify":  {"type":"boolean","title":"开播提醒"}
         }
       }`
   }
   ```

表单渲染器支持的类型：`object`/`properties`、`string`、`integer`、`number`、`boolean`、
字符串 `enum`，以及标量数组。无法识别的结构会自动回退到 YAML 文本框。`.schemas.json` 是 bot
启动时生成的，所以新加的 schema 会在「重新构建并重启」后自动出现在网页上。

## 已知边界（可后续扩展）

- 「驱动配置」按你给的 `zero.Config` 字段建模，键名以结构体 tag 为准（如机器人名是
  `nickname`，不是早期文档里的 `nick_name`）。`config.json` 里这套面板没建模的其它键会原样保留，
  写入前同样有备份。`latency` / `max_process_time` 是 `time.Duration`，在 JSON 里是纳秒整数，
  面板按纳秒填（4 分钟 = 240000000000）。
- 注意：顶层全局设置里的 `bot_name` / `super_users`（plugins.yaml）和驱动配置里的
  `nickname` / `super_users`（config.json）是两个不同文件里的字段，如果你的框架只认其中一处，
  另一处可以不填，避免混淆。
- 目前只管理主 `plugins.yaml`。README 里提到的「多文件插件配置」（`path` 目录下的额外
  `*.yaml`）尚未纳入，可按相同模型扩展。
- 重写 `plugins.yaml` 时，插件的 `conf` 块会原样保留，但文件顶层的注释可能被重新格式化——所以
  每次写入前都做了备份。若要完全保留注释，可把读写层换成基于 `yaml.Node` 的就地编辑。
