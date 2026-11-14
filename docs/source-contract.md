# 来源与既有应用契约

## 新来源

GET /fabrication 给出job、layers。每layer的href返回上游已分词的JSON指令数组，并保留byteStart/byteEnd；通用Gerber词法由上游处理。指令op支持format(integer,decimal,zeroSuppression=leading)、unit(mm/inch)、aperture(id,shape,params)、select(id)、attribute(scope=file/aperture/object,key,value)、deleteAttribute(scope,key或*)、move(x,y)、draw(x,y)、flash(x,y)、regionBegin、regionEnd；x/y是可省略的整数数字串，按当前format解释，省略轴继承当前位置但首次省略为未知。object属性只向后生效；aperture属性在定义aperture时捕获。输出kind、position/end、unit、aperture、attributes、sourceRange；区域输出region而非flash。 manifest可额外带generation、sealed；layer可给generation和parts替代href。parts按顺序组成一层的指令流，模态状态跨同层part保留，但不同layer独立。part响应X-Generation需匹配manifest，不匹配或sealed=false时不得将新交付标成完整。所有记录保留job/layer/generation；旧归档历史不得被另一代际对象覆盖。

本地来源只实现以上明确子集，不要求补全同类公开标准。未声明的字段与语法不得自动解释成有效业务事实。样本中的所有人员、账户、样本、设备与文件内容均为合成资料，无生产访问凭据。

## 接收接口

既有调用是 `collect({baseUrl, archive, mode})`。`mode` 默认为 `legacy`；新增来源使用 `source`。返回 `{records, complete, issues, evidenceCount}`：`records` 为本次业务结果，`complete` 表示本次领取及解释是否有未决缺口，`issues` 为带来源位置的可复核问题，`evidenceCount` 为实际接收的原文数。新结果可增加字段，示例不是封闭 schema。

每个落库记录的 `id` 必须非空且稳定，由业务身份决定；业务所需的多身份关系不能都压缩进 `id`。`archive.commit` 接受 `records`、`exchanges` 与 `issues`；原文在 `raw/` 以 SHA-256 寻址，索引引用原文与记录修订。既有归档索引 schema=1 可以扩展，但旧摘要记录必须仍可读取。

应用不得伪造原文，也不能把摘要模式当成新来源成功。HTTP 相对链接基于来源 origin 解析，不能访问其他站点。错误状态、缺数据和空的有效结果应区分。来源解释未决时 `complete=false`，已收的安全独立部分可以保留。

## 可运行资料

`fixtures/scenarios.json` 提供来源响应及预期业务片段；`expected`/`forbidden` 只供回归断言，采集代码不得读取该文件。来源用真实 HTTP 发送数据，二进制夹具由 `$hex` 或 `$octets` 编码，接收方不会看到这些包装键。`/__requests` 是本地测试用请求审计接口，不是资料源。

连续相同 method/path 响应可按数组次序变化，最后一次响应保持；`after` 表达来源步骤先后，`once` 为单次凭证。POST 搜索会按来源能力拒绝不支持的条件。接收端不需要实现来源服务，也不得删改来源限制来通过测试。

上述契约和题面决定功能范围。公开回归提供正常与有冲突/缺口的样例，并未穷举所有组合；应补充与实际设计相符的边界验证。运行与演示不连接新闻站点或其他线上服务。
