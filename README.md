<p align="center">
  <img src="docs/assets/run2skill-hero.png" alt="Run2Skill — Teach once. Reuse the skill." width="1000" />
</p>

<p align="center"><strong>把对话经验，变成下次可用的 Skill。</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.2.2-247C78" alt="版本 1.2.2" />
  <img src="https://img.shields.io/badge/DSH-0.2.3--alpha.2%20%7C%200.2.2--rc.3%20%7C%200.2.2--rc.1-153B3C" alt="支持 DSH 0.2.3-alpha.2、0.2.2-rc.3、0.2.2-rc.1" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-EAB45C" alt="MIT 许可证" /></a>
</p>

> **这是 duma520 维护的分叉版本（`@duma520/dsh-run2skill` v1.2.2）**
>
> 上游为 [qkycir-123/dsh-run2skill](https://github.com/qkycir-123/dsh-run2skill) v1.0.0。
>
> 本分叉做两件事：**① 放宽 `peerDependencies` 白名单以支持 DSH 0.2.3-alpha.2**；**② 补上四项可观测与可回滚能力**（自有落盘日志、运行代际自检、「技能使用情况」召回遥测、发布历史快照）。包名改为 `@duma520/dsh-run2skill` 以便与本机原插件共存/替换。
>
> 1.2.0 的四项能力只借鉴公开插件的**设计思路**，代码全部自写，未引入任何新的 `@deepseek-ai/*` 依赖。
> 1.2.1 是缺陷修复：一条历史会话日志缺了 7 个事件，曾导致插件恢复永久卡死（详见迭代记录）。
> 1.2.2 继续修同一个症状的另一半：28 种事件白名单缺了 0.2.3 新增的 24 种，导致 201 个历史会话无法投影、恢复整批中断（详见迭代记录）。
>
> - 上游 1.0.0 在 DSH 0.2.3-alpha.2 上会被插件门禁拦下，报「与 DSH 0.2.3-alpha.2 不兼容（要求 … 0.2.2-rc.1 \|\| 0.2.2-rc.3）」。
> - 本分叉把 4 个 `@deepseek-ai/*` peer 白名单改成 `0.2.2-rc.1 \|\| 0.2.2-rc.3 \|\| 0.2.3-alpha.2`。
> - 安装到本机后需**重启 DSH 桌面应用**才生效；改动明细见 [软件升级迭代记录.md](软件升级迭代记录.md)。
> - 不发布到 npm，仅作本地插件使用（`link:` 挂载）。

<p align="center">
  <a href="#安装">安装</a> · <a href="#看一遍完整流程">完整流程</a> · <a href="docs/compatibility.md">兼容性</a> · <a href="CHANGELOG.md">更新记录</a> · <a href="README.en.md">English</a>
</p>

Run2Skill 把你在 DeepSeek Harness（DSH）里教给 Agent 的纠正、约束和工作流，整理成可复用的 Skill。你查看草稿、提出修改意见，确认后保存。

长会话通过有界 Pending Window 保留候选经验和相关反馈，后续判断可回读原始证据。默认保持标准召回；在 **插件 → Run2Skill → Skill 召回** 中可开启高级召回，配置 embedding 服务后使用 **BM25 + 向量 + RRF + 摘要重排**。重排默认沿用会话模型，也可配置专用服务。新建和合并前仍完整复核目录。模型、索引和失败回退说明见[高级召回](docs/features/hybrid-recall.md)。

## 看一遍完整流程

![Run2Skill：打开插件、审核草稿、确认保存](docs/assets/run2skill-demo.gif)

*main 分支界面 · 示例草稿演示*

1. 打开 **左侧栏 → 插件 → Run2Skill**。
2. 查看草稿的用途、适用范围、对话来源和完整内容。
3. 按需提出修改意见，或直接**确认并保存**。
4. 在**最近活动**中查看结果，下次相关任务即可使用这个 Skill。

<details>
<summary>查看关键界面</summary>

![待审核草稿](docs/assets/01-proposal-inbox.png)

![草稿来源与内容](docs/assets/02-review-details.png)

![保存结果与最近活动](docs/assets/03-saved-activity.png)

</details>

## 安装

### 本机（DSH 0.2.3-alpha.2 桌面版）—— 推荐读这一节

本分叉**不走 npm**，用本地目录 + `link:` 挂载。装法如下（每一步都已在 2026-11-25 实测过）：

1. **准备插件目录**：本机路径是 `G:\DSH\dsh-plugins\dsh-run2skill`。

   > **从 GitHub 克隆的话，`lib\` 不存在**（仓库只收源码，构建产物在 `.gitignore` 里）。先构建一次：
   > ```bash
   > pnpm install
   > pnpm run build
   > ```
   > 成功后 `lib\` 会有 8 个文件：`client.js`、`index.js`、`index.d.ts`、`typert.host.js`、`typert.host.d.ts`、`typert.remote-client.js`、`typert.remote-client.d.ts`、`contract-*.js`。
   > 从本机备份目录 `version/20261125-v4/lib/` 直接拷一份也可以，字节完全一致。

   下面 2~6 步用的是 `G:\DSH\dsh-plugins\dsh-run2skill`；装在别处就把这个路径整体替换掉。

2. **在 profile 里挂依赖**。编辑 `C:\Users\duma520\.dsh\profiles\desktop\package.json`，`dependencies` 加一行：
   ```json
   "@duma520/dsh-run2skill": "link:G:/DSH/dsh-plugins/dsh-run2skill"
   ```
3. **在 `dsh.profile.bundles` 数组里加一项** `"@duma520/dsh-run2skill"`（不加则宿主不会装配它的 Host/Client 半身）。
4. **建目录符号链接**（在 `C:\Users\duma520\.dsh\profiles\desktop\node_modules\@duma520\` 下）：
   ```cmd
   mklink /D dsh-run2skill G:\DSH\dsh-plugins\dsh-run2skill
   ```
   用 PowerShell 的 `New-Item -ItemType SymbolicLink` 也可以；若报没有权限，用 `python -c "import os; os.symlink(r'G:\DSH\dsh-plugins\dsh-run2skill','dsh-run2skill',target_is_directory=True)"`。
5. **改 `cordis.patch.yml`**：找到 `- id: run2skill` 那一行，把 `name` 改成 `"@duma520/dsh-run2skill"`（**必须带引号**，YAML 里以 `@` 开头的裸标量是非法的）。`config.automaticLearning` 保留原值。
6. **彻底退出并重启 DSH 桌面应用**。前端与 bundle 清单只在启动时装配一次，热刷新不生效。

重启后验证：左侧栏 **插件** 里出现 `dsh-run2skill` 卡片，版本 `1.2.2`，`未运行` 的红字不兼容提示消失。

### 为什么不能用 `dsh plugin` 命令行

`dsh plugin --profile desktop ...` 会直接报：

```
error: profile "desktop" is managed exclusively by the Electron application
```

desktop profile 由 DSH 桌面应用独占管理，CLI 完全无法装/改。要么走上面的手工配置，要么走 GUI 插件市场的「安装 bundle」。

### 上游原始安装说明（Web / Mac / 旧版 Windows）

以下为上游项目的通用装法，仅供其他宿主参考；`dsh-run2skill@1.0.0` 在 DSH 0.2.3-alpha.2 上会被门禁拦下。

**Web（DSH 0.2.2-rc.1）**：准备好 Node.js `>=24.9.0`、`pnpm` 和 `dsh` 命令，安装 `1.0.0`：

```bash
dsh plugin --profile web add dsh-run2skill@1.0.0
```

**Mac 桌面版（DSH 0.2.2-rc.3）**。首次打开 DSH 后，在应用菜单中选择 **管理 dsh 命令… → 安装**。完全退出应用，再在新终端运行。

```bash
dsh plugin --profile desktop add dsh-run2skill@1.0.0
```

**Windows Desktop（DSH 0.2.0-rc.2）**：通过 **Manage dsh Command…** 配置命令，完成首次启动后退出应用，安装 `0.5.0-alpha.4`：

```bash
dsh plugin --profile desktop add dsh-run2skill@0.5.0-alpha.4
```

安装后重启 DSH。Run2Skill 使用当前会话选择的模型。版本信息见 [兼容性](docs/compatibility.md)。

## 使用

照常与 Agent 工作，把值得复用的做法说清楚：

- **纠正**：“先写失败测试，再修实现。”
- **约束**：“这个项目的 GitHub 文案统一用中文。”
- **工作流**：“先核对上游版本，再运行兼容性检查。”
- **保存请求**：“把这个流程保存成 Skill，以后复用。”

Run2Skill 在会话空闲或收到保存请求时整理经验。有草稿需要审核时，DSH 会通知你。也可以打开插件页，点击**立即整理本次经验**。

每份草稿都附有对话来源。你可以确认保存、要求修改，或放弃草稿。Skill 支持保存到**当前项目**或**所有项目**，使用 DSH 默认的 Skill 目录。

## 设置

- **整理状态**：查看当前会话的经验整理进度。插件启用时自动生成草稿，也可手动请求立即整理。
- **最近活动**：查看最近 7 天新建或更新的 Skill。
- **清理所有缓存**：预览并清理待处理草稿与中间缓存，保留已保存的 Skill、会话记录和 DSH 设置。

Run2Skill 在本地管理草稿，并将经过筛选和脱敏的必要对话片段交给当前模型分析。详见 [数据存储与升级](docs/storage-and-upgrades.md)。

## 1.2.0 新增的四项能力

这四项都是「出错时能查、改坏时能退、不是同一版时能看出来」，不改变上游的业务流程。

### 1. 插件自有落盘日志

- 路径：`~/.dsh/dsh-run2skill/logs/run2skill.log`（Windows 是 `C:\Users\<你>\.dsh\dsh-run2skill\logs\run2skill.log`）。
- 格式：每行一个 JSON 对象，含 `ts` / `level` / `name` / `message` / `args`。文件权限 `0600`。
- 轮转：单个文件超过 **5 MB** 时改名为 `run2skill.log.1`（只保留一份旧档，不做无限堆积）。
- 脱敏：写入前逐字段脱敏，`password=`、`authorization:` 头、bearer token、URL 内嵌凭据等一律替换为 `[REDACTED]`；结构化字段（数字、布尔、数组）原样保留。
- 安全阀：**任何写日志失败都不会抛出**，只静默降级——日志不能打断 Agent 主循环。
- 记录内容：插件装载/就绪/卸载、ingress 健康码、代际过期告警、代际探测失败。排查问题时先看这里。

### 2. 运行代际自检（需重启时会明确告诉你）

插件在模块导入时对**正在运行的这份代码**算一次 SHA-1 指纹（12 位），之后每次读取设置页都会重读磁盘上的同一文件比对：

- 两侧一致：设置页不显示任何提示。
- 磁盘已换新版（例如你更新了插件但没重启）：设置页顶部出现红色横幅，写明「运行中的插件是旧版本（运行 xxx），磁盘上已是新版本（磁盘 yyy）。请重启 DSH 桌面应用后生效。」
- 任一侧指纹读不出来：**不报警**（宁可漏报也不误报）。

> 为什么需要这个：DSH 的插件界面改动不随热刷新生效，以前只能靠「改了没反应」来猜。现在它会直接告诉你磁盘和内存不是同一版。探测节流为 60 秒一次，不会每次轮询都读盘。

### 3. 技能使用情况（召回遥测）

设置页新增「技能使用情况」折叠区，显示**最近 30 天**每个 Skill 被读出来交给模型的次数：

- 数据来源：直接读 v2 域里 `experience_intents` 的召回候选，**不额外落一份派生索引**——同一件事不存两遍，也不会与主数据不一致。
- 计次口径：只有 `bodyDigest` 存在（正文真被读出来）的候选才算一次；同一次召回里重试不会重复计数。
- 作用域：`仅当前项目可用` / `所有项目可用` / `来源未知`。项目级记录必须能确定归属到某个工作区才算数，归不了属的一律丢弃，**不把多个工作区的数字合并成一个误导性总数**。
- 诚实边界（界面上也写着）：**只表示这些 Skill 的正文被读出来交给了模型，不代表模型真的用上了它们。**
- 与会「最近活动」的区别：「最近活动」是**写侧**（新建/更新了哪些 Skill），「技能使用情况」是**读侧**（哪些 Skill 被拿出了）。两者分开，不混成一个数字。

### 4. 发布历史快照（改坏了能找回上一版）

- 每次**合并更新**一个已存在的 Skill 时，被替换掉的旧正文会先归档到 `skills/.run2skill-history/<skill-name>/<内容哈希>.md`（与 `SKILL.md` 同级目录下的隐藏目录）。
- 每个 Skill **最多保留 3 个历史版本**，超出按修改时间删最旧。
- 按内容哈希命名，所以崩溃重试只会把同样的字节拷到同样的名字，天然幂等。
- 首次创建不产生历史（没有旧版本可留）。
- 归档失败**不会回滚**一次已经校验通过的发布——历史副本是尽力而为，不能因为它写不进去就把刚发布的好版本撤掉。
- 恢复方法：把 `history/<哈希>.md` 手工拷回 `SKILL.md` 即可（插件不提供自动回滚按钮，避免误操作覆盖你要保留的版本）。

## 更新与卸载

按上方安装说明选择与宿主匹配的版本，安装后重启 DSH。

**本机分叉版的卸载 / 回滚**（手工操作，因为 desktop profile 不能用 CLI）：

1. 从 `C:\Users\duma520\.dsh\profiles\desktop\package.json` 的 `dependencies` 删掉 `"@duma520/dsh-run2skill"`，从 `dsh.profile.bundles` 删掉 `"@duma520/dsh-run2skill"`。
2. 从 `cordis.patch.yml` 删掉整段 `- id: run2skill` 行（或把它注释掉）。
3. 删掉 `C:\Users\duma520\.dsh\profiles\desktop\node_modules\@duma520\dsh-run2skill` 这个符号链接。
4. 重启 DSH 桌面应用。

**回滚到上游原插件**：把 `node_modules\dsh-run2skill.disabled-by-duma520` 改回 `node_modules\dsh-run2skill`，并把 `package.json` 里 `"dsh-run2skill": "1.0.0"`、`bundles` 里的 `"dsh-run2skill"`、`cordis.patch.yml` 里 `name: "dsh-run2skill"` 一并恢复。本次改动前的原始文件已备份在 `C:\Users\duma520\.dsh\profiles\desktop\.backup-run2skill\`。

上游通用卸载命令（其他宿主适用）：

```bash
dsh plugin --profile desktop remove dsh-run2skill
```

Web 用户将 `desktop` 换成 `web`。卸载后已保存的 Skill 和插件数据继续保留；需要清理缓存时，可在卸载前使用插件页的清理功能。

## 版本更新简介

| 版本 | 日期 | 一句话变更 |
| --- | --- | --- |
| 1.2.1 | 2026-11-25 | 修复：单条残缺会话日志会让恢复永久重试；补健康码落盘、恢复失败原因落盘、历史会话水合缓存 |
| 1.2.2 | 2026-11-25 | 修复：事件白名单缺 24 种 0.2.3 新增事件，导致恢复仍永久降级；不可投影的会话改为跳过而非整批中断 |
| 1.2.0 | 2026-11-25 | 新增自有日志、运行代际自检、技能召回遥测、发布历史快照四项能力（只借设计，代码自写） |
| 1.1.0 | 2026-11-25 | 分叉为 `@duma520/dsh-run2skill`，放宽 peer 白名单以支持 DSH 0.2.3-alpha.2 |
| 1.0.0 | 2026-11-14 | 上游首个稳定版 |

详细改动、验证过程与回滚方法见 [软件升级迭代记录.md](软件升级迭代记录.md)。

## 帮助与贡献

- 本分叉问题：[duma520/dsh-run2skill/issues](https://github.com/duma520/dsh-run2skill/issues)
- 上游问题：[qkycir-123/dsh-run2skill/issues](https://github.com/qkycir-123/dsh-run2skill/issues)
- [兼容性](docs/compatibility.md) · [更新记录](CHANGELOG.md) · [本分叉改动记录](软件升级迭代记录.md)
- [贡献指南](CONTRIBUTING.md) · [维护者探针](probes/README.md)
- [产品需求](docs/product/prd.md) · [架构与设计](docs/architecture/baseline.md)

[MIT License](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
