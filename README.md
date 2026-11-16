# 制板交付的模态指令与属性资料采集

这是资料接收服务的独立工作副本。当前版本支持人工摘要领取，以及把制板交付的模态指令流解释成可追溯对象资料；原文归档、重复导入和归档检查沿用既有通路。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 运行基线回归和补充的边界验证：既有摘要通路、原文摘要检查、本地来源响应、CLI 在独立进程中的真实领取、重复导入与持久归档检查，以及新来源按层隔离模态状态、属性作用时点、代际边界和缺口留痕。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收，断言原样保留。交付时执行 `npm run verify:complete`，让基线和来源验收同时通过。

```sh
npm run verify:complete
npm run demo:feature
```

`npm run demo:feature` 从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `attribute-scope`。单次命令应在90秒内结束，不使用真实客户数据。

## 新来源的行为

`collect({baseUrl, archive, mode: 'source'})` 领取 `/fabrication` 清单，再逐层领取声明的 `href` 或按顺序领取 `parts`。解释规则以 `docs/source-contract.md` 为准：

- 模态状态（数字格式、单位、当前位置、已定义孔径、选中孔径、各级属性）按层独立；同一层的多个 part 连续沿用，换层或换代际不复用。
- 孔径属性在 `aperture` 定义时捕获；object 属性只向后生效；file/aperture/object 属性按该顺序叠加，同一键后者覆盖前者。
- 每条对象记录带 `job`/`layer`/`generation`，并用 `source` 定位到文件分段、指令序号与 `byteStart`/`byteEnd`；同层跨 part 的区域另有 `sourceRanges`。
- `flash`/`draw` 输出 `kind`、`position`/`end`、`unit`、`aperture`、`attributes` 和所引用孔径的定义快照；`regionBegin` 至 `regionEnd` 输出 `kind: "region"` 的轮廓，不伪装成测试点。
- 已有的旧代际记录保留在索引里；新代际使用不同 `id`（含代际），同一份共享孔径定义在新层/新代际重新捕获，不串用旧状态。
- 属性删除、缺失孔径、未知坐标轴、暂不支持的指令、区域落在分包边界等情况都会留下带位置的问题并使 `complete=false`；无法解释的层在缺口处停止，不再沿用最后有效状态补对象。来源声明 `sealed:false` 时保留已收部分但不算完整。

返回 `{records, complete, issues, evidenceCount}`，记录与原文证据一并写入 `archive.commit`。

## 容器

```sh
docker build -t acquisition-fabrication-modal:local .
docker run --rm --network none acquisition-fabrication-modal:local
docker run --rm --network none acquisition-fabrication-modal:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令依次跑测试、摘要导入和制板来源演示。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式保留，`source` 模式交给 `src/source.mjs`。
- `src/source.mjs` 负责清单遍历、分段领取、代际核对与缺口汇总；不解释指令本身。
- `src/modal.mjs` 是单层的模态指令解释器，持有该层的格式、单位、位置、孔径定义与属性作用域。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 是新来源验收；`test/source.test.mjs` 补充边界验证。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
