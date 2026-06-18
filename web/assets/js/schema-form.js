// schema-form.js — 从 JSON Schema 渲染表单。
// 支持 invopop/jsonschema 产出的 draft 2020-12 的 $ref/$defs：根可能是 {$ref,$defs}，
// 嵌套结构体与数组项也是 $ref。处理嵌套对象（递归）、map[K]V（object+additionalProperties，
// 键值行编辑器）、string/integer/number/boolean、string 枚举。数组：标量数组（[]string/[]int64/[]number）默认用标签编辑器（回车添加、
// × 删除）；对象数组（[]struct）用可增删的行编辑器，每项是子表单；数组套数组回退 JSON
// 文本域。无法建模的（自由对象 / oneOf …）也回退 JSON，保证数据不丢。纯函数模块，仅依赖 dom。
//
// 自定义控件：识别 schema 上的 "k-ui" 扩展字段（由 Go 端 Extras 写入），覆盖默认渲染：
//   textarea  多行文本域（可选 k-rows 指定行数）
//   code      等宽代码文本域（可选 k-lang 标注语言、k-rows 行数）
//   secret    密码框 + 显示/隐藏切换（token、密钥）
//   color     颜色选择器 + 十六进制输入，取值 #rrggbb
//   slider    滑块 + 数字框，范围取标准 minimum/maximum/multipleOf
//   tags      标签输入（回车添加、× 删除），底层为字符串/数字数组
// k-ui 既可能落在解析后的 $defs 节点上，也可能落在属性本身（取决于 invopop 是否内联），
// 因此统一用 pick() 同时在两处查找。

import { el } from './dom.js';

// 在「解析后的 schema」与「原始属性」两处按序取值；
// title/description/minimum 等字段标签会贴在属性上，而 k-ui/type 在 $defs 节点上。
function pick(s, rawProp, key) {
  if (s && s[key] !== undefined) return s[key];
  if (rawProp && rawProp[key] !== undefined) return rawProp[key];
  return undefined;
}

function resolveSchema(node, root) {
  let n = node || {};
  let guard = 0;
  while (n && n.$ref && guard++ < 50) {
    const ref = n.$ref;
    let name = null, bag = null;
    if (ref.indexOf('#/$defs/') === 0)        { name = ref.slice(8);  bag = (root && root.$defs) || {}; }
    else if (ref.indexOf('#/definitions/') === 0) { name = ref.slice(14); bag = (root && root.definitions) || {}; }
    else break;
    n = bag[name] || {};
  }
  return n || {};
}

function schemaType(s) {
  let t = s.type;
  if (Array.isArray(t)) t = t.find(x => x !== 'null') || t[0];
  if (!t) { if (s.properties) t = 'object'; else if (s.enum) t = 'string'; }
  return t;
}

function coerceEnum(v, enumArr) { for (const e of enumArr) if (String(e) === v) return e; return v; }

function jsonArea(cur) {
  const ta = el('textarea', { spellcheck: 'false', class: 'mono' });
  ta.value = (cur !== undefined && cur !== null) ? JSON.stringify(cur, null, 2) : '';
  const get = () => {
    const t = ta.value.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return ta.value; }
  };
  return { input: ta, get };
}

// 自定义控件用按钮/回车改值，不会触发 input/change；派发一个冒泡 change，
// 让外层（如插件卡片）的脏检测能感知到。用节点所属文档的 view 构造事件，跨 realm 也安全。
function notify(node) {
  const view = (node.ownerDocument && node.ownerDocument.defaultView) || window;
  node.dispatchEvent(new view.Event('change', { bubbles: true }));
}

// 标签编辑器：标量数组（[]string/[]int64/[]number）的默认控件，也用于 k-ui:tags。
// itemT 决定取值时的元素类型转换。
function tagsField(cur, itemT) {
  const tags = Array.isArray(cur) ? cur.map(String) : [];
  const box = el('div', { class: 'tags' });
  const listEl = el('div', { class: 'tags-list' });
  const entry = el('input', { type: 'text', class: 'tags-input', placeholder: '输入后回车添加' });
  const draw = () => {
    listEl.textContent = '';
    tags.forEach((tg, i) => {
      const chip = el('span', { class: 'chip', text: tg });
      const x = el('button', { type: 'button', class: 'chip-x', text: '×' });
      x.setAttribute('aria-label', '删除');
      x.addEventListener('click', () => { tags.splice(i, 1); draw(); notify(box); });
      chip.appendChild(x);
      listEl.appendChild(chip);
    });
  };
  const commit = () => {
    const v = entry.value.trim();
    if (v && tags.indexOf(v) < 0) { tags.push(v); entry.value = ''; draw(); notify(box); }
    else entry.value = '';
  };
  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !entry.value && tags.length) { tags.pop(); draw(); notify(box); }
  });
  entry.addEventListener('blur', commit);
  box.append(listEl, entry);
  draw();
  const get = () => tags.map(x => itemT === 'integer' ? parseInt(x, 10) : itemT === 'number' ? parseFloat(x) : x);
  return { el: box, get };
}

