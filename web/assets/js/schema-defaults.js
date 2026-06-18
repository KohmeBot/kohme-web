// schema-defaults.js — 插件公共配置、插件全局配置、驱动配置的「兜底 schema」。
//
// 这几块都改为 schema 驱动：后端在 /api/schemas 里用保留键
//   kohme-plugin         → 插件公共字段（除 name / seq / 每插件 conf 之外的元信息）
//   kohme-plugin-global  → 插件全局配置（path / groups 等）
//   kohme-zerobot        → 驱动配置 config.json（ZeroBot）整体对象
// 当后端尚未提供时（如首次构建前 schema 还没生成），前端用下面的默认 schema 渲染，
// 保证界面始终可用；后端提供后即以后端的为准。这几份默认 schema 同时也是后端应当
// 产出的结构样板——字段名必须与 DTO 对应：
//   插件 DTO：{ name, repo, version, seq, disable, exclude, groups, confValue|confYaml }
//             （name 是身份、seq 由卡片的排序控件管理，二者都不应出现在 kohme-plugin 里；
//              每插件 conf 由该插件自己的 schema 负责）
//   全局 PUT：{ path, groups }
//   驱动 PUT：{ zero:{...}, ws:{url,token}, rws:{url,token} }
//
// 任何字段都可叠加 k-ui 自定义控件（见 schema-form.js / ui.go），例如 token 用 secret、
// 群号列表用 tags。

export const PLUGIN_COMMON_SCHEMA = {
  type: 'object',
  properties: {
    repo:    { type: 'string',  title: '仓库 repo' },
    version: { type: 'string',  title: '版本 version' },
    groups:  {
      type: 'array', items: { type: 'integer' }, 'k-ui': 'tags',
      title: '本插件启用的群', description: '留空用全局',
    },
    disable: { type: 'boolean', title: '禁用功能（仍编译加载）' },
    exclude: { type: 'boolean', title: '排除（不编译进 bot）' },
  },
};

export const GLOBAL_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array', items: { type: 'integer' }, 'k-ui': 'tags',
      title: '全局启用的群 groups', description: '所有未单独设置群的插件都在这些群生效',
    },
    path: { type: 'string', title: '插件配置目录 path' },
  },
};

export const ZEROBOT_SCHEMA = {
  type: 'object',
  properties: {
    zero: {
      type: 'object', title: 'ZeroBot',
      properties: {
        nickname:         { type: 'array', items: { type: 'string' }, 'k-ui': 'tags', title: '机器人名 nickname' },
        command_prefix:   { type: 'string',  title: '命令前缀 command_prefix' },
        super_users:      { type: 'array', items: { type: 'integer' }, 'k-ui': 'tags', title: '超级用户 super_users' },
        ring_len:         { type: 'integer', title: '事件环长度 ring_len', description: '0 关闭' },
        latency:          { type: 'integer', title: '事件延迟 latency（纳秒）' },
        max_process_time: { type: 'integer', title: '最大处理时间 max_process_time（纳秒）' },
        mark_message:       { type: 'boolean', title: '自动标记消息已读 mark_message' },
        keep_at_me_message: { type: 'boolean', title: '保留 at me 原始消息 keep_at_me_message' },
      },
    },
    ws: {
      type: 'object', title: '正向 WS',
      properties: {
        url:   { type: 'string', title: '地址 url' },
        token: { type: 'string', 'k-ui': 'secret', title: 'Token' },
      },
    },
    rws: {
      type: 'object', title: '反向 WS',
      properties: {
        url:   { type: 'string', title: '地址 url（不用留空）' },
        token: { type: 'string', 'k-ui': 'secret', title: 'Token' },
      },
    },
  },
};
