import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openArchive} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';

const HEAD = [
  {op: 'format', integer: 2, decimal: 4, zeroSuppression: 'leading'},
  {op: 'unit', value: 'mm'},
  {op: 'aperture', id: '10', shape: 'C', params: ['0.5']},
  {op: 'select', id: '10'},
];

async function withSource(routes, body) {
  const hits = [];
  const counts = new Map();
  const server = createServer((request, response) => {
    hits.push(request.url);
    const entries = routes[request.url];
    if (!entries) {
      response.writeHead(404).end('未声明');
      return;
    }
    const count = counts.get(request.url) ?? 0;
    counts.set(request.url, count + 1);
    const [status, payload, headers = {}] = entries[Math.min(count, entries.length - 1)];
    response.writeHead(status, {'content-type': 'application/json', ...headers});
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  try {
    return await body({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      hits,
      archive: await openArchive(directory),
      directory,
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await rm(directory, {recursive: true, force: true});
  }
}

const manifest = (layer, extra = {}) => [200, {job: 'job', generation: 'g1', sealed: true, layers: [layer], ...extra}];

test('孔径属性在定义时捕获，之后修改不追溯已定义孔径', async () => {
  await withSource({
    '/fabrication': [manifest({id: 'top', href: '/p', generation: 'g1'})],
    '/p': [[200, [
      ...HEAD.slice(0, 2),
      {op: 'attribute', scope: 'aperture', key: 'role', value: 'pad', byteStart: 1, byteEnd: 2},
      ...HEAD.slice(2),
      {op: 'attribute', scope: 'aperture', key: 'role', value: 'other', byteStart: 3, byteEnd: 4},
      {op: 'flash', x: '100', y: '200', byteStart: 5, byteEnd: 9},
    ], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0].attributes, {role: 'pad'});
    assert.deepEqual(result.records[0].apertureDefinition.attributes, {role: 'pad'});
    assert.deepEqual(result.records[0].apertureDefinition.attributeSources[0].sourceRange, {start: 1, end: 2});
  });
});

test('同层part沿用模态状态，每条结果定位到所在分段与字节区间', async () => {
  await withSource({
    '/fabrication': [manifest({id: 'top', parts: ['/p1', '/p2'], generation: 'g1'})],
    '/p1': [[200, [...HEAD, {op: 'move', x: '100', y: '200', byteStart: 0, byteEnd: 10}], {'x-generation': 'g1'}]],
    '/p2': [[200, [
      {op: 'flash', x: '1000', byteStart: 20, byteEnd: 30},
      {op: 'flash', y: '3000', byteStart: 40, byteEnd: 55},
    ], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, true);
    assert.deepEqual(result.records.map(record => record.position), [[0.1, 0.02], [0.1, 0.3]]);
    assert.deepEqual(result.records[0].source, {
      job: 'job', layer: 'top', generation: 'g1', part: '/p2', partIndex: 1,
      instruction: 0, byteStart: 20, byteEnd: 30,
    });
    assert.equal(result.records[1].sourceRange.part, '/p2');
  });
});

test('跨代际分段不并入同层新对象，已完成的旧代际结果仍可查', async () => {
  await withSource({
    '/fabrication': [
      manifest({id: 'top', parts: ['/p1', '/p2'], generation: 'g1'}),
      [200, {job: 'job', generation: 'g2', sealed: true, layers: [{id: 'top', href: '/p3', generation: 'g2'}]}],
    ],
    '/p1': [[200, [...HEAD, {op: 'flash', x: '100', y: '200', byteStart: 1, byteEnd: 5}], {'x-generation': 'g1'}]],
    '/p2': [[200, [{op: 'flash', x: '900', y: '800', byteStart: 6, byteEnd: 9}], {'x-generation': 'g2'}]],
    '/p3': [[200, [
      {op: 'format', integer: 2, decimal: 4},
      {op: 'unit', value: 'mm'},
      {op: 'aperture', id: '77', shape: 'R', params: ['1', '2']},
      {op: 'select', id: '77'},
      {op: 'flash', x: '500', y: '600', byteStart: 10, byteEnd: 14},
    ], {'x-generation': 'g2'}]],
  }, async ({baseUrl, archive}) => {
    const first = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(first.complete, false);
    assert.deepEqual(first.records.map(record => [record.generation, record.aperture]), [['g1', '10']]);
    assert.ok(first.issues.some(issue => issue.code === 'GENERATION_MISMATCH'));
    const second = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(second.complete, true);
    assert.deepEqual(second.records.map(record => [record.generation, record.aperture]), [['g2', '77']]);
    const stored = archive.snapshot().records;
    assert.ok(stored.some(record => record.id === first.records[0].id && record.generation === 'g1'));
    assert.ok(stored.some(record => record.id === second.records[0].id && record.generation === 'g2'));
  });
});

test('未封闭交付保留已收结果但不声明完整', async () => {
  await withSource({
    '/fabrication': [[200, {
      job: 'job', generation: 'g1', sealed: false, layers: [{id: 'top', href: '/p', generation: 'g1'}],
    }]],
    '/p': [[200, [...HEAD, {op: 'flash', x: '100', y: '200', byteStart: 1, byteEnd: 5}], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    assert.ok(result.issues.some(issue => issue.code === 'UNSEALED_MANIFEST'));
  });
});

test('暂不支持的指令停止本层，不沿用状态补出后续对象', async () => {
  await withSource({
    '/fabrication': [manifest({id: 'top', parts: ['/p1', '/p2'], generation: 'g1'})],
    '/p1': [[200, [
      ...HEAD,
      {op: 'flash', x: '100', y: '200', byteStart: 1, byteEnd: 5},
      {op: 'stepAndRepeat', byteStart: 6, byteEnd: 12},
    ], {'x-generation': 'g1'}]],
    '/p2': [[200, [{op: 'flash', x: '900', y: '800', byteStart: 13, byteEnd: 17}], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive, hits}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    assert.equal(hits.includes('/p2'), false);
    assert.ok(result.issues.some(issue => issue.code === 'UNSUPPORTED_OPERATION' && issue.sourceRange?.start === 6));
  });
});

test('区域输出区域对象而非测试点，不足三点的轮廓不生成对象', async () => {
  await withSource({
    '/fabrication': [manifest({id: 'top', href: '/p', generation: 'g1'})],
    '/p': [[200, [
      {op: 'format', integer: 2, decimal: 4},
      {op: 'unit', value: 'mm'},
      {op: 'attribute', scope: 'object', key: 'net', value: 'VCC', byteStart: 1, byteEnd: 2},
      {op: 'regionBegin', byteStart: 3, byteEnd: 4},
      {op: 'move', x: '0', y: '0', byteStart: 5, byteEnd: 6},
      {op: 'draw', x: '100', y: '0', byteStart: 7, byteEnd: 8},
      {op: 'draw', x: '100', y: '100', byteStart: 9, byteEnd: 10},
      {op: 'draw', x: '0', y: '0', byteStart: 11, byteEnd: 12},
      {op: 'regionEnd', byteStart: 13, byteEnd: 14},
      {op: 'regionBegin', byteStart: 15, byteEnd: 16},
      {op: 'move', x: '0', y: '0', byteStart: 17, byteEnd: 18},
      {op: 'draw', x: '50', y: '50', byteStart: 19, byteEnd: 20},
      {op: 'regionEnd', byteStart: 21, byteEnd: 22},
    ], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    const [region] = result.records;
    assert.equal(region.kind, 'region');
    assert.equal(region.closed, true);
    assert.equal(region.path.length, 4);
    assert.deepEqual(region.attributes, {net: 'VCC'});
    assert.equal(result.issues.filter(issue => issue.code === 'INVALID_REGION_CONTOUR').length, 1);
    assert.equal(result.records.some(record => record.kind === 'flash'), false);
  });
});

test('未知孔径或缺失格式不借用上一个有效状态', async () => {
  await withSource({
    '/fabrication': [manifest({id: 'top', parts: ['/p1', '/p2'], generation: 'g1'})],
    '/p1': [[200, [
      ...HEAD,
      {op: 'select', id: '99', byteStart: 1, byteEnd: 2},
      {op: 'flash', x: '100', y: '200', byteStart: 3, byteEnd: 5},
    ], {'x-generation': 'g1'}]],
    '/p2': [[200, [{op: 'flash', x: '100', y: '200', byteStart: 6, byteEnd: 8}], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 0);
    assert.ok(result.issues.some(issue => issue.code === 'UNKNOWN_APERTURE'));
    assert.ok(result.issues.some(issue => issue.code === 'MISSING_APERTURE'));
  });
});

test('另一层缺少格式与位置时不影响已解释层的坐标', async () => {
  await withSource({
    '/fabrication': [manifest(undefined, {
      layers: [
        {id: 'a', href: '/a', generation: 'g1'},
        {id: 'b', href: '/b', generation: 'g1'},
      ],
    })],
    '/a': [[200, [...HEAD, {op: 'flash', x: '100', y: '200', byteStart: 1, byteEnd: 5}], {'x-generation': 'g1'}]],
    '/b': [[200, [{op: 'flash', x: '100', y: '200', byteStart: 1, byteEnd: 5}], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.deepEqual(result.records.map(record => [record.layer, record.position]), [['a', [0.01, 0.02]]]);
    assert.ok(result.issues.some(issue => issue.code === 'MISSING_FORMAT' && issue.layer === 'b'));
  });
});

test('删除对象属性后新对象不再带出旧值，且边界可复核', async () => {
  await withSource({
    '/fabrication': [manifest({id: 'top', href: '/p', generation: 'g1'})],
    '/p': [[200, [
      ...HEAD,
      {op: 'attribute', scope: 'object', key: 'net', value: 'GND', byteStart: 1, byteEnd: 2},
      {op: 'flash', x: '100', y: '200', byteStart: 3, byteEnd: 5},
      {op: 'deleteAttribute', scope: 'object', key: '*', byteStart: 6, byteEnd: 7},
      {op: 'flash', x: '300', y: '400', byteStart: 8, byteEnd: 10},
    ], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive}) => {
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, true);
    assert.deepEqual(result.records[0].attributes, {net: 'GND'});
    assert.deepEqual(result.records[1].attributes, {});
    const boundary = result.records[1].boundaries.find(item => item.action === 'delete' && item.key === '*');
    assert.deepEqual(boundary.previousValue, {net: 'GND'});
    assert.deepEqual(boundary.sourceRange, {start: 6, end: 7});
  });
});

test('归档重复接收同一交付不新增修订，代际变化生成新标识', async () => {
  await withSource({
    '/fabrication': [[200, {job: 'job', generation: 'g1', sealed: true, layers: [{id: 'top', href: '/p', generation: 'g1'}]}]],
    '/p': [[200, [...HEAD, {op: 'flash', x: '100', y: '200', byteStart: 1, byteEnd: 5}], {'x-generation': 'g1'}]],
  }, async ({baseUrl, archive, directory}) => {
    const first = await collect({baseUrl, archive, mode: 'source'});
    await collect({baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(archive.snapshot().records.length, 1);
    assert.equal(first.records[0].id, 'fab:job:top:g1:flash:/p:1-5');
    await openArchive(directory);
  });
});