// 对象数组（[]struct）的行编辑器：每一项是 itemSchema 的子表单，可增删。
// 比手写 JSON 友好，且仍能保住任意嵌套结构。
function objectArrayField(itemSchema, cur, root, depth) {
  const wrap = el('div', { class: 'arr' });
  const rowsEl = el('div', { class: 'arr-rows' });
  const recs = [];   // 与 DOM 行同序：{ row, getValue }
  const renumber = () => {
    [...rowsEl.children].forEach((r, i) => {
      const idx = r.querySelector('.arr-idx');
      if (idx) idx.textContent = '#' + (i + 1);
    });
  };
  const addRow = (val, silent) => {
    const sub = buildObjectForm(itemSchema, val || {}, root, (depth || 0) + 1);
    const del = el('button', { type: 'button', class: 'btn btn--danger btn--sm arr-del', text: '删除' });
    const head = el('div', { class: 'arr-row-head' }, [el('span', { class: 'arr-idx' }), del]);
    const body = el('div', { class: 'arr-row-body' }); body.appendChild(sub.el);
    const row = el('div', { class: 'arr-row' }, [head, body]);
    const rec = { row, getValue: sub.getValue };
    recs.push(rec);
    del.addEventListener('click', () => {
      const i = recs.indexOf(rec);
      if (i >= 0) recs.splice(i, 1);
      row.remove(); renumber(); notify(wrap);
    });
    rowsEl.appendChild(row);
    renumber();
    if (!silent) notify(wrap);
  };
  (Array.isArray(cur) ? cur : []).forEach(v => addRow(v, true));
  const addBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm arr-add', text: '+ 添加一项' });
  addBtn.addEventListener('click', () => addRow({}, false));
  wrap.append(rowsEl, addBtn);
  const get = () => recs.map(r => r.getValue());
  return { el: wrap, get };
}

// map[K]V：JSON Schema 里是 object + additionalProperties(值的 schema)、且无固定 properties。
function hasProps(s) { return s.properties && Object.keys(s.properties).length > 0; }
function isMap(s) {
  return schemaType(s) === 'object' && !hasProps(s)
    && s.additionalProperties && typeof s.additionalProperties === 'object';
}

// map 键值编辑器：每行一个键输入 + 一个值控件（值是对象就用子表单，否则用标量控件），可增删。
function mapField(valueSchema, cur, root, depth) {
  const wrap = el('div', { class: 'mapf' });
  const rowsEl = el('div', { class: 'map-rows' });
  const recs = [];   // 与 DOM 同序：{ keyEl, getValue }
  const valIsObj = schemaType(valueSchema) === 'object' && hasProps(valueSchema);
  const addRow = (k, v, silent) => {
    const keyEl = el('input', { type: 'text', class: 'mono map-key', placeholder: '键' });
    keyEl.value = k != null ? k : '';
    let valEl, valGet;
    if (valIsObj) {
      const sub = buildObjectForm(valueSchema, v || {}, root, (depth || 0) + 1);
      valEl = sub.el; valGet = sub.getValue;
    } else {
      const f = renderScalarField('', valueSchema, v, valueSchema, root);
      const lab = f.el.querySelector('label.f'); if (lab) lab.remove();   // 值不需要标签
      valEl = f.el; valGet = f.get;
    }
    const del = el('button', { type: 'button', class: 'btn btn--danger btn--sm map-del', text: '删除' });
    const head = el('div', { class: 'map-row-head' }, [keyEl, del]);
    const body = el('div', { class: 'map-row-body' }); body.appendChild(valEl);
    const row = el('div', { class: 'map-row' }, [head, body]);
    const rec = { keyEl, getValue: valGet };
    recs.push(rec);
    del.addEventListener('click', () => {
      const i = recs.indexOf(rec); if (i >= 0) recs.splice(i, 1);
      row.remove(); notify(wrap);
    });
    rowsEl.appendChild(row);
    if (!silent) notify(wrap);
  };
  const entries = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? Object.entries(cur) : [];
  entries.forEach(([k, v]) => addRow(k, v, true));
  const addBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm map-add', text: '+ 添加键值' });
  addBtn.addEventListener('click', () => addRow('', valIsObj ? {} : '', false));
  wrap.append(rowsEl, addBtn);
  const get = () => {
    const o = {};
    recs.forEach(r => {
      const k = r.keyEl.value.trim();
      if (!k) return;
      const v = r.getValue();
      if (v === '' || v === null || v === undefined) return;
      o[k] = v;
    });
    return o;
  };
  return { el: wrap, get };
}

