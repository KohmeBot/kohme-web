# kohme 管理后台

一个独立的、自带网页界面的 kohme 插件管理后台。它不修改你现有的插件机制，而是把你已有的
`plugins.yaml` + `build.sh`（go generate → go build）这条链路，包成「网页里编辑配置 → 一键重新
构建 → 自动重启 bot → 实时看日志」。

前端是纯 HTML/CSS/JavaScript，没有 Vue / React，也没有任何前端构建步骤，全部用 `embed` 打进
一个二进制里。

## 它能做什么

- 浏览/编辑 `plugins.yaml` 里的每个插件：`repo`、`version`、`seq`、`disable`、`exclude`、
  `groups`，以及插件自己的 `conf`（直接当 YAML 编辑，对你所有现有插件零改动）。
- 添加 / 删除插件（即往 `plugins.yaml` 增删一条 `repo`）。
- 一键「重新构建并重启」：在仓库目录跑 `build.sh`，把输出实时推到网页；构建成功才替换并重启
  bot，**构建失败则保持原 bot 不变**。
- 「仅重启」：不重新编译，只重启 bot，用于只改了 `disable` / `conf` / `groups` 这类运行期配置时。
- 顶部状态条区分「期望状态」和「实际运行」：当你改动了 `repo` / `version` / `exclude` 后，会
  提示「需要重新构建」。
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
./kadmin -repo /path/to/kohme -bin ./bot
```

启动后终端会打印访问地址和登录口令，例如：

```
地址:   http://127.0.0.1:8787
口令:   3f9a1c...    <- 在网页登录时粘这个
```

浏览器打开该地址，输入口令即可。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-repo` | `.` | kohme 仓库根目录 |
| `-plugins` | `conf/plugins.yaml` | `plugins.yaml` 相对仓库根目录的路径 |
| `-bin` | `./bot` | `build.sh` 产出的 bot 二进制（相对仓库根目录）。按你的实际产物名改，比如 `./kohme` |
| `-build` | linux/mac 用 `build.sh`，windows 用 `build.bat` | 构建命令，可自定义 |
| `-bot-args` | 空 | 传给 bot 的额外参数 |
| `-addr` | `127.0.0.1:8787` | 监听地址 |
| `-token` | 自动随机生成 | 登录口令，留空则启动时随机生成并打印 |

## 安全须知

这个后台能编辑「哪些代码会被编译进 bot」并执行构建/运行，**本质上等于远程执行代码**。所以：

- 默认只监听 `127.0.0.1`，请勿直接 `-addr 0.0.0.0:xxxx` 暴露到公网。
- 需要远程访问时，走 SSH 端口转发或放在带认证的反向代理后面。
- 口令会随每次启动变化（除非你用 `-token` 固定），别把它写进公开的脚本里。

## 已知边界（可后续扩展）

- 目前只管理主 `plugins.yaml`。README 里提到的「多文件插件配置」（`path` 目录下的额外
  `*.yaml`）尚未纳入，可按相同模型扩展。
- 重写 `plugins.yaml` 时，插件的 `conf` 块会原样保留，但文件顶层的注释可能被重新格式化——所以
  每次写入前都做了备份。若要完全保留注释，可把读写层换成基于 `yaml.Node` 的就地编辑。
- 想把 `conf` 从「YAML 文本框」升级成「自动表单」，可给 `plugin/v2` 接口加一个可选的
  `ConfigSchema()` 返回 JSON Schema，实现了的插件渲染表单，没实现的回退到现在的文本框。
