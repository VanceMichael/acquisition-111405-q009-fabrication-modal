import {createLayerInterpreter} from './modal.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(response, label, gap) {
  try {
    return {value: response.json()};
  } catch (error) {
    gap({code: 'INVALID_JSON', message: `${label}不是有效JSON：${error.message}`, url: response.url ?? null});
    return {value: undefined};
  }
}

function partList(layer) {
  if (Array.isArray(layer.parts)) {
    return layer.parts.map((entry, index) => {
      if (typeof entry === 'string') return {href: entry, index};
      if (isObject(entry) && typeof entry.href === 'string') {
        return {href: entry.href, index, generation: typeof entry.generation === 'string' ? entry.generation : null};
      }
      return {href: null, index, generation: null};
    });
  }
  if (typeof layer.href === 'string') return [{href: layer.href, index: 0, generation: null}];
  return [];
}

export async function collectSource({transport, archive}) {
  const issues = [];
  const records = [];
  let complete = true;

  function gap(issue) {
    complete = false;
    issues.push(issue);
  }

  async function conclude() {
    await archive.commit({records, exchanges: transport.exchanges, issues});
    return {records, complete, issues, evidenceCount: transport.exchanges.length};
  }

  let manifestResponse;
  try {
    manifestResponse = await transport.request('/fabrication');
  } catch (error) {
    gap({code: 'MANIFEST_REQUEST_ERROR', message: `制板清单领取失败：${error.message}`, url: '/fabrication'});
    return conclude();
  }
  if (!manifestResponse.ok) {
    gap({
      code: 'MANIFEST_HTTP_ERROR', message: `制板清单领取失败：${manifestResponse.status}`,
      url: '/fabrication', status: manifestResponse.status,
    });
    return conclude();
  }

  const manifest = readJson(manifestResponse, '制板清单', gap).value;
  if (!isObject(manifest)) {
    if (manifest !== undefined) gap({code: 'INVALID_MANIFEST', message: '制板清单不是对象', url: '/fabrication'});
    return conclude();
  }

  if (typeof manifest.job !== 'string' || !manifest.job) {
    gap({code: 'INVALID_MANIFEST', message: '制板清单缺少job标识', url: '/fabrication'});
  }
  if (!Array.isArray(manifest.layers)) {
    gap({code: 'INVALID_MANIFEST', message: '制板清单缺少layers数组', url: '/fabrication'});
  }
  const manifestGeneration = typeof manifest.generation === 'string' && manifest.generation ? manifest.generation : null;
  if (manifest.sealed === false) {
    gap({code: 'UNSEALED_MANIFEST', message: '来源声明该交付未封闭，已收部分保留但不视为完整', url: '/fabrication'});
  }
  const job = typeof manifest.job === 'string' ? manifest.job : null;
  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const seenLayers = new Set();
  if (!job) return conclude();

  for (const [layerIndex, layer] of layers.entries()) {
    if (!isObject(layer) || typeof layer.id !== 'string' || !layer.id) {
      gap({code: 'INVALID_LAYER', message: '层缺少有效标识，已跳过', layerIndex});
      continue;
    }
    if (seenLayers.has(layer.id)) {
      gap({code: 'DUPLICATE_LAYER', message: `层标识重复：${layer.id}，已跳过后续条目`, layer: layer.id, layerIndex});
      continue;
    }
    seenLayers.add(layer.id);
    const layerGeneration = typeof layer.generation === 'string' && layer.generation
      ? layer.generation : manifestGeneration;
    const parts = partList(layer);
    if (!parts.length) {
      gap({code: 'MISSING_LAYER_SOURCE', message: `层 ${layer.id} 未给出任何指令原文`, layer: layer.id, layerIndex});
      continue;
    }
    if (parts.some(part => !part.href)) {
      gap({code: 'INVALID_PART', message: `层 ${layer.id} 存在无效的分段条目`, layer: layer.id, layerIndex});
    }

    const interpreter = createLayerInterpreter({
      job, layer: layer.id, generation: layerGeneration, report: issue => gap(issue),
    });
    let resolvedGeneration = layerGeneration;
    for (const part of parts.filter(item => item.href)) {
      const declaredGeneration = part.generation ?? layerGeneration;
      let response;
      try {
        response = await transport.request(part.href);
      } catch (error) {
        gap({
          code: 'PART_REQUEST_ERROR', message: `层 ${layer.id} 第${part.index}段领取失败：${error.message}`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index,
        });
        break;
      }
      if (!response.ok) {
        gap({
          code: 'PART_HTTP_ERROR', message: `层 ${layer.id} 第${part.index}段领取失败：${response.status}`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index, status: response.status,
        });
        break;
      }
      const announced = response.headers.get('x-generation');
      if (declaredGeneration && resolvedGeneration && declaredGeneration !== resolvedGeneration) {
        gap({
          code: 'GENERATION_MISMATCH',
          message: `层 ${layer.id} 第${part.index}段声明交付版本 ${declaredGeneration}，与本层已核对的 ${resolvedGeneration} 不同，不并入同一层`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index,
          expectedGeneration: resolvedGeneration, actualGeneration: declaredGeneration,
        });
        break;
      }
      const requested = declaredGeneration ?? resolvedGeneration;
      if (requested && announced && announced !== requested) {
        gap({
          code: 'GENERATION_MISMATCH',
          message: `层 ${layer.id} 第${part.index}段属于另一交付版本 ${announced}，不并入 ${requested}`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index,
          expectedGeneration: requested, actualGeneration: announced,
        });
        break;
      }
      if (requested && !announced) {
        gap({
          code: 'GENERATION_UNVERIFIED',
          message: `层 ${layer.id} 第${part.index}段未声明交付版本，无法核对是否属于 ${requested}`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index,
          expectedGeneration: requested, actualGeneration: null,
        });
      }
      if (!requested && announced) resolvedGeneration = announced;
      const body = readJson(response, `层 ${layer.id} 第${part.index}段`, gap);
      if (body.value === undefined) break;
      if (!Array.isArray(body.value)) {
        gap({
          code: 'INVALID_INSTRUCTION_STREAM', message: `层 ${layer.id} 第${part.index}段不是指令数组`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index,
        });
        break;
      }
      const feedGeneration = resolvedGeneration;
      interpreter.setGeneration(feedGeneration);
      interpreter.feed(body.value, {href: part.href, index: part.index, generation: feedGeneration});
      if (interpreter.stopped) {
        gap({
          code: 'LAYER_STOPPED', message: `层 ${layer.id} 的指令流在无法解释的指令处停止`,
          layer: layer.id, layerIndex, part: part.href, partIndex: part.index,
        });
        break;
      }
    }
    records.push(...interpreter.finish());
  }

  return conclude();
}