function renderScalarField(key, s, cur, rawProp, root) {
  const field = el('div');
  const wide = () => field.classList.add('field--wide');   // 占满整行（⑥）
  const desc = s.description || (rawProp && rawProp.description);
  // 有描述就只显示描述，不再带字段名（⑤）
  const labelText = desc || s.title || (rawProp && rawProp.title) || key;
  const label = el('label', { class: 'f', text: labelText });
  field.appendChild(label);

  const t = schemaType(s);
  const ui = pick(s, rawProp, 'k-ui');
  let input, get;

  // —— 自定义控件（k-ui）：命中即自行渲染并提前返回 ——
  if (ui === 'textarea' || ui === 'code') {
    wide();
    input = el('textarea', { spellcheck: ui === 'code' ? 'false' : 'true' });
    if (ui === 'code') input.classList.add('mono', 'code');
    const rows = parseInt(pick(s, rawProp, 'k-rows'), 10);
    if (rows > 0) input.rows = rows;
    const lang = pick(s, rawProp, 'k-lang');
    if (lang) input.dataset.lang = lang;
    input.value = (cur !== undefined && cur !== null) ? cur : (s.default !== undefined ? s.default : '');
    field.appendChild(input);
    return { el: field, get: () => input.value };
  }

  if (ui === 'secret') {
    const wrap = el('div', { class: 'secret' });
    input = el('input', { type: 'password', class: 'mono', autocomplete: 'new-password', spellcheck: 'false' });
    input.value = (cur !== undefined && cur !== null) ? cur : (s.default !== undefined ? s.default : '');
    const toggle = el('button', { type: 'button', class: 'secret-toggle', text: '显示' });
    toggle.setAttribute('aria-label', '显示或隐藏');
    toggle.addEventListener('click', () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? '隐藏' : '显示';
    });
    wrap.append(input, toggle);
    field.appendChild(wrap);
    return { el: field, get: () => input.value };
  }

  if (ui === 'color') {
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    const wrap = el('div', { class: 'color' });
    const start = hexRe.test(cur || '') ? cur : (hexRe.test(s.default || '') ? s.default : '#5b53c4');
    input = el('input', { type: 'color' });
    input.value = start;
    const hex = el('input', { type: 'text', class: 'mono color-hex', placeholder: '#rrggbb' });
    hex.maxLength = 7;
    hex.value = start;
    input.addEventListener('input', () => { hex.value = input.value; });
    hex.addEventListener('input', () => { if (hexRe.test(hex.value)) input.value = hex.value; });
    wrap.append(input, hex);
    field.appendChild(wrap);
    return { el: field, get: () => (hexRe.test(hex.value) ? hex.value : input.value) };
  }

  if (ui === 'slider') {
    wide();
    const min = Number(pick(s, rawProp, 'minimum'));
    const max = Number(pick(s, rawProp, 'maximum'));
    const stepRaw = pick(s, rawProp, 'multipleOf');
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 100;
    const start = (cur !== undefined && cur !== null) ? cur : (s.default !== undefined ? s.default : lo);
    const wrap = el('div', { class: 'slider' });
    input = el('input', { type: 'range' });
    input.min = lo; input.max = hi;
    input.step = (stepRaw !== undefined) ? stepRaw : (t === 'integer' ? 1 : 'any');
    input.value = start;
    const num = el('input', { type: 'number', class: 'mono slider-num' });
    num.min = lo; num.max = hi; num.step = input.step; num.value = start;
    input.addEventListener('input', () => { num.value = input.value; });
    num.addEventListener('input', () => { if (num.value !== '') input.value = num.value; });
    wrap.append(input, num);
    field.appendChild(wrap);
    return {
      el: field,
      get: () => (num.value === '' ? null : (t === 'integer' ? parseInt(num.value, 10) : parseFloat(num.value))),
    };
  }

  if (ui === 'tags') {
    wide();
    const itemT = schemaType(resolveSchema(s.items || {}, root));
    const tf = tagsField(cur, itemT);
    field.appendChild(tf.el);
    return { el: field, get: tf.get };
  }

  // —— 默认按 type 渲染 ——
  if (Array.isArray(s.enum)) {
    input = el('select', { class: 'mono' });
    s.enum.forEach(opt => input.appendChild(el('option', { value: String(opt), text: String(opt) })));
    input.value = String(cur !== undefined ? cur : (s.default !== undefined ? s.default : s.enum[0]));
    get = () => coerceEnum(input.value, s.enum);
  } else if (t === 'boolean') {
    const sw = el('label', { class: 'sw' });
    input = el('input', { type: 'checkbox' });
    input.checked = cur !== undefined ? !!cur : !!s.default;
    sw.append(input, document.createTextNode(' '));
    field.appendChild(sw);
    get = () => input.checked;
  } else if (t === 'integer' || t === 'number') {
    input = el('input', { type: 'number' });
    if (t === 'number') input.step = 'any';
    input.value = (cur !== undefined && cur !== null) ? cur : (s.default !== undefined ? s.default : '');
    get = () => input.value === '' ? null : (t === 'integer' ? parseInt(input.value, 10) : parseFloat(input.value));
  } else if (t === 'array') {
    const items = resolveSchema(s.items || {}, root);
    const it = schemaType(items);
    if (ui === 'csv') {
      // 显式要求时回退到逗号分隔的单行文本框
      input = el('input', { type: 'text', class: 'mono', placeholder: '逗号分隔' });
      input.value = Array.isArray(cur) ? cur.join(', ') : '';
      get = () => input.value.split(/[,\n]/).map(x => x.trim()).filter(Boolean)
        .map(x => it === 'integer' ? parseInt(x, 10) : it === 'number' ? parseFloat(x) : x);
    } else if (it === 'object') {
      wide();
      const af = objectArrayField(items, cur, root, 0);   // []struct → 行编辑器
      field.appendChild(af.el);
      return { el: field, get: af.get };
    } else if (it === 'array') {
      wide();
      const a = jsonArea(cur); input = a.input; get = a.get;   // 数组套数组仍用 JSON
    } else {
      wide();
      const tf = tagsField(cur, it);                      // 标量数组 → 标签编辑器（默认）
      field.appendChild(tf.el);
      return { el: field, get: tf.get };
    }
  } else if (t === 'object') {
    if (isMap(s)) {                                        // map[K]V → 键值编辑器（②）
      wide();
      const mf = mapField(resolveSchema(s.additionalProperties, root), cur, root, 0);
      field.appendChild(mf.el);
      return { el: field, get: mf.get };
    }
    wide();
    const a = jsonArea(cur); input = a.input; get = a.get;
  } else {
    input = el('input', { type: 'text' });
    input.value = (cur !== undefined && cur !== null) ? cur : (s.default !== undefined ? s.default : '');
    get = () => input.value;
  }

  if (t !== 'boolean') field.appendChild(input);
  return { el: field, get };
}

