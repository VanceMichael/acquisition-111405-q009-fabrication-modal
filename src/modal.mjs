// 制板模态指令解释器。状态按层隔离，由调用方为每一层创建一个实例；
// 每条产出记录都保留层、交付版本与原文分段/指令区间，无法解释的指令不沿用旧状态凑对象。
const OPERATIONS = new Set([
  'format', 'unit', 'aperture', 'select', 'attribute', 'deleteAttribute',
  'move', 'draw', 'flash', 'regionBegin', 'regionEnd',
]);
const MODAL_OPERATIONS = new Set(['format', 'unit', 'aperture', 'select', 'attribute', 'deleteAttribute']);
const SCOPES = new Set(['file', 'aperture', 'object']);
const UNITS = new Set(['mm', 'inch']);
const ZERO_SUPPRESSION = new Set(['leading']);
const COORDINATE = /^\d+$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRange(instruction) {
  const {byteStart, byteEnd} = instruction;
  if (byteStart === undefined && byteEnd === undefined) return {ok: true, range: null};
  if (!Number.isInteger(byteStart) || !Number.isInteger(byteEnd) || byteStart < 0 || byteEnd < byteStart) {
    return {ok: false, range: null};
  }
  return {ok: true, range: {start: byteStart, end: byteEnd}};
}

