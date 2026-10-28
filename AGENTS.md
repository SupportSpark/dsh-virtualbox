# AGENTS.md — dsh-virtualbox

本文件给 DSH Agent 阅读。人类安装/排错请看 [README.zh.md](README.zh.md)。

## 这是什么

在**本机 VirtualBox** 上按模板创建 Linux 虚拟机，并把「建好、启动、等 SSH、跑命令」这一串变成工具调用。全部走 `VBoxManage`，无外部依赖。

## 使用顺序（建议）

1. **先看环境**：`vbox_status` —— 引擎版本、宿主机 CPU、已有 VM、各自 SSH 端口。
2. **再选系统**：`vbox_templates` —— 需要什么发行版/版本，看 `format` 与 `minMemoryMB` / `minDiskGB`。
3. **要整套环境**：改 `examples/boxes.json` → `vbox_apply`；只要一台：`vbox_create`。
4. **验证**：`vbox_ssh` 跑命令；不要用 bash/pwsh 去模拟 guest 内的行为。
5. **重置**：`vbox_reset`（默认回 `clean` 快照），比删了重建快得多。
6. **收尾**：`vbox_destroy`。

## 硬规则

- **`vbox_ssh` 每次一条自包含命令**：没有交互式会话，需要多步就用 `&&` / `;`。
- **不要用宿主机命令代替 guest 命令**：编译、服务、权限、内核行为都必须在 guest 里验证。
- **非零退出码不是工具失败**：`vbox_ssh` 会返回 `exit=N` 和 stderr，按内容判断，不要重试同一条命令。
- **起不来先看控制台**：`vbox_console` 给截图 + 串口日志尾部，这比猜快。
- **`vbox_create` 是重操作**：会下载镜像（首次几百 MB）、转换磁盘、等 cloud-init。同一个模板第二次会命中缓存；跨会话也命中。
- **端口是回环的**：SSH 只转发到 `127.0.0.1:<port>`，guest 不对局域网暴露。

## 模板怎么改

`examples/boxes.json`（可用 `vbox_apply { "file": "..." }` 指定别的路径）：

```json
{
  "defaults": { "template": "debian-12", "cpus": 2, "memoryMB": 2048, "diskGB": 12, "user": "dev", "snapshot": "clean" },
  "boxes": { "lab-debian": { "packages": ["gdb"] } }
}
```

- `defaults` 被每个 box 继承，box 里的同名字段覆盖它。
- 允许 `//` 与 `/* */` 注释；字符串里的 `https://` 不会被误判。
- `vbox_apply` 幂等：缺的建、停的启、运行中的不动；`only` 限定范围，`dryRun` 只报告。

## 镜像与格式

- 目录里的模板都选了 **raw / tar.xz / 未压缩 qcow2 / vmdk**，插件内部转 VDI。
- **压缩 qcow2 不支持**（Debian 官方 `.qcow2` 就是这种）。遇到会报可操作的错误，换该发行版的 `.tar.xz` / `.raw`。
- 点版本号会变的模板（Alpine、Fedora）在 `notes` 里标注了，需要固定版本时用 `url` 覆盖。
- `reinstall-iso` 模板指向上游仓库的 release 产物，而**上游目前没有发布可引导 ISO**，取不到会明确报错；空 VM 场景用云镜像模板。

## 常见失败

| 现象 | 判断 |
|---|---|
| `SSH did not become ready` | 先 `vbox_console`；固件不匹配时试 `firmware: "efi"` |
| VM 慢 / guest 时钟跑飞 | `vbox_status` 的 `execution engine` 行：`NEM/WHP` 表示 CPU 虚拟化扩展被 hypervisor 占着（VBS/HVCI、Credential Guard、KeyGuard 都算，不只是 Hyper-V）。**开着内存完整性也能正常用**（本机实测两种状态都 30/30、建机约 40 秒），代价只有嵌套虚拟化，不要为了这点差异劝用户关掉安全功能 |
| 盘只有 3 GiB | `diskGB` 只在创建时生效，重建 VM |
| `VERR_NEM_VM_CREATE_FAILED` | 宿主机开了 Hyper-V，需要启用「Windows 虚拟机监控程序平台」 |