function buildObjectForm(objSchema, value, root, depth) {
  value = value || {};
  const wrap = el('div', { class: 'grid' });
  const props = objSchema.properties || {};
  let order = Object.keys(props);
  if (Array.isArray(objSchema.required)) {
    const req = objSchema.required.filter(k => props[k]);
    order = req.concat(order.filter(k => req.indexOf(k) < 0));
  }
  const getters = [];
  // 给嵌套对象/Map 生成一个带标题的整行分组；有描述就只显示描述（③⑤）
  const groupTitle = (s, raw, key) => {
    const d = s.description || (raw && raw.description);
    return d || s.title || (raw && raw.title) || key;
  };
  for (const key of order) {
    const raw = props[key];
    const s = resolveSchema(raw, root);
    const cur = value[key];
    const t = schemaType(s);
    if (t === 'object' && isMap(s)) {                       // map[K]V（②）
      const group = el('div', { class: 'field--wide' }, [
        el('div', { class: 'subgroup-title', text: groupTitle(s, raw, key) }),
      ]);
      const box = el('div', { class: 'subgroup-box' });
      const mf = mapField(resolveSchema(s.additionalProperties, root), cur, root, depth + 1);
      box.appendChild(mf.el);
      group.appendChild(box);
      wrap.appendChild(group);
      getters.push([key, mf.get]);
      continue;
    }
    if (t === 'object' && s.properties) {                   // 嵌套结构体
      const group = el('div', { class: 'field--wide' }, [
        el('div', { class: 'subgroup-title', text: groupTitle(s, raw, key) }),
      ]);
      const box = el('div', { class: 'subgroup-box' });
      const sub = buildObjectForm(s, cur || {}, root, depth + 1);
      box.appendChild(sub.el);
      group.appendChild(box);
      wrap.appendChild(group);
      getters.push([key, sub.getValue]);
      continue;
    }
    const f = renderScalarField(key, s, cur, raw, root);
    wrap.appendChild(f.el);
    getters.push([key, f.get]);
  }
  return {
    el: wrap,
    getValue: () => {
      const o = {};
      for (const [k, g] of getters) {
        const v = g();
        if (v === '' || v === null || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
        o[k] = v;
      }
      return o;
    },
  };
}

// buildForm(schema, value) → { el, getValue }
export function buildForm(schema, value) {
  const root = schema || {};
  const top = resolveSchema(root, root);
  return buildObjectForm(top, value || {}, root, 0);
}