function samePoint(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function locate(ranges) {
  const parts = [...new Set(ranges.map(item => item.part).filter(Boolean))];
  const sourceRanges = parts.map(part => {
    const items = ranges.filter(item => item.part === part);
    return {
      part, partIndex: items[0].partIndex,
      start: Math.min(...items.map(item => item.start)),
      end: Math.max(...items.map(item => item.end)),
    };
  });
  return {
    sourceRange: sourceRanges.length === 1 ? {...sourceRanges[0]} : null,
    sourceRanges,
    parts,
  };
}

function cloneDefinition(definition) {
  const attributes = [...definition.attributes];
  return {
    id: definition.id,
    shape: definition.shape,
    params: structuredClone(definition.params),
    attributes: Object.fromEntries(attributes.map(([key, entry]) => [key, entry.value])),
    attributeSources: attributes.map(([key, entry]) => ({
      scope: 'aperture', key, value: entry.value,
      part: entry.part ?? null, partIndex: entry.partIndex ?? null,
      instruction: entry.instruction ?? null, sourceRange: entry.sourceRange ?? null,
    })),
    sourceRange: definition.sourceRange ? {...definition.sourceRange} : null,
  };
}

export function createLayerInterpreter({job, layer, generation = null, report}) {
  let activeGeneration = generation;
  let started = false;
  const state = {
    format: null,
    unit: null,
    position: {x: null, y: null},
    apertures: new Map(),
    selection: null,
    fileAttributes: new Map(),
    apertureAttributes: new Map(),
    objectAttributes: new Map(),
    attributeJournal: [],
    region: null,
    records: [],
    idCounts: new Map(),
    ordinal: 0,
    stopped: false,
  };

  function issue(code, message, place = {}, extra = {}) {
    report({
      code, message, job, layer, generation: activeGeneration,
      part: place.part ?? null,
      partIndex: place.partIndex ?? null,
      instruction: place.instruction ?? null,
      sourceRange: place.sourceRange ?? null,
      ...extra,
    });
  }

  function stopLayer(code, message, place = {}) {
    state.region = null;
    state.stopped = true;
    issue(code, message, place);
  }

  function failRegion(code, message, place = {}) {
    issue(code, message, place);
    if (state.region) state.region.failed = true;
  }

  function recordId(kind, location) {
    // 业务身份 = 作业/层/交付版本/原文分段与区间；同一原文重复出现时追加出现序号后缀。
    const where = location.sourceRanges.length
      ? location.sourceRanges.map(item => `${item.part}:${item.start}-${item.end}`).join('|')
      : `#${state.ordinal}`;
    const base = [`fab`, job, layer, activeGeneration ?? '-', kind, where].join(':');
    const seen = state.idCounts.get(base) ?? 0;
    state.idCounts.set(base, seen + 1);
    return seen ? `${base}~${seen}` : base;
  }

  function selectedDefinition() {
    if (!state.selection || !state.selection.valid) return null;
    return state.apertures.get(state.selection.id) ?? null;
  }

  function effectiveAttributes() {
    const merged = new Map();
    const definition = selectedDefinition();
    const scopes = [state.fileAttributes, definition ? definition.attributes : new Map(), state.objectAttributes];
    for (const map of scopes) {
      for (const [key, entry] of map) merged.set(key, entry);
    }
    return {
      attributes: Object.fromEntries([...merged].map(([key, entry]) => [key, entry.value])),
      attributeSources: [...merged].map(([key, entry]) => ({
        scope: entry.scope, key, value: entry.value,
        part: entry.part ?? null, partIndex: entry.partIndex ?? null,
        instruction: entry.instruction ?? null, sourceRange: entry.sourceRange ?? null,
      })),
    };
  }

  function takeJournal() {
    const journal = state.attributeJournal;
    state.attributeJournal = [];
    return journal;
  }

  function resetModal() {
    state.format = null;
    state.unit = null;
    state.position = {x: null, y: null};
    state.apertures.clear();
    state.selection = null;
    state.fileAttributes.clear();
    state.apertureAttributes.clear();
    state.objectAttributes.clear();
    state.attributeJournal = [];
  }

  function setGeneration(next) {
    // 同一层内的 part 属于同一交付版本，代际由收集层先行核对；这里只在状态被要求重置时清空。
    if (!started) {
      started = true;
      activeGeneration = next;
      return;
    }
    if (next === null || next === activeGeneration) return;
    const from = activeGeneration;
    activeGeneration = next;
    if (from === null) return;
    if (state.region) {
      issue('REGION_BOUNDARY', '交付版本切换，未结束的区域不生成对象', {
        sourceRange: locate(state.region.ranges).sourceRange,
      });
      state.region = null;
    }
    resetModal();
    issue('GENERATION_CHANGE', `层从交付版本 ${from} 切换到 ${next}，模态状态不复用`, {}, {from, to: next});
  }

  function readAxis(value) {
    if (value === undefined) return {absent: true};
    if (typeof value !== 'string' || !COORDINATE.test(value)) {
      return {fatal: true, code: 'INVALID_COORDINATE', message: '坐标不是整数数字串'};
    }
    if (!state.format) {
      return {fatal: true, code: 'MISSING_FORMAT', message: '坐标出现前未声明数字格式'};
    }
    if (value.replace(/^0+(?=\d)/, '').length > state.format.integer + state.format.decimal) {
      return {
        fatal: true, code: 'COORDINATE_OUT_OF_FORMAT',
        message: `坐标位数超出已声明格式（${state.format.integer}.${state.format.decimal}）`,
      };
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return {fatal: true, code: 'INVALID_COORDINATE', message: '坐标无法按数字格式解释'};
    }
    return {value: number / (10 ** state.format.decimal)};
  }

  function resolveTarget(instruction) {
    const x = readAxis(instruction.x);
    if (x.fatal) return x;
    const y = readAxis(instruction.y);
    if (y.fatal) return y;
    return {
      x: x.absent ? state.position.x : x.value,
      y: y.absent ? state.position.y : y.value,
    };
  }

  function unknownAxis(target, place) {
    const missing = [target.x === null ? 'x' : null, target.y === null ? 'y' : null].filter(Boolean);
    issue('UNKNOWN_AXIS', `坐标轴 ${missing.join('/')} 尚无有效位置，不生成对象`, place, {missing});
  }

  function objectLocation(range, part) {
    return locate(range ? [{...range, part: part.href, partIndex: part.index}] : []);
  }

  function emitObject(kind, instruction, place, range, part) {
    const target = resolveTarget(instruction);
    if (target.fatal) {
      stopLayer(target.code, target.message, place);
      return;
    }
    const start = {...state.position};
    state.position = {x: target.x, y: target.y};
    if (target.x === null || target.y === null) {
      unknownAxis(target, place);
      return;
    }
    if (kind === 'draw' && (start.x === null || start.y === null)) {
      unknownAxis(start, place);
      return;
    }
    if (!state.unit) {
      issue('MISSING_UNIT', '绘图指令出现前未声明单位，不生成对象', place);
      return;
    }
    const definition = selectedDefinition();
    if (!definition) {
      issue('MISSING_APERTURE', '绘图指令没有可用的已定义孔径，不生成对象', place);
      return;
    }
    if (!range) issue('MISSING_SOURCE_RANGE', '对象缺少指令区间，只能按分段与指令序号定位', place);
    const location = objectLocation(range, part);
    const boundaries = takeJournal();
    const {attributes, attributeSources} = effectiveAttributes();
    const record = {
      id: recordId(kind, location),
      job, layer, generation: activeGeneration, kind,
      position: kind === 'draw' ? [start.x, start.y] : [target.x, target.y],
      end: [target.x, target.y],
      unit: state.unit,
      aperture: definition.id,
      attributes,
      attributeSources,
      apertureDefinition: cloneDefinition(definition),
      sourcePart: location.sourceRange ? location.sourceRange.part : part.href,
      sourceRange: location.sourceRange,
      sourceInstruction: place.instruction ?? null,
      source: {
        job, layer, generation: activeGeneration,
        part: location.sourceRange ? location.sourceRange.part : part.href,
        partIndex: location.sourceRange ? location.sourceRange.partIndex : part.index,
        instruction: place.instruction ?? null,
        byteStart: location.sourceRange ? location.sourceRange.start : null,
        byteEnd: location.sourceRange ? location.sourceRange.end : null,
      },
    };
    if (boundaries.length) record.boundaries = boundaries;
    state.records.push(record);
    state.ordinal += 1;
  }

  function beginRegion(place, range, part) {
    if (state.region) {
      failRegion('NESTED_REGION', '区域未结束前不能开始另一区域，当前区域不生成对象', place);
      return;
    }
    const definition = selectedDefinition();
    const ranges = [];
    if (range) ranges.push({...range, part: part.href, partIndex: part.index});
    const boundaries = takeJournal();
    const {attributes, attributeSources} = effectiveAttributes();
    state.region = {
      contours: [[]],
      ranges,
      failed: false,
      attributes,
      attributeSources,
      boundaries,
      aperture: definition ? definition.id : null,
      apertureDefinition: definition ? cloneDefinition(definition) : null,
      firstPart: part.href,
    };
  }

  function noteContourPoint(target) {
    state.region.contours[state.region.contours.length - 1].push([target.x, target.y]);
    state.position = {x: target.x, y: target.y};
  }

  function moveInRegion(instruction, place, range, part) {
    const target = resolveTarget(instruction);
    if (target.fatal) {
      stopLayer(target.code, target.message, place);
      return;
    }
    if (target.x === null || target.y === null) {
      unknownAxis(target, place);
      state.region.failed = true;
      return;
    }
    if (state.region.contours[state.region.contours.length - 1].length) state.region.contours.push([]);
    noteContourPoint(target);
    if (range) state.region.ranges.push({...range, part: part.href, partIndex: part.index});
  }

  function drawInRegion(instruction, place, range, part) {
    const target = resolveTarget(instruction);
    if (target.fatal) {
      stopLayer(target.code, target.message, place);
      return;
    }
    if (target.x === null || target.y === null) {
      unknownAxis(target, place);
      state.region.failed = true;
      return;
    }
    const contour = state.region.contours[state.region.contours.length - 1];
    if (!contour.length) {
      if (state.position.x === null || state.position.y === null) {
        unknownAxis(state.position, place);
        state.region.failed = true;
        return;
      }
      contour.push([state.position.x, state.position.y]);
    }
    noteContourPoint(target);
    if (range) state.region.ranges.push({...range, part: part.href, partIndex: part.index});
  }

  function endRegion(place) {
    const region = state.region;
    if (!region) {
      issue('STRAY_REGION_END', '没有对应的区域开始指令', place);
      return;
    }
    state.region = null;
    if (region.failed) return;
    if (region.contours.length > 1) {
      issue('MULTIPLE_REGION_CONTOURS', '同一区域包含多个轮廓，按逐条独立轮廓保留', place);
    }
    if (!region.ranges.length) issue('MISSING_SOURCE_RANGE', '区域缺少指令区间，只能按分段与指令序号定位', place);
    const drawn = region.contours.filter(contour => contour.length);
    const valid = drawn.filter(contour => contour.length >= 3);
    if (valid.length !== drawn.length) issue('INVALID_REGION_CONTOUR', '区域中存在不足三个点的轮廓，未被当作有效区域', place);
    if (!valid.length) {
      issue('INVALID_REGION', '区域没有可用的轮廓，不生成对象', {
        ...place, sourceRange: locate(region.ranges).sourceRange,
      });
      return;
    }
    if (!state.unit) {
      issue('MISSING_UNIT', '区域结束前未声明单位，不生成对象', place);
      return;
    }
    const location = locate(region.ranges);
    const last = valid[valid.length - 1];
    const record = {
      id: recordId('region', location),
      job, layer, generation: activeGeneration, kind: 'region',
      position: [valid[0][0][0], valid[0][0][1]],
      end: [last[last.length - 1][0], last[last.length - 1][1]],
      unit: state.unit,
      aperture: region.aperture,
      attributes: region.attributes,
      attributeSources: region.attributeSources,
      apertureDefinition: region.apertureDefinition,
      path: valid.length === 1 ? valid[0] : valid,
      contours: valid.length,
      closed: valid.every(contour => samePoint(contour[0], contour[contour.length - 1])),
      sourcePart: location.sourceRange ? location.sourceRange.part : region.firstPart,
      sourceRange: location.sourceRange,
      sourceRanges: location.sourceRanges,
      sourceInstruction: place.instruction ?? null,
      source: {
        job, layer, generation: activeGeneration,
        part: location.sourceRange ? location.sourceRange.part : region.firstPart,
        partIndex: location.sourceRange ? location.sourceRange.partIndex : null,
        instruction: place.instruction ?? null,
        byteStart: location.sourceRange ? location.sourceRange.start : null,
        byteEnd: location.sourceRange ? location.sourceRange.end : null,
      },
    };
    if (region.boundaries.length) record.boundaries = region.boundaries;
    state.records.push(record);
    state.ordinal += 1;
  }

  function applyAttribute(instruction, place, remove) {
    const {scope, key} = instruction;
    if (!SCOPES.has(scope)) {
      stopLayer('UNSUPPORTED_ATTRIBUTE_SCOPE', `暂不支持的属性作用域：${String(scope)}`, place);
      return;
    }
    if (typeof key !== 'string' || !key || (!remove && key === '*')) {
      stopLayer('INVALID_ATTRIBUTE', remove ? '属性删除缺少键' : '属性缺少有效键', place);
      return;
    }
    if (!remove && !['string', 'number', 'boolean'].includes(typeof instruction.value)) {
      stopLayer('INVALID_ATTRIBUTE', '属性值不是可追溯的标量', place);
      return;
    }
    const map = scope === 'file' ? state.fileAttributes
      : scope === 'aperture' ? state.apertureAttributes : state.objectAttributes;
    const previousValue = remove
      ? (key === '*' ? Object.fromEntries([...map].map(([name, entry]) => [name, entry.value])) : map.get(key)?.value ?? null)
      : map.get(key)?.value ?? null;
    if (remove) {
      if (key === '*') map.clear();
      else map.delete(key);
    } else {
      map.set(key, {
        value: instruction.value, scope,
        part: place.part ?? null, partIndex: place.partIndex ?? null,
        instruction: place.instruction ?? null, sourceRange: place.sourceRange ?? null,
      });
    }
    state.attributeJournal.push({
      scope, key, action: remove ? 'delete' : 'set',
      value: remove ? null : instruction.value,
      previousValue,
      part: place.part ?? null, partIndex: place.partIndex ?? null,
      instruction: place.instruction ?? null, sourceRange: place.sourceRange ?? null,
    });
  }

  function defineAperture(instruction, place, part) {
    if (typeof instruction.id !== 'string' || !instruction.id) {
      stopLayer('INVALID_APERTURE', '孔径定义缺少标识', place);
      return;
    }
    if (typeof instruction.shape !== 'string' || !instruction.shape) {
      stopLayer('INVALID_APERTURE', '孔径定义缺少形状', place);
      return;
    }
    if (!Array.isArray(instruction.params)
      || !instruction.params.every(item => typeof item === 'string' || typeof item === 'number')) {
      stopLayer('INVALID_APERTURE', '孔径定义参数无效', place);
      return;
    }
    state.apertures.set(instruction.id, {
      id: instruction.id,
      shape: instruction.shape,
      params: structuredClone(instruction.params),
      attributes: new Map([...state.apertureAttributes].map(([key, entry]) => [key, {...entry}])),
      sourceRange: place.sourceRange ? {...place.sourceRange, part: part.href, partIndex: part.index} : null,
    });
  }

  function process(instruction, index, part) {
    if (!isObject(instruction)) {
      stopLayer('INVALID_INSTRUCTION', '指令不是对象', {
        part: part.href, partIndex: part.index, instruction: index,
      });
      return;
    }
    const op = instruction.op;
    const rangeCheck = readRange(instruction);
    const range = rangeCheck.range;
    const place = {part: part.href, partIndex: part.index, instruction: index, sourceRange: range};
    if (!rangeCheck.ok) {
      stopLayer('INVALID_SOURCE_RANGE', '指令区间无效，无法定位原文，后续指令不再沿用状态', place);
      return;
    }
    if (typeof op !== 'string' || !OPERATIONS.has(op)) {
      stopLayer('UNSUPPORTED_OPERATION', `暂不支持的指令：${String(op)}`, place);
      return;
    }

    if (state.region?.failed) {
      if (op === 'regionEnd') {
        endRegion(place);
        return;
      }
      if (op === 'regionBegin') {
        issue('NESTED_REGION', '失败区域结束前不能开始另一区域', place);
        return;
      }
      if (!MODAL_OPERATIONS.has(op)) return;
    }

    switch (op) {
      case 'format': {
        const {integer, decimal, zeroSuppression} = instruction;
        if (!Number.isInteger(integer) || integer < 1 || !Number.isInteger(decimal) || decimal < 0) {
          stopLayer('INVALID_FORMAT', '数字格式的整数位或小数位无效', place);
          return;
        }
        if (zeroSuppression !== undefined && !ZERO_SUPPRESSION.has(zeroSuppression)) {
          stopLayer('UNSUPPORTED_ZERO_SUPPRESSION', `暂不支持的零抑制方式：${String(zeroSuppression)}`, place);
          return;
        }
        state.format = {integer, decimal};
        return;
      }
      case 'unit': {
        if (!UNITS.has(instruction.value)) {
          stopLayer('UNSUPPORTED_UNIT', `暂不支持的单位：${String(instruction.value)}`, place);
          return;
        }
        state.unit = instruction.value;
        return;
      }
      case 'aperture': {
        defineAperture(instruction, place, part);
        return;
      }
      case 'select': {
        if (typeof instruction.id !== 'string' || !instruction.id) {
          stopLayer('INVALID_SELECT', '选择孔径缺少标识', place);
          return;
        }
        const valid = state.apertures.has(instruction.id);
        if (!valid) issue('UNKNOWN_APERTURE', `选择了未定义的孔径：${instruction.id}`, place);
        state.selection = {id: instruction.id, valid};
        return;
      }
      case 'attribute': {
        applyAttribute(instruction, place, false);
        return;
      }
      case 'deleteAttribute': {
        applyAttribute(instruction, place, true);
        return;
      }
      case 'move': {
        if (state.region) {
          moveInRegion(instruction, place, range, part);
          return;
        }
        const target = resolveTarget(instruction);
        if (target.fatal) {
          stopLayer(target.code, target.message, place);
          return;
        }
        state.position = {x: target.x, y: target.y};
        if (target.x === null || target.y === null) unknownAxis(target, place);
        return;
      }
      case 'draw': {
        if (state.region) {
          drawInRegion(instruction, place, range, part);
          return;
        }
        emitObject('draw', instruction, place, range, part);
        return;
      }
      case 'flash': {
        if (state.region) {
          failRegion('FLASH_IN_REGION', '区域内出现闪光指令，该区域不生成对象', place);
          return;
        }
        emitObject('flash', instruction, place, range, part);
        return;
      }
      case 'regionBegin': {
        beginRegion(place, range, part);
        return;
      }
      case 'regionEnd': {
        endRegion(place);
        return;
      }
      default: {
        stopLayer('UNSUPPORTED_OPERATION', `暂不支持的指令：${op}`, place);
      }
    }
  }

  return {
    feed(instructions, part) {
      if (state.stopped) return;
      for (let index = 0; index < instructions.length; index += 1) {
        if (state.stopped) return;
        process(instructions[index], index, part);
      }
    },
    finish() {
      if (state.region) {
        const region = state.region;
        state.region = null;
        if (!region.failed) {
          issue('UNFINISHED_REGION', '区域未结束，不生成区域对象', {
            sourceRange: locate(region.ranges).sourceRange,
          });
        }
      }
      state.attributeJournal = [];
      return state.records;
    },
    setGeneration,
    get stopped() {
      return state.stopped;
    },
  };
}
